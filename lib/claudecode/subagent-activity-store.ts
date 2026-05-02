import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  ClaudeCodeSubagentActivity,
  ClaudeCodeSubagentEvent,
  ClaudeCodeSubagentEventType,
  ClaudeCodeSubagentSnapshot,
  ClaudeCodeSubagentStatus,
} from "./subagent-activity-types";

const MAX_EVENTS_PER_ACTIVITY = 160;
const RECENT_TTL_MS = 30 * 60 * 1000;
const STREAM_UNAVAILABLE_GRACE_MS = 5_000;

interface ScopeInput {
  userId?: string;
  sessionId?: string;
  runId?: string;
  characterId?: string | null;
}

interface RecordStartInput extends ScopeInput {
  parentToolUseId: string;
  taskId?: string;
  subagentName?: string;
  subagentType?: string;
  description?: string;
  summary?: string;
}

interface RecordActivityInput extends ScopeInput {
  parentToolUseId?: string;
  taskId?: string;
  type?: ClaudeCodeSubagentEventType;
  status?: ClaudeCodeSubagentStatus;
  summary: string;
  toolName?: string;
  streamEvent?: boolean;
}

type Listener = (event: ClaudeCodeSubagentEvent, activity: ClaudeCodeSubagentActivity) => void;

const activities = new Map<string, ClaudeCodeSubagentActivity>();
const eventsByActivityId = new Map<string, ClaudeCodeSubagentEvent[]>();
const activityByParentToolUseId = new Map<string, string>();
const activityByTaskId = new Map<string, string>();
const streamFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

function now() {
  return Date.now();
}

function isEnabled() {
  return process.env.CLAUDECODE_SUBAGENT_ACTIVITY_ENABLED !== "false";
}

function normalizeCharacterId(value: string | null | undefined) {
  return value ?? undefined;
}

function truncate(value: string, max = 600) {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

function makeActivityId(input: { sessionId: string; parentToolUseId?: string; taskId?: string }) {
  return [input.sessionId, input.parentToolUseId || input.taskId || randomUUID()].join(":");
}

function scopedChannel(userId?: string, sessionId?: string) {
  return `activity:${userId || "anonymous"}:${sessionId || "*"}`;
}

function globalUserChannel(userId?: string) {
  return `activity:${userId || "anonymous"}:*`;
}

function cleanupExpired() {
  const cutoff = now() - RECENT_TTL_MS;
  for (const [id, activity] of activities) {
    if (activity.completedAt && activity.completedAt < cutoff) {
      activities.delete(id);
      eventsByActivityId.delete(id);
      if (activity.parentToolUseId) activityByParentToolUseId.delete(activity.parentToolUseId);
      if (activity.taskId) activityByTaskId.delete(activity.taskId);
      const timer = streamFallbackTimers.get(id);
      if (timer) clearTimeout(timer);
      streamFallbackTimers.delete(id);
    }
  }
}

function appendEvent(activity: ClaudeCodeSubagentActivity, event: Omit<ClaudeCodeSubagentEvent, "id" | "timestamp">) {
  const fullEvent: ClaudeCodeSubagentEvent = {
    ...event,
    id: randomUUID(),
    timestamp: now(),
  };
  const events = eventsByActivityId.get(activity.id) ?? [];
  events.push(fullEvent);
  if (events.length > MAX_EVENTS_PER_ACTIVITY) events.splice(0, events.length - MAX_EVENTS_PER_ACTIVITY);
  eventsByActivityId.set(activity.id, events);
  emitter.emit(scopedChannel(activity.userId, activity.sessionId), fullEvent, activity);
  emitter.emit(globalUserChannel(activity.userId), fullEvent, activity);
  return fullEvent;
}

function findActivity(input: ScopeInput & { parentToolUseId?: string; taskId?: string }) {
  if (input.parentToolUseId) {
    const id = activityByParentToolUseId.get(input.parentToolUseId);
    if (id) return activities.get(id);
  }
  if (input.taskId) {
    const id = activityByTaskId.get(input.taskId);
    if (id) return activities.get(id);
  }
  return undefined;
}

function scheduleStreamUnavailable(activityId: string) {
  if (streamFallbackTimers.has(activityId)) return;
  const timer = setTimeout(() => {
    streamFallbackTimers.delete(activityId);
    const activity = activities.get(activityId);
    if (!activity || activity.streamAvailability !== "pending" || activity.status !== "running") return;
    activity.streamAvailability = "unavailable";
    activity.latestSummary = "Live nested stream is unavailable; waiting for Claude Code completion.";
    activity.updatedAt = now();
    appendEvent(activity, {
      activityId: activity.id,
      type: "stream-unavailable",
      status: activity.status,
      summary: activity.latestSummary,
      parentToolUseId: activity.parentToolUseId,
      taskId: activity.taskId,
    });
  }, STREAM_UNAVAILABLE_GRACE_MS);
  streamFallbackTimers.set(activityId, timer);
}

function markStreamAvailable(activity: ClaudeCodeSubagentActivity) {
  if (activity.streamAvailability === "available") return;
  activity.streamAvailability = "available";
  const timer = streamFallbackTimers.get(activity.id);
  if (timer) clearTimeout(timer);
  streamFallbackTimers.delete(activity.id);
}

export function recordClaudeCodeSubagentStarted(input: RecordStartInput) {
  if (!isEnabled() || !input.userId || !input.sessionId || !input.parentToolUseId) return null;
  cleanupExpired();
  const existing = findActivity(input);
  const timestamp = now();
  const activity = existing ?? {
    id: makeActivityId({ sessionId: input.sessionId, parentToolUseId: input.parentToolUseId, taskId: input.taskId }),
    userId: input.userId,
    sessionId: input.sessionId,
    runId: input.runId,
    characterId: normalizeCharacterId(input.characterId),
    parentToolUseId: input.parentToolUseId,
    taskId: input.taskId,
    subagentName: input.subagentName || input.subagentType || "Claude sub-agent",
    subagentType: input.subagentType,
    description: input.description,
    status: "running" as const,
    latestSummary: input.summary || input.description || "Claude Code native sub-agent started.",
    streamAvailability: "pending" as const,
    source: "claude-code-native" as const,
    startedAt: timestamp,
    updatedAt: timestamp,
  };

  activity.status = "running";
  activity.completedAt = undefined;
  activity.updatedAt = timestamp;
  activity.taskId = input.taskId ?? activity.taskId;
  activity.runId = input.runId ?? activity.runId;
  activity.characterId = normalizeCharacterId(input.characterId) ?? activity.characterId;
  activity.subagentName = input.subagentName || activity.subagentName;
  activity.subagentType = input.subagentType ?? activity.subagentType;
  activity.description = input.description ?? activity.description;
  activity.latestSummary = input.summary || input.description || activity.latestSummary;

  activities.set(activity.id, activity);
  activityByParentToolUseId.set(activity.parentToolUseId, activity.id);
  if (activity.taskId) activityByTaskId.set(activity.taskId, activity.id);
  scheduleStreamUnavailable(activity.id);

  appendEvent(activity, {
    activityId: activity.id,
    type: "subagent-started",
    status: activity.status,
    summary: activity.latestSummary,
    parentToolUseId: activity.parentToolUseId,
    taskId: activity.taskId,
  });
  return activity;
}

export function recordClaudeCodeSubagentActivity(input: RecordActivityInput) {
  if (!isEnabled() || !input.userId || !input.sessionId || !input.summary) return null;
  cleanupExpired();
  let activity = findActivity(input);
  if (!activity && input.parentToolUseId) {
    activity = recordClaudeCodeSubagentStarted({
      userId: input.userId,
      sessionId: input.sessionId,
      runId: input.runId,
      characterId: input.characterId,
      parentToolUseId: input.parentToolUseId,
      taskId: input.taskId,
      summary: "Claude Code native sub-agent activity detected.",
    }) ?? undefined;
  }
  if (!activity) return null;

  if (input.streamEvent && input.parentToolUseId) markStreamAvailable(activity);
  if (input.taskId && !activity.taskId) {
    activity.taskId = input.taskId;
    activityByTaskId.set(input.taskId, activity.id);
  }
  activity.status = input.status ?? activity.status;
  activity.latestSummary = truncate(input.summary);
  activity.latestToolName = input.toolName ?? activity.latestToolName;
  activity.updatedAt = now();

  appendEvent(activity, {
    activityId: activity.id,
    type: input.type ?? "subagent-activity",
    status: activity.status,
    summary: activity.latestSummary,
    toolName: input.toolName,
    parentToolUseId: activity.parentToolUseId,
    taskId: activity.taskId,
  });
  return activity;
}

export function recordClaudeCodeSubagentFinished(input: RecordActivityInput & { failed?: boolean }) {
  const finalStatus: ClaudeCodeSubagentStatus = input.status ?? (input.failed ? "failed" : "completed");
  const activity = recordClaudeCodeSubagentActivity({
    ...input,
    type: finalStatus === "completed" ? "subagent-completed" : "subagent-failed",
    status: finalStatus,
  });
  if (!activity) return null;
  activity.completedAt = now();
  const timer = streamFallbackTimers.get(activity.id);
  if (timer) clearTimeout(timer);
  streamFallbackTimers.delete(activity.id);
  return activity;
}

export function getClaudeCodeSubagentSnapshot(input: { userId: string; sessionId?: string }): ClaudeCodeSubagentSnapshot {
  cleanupExpired();
  const filtered = [...activities.values()]
    .filter((activity) => activity.userId === input.userId)
    .filter((activity) => !input.sessionId || activity.sessionId === input.sessionId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const events: Record<string, ClaudeCodeSubagentEvent[]> = {};
  for (const activity of filtered) {
    events[activity.id] = eventsByActivityId.get(activity.id) ?? [];
  }
  return { activities: filtered, eventsByActivityId: events, emittedAt: now() };
}

export function subscribeToClaudeCodeSubagentActivity(input: { userId: string; sessionId?: string }, listener: Listener) {
  const channel = input.sessionId ? scopedChannel(input.userId, input.sessionId) : globalUserChannel(input.userId);
  emitter.on(channel, listener);
  return () => emitter.off(channel, listener);
}

export function clearClaudeCodeSubagentActivityForTests() {
  activities.clear();
  eventsByActivityId.clear();
  activityByParentToolUseId.clear();
  activityByTaskId.clear();
  for (const timer of streamFallbackTimers.values()) clearTimeout(timer);
  streamFallbackTimers.clear();
}

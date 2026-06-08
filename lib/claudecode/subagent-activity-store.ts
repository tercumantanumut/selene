import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { getRawSqlite } from "@/lib/db/sqlite-client";
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

interface ActivityRow {
  id: string;
  user_id: string;
  session_id: string;
  run_id: string | null;
  character_id: string | null;
  parent_tool_use_id: string;
  task_id: string | null;
  subagent_name: string;
  subagent_type: string | null;
  description: string | null;
  status: ClaudeCodeSubagentStatus;
  latest_summary: string;
  latest_tool_name: string | null;
  stream_availability: ClaudeCodeSubagentActivity["streamAvailability"];
  source: ClaudeCodeSubagentActivity["source"];
  started_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface EventRow {
  id: string;
  activity_id: string;
  type: ClaudeCodeSubagentEventType;
  status: ClaudeCodeSubagentStatus;
  summary: string;
  tool_name: string | null;
  task_id: string | null;
  parent_tool_use_id: string | null;
  timestamp: number;
}

function dbEnabled() {
  return process.env.CLAUDECODE_SUBAGENT_SQLITE_HISTORY_ENABLED !== "false";
}

function getDb() {
  if (!dbEnabled()) return null;
  try {
    return getRawSqlite();
  } catch (error) {
    console.debug("[ClaudeCode] SQLite sub-agent history unavailable:", error);
    return null;
  }
}

function activityFromRow(row: ActivityRow): ClaudeCodeSubagentActivity {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    runId: row.run_id ?? undefined,
    characterId: row.character_id ?? undefined,
    parentToolUseId: row.parent_tool_use_id,
    taskId: row.task_id ?? undefined,
    subagentName: row.subagent_name,
    subagentType: row.subagent_type ?? undefined,
    description: row.description ?? undefined,
    status: row.status,
    latestSummary: row.latest_summary,
    latestToolName: row.latest_tool_name ?? undefined,
    streamAvailability: row.stream_availability,
    source: row.source,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function eventFromRow(row: EventRow): ClaudeCodeSubagentEvent {
  return {
    id: row.id,
    activityId: row.activity_id,
    type: row.type,
    status: row.status,
    summary: row.summary,
    toolName: row.tool_name ?? undefined,
    taskId: row.task_id ?? undefined,
    parentToolUseId: row.parent_tool_use_id ?? undefined,
    timestamp: row.timestamp,
  };
}

function persistActivity(activity: ClaudeCodeSubagentActivity) {
  const sqlite = getDb();
  if (!sqlite) return;
  try {
    sqlite.prepare(`
      INSERT INTO claudecode_subagent_activities (
        id, user_id, session_id, run_id, character_id, parent_tool_use_id, task_id,
        subagent_name, subagent_type, description, status, latest_summary, latest_tool_name,
        stream_availability, source, started_at, updated_at, completed_at
      ) VALUES (
        @id, @userId, @sessionId, @runId, @characterId, @parentToolUseId, @taskId,
        @subagentName, @subagentType, @description, @status, @latestSummary, @latestToolName,
        @streamAvailability, @source, @startedAt, @updatedAt, @completedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        run_id = excluded.run_id,
        character_id = excluded.character_id,
        task_id = excluded.task_id,
        subagent_name = excluded.subagent_name,
        subagent_type = excluded.subagent_type,
        description = excluded.description,
        status = excluded.status,
        latest_summary = excluded.latest_summary,
        latest_tool_name = excluded.latest_tool_name,
        stream_availability = excluded.stream_availability,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `).run({
      ...activity,
      runId: activity.runId ?? null,
      characterId: activity.characterId ?? null,
      taskId: activity.taskId ?? null,
      subagentType: activity.subagentType ?? null,
      description: activity.description ?? null,
      latestToolName: activity.latestToolName ?? null,
      completedAt: activity.completedAt ?? null,
    });
  } catch (error) {
    console.debug("[ClaudeCode] Failed to persist native sub-agent activity:", error);
  }
}

function persistEvent(event: ClaudeCodeSubagentEvent) {
  const sqlite = getDb();
  if (!sqlite) return;
  try {
    sqlite.prepare(`
      INSERT OR IGNORE INTO claudecode_subagent_events (
        id, activity_id, type, status, summary, tool_name, task_id, parent_tool_use_id, timestamp
      ) VALUES (
        @id, @activityId, @type, @status, @summary, @toolName, @taskId, @parentToolUseId, @timestamp
      )
    `).run({
      ...event,
      toolName: event.toolName ?? null,
      taskId: event.taskId ?? null,
      parentToolUseId: event.parentToolUseId ?? null,
    });
  } catch (error) {
    console.debug("[ClaudeCode] Failed to persist native sub-agent event:", error);
  }
}

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
  persistEvent(fullEvent);
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
  persistActivity(activity);
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

  if (input.type === "stream-unavailable") {
    activity.streamAvailability = "unavailable";
  } else if (input.streamEvent && input.parentToolUseId) {
    markStreamAvailable(activity);
  }
  if (input.taskId && !activity.taskId) {
    activity.taskId = input.taskId;
    activityByTaskId.set(input.taskId, activity.id);
  }
  activity.status = input.status ?? activity.status;
  activity.latestSummary = truncate(input.summary);
  activity.latestToolName = input.toolName ?? activity.latestToolName;
  activity.updatedAt = now();
  persistActivity(activity);

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
  persistActivity(activity);
  const timer = streamFallbackTimers.get(activity.id);
  if (timer) clearTimeout(timer);
  streamFallbackTimers.delete(activity.id);
  return activity;
}

export function getClaudeCodeSubagentSnapshot(input: { userId: string; sessionId?: string }): ClaudeCodeSubagentSnapshot {
  cleanupExpired();
  const sqlite = getDb();
  if (sqlite) {
    try {
      const rows = sqlite.prepare(
        input.sessionId
          ? "SELECT * FROM claudecode_subagent_activities WHERE user_id = ? AND session_id = ? ORDER BY updated_at DESC"
          : "SELECT * FROM claudecode_subagent_activities WHERE user_id = ? ORDER BY updated_at DESC",
      ).all(...(input.sessionId ? [input.userId, input.sessionId] : [input.userId])) as ActivityRow[];
      const persistedActivities = rows.map(activityFromRow);
      const persistedEvents: Record<string, ClaudeCodeSubagentEvent[]> = {};
      const eventQuery = sqlite.prepare(
        "SELECT * FROM claudecode_subagent_events WHERE activity_id = ? ORDER BY timestamp ASC",
      );
      for (const activity of persistedActivities) {
        persistedEvents[activity.id] = (eventQuery.all(activity.id) as EventRow[]).map(eventFromRow);
        activities.set(activity.id, activity);
        activityByParentToolUseId.set(activity.parentToolUseId, activity.id);
        if (activity.taskId) activityByTaskId.set(activity.taskId, activity.id);
        eventsByActivityId.set(activity.id, persistedEvents[activity.id]);
      }
      return { activities: persistedActivities, eventsByActivityId: persistedEvents, emittedAt: now() };
    } catch (error) {
      console.debug("[ClaudeCode] Failed to load native sub-agent history:", error);
    }
  }

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
  getDb()?.exec(`
    DELETE FROM claudecode_subagent_events;
    DELETE FROM claudecode_subagent_activities;
  `);
}

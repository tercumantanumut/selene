/**
 * Unified Background Task Type Definitions
 *
 * Uses discriminated unions for type-safe task handling.
 */

export type TaskType = "scheduled" | "channel" | "chat" | "solo_story";

export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stale";

interface BaseTask {
  runId: string;
  type: TaskType;
  status: TaskStatus;
  userId: string;
  sessionId?: string;
  characterId?: string;
  startedAt: string;
  lastActivityAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  /**
   * Solo Story Mode (SPEC §8): when this task corresponds to a soloStory run
   * (planner / worker / synthesizer), `lobbyId` (and `cardId` for worker
   * runs) are mirrored from the soloStory snapshot so SSE consumers can
   * filter task events by the lobby they belong to without re-querying
   * `agent_runs.metadata`. Undefined for non-soloStory tasks.
   */
  lobbyId?: string;
  cardId?: string;
}

export interface BackgroundTask extends BaseTask {
  type: "scheduled";
  taskId: string;
  taskName: string;
  prompt: string;
  priority: "high" | "normal" | "low";
  attemptNumber?: number;
  maxRetries?: number;
}

export interface ChannelTask extends BaseTask {
  type: "channel";
  channelType: "telegram" | "whatsapp" | "slack" | "discord";
  connectionId: string;
  peerId: string;
  threadId?: string;
  peerName?: string;
}

export interface ChatTask extends BaseTask {
  type: "chat";
  pipelineName: string;
  triggerType: "chat" | "api" | "job" | "cron" | "webhook" | "tool" | "delegation";
  messageCount?: number;
}

export type UnifiedTask = BackgroundTask | ChannelTask | ChatTask;

interface TaskStartedEvent {
  eventType: "task:started";
  task: UnifiedTask;
  timestamp: string;
}

export interface TaskProgressEvent {
  eventType: "task:progress";
  runId: string;
  type: TaskType;
  taskId?: string;
  taskName?: string;
  userId: string;
  characterId?: string;
  sessionId?: string;
  assistantMessageId?: string;
  progressText?: string;
  progressPercent?: number;
  progressContent?: unknown[];
  progressContentLimited?: boolean;
  progressContentOriginalTokens?: number;
  progressContentFinalTokens?: number;
  progressContentTruncatedParts?: number;
  /** Indicates progressContent is a transport-safe projection, not canonical chat history. */
  progressContentProjectionOnly?: boolean;
  startedAt?: string;
  timestamp: string;
  /**
   * Solo Story Mode (SPEC §8): mirrored from the registered task so progress
   * events also carry routing metadata. The registry sources these from the
   * task row when possible, so callers do not need to populate them in
   * `details`.
   */
  lobbyId?: string;
  cardId?: string;
}

interface TaskCompletedEvent {
  eventType: "task:completed";
  task: UnifiedTask;
  timestamp: string;
}

export type TaskEvent = TaskStartedEvent | TaskProgressEvent | TaskCompletedEvent;

function isBackgroundTask(task: UnifiedTask): task is BackgroundTask {
  return task.type === "scheduled";
}

function isChannelTask(task: UnifiedTask): task is ChannelTask {
  return task.type === "channel";
}

function isChatTask(task: UnifiedTask): task is ChatTask {
  return task.type === "chat";
}

export function isDelegationTask(task: { type: string; metadata?: unknown }): boolean {
  if (task.type !== "chat") {
    return false;
  }
  const metadata = task.metadata;
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  return (metadata as { isDelegation?: unknown }).isDelegation === true;
}

export function isBackgroundLifecycleTask(task: { type: string; metadata?: unknown }): boolean {
  return task.type === "scheduled" || isDelegationTask(task);
}

export function isTaskSuppressedFromUI(task: UnifiedTask): boolean {
  if (task.type !== "chat") {
    return false;
  }
  const metadata = task.metadata;
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  return Boolean((metadata as { suppressFromUI?: unknown }).suppressFromUI);
}

export interface ListActiveTasksOptions {
  userId?: string;
  characterId?: string;
  type?: TaskType;
  sessionId?: string;
  limit?: number;
}

export interface ActiveTasksResult {
  tasks: UnifiedTask[];
  total: number;
}

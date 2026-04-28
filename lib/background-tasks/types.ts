/**
 * Unified Background Task Type Definitions
 *
 * Uses discriminated unions for type-safe task handling.
 */

export type TaskType = "scheduled" | "channel" | "chat";

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

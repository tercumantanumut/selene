export type ClaudeCodeSubagentStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale";

export type ClaudeCodeSubagentEventType =
  | "snapshot"
  | "subagent-started"
  | "subagent-activity"
  | "subagent-completed"
  | "subagent-failed"
  | "subagent-stale"
  | "stream-unavailable";

export type ClaudeCodeSubagentStreamAvailability = "pending" | "available" | "unavailable";

export interface ClaudeCodeSubagentEvent {
  id: string;
  activityId: string;
  type: ClaudeCodeSubagentEventType;
  status: ClaudeCodeSubagentStatus;
  summary: string;
  toolName?: string;
  taskId?: string;
  parentToolUseId?: string;
  timestamp: number;
}

export interface ClaudeCodeSubagentActivity {
  id: string;
  userId: string;
  sessionId: string;
  runId?: string;
  characterId?: string;
  parentToolUseId: string;
  taskId?: string;
  subagentName: string;
  subagentType?: string;
  description?: string;
  status: ClaudeCodeSubagentStatus;
  latestSummary: string;
  latestToolName?: string;
  streamAvailability: ClaudeCodeSubagentStreamAvailability;
  source: "claude-code-native";
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface ClaudeCodeSubagentSnapshot {
  activities: ClaudeCodeSubagentActivity[];
  eventsByActivityId: Record<string, ClaudeCodeSubagentEvent[]>;
  emittedAt: number;
}

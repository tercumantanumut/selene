/**
 * Delegate to Sub-Agent Tool – Shared Types and In-Memory Registry
 *
 * Contains type definitions, constants, and the in-memory delegation registry
 * that are shared between the tool factory and action handlers.
 */

import type { AgentWorkflowMember } from "@/lib/agents/workflows";

// ---------------------------------------------------------------------------
// Public types (re-exported for external consumers)
// ---------------------------------------------------------------------------

export interface DelegateToSubagentToolOptions {
  sessionId: string;
  userId: string;
  characterId: string;
  /** LLM provider name — determines whether background delegations can use async completion notifications. */
  provider?: string;
}

type DelegateAction = "start" | "observe" | "continue" | "answer" | "stop" | "list";

export interface DelegateToSubagentInput {
  action: DelegateAction;
  agentId?: string;
  agentName?: string;
  task?: string;
  context?: string;
  delegationId?: string;
  followUpMessage?: string;
  toolUseId?: string;
  answers?: Record<string, string>;
  waitSeconds?: number;
  /** Re-read a settled result even when it was already auto-delivered. */
  force?: boolean;
  /** @deprecated Use mode instead. Kept for backwards compatibility. */
  runInBackground?: boolean;
  mode?: "blocking" | "background";
  resume?: string;
}

export interface AvailableSubagent {
  agentId: string;
  agentName: string;
  role: string;
  purpose: string;
}

export interface DelegationInteractivePrompt {
  toolUseId: string;
  questions: unknown;
  createdAt: number;
}

export interface DelegateResult {
  success: boolean;
  error?: string;
  availableAgents?: AvailableSubagent[];
  delegationId?: string;
  sessionId?: string;
  delegateAgent?: string;
  message?: string;
  mode?: "blocking" | "background";
  running?: boolean;
  completed?: boolean;
  /** Compact final response text. Returned in blocking mode instead of lastResponse/allResponses. */
  result?: string;
  messageCount?: number;
  toolCallCount?: number;
  lastResponse?: string;
  allResponses?: string[];
  responseCount?: number;
  responsePreviewCount?: number;
  responsePreviewOmittedCount?: number;
  responsePreviewTruncatedCount?: number;
  /** Incremental steps since last observe — compact tool call descriptions. */
  steps?: Array<{ toolName: string; summary: string }>;
  /** Total new steps since last observe. */
  newStepCount?: number;
  deliveryStatus?: "already_delivered";
  deliveryId?: string;
  resultVersion?: number;
  resultHash?: string;
  deliveredAt?: number;
  elapsed?: number;
  waitedMs?: number;
  waitTimedOut?: boolean;
  pendingInteractivePrompts?: DelegationInteractivePrompt[];
  delegations?: Array<{
    delegationId: string;
    sessionId: string;
    delegateAgentId: string;
    delegateAgent: string;
    task: string;
    running: boolean;
    completed?: boolean;
    elapsed: number;
  }>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface ActiveDelegation {
  id: string;
  /** The sub-agent's chat session ID. */
  sessionId: string;
  /** The initiator's chat session ID — used to scope delegations per session. */
  initiatorSessionId: string;
  /**
   * The root session ID — the original channel/web session that started the
   * delegation chain. Used by the channel bridge to route interactive questions
   * back to the correct channel conversation when the subagent's own session
   * has no channel_conversations mapping.
   */
  rootSessionId: string;
  delegateId: string;
  delegateName: string;
  delegatorId: string;
  workflowId: string;
  task: string;
  startedAt: number;
  settledAt?: number;
  abortController: AbortController;
  streamPromise: Promise<void>;
  settled: boolean;
  executionId: number;
  error?: string;
  /** Watermark for incremental observe — tracks the last orderingIndex seen by the caller. */
  lastObservedOrderingIndex: number;
  /** Monotonic version for the latest settled result; increments on continue(). */
  resultVersion: number;
}

export type SubagentCandidate = {
  member: AgentWorkflowMember;
  agentId: string;
  agentName: string;
  purpose: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_OBSERVE_WAIT_SECONDS = 10 * 60;
export const MAX_OBSERVE_PREVIEW_RESPONSES = 6;
export const MAX_OBSERVE_PREVIEW_CHARS = 1_200;
export const OBSERVE_RESPONSE_TRUNCATION_SUFFIX = "\n\n[Response truncated]";

// ---------------------------------------------------------------------------
// In-memory delegation registry
// Persisted on globalThis to survive Next.js hot reloads.
// ---------------------------------------------------------------------------

export const activeDelegations: Map<string, ActiveDelegation> =
  ((globalThis as Record<string, unknown>).__activeDelegations as Map<string, ActiveDelegation>) ??
  ((globalThis as Record<string, unknown>).__activeDelegations = new Map<string, ActiveDelegation>());

let delegationCounter = 0;

export function nextDelegationId(): string {
  delegationCounter += 1;
  return `del-${Date.now()}-${delegationCounter}`;
}

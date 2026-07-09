/**
 * Delegate to Sub-Agent Tool – Execution Helpers and Subagent Resolution
 *
 * Contains the background execution helper, text extraction utilities,
 * subagent resolution logic, and the delegation accessor.
 *
 * Action handlers (start, observe, continue, stop, list) live in
 * delegate-subagent-action-handlers.ts and are re-exported here for
 * backward compatibility.
 */

import { getCharacterFull } from "@/lib/characters/queries";
import {
  getWorkflowByAgentId,
  getWorkflowMembers,
} from "@/lib/agents/workflows";
import {
  getMessages,
} from "@/lib/db/sqlite-queries";
import { INTERNAL_API_SECRET } from "@/lib/config/internal-api-secret";
import { getInternalApiBaseUrl } from "@/lib/utils/environment";
import {
  activeDelegations,
  nextDelegationId,
  MAX_OBSERVE_WAIT_SECONDS,
  MAX_OBSERVE_PREVIEW_RESPONSES,
  MAX_OBSERVE_PREVIEW_CHARS,
  OBSERVE_RESPONSE_TRUNCATION_SUFFIX,
  type ActiveDelegation,
  type DelegateToSubagentInput,
  type DelegateResult,
  type DelegationStatus,
  type DelegationTerminalStatus,
  type SubagentCandidate,
  type AvailableSubagent,
} from "./delegate-to-subagent-types";
import { appendToLivePromptQueueBySession } from "@/lib/background-tasks/live-prompt-queue-registry";
import { addDelegationCompletion } from "./delegation-completion-store";
import {
  buildDelegationDeliveryMetadata,
} from "./delegation-delivery-registry";
import { emitDelegationCompleted } from "@/lib/background-tasks/delegation-completion-signal";

// ---------------------------------------------------------------------------
// Read-only accessor for external consumers (API routes, system prompt)
// ---------------------------------------------------------------------------

/**
 * Return delegations for a character, including settled ones until TTL cleanup.
 * When `initiatorSessionId` is provided, only delegations created in that
 * session are returned — this prevents cross-session leakage.
 */
const DELEGATION_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isDelegationExpired(delegation: ActiveDelegation, now = Date.now()): boolean {
  const referenceTime = delegation.settledAt ?? delegation.startedAt;
  return now - referenceTime > DELEGATION_STALE_TTL_MS;
}

export function getDelegationStatus(delegation: ActiveDelegation): DelegationStatus {
  if (!delegation.settled) return "running";
  return delegation.terminalStatus ?? (delegation.error ? "failed" : "completed");
}

export function markDelegationSettled(
  delegation: ActiveDelegation,
  status: DelegationTerminalStatus,
  settledAt = Date.now(),
): void {
  delegation.settled = true;
  delegation.settledAt = settledAt;
  delegation.terminalStatus = status;
}

export function isDelegationCompleted(delegation: ActiveDelegation): boolean {
  return getDelegationStatus(delegation) === "completed";
}

function toDelegationSummary(
  delegationId: string,
  delegation: ActiveDelegation,
  now = Date.now(),
): NonNullable<DelegateResult["delegations"]>[number] {
  const status = getDelegationStatus(delegation);
  return {
    delegationId,
    sessionId: delegation.sessionId,
    delegateAgentId: delegation.delegateId,
    delegateAgent: delegation.delegateName,
    task: delegation.task.length > 100 ? delegation.task.slice(0, 100) + "..." : delegation.task,
    running: status === "running",
    completed: status === "completed",
    status,
    elapsed: now - delegation.startedAt,
  };
}

export function getActiveDelegationsForCharacter(
  characterId: string,
  initiatorSessionId?: string,
): Array<{
  delegationId: string;
  sessionId: string;
  delegateAgentId: string;
  delegateAgent: string;
  task: string;
  running: boolean;
  completed?: boolean;
  status?: DelegationStatus;
  elapsed: number;
}> {
  const results: Array<{
    delegationId: string;
    sessionId: string;
    delegateAgentId: string;
    delegateAgent: string;
    task: string;
    running: boolean;
    completed?: boolean;
    status?: DelegationStatus;
    elapsed: number;
  }> = [];

  const staleIds: string[] = [];
  const now = Date.now();
  for (const [id, del] of activeDelegations.entries()) {
    if (del.delegatorId !== characterId) continue;
    if (initiatorSessionId && del.initiatorSessionId !== initiatorSessionId) continue;
    if (isDelegationExpired(del, now)) {
      staleIds.push(id);
      continue;
    }

    results.push(toDelegationSummary(id, del, now));
  }
  for (const id of staleIds) {
    activeDelegations.delete(id);
  }
  return results;
}

/** Build compact delegations array for inclusion in all tool responses. */
export function buildDelegationsSummary(
  characterId: string,
  initiatorSessionId?: string,
): DelegateResult["delegations"] {
  return getActiveDelegationsForCharacter(characterId, initiatorSessionId);
}

// ---------------------------------------------------------------------------
// Background execution helper (mirrors lib/scheduler/task-queue.ts:539-624)
// ---------------------------------------------------------------------------

function getChatApiBaseUrl(): string {
  return getInternalApiBaseUrl();
}

async function executeDelegation(
  delegationId: string,
  sessionId: string,
  characterId: string,
  userMessage: string,
  abortController: AbortController,
): Promise<void> {
  const baseUrl = getChatApiBaseUrl();

  console.log(`[Delegation] ${delegationId} starting fetch to /api/chat`);

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": sessionId,
      "X-Character-Id": characterId,
      "X-Internal-Auth": INTERNAL_API_SECRET,
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: userMessage }],
      sessionId,
    }),
    signal: abortController.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "").then(t => t.slice(0, 500));
    throw new Error(
      `Chat API returned ${response.status}: ${errorText}`,
    );
  }

  // Consume the stream to completion
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  }

  console.log(`[Delegation] ${delegationId} stream ended, waiting for DB persistence`);

  // Wait for onFinish to persist the assistant message to DB.
  // The AI SDK's onFinish callback is async — the stream closes before it
  // completes its DB writes. Poll until the assistant message appears.
  for (let attempt = 0; attempt < 20; attempt++) {
    const msgs = await getMessages(sessionId);
    if (msgs.some((m) => m.role === "assistant")) {
      console.log(`[Delegation] ${delegationId} assistant message persisted`);
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  console.warn(`[Delegation] ${delegationId} WARNING: assistant message not found after polling`);
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

export function extractTextFromContent(content: unknown): string | undefined {
  if (!content) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter(
        (p: Record<string, unknown>) =>
          p.type === "text" && typeof p.text === "string",
      )
      .map((p: Record<string, unknown>) => p.text as string);
    return textParts.length > 0 ? textParts.join("\n") : undefined;
  }
  return undefined;
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeCompatibilityInput(input: DelegateToSubagentInput): DelegateToSubagentInput {
  return input;
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateObserveWaitSeconds(waitSeconds?: number): { waitMs: number; error?: string } {
  if (waitSeconds === undefined) {
    return { waitMs: 0 };
  }

  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    return {
      waitMs: 0,
      error: "'waitSeconds' must be a non-negative number.",
    };
  }

  if (waitSeconds > MAX_OBSERVE_WAIT_SECONDS) {
    return {
      waitMs: 0,
      error: `'waitSeconds' cannot exceed ${MAX_OBSERVE_WAIT_SECONDS} (10 minutes).`,
    };
  }

  return { waitMs: waitSeconds * 1000 };
}

export function truncateObservePreview(response: string): { text: string; truncated: boolean } {
  if (response.length <= MAX_OBSERVE_PREVIEW_CHARS) {
    return { text: response, truncated: false };
  }
  return {
    text: response.slice(0, MAX_OBSERVE_PREVIEW_CHARS) + OBSERVE_RESPONSE_TRUNCATION_SUFFIX,
    truncated: true,
  };
}

export async function buildSubagentCandidates(
  members: import("@/lib/agents/workflows").AgentWorkflowMember[],
  currentAgentId: string,
): Promise<SubagentCandidate[]> {
  const subagentMembers = members.filter(
    (member) => member.role === "subagent" && member.agentId !== currentAgentId,
  );

  const candidates = await Promise.all(
    subagentMembers.map(async (member): Promise<SubagentCandidate> => {
      const character = await getCharacterFull(member.agentId);
      const charRecord = character as
        | {
            name?: string;
            displayName?: string;
            tagline?: string;
            description?: string;
          }
        | null;

      const agentName =
        (typeof charRecord?.displayName === "string" && charRecord.displayName.trim()) ||
        (typeof charRecord?.name === "string" && charRecord.name.trim()) ||
        member.agentId;

      const purpose =
        member.metadataSeed?.purpose ||
        (typeof charRecord?.tagline === "string" && charRecord.tagline.trim()) ||
        (typeof charRecord?.description === "string" && charRecord.description.trim()) ||
        "No purpose set";

      return {
        member,
        agentId: member.agentId,
        agentName,
        purpose,
      };
    }),
  );

  return candidates.sort((a, b) => a.agentName.localeCompare(b.agentName));
}

export function toAvailableAgents(candidates: SubagentCandidate[]): AvailableSubagent[] {
  return candidates.map((candidate) => ({
    agentId: candidate.agentId,
    agentName: candidate.agentName,
    role: candidate.member.role,
    purpose: candidate.purpose,
  }));
}

export function resolveSubagentCandidate(
  candidates: SubagentCandidate[],
  selection: { agentId?: string; agentName?: string },
): { candidate?: SubagentCandidate; error?: string } {
  const { agentId, agentName } = selection;

  if (agentId) {
    const byId = candidates.find((candidate) => candidate.agentId === agentId);
    if (!byId) {
      return { error: `No workflow sub-agent found with id "${agentId}".` };
    }

    if (agentName) {
      const normalizedRequested = normalizeLookup(agentName);
      const normalizedActual = normalizeLookup(byId.agentName);
      if (normalizedRequested !== normalizedActual) {
        return {
          error:
            `agentId "${agentId}" resolved to "${byId.agentName}", but agentName "${agentName}" does not match. ` +
            "Use either agentId alone or provide a matching agentName.",
        };
      }
    }

    return { candidate: byId };
  }

  if (!agentName) {
    return { error: "Provide either agentId or agentName for action=start." };
  }

  const normalizedName = normalizeLookup(agentName);
  const exactMatches = candidates.filter(
    (candidate) => normalizeLookup(candidate.agentName) === normalizedName,
  );

  if (exactMatches.length === 1) {
    return { candidate: exactMatches[0] };
  }
  if (exactMatches.length > 1) {
    return {
      error:
        `agentName "${agentName}" is ambiguous (${exactMatches.length} exact matches). ` +
        "Use agentId to target a specific sub-agent.",
    };
  }

  const partialMatches = candidates.filter((candidate) =>
    normalizeLookup(candidate.agentName).includes(normalizedName),
  );
  if (partialMatches.length === 1) {
    return { candidate: partialMatches[0] };
  }
  if (partialMatches.length > 1) {
    return {
      error:
        `agentName "${agentName}" matches multiple sub-agents (${partialMatches.length} partial matches). ` +
        "Use agentId to disambiguate.",
    };
  }

  return { error: `No workflow sub-agent found with name "${agentName}".` };
}

// ---------------------------------------------------------------------------
// Final response extractor (compact, for blocking mode)
// ---------------------------------------------------------------------------

/**
 * Read the sub-agent's final assistant response from DB.
 * Returns only the last assistant text — no intermediate previews or metadata.
 */
async function extractFinalResponse(sessionId: string): Promise<string | undefined> {
  const messages = await getMessages(sessionId);
  if (!Array.isArray(messages)) return undefined;

  const assistantMessages = messages.filter(
    (message) =>
      !!message && typeof message === "object" && "role" in message && (message as { role?: string }).role === "assistant",
  );
  if (assistantMessages.length === 0) return undefined;

  const last = assistantMessages[assistantMessages.length - 1];
  return extractTextFromContent(last.content);
}

// ---------------------------------------------------------------------------
// Background execution starter
// ---------------------------------------------------------------------------

/**
 * Notify the initiator session that a delegation completed, including the
 * actual subagent result so the model can react without calling observe().
 */
async function notifyInitiatorSessionOfCompletion(delegation: ActiveDelegation): Promise<void> {
  // Fetch the actual final response from the subagent's session only for normal
  // successful completion. Explicit stops should report a stopped terminal state,
  // not masquerade as a successful completed result with whatever partial output
  // happened to be present.
  let resultContent: string;
  let shouldAppendObserveReminder = false;
  let terminalStatus = getDelegationStatus(delegation);

  if (terminalStatus === "stopped") {
    resultContent = "Delegation was stopped by the initiator.";
  } else if (delegation.error) {
    terminalStatus = "failed";
    delegation.terminalStatus = "failed";
    resultContent = `<error>${delegation.error}</error>`;
  } else {
    try {
      const finalResponse = await extractFinalResponse(delegation.sessionId);
      if (finalResponse?.trim()) {
        resultContent = finalResponse;
        shouldAppendObserveReminder = true;
      } else {
        resultContent = "No response captured. Observe the session first, send continue preferably.";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Delegation] Failed to read final response for ${delegation.id}:`, error);
      delegation.error = delegation.error ?? `Failed to read subagent response: ${message}`;
      markDelegationSettled(delegation, "failed", delegation.settledAt ?? Date.now());
      terminalStatus = "failed";
      resultContent = `<error>${delegation.error}</error>`;
    }
  }

  const completionStatus: DelegationTerminalStatus =
    terminalStatus === "running" ? "completed" : terminalStatus;

  const elapsed = delegation.settledAt
    ? delegation.settledAt - delegation.startedAt
    : Date.now() - delegation.startedAt;

  const completionMessageParts = [
    `<delegation-result delegationId="${delegation.id}" delegate="${delegation.delegateName}" status="${completionStatus}" elapsed="${elapsed}ms" resultVersion="${delegation.resultVersion}">`,
    resultContent,
    `</delegation-result>`,
  ];

  if (shouldAppendObserveReminder) {
    completionMessageParts.push(
      `Note: You have the sub agent result in your context window, avoid using observe action to see full results again unless necessary.`,
    );
  }

  const completionMessage = completionMessageParts.join("\n");

  const deliveryMetadata = buildDelegationDeliveryMetadata({
    delegationId: delegation.id,
    resultVersion: delegation.resultVersion,
    resultContent: completionMessage,
    deliveredAt: delegation.settledAt ?? Date.now(),
  });

  const queued = appendToLivePromptQueueBySession(delegation.initiatorSessionId, {
    id: deliveryMetadata.deliveryId,
    content: completionMessage,
    stopIntent: false,
    metadata: {
      kind: "delegation_completion",
      delegationId: delegation.id,
      delegateName: delegation.delegateName,
      status: completionStatus,
      resultVersion: deliveryMetadata.resultVersion,
      deliveryId: deliveryMetadata.deliveryId,
      resultHash: deliveryMetadata.resultHash,
    },
  });

  if (queued) {
    return;
  }

  // Live prompt queue not active (run ended). Store the result in the
  // persistent completion store so the next turn's prepareStep can inject it.
  addDelegationCompletion({
    delegationId: delegation.id,
    delegateName: delegation.delegateName,
    sessionId: delegation.sessionId,
    initiatorSessionId: delegation.initiatorSessionId,
    characterId: delegation.delegatorId,
    completedAt: delegation.settledAt ?? Date.now(),
    status: completionStatus,
    error: delegation.error,
    resultContent: completionMessage,
    resultVersion: deliveryMetadata.resultVersion,
    deliveryId: deliveryMetadata.deliveryId,
    resultHash: deliveryMetadata.resultHash,
    deliveredAt: deliveryMetadata.deliveredAt,
  });

  // Signal the SSE endpoint so the frontend can auto-resume the conversation.
  emitDelegationCompleted(delegation.initiatorSessionId);
}

export function startBackgroundExecution(
  delegation: ActiveDelegation,
  userMessage: string,
): void {
  const abortController = new AbortController();
  const executionId = delegation.executionId + 1;

  delegation.abortController = abortController;
  delegation.executionId = executionId;
  delegation.settled = false;
  delegation.settledAt = undefined;
  delegation.terminalStatus = undefined;
  delegation.stopRequestedAt = undefined;
  delegation.error = undefined;

  const streamPromise = executeDelegation(
    delegation.id,
    delegation.sessionId,
    delegation.delegateId,
    userMessage,
    abortController,
  )
    .then(async () => {
      if (delegation.executionId !== executionId) return;
      markDelegationSettled(
        delegation,
        delegation.stopRequestedAt ? "stopped" : "completed",
      );
      await notifyInitiatorSessionOfCompletion(delegation);
    })
    .catch(async (err) => {
      if (delegation.executionId !== executionId) return;

      const isAbortError =
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError");

      if (isAbortError) {
        markDelegationSettled(
          delegation,
          delegation.stopRequestedAt ? "stopped" : "completed",
        );
        await notifyInitiatorSessionOfCompletion(delegation);
        return;
      }

      delegation.error = err instanceof Error ? err.message : String(err);
      markDelegationSettled(delegation, "failed");
      console.error(`[Delegation] ${delegation.id} failed:`, delegation.error);
      await notifyInitiatorSessionOfCompletion(delegation);
    });

  delegation.streamPromise = streamPromise;
}


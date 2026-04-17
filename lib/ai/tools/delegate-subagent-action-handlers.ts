/**
 * Delegate to Sub-Agent Tool – Action Handlers
 *
 * Contains the five action handlers (start, observe, continue, stop, list)
 * that implement the public delegation API.  Execution helpers, text
 * utilities, and subagent resolution logic live in
 * delegate-to-subagent-handlers.ts.
 */

import {
  getWorkflowByAgentId,
  getWorkflowMembers,
} from "@/lib/agents/workflows";
import { createSession, getObserveMessageSummary, getObserveStepsSince } from "@/lib/db/sqlite-queries";
import {
  activeDelegations,
  nextDelegationId,
  MAX_OBSERVE_WAIT_SECONDS,
  MAX_OBSERVE_PREVIEW_RESPONSES,
  MAX_OBSERVE_PREVIEW_CHARS,
  type ActiveDelegation,
  type DelegateToSubagentInput,
  type DelegateResult,
  type DelegationInteractivePrompt,
} from "./delegate-to-subagent-types";
import {
  buildDelegationsSummary,
  startBackgroundExecution,
  extractTextFromContent,
  sleepMs,
  validateObserveWaitSeconds,
  truncateObservePreview,
  buildSubagentCandidates,
  toAvailableAgents,
  resolveSubagentCandidate,
} from "./delegate-to-subagent-handlers";
import { getCharacterFull } from "@/lib/characters/queries";
import {
  appendToLivePromptQueueBySession,
  removeFromQueueByDelegationId,
} from "@/lib/background-tasks/live-prompt-queue-registry";
import { removeDelegationCompletionById } from "./delegation-completion-store";
import {
  hasStopIntent,
  sanitizeLivePromptContent,
} from "@/lib/background-tasks/live-prompt-helpers";
import {
  getPendingInteractivePrompts,
  resolveInteractiveWait,
} from "@/lib/interactive-tool-bridge";
import {
  listAgentRunsBySession,
  markRunAsCancelled,
} from "@/lib/observability/queries";
import {
  abortChatRun,
  removeChatAbortController,
} from "@/lib/background-tasks/chat-abort-registry";
import { taskRegistry } from "@/lib/background-tasks/registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk the active delegation chain to find the root session ID.
 * In a multi-hop delegation (A → B → C), B's initiatorSessionId is A's session,
 * and A might itself be a delegation from a channel session. This function
 * traces back to the original session that has no parent delegation.
 *
 * WARNING: This function relies on intermediate delegations still being present
 * in the `activeDelegations` in-memory map. If a delegation has been GC'd
 * (e.g. via stop/cleanup), the chain walk will terminate early — returning the
 * first session whose parent delegation is missing, not necessarily the true
 * root. Currently safe because this is only called at delegation start time
 * (before any cleanup). Future callers should be aware of this limitation.
 */
function resolveRootSessionId(initiatorSessionId: string): string {
  let currentSessionId = initiatorSessionId;
  const visited = new Set<string>();

  while (true) {
    if (visited.has(currentSessionId)) break; // cycle guard
    visited.add(currentSessionId);

    // Find any delegation whose subagent session matches currentSessionId
    let parentFound = false;
    for (const d of activeDelegations.values()) {
      if (d.sessionId === currentSessionId) {
        currentSessionId = d.initiatorSessionId;
        parentFound = true;
        break;
      }
    }
    if (!parentFound) break;
  }

  return currentSessionId;
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------


function getDelegationPendingInteractivePrompts(
  sessionId: string,
): DelegationInteractivePrompt[] {
  return getPendingInteractivePrompts(sessionId).map(({ toolUseId, questions, createdAt }) => ({
    toolUseId,
    questions,
    createdAt,
  }));
}

async function waitForDelegationPausePoint(
  delegation: ActiveDelegation,
  waitMs: number,
): Promise<DelegationInteractivePrompt[]> {
  const deadline = Date.now() + waitMs;

  while (true) {
    const pendingInteractivePrompts = getDelegationPendingInteractivePrompts(delegation.sessionId);
    if (pendingInteractivePrompts.length > 0 || delegation.settled) {
      return pendingInteractivePrompts;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return pendingInteractivePrompts;
    }

    await sleepMs(Math.min(200, remainingMs));
  }
}

async function cancelDelegationSessionRun(sessionId: string): Promise<void> {
  const runs = await listAgentRunsBySession(sessionId);
  const activeRun = runs.find((run) => run.status === "running");
  if (!activeRun) {
    return;
  }

  const registryTask = taskRegistry.get(activeRun.id);
  const registryDurationMs = registryTask
    ? Date.now() - new Date(registryTask.startedAt).getTime()
    : undefined;

  abortChatRun(activeRun.id, "user_cancelled");
  await markRunAsCancelled(activeRun.id, "user_cancelled");
  taskRegistry.updateStatus(activeRun.id, "cancelled", {
    durationMs: registryDurationMs,
  });
  removeChatAbortController(activeRun.id);
}

export async function handleStartAction(
  input: DelegateToSubagentInput,
  userId: string,
  characterId: string,
  initiatorSessionId: string,
  provider?: string,
): Promise<DelegateResult> {
  // Compatibility mode: resume + start maps to continue with task as follow-up.
  if (input.resume) {
    if (!input.task) {
      return {
        success: false,
        error: "'task' is required when using 'resume' with action='start'.",
        delegations: buildDelegationsSummary(characterId, initiatorSessionId),
      };
    }

    return handleContinue(
      {
        action: "continue",
        delegationId: input.resume,
        followUpMessage: input.task,
      },
      characterId,
      initiatorSessionId,
    );
  }

  const startResult = await handleStart(input, userId, characterId, initiatorSessionId);

  if (!startResult.success || !startResult.delegationId) {
    return startResult;
  }

  // ── Always return immediately (background/non-blocking) ──────────────────
  // Delegations run concurrently. The AI SDK's shouldStopTurn keeps the
  // initiator's agentic loop alive while any delegations are running, so the
  // model can call observe() to collect results once sub-agents settle.
  //
  // Previous "blocking" mode awaited completion inside the tool execute()
  // function, which serialized parallel delegations when the model emitted
  // start calls across multiple steps instead of batching them in one response.
  return {
    ...startResult,
    mode: "background",
    message:
      `Delegation started in background (${startResult.delegationId}). ` +
      "Use observe/continue/stop with this delegationId to manage it.",
  };
}

async function handleStart(
  input: DelegateToSubagentInput,
  userId: string,
  characterId: string,
  initiatorSessionId: string,
): Promise<DelegateResult> {
  const { agentId, agentName, task, context: extraContext } = input;

  if (!task) {
    return {
      success: false,
      error: "'task' is required for the 'start' action.",
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  // 1. Verify calling agent is an initiator in a workflow
  const membership = await getWorkflowByAgentId(characterId);
  if (!membership) {
    return {
      success: false,
      error:
        "You are not part of a workflow. Delegation requires an active workflow with sub-agents.",
    };
  }
  if (membership.member.role !== "initiator") {
    return {
      success: false,
      error: "Only the workflow initiator can delegate tasks to sub-agents.",
    };
  }

  // 2. Resolve sub-agent selection by ID or Name
  const members = await getWorkflowMembers(membership.workflow.id);
  const candidates = await buildSubagentCandidates(members, characterId);
  const availableAgents = toAvailableAgents(candidates);

  if (candidates.length === 0) {
    return {
      success: false,
      error: "No sub-agents are available in this workflow.",
      availableAgents,
    };
  }

  const resolution = resolveSubagentCandidate(candidates, { agentId, agentName });
  if (!resolution.candidate) {
    return {
      success: false,
      error: resolution.error,
      availableAgents,
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  // 3. Prevent self-delegation (defensive)
  if (resolution.candidate.agentId === characterId) {
    return {
      success: false,
      error: "Cannot delegate to yourself. Choose a different sub-agent from the workflow.",
      availableAgents,
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  // 4. Load the sub-agent character
  const subAgent = await getCharacterFull(resolution.candidate.agentId);
  if (!subAgent) {
    return {
      success: false,
      error: `Sub-agent ${resolution.candidate.agentId} not found.`,
      availableAgents,
    };
  }

  // 5. Create a real session for the sub-agent
  // NOTE: characterId MUST be in metadata — createSession's extractSessionMetadataColumns
  // promotes metadata.characterId to the DB column. Passing it only as a top-level field
  // gets overridden to null by the metadata extraction spread.
  // Resolve root session ID early so we can embed it in session metadata
  const rootSessionId = resolveRootSessionId(initiatorSessionId);

  const session = await createSession({
    title: `Delegation: ${task.slice(0, 50)}`,
    userId,
    metadata: {
      isDelegation: true,
      parentAgentId: characterId,
      workflowId: membership.workflow.id,
      characterId: resolution.candidate.agentId,
      characterName: resolution.candidate.agentName,
      delegationTask: task,
      rootSessionId,
    },
  });

  // 6. Build the user message
  const userMessage = extraContext
    ? `${task}\n\nAdditional context:\n${extraContext}`
    : task;

  // 7. Fire-and-forget: call internal chat API
  // The chat API handles user message persistence, agent run creation,
  // task registry, SSE events, and green dot indicators automatically.
  const delegationId = nextDelegationId();

  const delegation: ActiveDelegation = {
    id: delegationId,
    sessionId: session.id,
    initiatorSessionId,
    rootSessionId,
    delegateId: resolution.candidate.agentId,
    delegateName: resolution.candidate.agentName,
    delegatorId: characterId,
    workflowId: membership.workflow.id,
    task,
    startedAt: Date.now(),
    abortController: new AbortController(),
    streamPromise: Promise.resolve(),
    settled: false,
    executionId: 0,
    lastObservedOrderingIndex: 0,
  };

  startBackgroundExecution(delegation, userMessage);
  activeDelegations.set(delegationId, delegation);

  return {
    success: true,
    delegationId,
    sessionId: session.id,
    delegateAgent: delegation.delegateName,
    message: `Delegation ${delegationId} created for sub-agent "${delegation.delegateName}".`,
    availableAgents,
    delegations: buildDelegationsSummary(characterId, initiatorSessionId),
  };
}

export async function handleObserve(
  input: DelegateToSubagentInput,
  characterId: string,
  initiatorSessionId: string,
): Promise<DelegateResult> {
  const { delegationId, waitSeconds } = input;
  if (!delegationId) {
    return {
      success: false,
      error: "'delegationId' is required for the 'observe' action.",
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  const waitValidation = validateObserveWaitSeconds(waitSeconds);
  if (waitValidation.error) {
    return {
      success: false,
      error: waitValidation.error,
    };
  }

  const delegation = activeDelegations.get(delegationId);
  if (!delegation || delegation.initiatorSessionId !== initiatorSessionId) {
    return {
      success: false,
      error: `Delegation ${delegationId} not found. It may have already completed and been cleaned up.`,
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  const observeStart = Date.now();

  const pendingInteractivePrompts = !delegation.settled && waitValidation.waitMs > 0
    ? await waitForDelegationPausePoint(delegation, waitValidation.waitMs)
    : getDelegationPendingInteractivePrompts(delegation.sessionId);

  // If delegation failed, return the error immediately
  if (delegation.error) {
    const waitedMs = Date.now() - observeStart;
    return {
      success: false,
      delegationId,
      sessionId: delegation.sessionId,
      delegateAgent: delegation.delegateName,
      error: `Delegation failed: ${delegation.error}`,
      running: false,
      completed: true,
      elapsed: Date.now() - delegation.startedAt,
      waitedMs,
      waitTimedOut: waitValidation.waitMs > 0 && !delegation.settled,
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  // Query bounded DB summary data instead of loading the full session history.
  const [observeSummary, stepsSince] = await Promise.all([
    getObserveMessageSummary(
      delegation.sessionId,
      MAX_OBSERVE_PREVIEW_RESPONSES + 1,
    ),
    getObserveStepsSince(
      delegation.sessionId,
      delegation.lastObservedOrderingIndex,
    ),
  ]);

  // Advance the watermark so the next observe() only returns new steps.
  if (stepsSince.maxOrderingIndex > delegation.lastObservedOrderingIndex) {
    delegation.lastObservedOrderingIndex = stepsSince.maxOrderingIndex;
  }

  // Return the final response in full via `lastResponse` and keep `allResponses`
  // as a bounded preview list of prior assistant turns to avoid context blowups.
  const assistantResponses = observeSummary.recentAssistantMessages
    .map((message) => extractTextFromContent(message.content))
    .filter((text): text is string => !!text);
  const lastResponse = assistantResponses[assistantResponses.length - 1];
  const priorResponses = assistantResponses.slice(0, -1);
  let responsePreviewTruncatedCount = 0;
  const allResponses = priorResponses.map((response) => {
    const preview = truncateObservePreview(response);
    if (preview.truncated) {
      responsePreviewTruncatedCount += 1;
    }
    return preview.text;
  });
  const responsePreviewOmittedCount = Math.max(
    0,
    (observeSummary.assistantMessageCount - 1) - allResponses.length,
  );

  const isRunning = !delegation.settled;
  const waitedMs = Date.now() - observeStart;

  // ── Prevent duplicate delivery ───────────────────────────────────────────
  // When observe returns a completed result, the caller already has the full
  // delegation output. Remove any queued completion notifications from both
  // the live prompt queue (would be injected as user message in prepareStep)
  // and the delegation completion store (would appear in system prompt).
  // Without this, the model sees the result AND a "use observe to read results"
  // notification, causing it to re-observe or generate a duplicate response.
  if (delegation.settled) {
    removeFromQueueByDelegationId(initiatorSessionId, delegationId);
    removeDelegationCompletionById(initiatorSessionId, delegationId);
  }

  return {
    success: true,
    delegationId,
    sessionId: delegation.sessionId,
    delegateAgent: delegation.delegateName,
    running: isRunning,
    completed: delegation.settled,
    elapsed: Date.now() - delegation.startedAt,
    waitedMs,
    waitTimedOut: waitValidation.waitMs > 0 && isRunning,
    messageCount: observeSummary.messageCount,
    toolCallCount: observeSummary.toolMessageCount,
    lastResponse,
    allResponses,
    responseCount: observeSummary.assistantMessageCount,
    responsePreviewCount: allResponses.length,
    responsePreviewOmittedCount,
    responsePreviewTruncatedCount,
    ...(stepsSince.steps.length > 0
      ? {
          steps: stepsSince.steps.map(({ toolName, summary }) => ({ toolName, summary })),
          newStepCount: stepsSince.steps.length,
        }
      : {}),
    ...(pendingInteractivePrompts.length > 0 ? { pendingInteractivePrompts } : {}),
    ...(pendingInteractivePrompts.length > 0
      ? {
          message:
            "Sub-agent is waiting for an interactive answer. " +
            "Use delegateToSubagent action='answer' with the delegationId, toolUseId, and answers to continue.",
        }
      : {}),
    delegations: buildDelegationsSummary(characterId, initiatorSessionId),
  };
}

export async function handleAnswer(
  input: DelegateToSubagentInput,
  characterId: string,
  initiatorSessionId: string,
): Promise<DelegateResult> {
  const { delegationId, toolUseId, answers } = input;

  if (!delegationId) {
    return {
      success: false,
      error: "'delegationId' is required for the 'answer' action.",
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  if (!toolUseId) {
    return {
      success: false,
      error: "'toolUseId' is required for the 'answer' action.",
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  if (
    !answers ||
    typeof answers !== "object" ||
    Array.isArray(answers) ||
    !Object.values(answers).every((value) => typeof value === "string")
  ) {
    return {
      success: false,
      error: "'answers' must be a Record<string, string> for the 'answer' action.",
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  const delegation = activeDelegations.get(delegationId);
  if (!delegation || delegation.initiatorSessionId !== initiatorSessionId) {
    return {
      success: false,
      error: `Delegation ${delegationId} not found. It may have already completed and been cleaned up.`,
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  const resolved = resolveInteractiveWait(delegation.sessionId, toolUseId, answers);
  if (!resolved) {
    const pendingInteractivePrompts = getDelegationPendingInteractivePrompts(delegation.sessionId);
    return {
      success: false,
      delegationId,
      sessionId: delegation.sessionId,
      delegateAgent: delegation.delegateName,
      error:
        `No pending interactive prompt found for toolUseId "${toolUseId}" in delegation ${delegationId}.`,
      ...(pendingInteractivePrompts.length > 0 ? { pendingInteractivePrompts } : {}),
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  return {
    success: true,
    delegationId,
    sessionId: delegation.sessionId,
    delegateAgent: delegation.delegateName,
    message:
      "Interactive answer forwarded to the sub-agent. " +
      "Use 'observe' to check progress and any follow-up prompts.",
    delegations: buildDelegationsSummary(characterId, initiatorSessionId),
  };
}

export async function handleContinue(
  input: DelegateToSubagentInput,
  characterId: string,
  initiatorSessionId: string,
): Promise<DelegateResult> {
  const { delegationId, followUpMessage } = input;

  if (!delegationId) {
    return {
      success: false,
      error: "'delegationId' is required for the 'continue' action.",
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }
  if (!followUpMessage) {
    return {
      success: false,
      error: "'followUpMessage' is required for the 'continue' action.",
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  const sanitizedFollowUpMessage = sanitizeLivePromptContent(followUpMessage);
  if (!sanitizedFollowUpMessage) {
    return {
      success: false,
      error: "'followUpMessage' cannot be empty after sanitization.",
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  const delegation = activeDelegations.get(delegationId);
  if (!delegation || delegation.initiatorSessionId !== initiatorSessionId) {
    return {
      success: false,
      error: `Delegation ${delegationId} not found. It may have already completed and been cleaned up.`,
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  // If previous stream is still running, enqueue a live prompt injection so the
  // active sub-agent stream continues uninterrupted.
  if (!delegation.settled) {
    const queued = appendToLivePromptQueueBySession(delegation.sessionId, {
      id: `deleg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content: sanitizedFollowUpMessage,
      stopIntent: hasStopIntent(sanitizedFollowUpMessage),
    });

    if (queued) {
      return {
        success: true,
        delegationId,
        sessionId: delegation.sessionId,
        delegateAgent: delegation.delegateName,
        message:
          "Follow-up message queued for live injection. The active sub-agent stream continues without interruption. " +
          "Use 'observe' to check progress and response updates.",
        delegations: buildDelegationsSummary(characterId, initiatorSessionId),
      };
    }
  }

  // No active stream to inject into (or queue unavailable): start a new run.
  // The chat route handles message persistence automatically.
  startBackgroundExecution(delegation, sanitizedFollowUpMessage);

  return {
    success: true,
    delegationId,
    sessionId: delegation.sessionId,
    delegateAgent: delegation.delegateName,
    message:
      "Follow-up message sent. The sub-agent is processing your message. " +
      "Use 'observe' to check the response, and set observe.waitSeconds to avoid tight polling loops.",
    delegations: buildDelegationsSummary(characterId, initiatorSessionId),
  };
}

export async function handleStop(
  input: DelegateToSubagentInput,
  characterId: string,
  initiatorSessionId: string,
): Promise<DelegateResult> {
  const { delegationId } = input;
  if (!delegationId) {
    return {
      success: false,
      error: "'delegationId' is required for the 'stop' action.",
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  const delegation = activeDelegations.get(delegationId);
  if (!delegation || delegation.initiatorSessionId !== initiatorSessionId) {
    return {
      success: false,
      error: `Delegation ${delegationId} not found. It may have already completed.`,
      delegations: buildDelegationsSummary(characterId, initiatorSessionId),
    };
  }

  // Stop both the delegation wrapper and the underlying chat run so UI state clears.
  delegation.abortController.abort();
  await cancelDelegationSessionRun(delegation.sessionId);
  delegation.settled = true;
  activeDelegations.delete(delegationId);

  return {
    success: true,
    delegationId,
    message: `Delegation ${delegationId} stopped and cancelled.`,
    delegations: buildDelegationsSummary(characterId, initiatorSessionId),
  };
}

export async function handleList(
  characterId: string,
  initiatorSessionId: string,
): Promise<DelegateResult> {
  const membership = await getWorkflowByAgentId(characterId);
  if (!membership) {
    return {
      success: false,
      error:
        "You are not part of a workflow. Delegation requires an active workflow with sub-agents.",
      availableAgents: [],
      delegations: [],
    };
  }

  if (membership.member.role !== "initiator") {
    return {
      success: false,
      error: "Only the workflow initiator can delegate tasks to sub-agents.",
      availableAgents: [],
      delegations: [],
    };
  }

  const members = await getWorkflowMembers(membership.workflow.id);
  const candidates = await buildSubagentCandidates(members, characterId);
  const availableAgents = toAvailableAgents(candidates);

  const results = buildDelegationsSummary(characterId, initiatorSessionId) ?? [];

  return {
    success: true,
    availableAgents,
    delegations: results,
    message:
      results.length === 0
        ? `No delegations found. ${availableAgents.length} available sub-agent(s) listed.`
        : `${results.length} delegation(s) found. ${availableAgents.length} available sub-agent(s) listed.`,
  };
}

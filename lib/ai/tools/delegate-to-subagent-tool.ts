/**
 * Delegate to Sub-Agent Tool (Session-Based Async)
 *
 * Creates real persisted chat sessions for sub-agents, calls the internal
 * chat API (same pattern as lib/scheduler/task-queue.ts), tracks via agent
 * runs, and is visible in the UI with active session indicators + full
 * chat history.
 *
 * Actions:
 *   start    – create session, fire-and-forget chat API call, return immediately
 *   observe  – query DB for real message count, tool calls, last response content
 *   continue – send a follow-up message to an existing delegation session
 *   answer   – forward an interactive answer to a waiting sub-agent
 *   stop     – abort the running delegation
 *   list     – list active delegations + available sub-agents for the calling agent
 */

import { tool, jsonSchema } from "ai";

// Re-export all types and registry items for backward compatibility
export type { DelegateToSubagentToolOptions } from "./delegate-to-subagent-types";

// Re-export the external accessor used by API routes and system prompt builders
export { getActiveDelegationsForCharacter } from "./delegate-to-subagent-handlers";

import {
  normalizeCompatibilityInput,
  buildDelegationsSummary,
} from "./delegate-to-subagent-handlers";
import {
  handleStartAction,
  handleObserve,
  handleContinue,
  handleAnswer,
  handleStop,
  handleList,
} from "./delegate-subagent-action-handlers";

import {
  MAX_OBSERVE_WAIT_SECONDS,
  type DelegateToSubagentToolOptions,
  type DelegateToSubagentInput,
  type DelegateResult,
} from "./delegate-to-subagent-types";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const delegateSchema = jsonSchema<DelegateToSubagentInput>({
  type: "object",
  title: "DelegateToSubagentInput",
  description:
    "Delegate work to a sub-agent. 'start' returns immediately and runs the sub-agent in the background. " +
    "Launch multiple start calls in parallel for concurrent sub-agent work. " +
    "Results are auto-delivered when sub-agents settle; use observe only for progress, pending prompts, missing output, or force re-read.",
  properties: {
    action: {
      type: "string",
      enum: ["start", "observe", "continue", "answer", "stop", "list"],
      description:
        "Action to perform: 'start' a new delegation (returns immediately), 'observe' progress or force re-read a delivered result, 'continue' with a follow-up message, 'answer' a pending interactive question from a sub-agent, 'stop' a running delegation, or 'list' available sub-agents and active delegations.",
    },
    agentId: {
      type: "string",
      description:
        "The ID of the sub-agent to delegate the task to. Optional for 'start' if agentName is provided.",
    },
    agentName: {
      type: "string",
      description:
        "The display name of the sub-agent to delegate the task to. Optional for 'start' if agentId is provided.",
    },
    task: {
      type: "string",
      description:
        "The task or question for the sub-agent. Be specific about what you need. Required for 'start'.",
    },
    context: {
      type: "string",
      description:
        "Optional additional context from the current conversation to help the sub-agent.",
    },
    delegationId: {
      type: "string",
      description:
        "The delegation ID returned by 'start'. Required for 'observe', 'continue', and 'stop'.",
    },
    followUpMessage: {
      type: "string",
      description:
        "A follow-up message to send to the sub-agent in an existing delegation session. Required for 'continue'.",
    },
    mode: {
      type: "string",
      enum: ["background"],
      description:
        "Execution mode for 'start'. Always runs in background — returns immediately with a delegationId. " +
        "Use observe/continue/stop to manage. Kept for backward compatibility.",
    },
    waitSeconds: {
      type: "number",
      minimum: 0,
      maximum: MAX_OBSERVE_WAIT_SECONDS,
      description:
        "Max wait time in seconds. For blocking 'start': timeout before returning partial result (default 300). " +
        "For 'observe': wait before returning (default 0). Example: 30, 60, 600.",
    },
    force: {
      type: "boolean",
      description:
        "For action='observe': set true to re-read a settled result that was already auto-delivered. Default false returns compact already_delivered metadata instead of duplicating the payload.",
    },
    runInBackground: {
      type: "boolean",
      description:
        "Deprecated — use mode instead. true maps to mode='background', false maps to mode='blocking'.",
    },
    resume: {
      type: "string",
      description:
        "Optional compatibility alias for delegationId. With action='start', resume maps to continue using this delegationId and task as the follow-up message.",
    },
    toolUseId: {
      type: "string",
      description:
        "The toolUseId from the pendingInteractivePrompts array. Required for 'answer' action.",
    },
    answers: {
      type: "object",
      additionalProperties: { type: "string" },
      description:
        "A Record<string, string> mapping question text to the chosen answer. Required for 'answer' action.",
    },
  },
  required: ["action"],
  additionalProperties: false,
});

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createDelegateToSubagentTool(
  options: DelegateToSubagentToolOptions,
) {
  const { sessionId: initiatorSessionId, userId, characterId, provider } = options;

  return tool({
    description:
      "Delegate work to a sub-agent in your workflow team. " +
      "'start' launches the sub-agent and returns immediately. " +
      "Launch multiple start calls in parallel for concurrent sub-agent work. " +
      "Settled results are auto-delivered; avoid observe after delivery unless you need progress, missing output, pending prompts, or force re-read.",
    inputSchema: delegateSchema,
    execute: async (input: DelegateToSubagentInput): Promise<DelegateResult> => {
      const normalizedInput = normalizeCompatibilityInput(input);

      switch (normalizedInput.action) {
        case "start":
          return handleStartAction(normalizedInput, userId, characterId, initiatorSessionId, provider);
        case "observe":
          return handleObserve(normalizedInput, characterId, initiatorSessionId);
        case "continue":
          return handleContinue(
            {
              ...normalizedInput,
              delegationId: normalizedInput.delegationId ?? normalizedInput.resume,
            },
            characterId,
            initiatorSessionId,
          );
        case "answer":
          return handleAnswer(normalizedInput, characterId, initiatorSessionId);
        case "stop":
          return handleStop(normalizedInput, characterId, initiatorSessionId);
        case "list":
          return handleList(characterId, initiatorSessionId);
        default:
          return {
            success: false,
            error: `Unknown action: ${normalizedInput.action}. Use start, observe, continue, answer, stop, or list.`,
            delegations: buildDelegationsSummary(characterId, initiatorSessionId),
          };
      }
    },
  });
}

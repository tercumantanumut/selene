import type { DBContentPart, DBToolCallPart, DBToolResultPart } from "@/lib/messages/converter";
import { normalizeToolResultOutput } from "@/lib/ai/tool-result-utils";
import { attemptJsonRepair } from "./tool-call-utils";
import {
  normalizeProvenance,
  type ContextProvenance,
} from "@/lib/context-window/scoped-counting-contract";
import { activeDelegations } from "@/lib/ai/tools/delegate-to-subagent-types";

/**
 * Hard cap on accumulated argsText per tool call (100KB).
 * Prevents unbounded memory growth when models produce runaway/repeated
 * content in tool-call arguments (e.g. duplicated test blocks in editFile).
 * Lowered from 512KB — legitimate tool calls rarely exceed 50KB of JSON args,
 * and catching runaway streams earlier prevents downstream cascading failures
 * (e.g. degenerate values causing bloated tool results → socket errors).
 */
export const MAX_ARGS_TEXT_BYTES = 100_000;

/** Max chars of argsText to include in console warnings to prevent log flooding. */
const LOG_ARGS_TEXT_PREVIEW_CHARS = 500;

export interface StreamingMessageState {
  parts: DBContentPart[];
  toolCallParts: Map<string, DBToolCallPart>;
  loggedIncompleteToolCalls: Set<string>;
  messageId?: string;
  isCreating?: boolean;
  lastBroadcastAt: number;
  lastBroadcastSignature: string;
  pendingBroadcast?: boolean;
  /**
   * Set when a live prompt injection splits the streaming message mid-run.
   * Points to the step index (0-based) at which the split occurred.
   * onFinish uses this to only persist post-injection steps to the new message.
   */
  stepOffset?: number;
  provenance?: ContextProvenance;
}

export function cloneContentParts(parts: DBContentPart[]): DBContentPart[] {
  if (typeof structuredClone === "function") {
    return structuredClone(parts);
  }
  return JSON.parse(JSON.stringify(parts));
}

export function buildProgressSignature(parts: DBContentPart[]): string {
  return parts.map((part) => {
    if (part.type === "text") {
      return `t:${part.text.length}:${part.text.slice(0, 100)}`;
    }

    if (part.type === "tool-call") {
      return `tc:${part.toolCallId}:${part.state ?? ""}`;
    }

    if (part.type === "tool-result") {
      const preview =
        typeof part.result === "string"
          ? `s:${part.result.length}:${part.result.slice(0, 120)}`
          : part.result && typeof part.result === "object"
            ? (() => {
                const entries = Object.entries(part.result as Record<string, unknown>)
                  .slice(0, 5)
                  .map(([key, value]) => {
                    if (typeof value === "string") return `${key}:${value.length}:${value.slice(0, 60)}`;
                    if (typeof value === "number" || typeof value === "boolean") return `${key}:${value}`;
                    if (Array.isArray(value)) return `${key}:arr${value.length}`;
                    return `${key}:${typeof value}`;
                  })
                  .join(",");
                return `o:${Object.keys(part.result as Record<string, unknown>).length}:${entries}`;
              })()
            : `p:${typeof part.result}`;
      return `tr:${part.toolCallId}:${part.state ?? ""}:${preview}`;
    }

    return `o:${part.type}`;
  }).join("|");
}

export function extractTextFromParts(parts: DBContentPart[]): string {
  return parts
    .filter((part): part is Extract<DBContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function applyProvenanceToPart(
  state: StreamingMessageState,
  part: DBContentPart
): DBContentPart {
  const provenance = normalizeProvenance(state.provenance);
  if (!provenance) return part;
  return {
    ...part,
    ...provenance,
  } as DBContentPart;
}

export function appendTextPartToState(state: StreamingMessageState, delta: string | undefined): boolean {
  if (!delta) {
    return false;
  }
  const lastPart = state.parts[state.parts.length - 1];
  if (lastPart?.type === "text") {
    lastPart.text += delta;
  } else {
    state.parts.push(applyProvenanceToPart(state, { type: "text", text: delta }));
  }
  return true;
}

/**
 * Append a streaming reasoning delta to the assistant message state.
 *
 * Used for thinking-mode providers (e.g. DeepSeek V4 Pro) that emit
 * `reasoning-delta` chunks via the @ai-sdk/openai-compatible adapter.
 * Multiple consecutive deltas merge into the trailing reasoning part so
 * the canonical persisted shape is one part per reasoning block. A new
 * non-reasoning part (text/tool-call) closes the current block; a fresh
 * reasoning delta after that opens a new one.
 */
export function appendReasoningPartToState(
  state: StreamingMessageState,
  delta: string | undefined
): boolean {
  if (!delta) {
    return false;
  }
  const lastPart = state.parts[state.parts.length - 1];
  if (lastPart?.type === "reasoning") {
    lastPart.text += delta;
  } else {
    state.parts.push(applyProvenanceToPart(state, { type: "reasoning", text: delta }));
  }
  return true;
}

function ensureToolCallPart(state: StreamingMessageState, toolCallId: string, toolName?: string): DBToolCallPart {
  let part = state.toolCallParts.get(toolCallId);
  if (!part) {
    part = applyProvenanceToPart(state, {
      type: "tool-call",
      toolCallId,
      toolName: toolName ?? "tool",
      state: "input-streaming",
    }) as DBToolCallPart;
    state.toolCallParts.set(toolCallId, part);
    state.parts.push(part);
  } else if (toolName && part.toolName !== toolName) {
    part.toolName = toolName;
  }
  return part;
}

export function recordToolInputStart(state: StreamingMessageState, toolCallId: string, toolName?: string): boolean {
  if (!toolCallId) {
    return false;
  }
  const part = ensureToolCallPart(state, toolCallId, toolName);
  part.state = "input-streaming";
  return true;
}

export function recordToolInputDelta(state: StreamingMessageState, toolCallId: string, delta: string | undefined): boolean {
  if (!toolCallId || !delta) {
    return false;
  }
  const part = ensureToolCallPart(state, toolCallId);
  const currentLength = part.argsText?.length ?? 0;

  // Hard cap: stop accumulating if argsText would exceed the safety limit.
  // This prevents unbounded memory growth from runaway/duplicated tool payloads.
  // Check combined size (current + delta) to prevent a single large delta from
  // overshooting the cap.
  if (currentLength + delta.length > MAX_ARGS_TEXT_BYTES) {
    if (!state.loggedIncompleteToolCalls.has(`oversized:${toolCallId}`)) {
      state.loggedIncompleteToolCalls.add(`oversized:${toolCallId}`);
      console.warn(
        `[CHAT API] argsText for ${part.toolName} (${toolCallId}) would exceed ${MAX_ARGS_TEXT_BYTES} bytes ` +
        `(current: ${currentLength}, delta: ${delta.length}). ` +
        `Dropping further deltas to prevent memory exhaustion.`
      );
    }
    return false;
  }

  // Degenerate repetition detection: if the last 64 chars of accumulated text
  // are all the same character, the model is stuck in a token repetition loop
  // (e.g. "endLine":44550000000000000000...). Halt accumulation early to prevent
  // downstream cascading failures (absurd params → bloated results → socket errors).
  if (currentLength > 200 && part.argsText) {
    const tail = part.argsText.slice(-64);
    if (tail.length === 64 && new Set(tail).size === 1) {
      if (!state.loggedIncompleteToolCalls.has(`degenerate:${toolCallId}`)) {
        state.loggedIncompleteToolCalls.add(`degenerate:${toolCallId}`);
        state.loggedIncompleteToolCalls.add(`oversized:${toolCallId}`);
        console.warn(
          `[CHAT API] Degenerate repetition detected in argsText for ${part.toolName} (${toolCallId}). ` +
          `Last 64 chars are all '${tail[0]}' at ${currentLength} bytes. Halting accumulation.`
        );
      }
      return false;
    }
  }

  part.argsText = `${part.argsText ?? ""}${delta}`;
  part.state = part.state ?? "input-streaming";
  return true;
}

export function finalizeStreamingToolCalls(state: StreamingMessageState): boolean {
  let changed = false;
  for (const part of state.toolCallParts.values()) {
    // Finalize any tool call that's still in input-streaming state without args
    if (part.type === "tool-call" && part.state === "input-streaming" && !part.args) {
      if (part.argsText) {
        // Parse the accumulated argsText
        try {
          const parsed = JSON.parse(part.argsText);
          part.args = parsed;
          part.state = "input-available";
          changed = true;
          console.log(`[CHAT API] Finalized streaming tool call: ${part.toolName} (${part.toolCallId})`);
        } catch (error) {
          // argsText is invalid JSON - log truncated preview to avoid log flooding
          console.warn(
            `[CHAT API] Failed to parse argsText for ${part.toolName} (${part.toolCallId}).\n` +
            `  Error: ${error instanceof Error ? error.message : String(error)}\n` +
            `  argsText length: ${part.argsText.length}\n` +
            `  argsText preview: ${part.argsText.slice(0, LOG_ARGS_TEXT_PREVIEW_CHARS)}` +
            (part.argsText.length > LOG_ARGS_TEXT_PREVIEW_CHARS ? `… [truncated ${part.argsText.length - LOG_ARGS_TEXT_PREVIEW_CHARS} more chars]` : "")
          );

          // Attempt to repair truncated JSON (e.g. missing closing braces/brackets)
          const repaired = attemptJsonRepair(part.argsText);
          if (repaired !== null) {
            console.log(
              `[CHAT API] Successfully repaired malformed JSON for ${part.toolName} (${part.toolCallId})`
            );
            part.args = repaired;
            part.state = "input-available";
            changed = true;
          } else {
            // Last resort: empty object so the tool call doesn't crash downstream
            console.warn(
              `[CHAT API] JSON repair failed for ${part.toolName} (${part.toolCallId}), using empty args`
            );
            part.args = {};
            part.state = "input-available";
            changed = true;
          }
        }
      } else {
        // No argsText means the tool was called with empty args (no tool-input-delta chunks sent)
        // This is valid - many tools accept empty/optional parameters
        part.args = {};
        part.state = "input-available";
        changed = true;
        console.log(`[CHAT API] Finalized streaming tool call with empty args: ${part.toolName} (${part.toolCallId})`);
      }
    }
  }
  return changed;
}

/**
 * Delegated tool calls can remain legitimately unresolved while the sub-agent is
 * still running. Keep those pending instead of sealing them into synthetic errors.
 */
/** Max time a delegation can remain "pending" before we consider it stale (7d). */
const DELEGATION_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldKeepDelegatedToolCallPending(
  part: Pick<DBToolCallPart, "toolName" | "args" | "active" | "timestamp">
): boolean {
  if (part.toolName !== "delegateToSubagent") return false;

  const args = part.args as { delegationId?: string } | undefined;
  const delegationId = args?.delegationId;

  // Check active delegation registry first — this is the source of truth.
  if (delegationId) {
    const delegation = activeDelegations.get(delegationId);
    if (delegation) {
      if (delegation.settled) return false;
      // M7: Don't keep pending forever after crashes — apply TTL.
      const age = Date.now() - delegation.startedAt;
      if (age > DELEGATION_PENDING_TTL_MS) return false;
      return true;
    }
  }

  // Progress persistence projects unresolved delegated calls with `active: true`.
  // This is a fallback for when the in-memory delegation registry has been
  // cleared (e.g. server restart) but the persisted state still has the flag.
  if (part.active === true) {
    const projectedAt = typeof part.timestamp === "string"
      ? Date.parse(part.timestamp)
      : Number.NaN;
    if (!Number.isFinite(projectedAt)) {
      return false;
    }
    return Date.now() - projectedAt <= DELEGATION_PENDING_TTL_MS;
  }

  return false;
}

/**
 * Ensure every persisted tool-call has a corresponding tool-result.
 *
 * Some interruption/error paths can leave tool-call parts in input-* states
 * without a result, which causes repeated client-side sanitization and noisy
 * logs on every poll. This seals those calls with a synthetic output-error
 * result so history is internally consistent.
 *
 * NOTE: This function skips sealing observe calls for delegations that are
 * still running. When parallel delegations are launched and the initiator
 * calls observe() on multiple delegations, completing one should not seal
 * the others as "dangling" — they are still legitimately waiting.
 */
export function sealDanglingToolCalls(
  state: StreamingMessageState,
  reason = "Tool execution ended before a result was persisted."
): boolean {
  if (!Array.isArray(state.parts) || state.parts.length === 0) return false;

  const toolResultIds = new Set<string>();
  for (const part of state.parts) {
    if (part.type === "tool-result" && typeof part.toolCallId === "string") {
      toolResultIds.add(part.toolCallId);
    }
  }

  let changed = false;
  const nextParts: DBContentPart[] = [];

  for (const part of state.parts) {
    nextParts.push(part);
    if (part.type !== "tool-call") continue;
    if (!part.toolCallId || toolResultIds.has(part.toolCallId)) continue;

    // Skip sealing delegated calls that are still legitimately waiting for a
    // sub-agent result. This prevents false "dangling" errors when one
    // delegation settles before its siblings.
    if (shouldKeepDelegatedToolCallPending(part)) {
      continue;
    }

    // Normalize unresolved tool call into a terminal state.
    if (!part.args) {
      if (part.argsText) {
        try {
          part.args = JSON.parse(part.argsText);
        } catch {
          const repaired = attemptJsonRepair(part.argsText);
          part.args = repaired ?? {};
        }
      } else {
        part.args = {};
      }
    }
    part.state = "output-error";

    nextParts.push({
      type: "tool-result",
      toolCallId: part.toolCallId,
      toolName: part.toolName || "tool",
      result: {
        status: "error",
        error: reason,
        reconstructed: true,
      },
      status: "error",
      state: "output-error",
      timestamp: new Date().toISOString(),
    });

    toolResultIds.add(part.toolCallId);
    changed = true;
  }

  if (changed) {
    state.parts = nextParts;
  }

  return changed;
}

function parseExactToolArgs(argsText: string | undefined): unknown {
  if (!argsText) return undefined;
  try {
    return JSON.parse(argsText);
  } catch {
    return undefined;
  }
}

function shouldTrustRepairedToolArgs(argsText: string | undefined): boolean {
  const trimmed = argsText?.trim();
  if (!trimmed) return false;
  const lastChar = trimmed[trimmed.length - 1];
  return !["{", "[", ":", ",", '"', "\\"].includes(lastChar);
}

function repairToolArgs(argsText: string | undefined): unknown {
  if (!argsText || !shouldTrustRepairedToolArgs(argsText)) return undefined;
  return attemptJsonRepair(argsText) ?? undefined;
}

export function recordStructuredToolCall(
  state: StreamingMessageState,
  toolCallId: string,
  toolName: string,
  input: unknown,
): boolean {
  if (!toolCallId) {
    return false;
  }
  const part = ensureToolCallPart(state, toolCallId, toolName);

  if (part.argsText && part.argsText.length > 0) {
    const serializedInput = JSON.stringify(input ?? {});
    const parsedStreamedArgs = parseExactToolArgs(part.argsText);
    const repairedStreamedArgs = parsedStreamedArgs ?? repairToolArgs(part.argsText);
    const streamedInputComplete = parsedStreamedArgs !== undefined;
    const prefixCompatible =
      serializedInput.startsWith(part.argsText) || part.argsText.startsWith(serializedInput);

    if (!streamedInputComplete && prefixCompatible) {
      part.state = "input-available";
      part.args = input;
      return true;
    }

    if (repairedStreamedArgs !== undefined) {
      if (JSON.stringify(repairedStreamedArgs) !== serializedInput) {
        console.warn(
          `[CHAT API] recordStructuredToolCall ignored conflicting structured input for ${toolName} (${toolCallId}). ` +
            `Preserving streamed argsText as the source of truth.`
        );
      }
      part.state = "input-available";
      part.args = repairedStreamedArgs;
      return true;
    }

    console.warn(
      `[CHAT API] recordStructuredToolCall recovered ${toolName} (${toolCallId}) from incomplete streamed argsText. ` +
        `Using provider structured input; streamed argsText remains for diagnostics.`
    );
    part.state = "input-available";
    part.args = input;
    return true;
  }

  part.state = "input-available";
  part.args = input;
  return true;
}

export function recordToolResultChunk(
  state: StreamingMessageState,
  toolCallId: string,
  toolName: string,
  output: unknown,
  preliminary?: boolean,
): boolean {
  if (!toolCallId) {
    return false;
  }
  const normalizedName = toolName || state.toolCallParts.get(toolCallId)?.toolName || "tool";
  const callPart = ensureToolCallPart(state, toolCallId, normalizedName);
  const normalized = normalizeToolResultOutput(
    normalizedName,
    output,
    callPart.args,
    { mode: "canonical" }
  );
  const status = normalized.status.toLowerCase();
  const isErrorStatus = status === "error" || status === "failed";
  callPart.state = isErrorStatus ? "output-error" : "output-available";

  // Check if we already have a tool-result for this toolCallId
  const existingResultIndex = state.parts.findIndex(
    (part) => part.type === "tool-result" && (part as DBToolResultPart).toolCallId === toolCallId
  );

  const resultPart: DBToolResultPart = applyProvenanceToPart(state, {
    type: "tool-result",
    toolCallId,
    toolName: normalizedName,
    result: normalized.output,
    state: callPart.state,
    preliminary,
    status: normalized.status,
    timestamp: new Date().toISOString(),
  }) as DBToolResultPart;

  if (existingResultIndex !== -1) {
    // Update existing result part instead of adding a new one
    state.parts[existingResultIndex] = resultPart;
  } else {
    // Only add new part if one doesn't exist
    state.parts.push(resultPart);
  }

  return true;
}

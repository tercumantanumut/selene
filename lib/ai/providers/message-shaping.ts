/**
 * Mid-Stream Injection — Message-Shaping Helpers
 *
 * Narrow helpers shared by both the non-Claude-Code and Claude Code
 * injection paths in `app/api/chat/route.ts` for the edge case where a
 * user message is injected WHILE an assistant message still has in-flight
 * tool calls that will never get a natural tool_result.
 *
 * Two concerns live here:
 *
 *   1. `findOrphanToolCalls(parts)` — walk an assistant DB row's `content[]`
 *      array and return the `{ toolCallId, toolName }` descriptors for every
 *      `tool-call` part whose matching `tool-result` is NOT present in the
 *      same array. Used by the injection handler to:
 *        a) stamp `metadata.custom.orphanToolCalls` on the sealed pre-
 *           injection assistant row — the wire frame forwards this set to
 *           the client so the UI can render "cancelled" chips on the
 *           in-flight tool call slots.
 *        b) drive `buildSyntheticModelToolResults` for the shim that gets
 *           prepended to the next step's `messages[]`.
 *
 *   2. `buildSyntheticModelToolResults(orphans, reason)` — produce
 *      ModelMessage-shaped `tool-result` content parts matching the shape
 *      `toModelToolResultOutput` produces (see
 *      `app/api/chat/tool-call-utils.ts` :92–108). Shaped so the next call
 *      to `streamText({ messages })` sees a well-formed conversation even
 *      though history rehydration has not run on the freshly-appended
 *      in-memory messages array.
 *
 * On future turns, `splitToolResultsFromAssistantMessages`
 * (`app/api/chat/message-splitter.ts` :30–198) already synthesizes the same
 * shape when walking DB history, so the shim we inject here is
 * indistinguishable from the one a later edit/reload would produce.
 */

import type { ModelMessage } from "ai";
import { toModelToolResultOutput } from "@/app/api/chat/tool-call-utils";
import type { SyntheticToolResultDescriptor } from "@/lib/ai/streaming/injection-stream-emitter";
import { toStructuredToolName } from "@/lib/messages/tool-name-placeholder";

/**
 * Minimal shape we walk — intentionally loose so this helper accepts both
 * the `DBContentPart` union (post-DB-serialization) and any similarly-shaped
 * runtime part array. We only look at `type`, `toolCallId`, and `toolName`.
 */
interface ToolLikePart {
  type?: string;
  toolCallId?: string;
  toolName?: string;
}

/**
 * ModelMessage-shaped synthetic tool_result content part.
 * Matches `makeSyntheticToolResult` in
 * `app/api/chat/message-splitter.ts` :48–61 so the two code paths produce
 * identical wire shapes.
 */
export interface SyntheticModelToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "text"; value: string } | { type: "json"; value: unknown };
  status: "error";
}

/**
 * Walk an assistant message's parts array and return every tool-call
 * descriptor whose matching tool-result is missing within the same array.
 *
 * Null-safe: returns `[]` for non-array inputs so this helper is safe to
 * call directly on `state.parts` or `message.content` without pre-checks.
 */
export function findOrphanToolCalls(
  parts: ToolLikePart[] | null | undefined,
): SyntheticToolResultDescriptor[] {
  if (!Array.isArray(parts)) return [];

  // First pass: collect tool-result ids so we can skip matched tool-calls
  // without requiring ordering.
  const resolved = new Set<string>();
  for (const part of parts) {
    if (
      part?.type === "tool-result" &&
      typeof part.toolCallId === "string" &&
      part.toolCallId.length > 0
    ) {
      resolved.add(part.toolCallId);
    }
  }

  const orphans: SyntheticToolResultDescriptor[] = [];
  for (const part of parts) {
    if (part?.type !== "tool-call") continue;
    const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : "";
    if (!toolCallId) continue;
    if (resolved.has(toolCallId)) continue;

    const toolName = toStructuredToolName(part.toolName);
    orphans.push({ toolCallId, toolName });
  }

  return orphans;
}

/**
 * Produce ModelMessage-shaped synthetic `tool-result` content parts for a
 * batch of orphan tool-call descriptors. The shape mirrors
 * `makeSyntheticToolResult` in `message-splitter.ts` so on-the-fly shim
 * insertion is indistinguishable from later history-based rehydration.
 *
 * `reason` is shown on the client's "cancelled" chip AND passed to the
 * model's tool_result output so the next step has a human-readable error
 * explaining why its call returned nothing useful.
 */
export function buildSyntheticModelToolResults(
  orphans: SyntheticToolResultDescriptor[],
  reason: string,
): SyntheticModelToolResult[] {
  if (!orphans || orphans.length === 0) return [];

  return orphans.map((orphan) => {
    const toolName = toStructuredToolName(orphan.toolName);
    return {
      type: "tool-result" as const,
      toolCallId: orphan.toolCallId,
      toolName,
      output: toModelToolResultOutput({
        status: "error",
        error: reason,
        reconstructed: true,
      }),
      status: "error" as const,
    };
  });
}

function getMessageParts(message: ModelMessage): Array<Record<string, unknown>> {
  return Array.isArray(message.content)
    ? message.content as Array<Record<string, unknown>>
    : [];
}

function messageHasToolCall(message: ModelMessage, toolCallId: string): boolean {
  if (message.role !== "assistant") return false;
  return getMessageParts(message).some(
    (part) => part.type === "tool-call" && part.toolCallId === toolCallId,
  );
}

function appendResultsToToolMessage(
  message: ModelMessage,
  results: SyntheticModelToolResult[],
): ModelMessage {
  const existing = getMessageParts(message);
  return {
    ...message,
    content: [...existing, ...results] as ModelMessage["content"],
  } as ModelMessage;
}

/**
 * Insert synthetic `tool-result` blocks into the only Anthropic-valid location:
 * immediately after the assistant message that emitted the corresponding
 * `tool-call`/`tool_use` id.
 *
 * The mid-stream injection path used to append a synthetic `role:"tool"`
 * message to the end of `stepMessages`. That is only valid when the final
 * message is still the owning assistant. Queued user-message injection can run
 * after the SDK has already added later assistant/user messages to the step
 * frame; appending there makes Anthropic see a `tool_result` whose previous
 * message has no matching `tool_use`, producing `unexpected tool_use_id found in
 * tool_result blocks`.
 *
 * This helper skips any orphan that is already resolved in the frame and skips
 * impossible synthetic results when the matching assistant is absent. A
 * tool_result with no preceding matching assistant can never be made valid by
 * appending it later.
 */
export function insertSyntheticToolResultsAfterMatchingAssistant(
  messages: ModelMessage[],
  orphans: SyntheticToolResultDescriptor[],
  reason: string,
): ModelMessage[] {
  if (!orphans || orphans.length === 0) return messages;

  const resolvedToolCallIds = new Set<string>();
  for (const message of messages) {
    for (const part of getMessageParts(message)) {
      if (part.type === "tool-result" && typeof part.toolCallId === "string") {
        resolvedToolCallIds.add(part.toolCallId);
      }
    }
  }

  const orphanGroupsByAssistantIndex = new Map<number, SyntheticToolResultDescriptor[]>();

  for (const orphan of orphans) {
    if (!orphan.toolCallId || resolvedToolCallIds.has(orphan.toolCallId)) {
      continue;
    }

    let assistantIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messageHasToolCall(messages[i], orphan.toolCallId)) {
        assistantIndex = i;
        break;
      }
    }

    if (assistantIndex === -1) {
      continue;
    }

    const group = orphanGroupsByAssistantIndex.get(assistantIndex) ?? [];
    group.push(orphan);
    orphanGroupsByAssistantIndex.set(assistantIndex, group);
  }

  if (orphanGroupsByAssistantIndex.size === 0) return messages;

  const shaped: ModelMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    shaped.push(message);

    const group = orphanGroupsByAssistantIndex.get(i);
    if (!group || group.length === 0) continue;

    const syntheticResults = buildSyntheticModelToolResults(group, reason);
    const next = messages[i + 1];
    if (next?.role === "tool") {
      i += 1;
      shaped.push(appendResultsToToolMessage(next, syntheticResults));
      continue;
    }

    shaped.push({
      role: "tool",
      content: syntheticResults as ModelMessage["content"],
    } as ModelMessage);
  }

  return shaped;
}

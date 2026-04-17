/**
 * Mid-Stream Injection — Message-Shaping Helpers
 *
 * Narrow helpers shared between the non-Claude-Code route handler
 * (`app/api/chat/route.ts` `prepareStep`) and the Claude Code provider
 * (`lib/ai/providers/claudecode-provider.ts`) for the edge case where a user
 * message is injected WHILE an assistant message still has in-flight tool
 * calls that will never get a natural tool_result.
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

import { toModelToolResultOutput } from "@/app/api/chat/tool-call-utils";
import type { SyntheticToolResultDescriptor } from "@/lib/ai/streaming/injection-stream-emitter";

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

    const toolName =
      typeof part.toolName === "string" && part.toolName.length > 0
        ? part.toolName
        : "tool";
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
    const toolName =
      typeof orphan.toolName === "string" && orphan.toolName.length > 0
        ? orphan.toolName
        : "tool";
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

/**
 * Mid-Stream User-Message Injection — Splice Core
 *
 * Pure, React-free logic that rewrites the live `chat.messages` array AND
 * rotates the AI SDK's in-flight `activeResponse.state` so the
 * `@assistant-ui/core` `MessageRepository.performOp/link` path never sees a
 * duplicated message id when an injected user UIMessage is spliced into an
 * active assistant stream.
 *
 * This module is the single source of truth for the splice — both the
 * client transport (`BufferedAssistantChatTransport` in
 * `components/chat-provider.tsx`) AND the regression test suite under
 * `tests/lib/mid-stream-injection/` call into `computeInjectionSplice` so a
 * test failure is a provable client bug, not a mock drift.
 *
 * ┌────────────────── Why this is the shape it is ──────────────────┐
 *
 * AI SDK v6's `UIMessageStream` assumes one message per HTTP response.
 * `Chat.activeResponse.state.message` is a SINGLE assistant UIMessage
 * accumulating parts for the entire stream duration. Every `write()` call
 * during chunk processing picks one of two branches based on id equality
 * with the tail of `chat.messages`:
 *
 *     replaceMessage(last, state.message)   if state.message.id === lastMessage.id
 *     pushMessage(state.message)            otherwise
 *
 * `pushMessage` concats BY REFERENCE (no snapshot), so if we naively
 * `setMessages(prev => [...prev, injectedUser])`, the NEXT chunk's write()
 * sees `state.message.id !== injectedUser.id` and pushes the SAME live
 * reference a SECOND time onto the array. The assistant-ui runtime then
 * feeds both positions into `MessageRepository.addOrUpdateMessage` with
 * DIFFERENT parents, and the second call throws:
 *
 *     MessageRepository(performOp/link): A message with the same id
 *     already exists in the parent tree.
 *
 * Fix: perform an atomic splice that:
 *
 *   1. Deep-clones the current `state.message` into a sealed snapshot
 *      (frozen pre-injection content, old id).
 *
 *   2. Resets `state.message` to a fresh empty assistant with a NEW id,
 *      and clears all active part trackers so post-injection chunks don't
 *      accidentally latch onto pre-injection part objects.
 *
 *   3. Rewrites `chat.messages` to
 *      `[...prev.slice(0, -1), sealed_snapshot, injected_user]` so the
 *      in-flight assistant reference that was at the tail is replaced by
 *      the sealed snapshot (old id preserved), followed by the injected
 *      user. The next chunk's write() now sees
 *      `state.message.id (new) !== lastMessage.id (injected_user)` →
 *      pushMessage branch → a genuinely new assistant row at the end.
 *
 * Edge cases covered:
 *
 *   - `activeState` is `null` (no in-flight response — e.g., an injection
 *     arrived between response lifecycles). We fall through to a plain
 *     append and do NOT rotate; there's no state to rotate.
 *
 *   - tail of `prev` is not the in-flight assistant (e.g., the very first
 *     chunk hasn't landed yet, so tail is still a user message). We append
 *     WITHOUT a seal, but still rotate the activeState id so any
 *     subsequent pushMessage lands on the new id.
 *
 *   - the injected user id is already present in `prev` — idempotent
 *     no-op on retransmit / reconnect.
 *
 *   - the tail of `prev` is an assistant with an id that does NOT match
 *     our sealed id (stale closure, or helper swap). Again, no seal —
 *     plain append with rotation.
 *
 * └──────────────────────────────────────────────────────────────────┘
 */

import type { UIMessage } from "ai";
import type { InjectedUserMessageData } from "./injection-stream-emitter";
import {
  findDuplicateIds,
  logSpliceEntry,
  logSpliceExit,
  summarizeMessages,
} from "./injection-diagnostic-logger";

/**
 * Minimal shape of AI SDK v6's `activeResponse.state`. Declared `private` on
 * the SDK's `AbstractChat` class but a plain own-property at runtime.
 * Kept narrow so this module stays dependency-free.
 */
export interface AiSdkActiveResponseStateLike {
  message: UIMessage;
  activeTextParts: Record<string, { text: string } | undefined>;
  activeReasoningParts: Record<string, { text: string } | undefined>;
  partialToolCalls: Record<string, unknown>;
}

export interface ComputeInjectionSpliceInput {
  /** Current `chat.messages` snapshot (what React sees right now). */
  prev: UIMessage[];
  /**
   * Live AI SDK stream state if a response is active, else `null`. The
   * splice MUTATES this object in-place so the next `write()` inside the
   * SDK picks up the rotated id — the caller is responsible for passing a
   * live reference, not a clone.
   */
  activeState: AiSdkActiveResponseStateLike | null;
  /** Validated injection payload (stripped of wire-frame metadata). */
  data: InjectedUserMessageData;
  /**
   * ID generator (normally the underlying `useChat` instance's
   * `generateId`) so the rotated post-injection assistant message id
   * matches the format of the rest of the SDK's message ids.
   */
  generateId: () => string;
  /**
   * Deep-clone function. Defaults to `structuredClone` with a shallow-clone
   * fallback for cases where a UIMessage contains non-cloneable values
   * (rare — but e.g. functions in metadata would choke structuredClone).
   * Callers in jsdom/node test environments can pass a custom cloner.
   */
  clone?: (message: UIMessage) => UIMessage;
  /**
   * Human-readable error text we stamp onto tombstoned (non-terminal) tool
   * parts on the sealed snapshot so the UI renders a proper "cancelled"
   * chip instead of a perpetual spinner. Defaults to
   * `"Cancelled — user interjected with a new message"`. Kept overrideable
   * so the delegation-completion branch in `app/api/chat/route.ts` can pass
   * its own reason (`"Cancelled — delegation result arrived ..."`).
   */
  tombstoneReason?: string;
}

export interface ComputeInjectionSpliceResult {
  /** New message array to pass to `chat.setMessages`. */
  nextMessages: UIMessage[];
  /**
   * The sealed snapshot, if one was produced (i.e. tail was the in-flight
   * assistant). Exposed so tests can assert splice shape directly.
   */
  sealedSnapshot: UIMessage | null;
  /**
   * The freshly-rotated assistant message id placed on
   * `activeState.message`, or `null` if rotation was skipped (e.g.
   * `activeState` was `null`, or injection was idempotently no-op'd).
   */
  newAssistantId: string | null;
  /** True iff the payload was already applied (idempotent retransmit). */
  alreadyApplied: boolean;
  /** True iff the tail of `prev` was the in-flight assistant we sealed. */
  sealedTail: boolean;
  /** The injected user UIMessage materialized from `data`. */
  injectedMessage: UIMessage;
}

function shallowCloneMessage(message: UIMessage): UIMessage {
  return {
    ...message,
    parts: Array.isArray(message.parts)
      ? message.parts.map((part) => ({ ...part }))
      : message.parts,
    metadata: message.metadata
      ? { ...(message.metadata as Record<string, unknown>) }
      : message.metadata,
  } as UIMessage;
}

/**
 * Default error text we stamp onto tombstoned tool parts on the sealed
 * snapshot. Matches the string used on the server-side message-shaping
 * shim (`app/api/chat/route.ts` :1307) so the client- and server-side
 * reconstructions render identical text on reload.
 */
export const DEFAULT_TOMBSTONE_REASON =
  "Cancelled — user interjected with a new message";

/**
 * Tool-part state values recognized by AI SDK v6 (see
 * `node_modules/ai/dist/index.d.ts` ~L1800 and ~L1895 for the
 * `ToolUIPart` / `DynamicToolUIPart` discriminated union). We tombstone
 * anything that is NOT already in a terminal state so the sealed snapshot
 * never leaves a tool chip rendering as "Running..." indefinitely.
 */
const TERMINAL_TOOL_STATES = new Set<string>([
  "output-available",
  "output-error",
  "output-denied",
]);

/**
 * Identify a tool part by its discriminator. AI SDK v6 static tools use
 * `type: "tool-<toolName>"`; dynamic tools use `type: "dynamic-tool"`.
 * We match both forms so an injection that interrupts either style of tool
 * call ends up with a clean terminal state on the sealed snapshot.
 */
function isToolPartLike(part: unknown): part is Record<string, unknown> {
  if (typeof part !== "object" || part === null) return false;
  const rec = part as Record<string, unknown>;
  const t = rec.type;
  if (typeof t !== "string") return false;
  return t.startsWith("tool-") || t === "dynamic-tool";
}

/**
 * Walk a UIMessage's `parts[]` and flip every tool part whose `state` is
 * NOT terminal to `"output-error"` with the provided error text. Returns
 * a new UIMessage (with a new parts array) when at least one part was
 * tombstoned; returns the original reference unchanged otherwise so
 * no-op calls don't spray garbage references into the React tree.
 *
 * Exported for the regression tests in
 * `tests/lib/mid-stream-injection/splice-with-real-repo.test.ts` which
 * assert the sealed snapshot's tool parts render a clean "cancelled"
 * chip instead of a stuck spinner.
 */
export function tombstoneUnresolvedToolParts(
  message: UIMessage,
  reason: string = DEFAULT_TOMBSTONE_REASON,
): UIMessage {
  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    return message;
  }

  let changed = false;
  const newParts = message.parts.map((part) => {
    if (!isToolPartLike(part)) return part;
    const state = (part as { state?: unknown }).state;
    if (typeof state === "string" && TERMINAL_TOOL_STATES.has(state)) {
      return part;
    }
    changed = true;
    // Preserve `input` when present (it captures the partial args the
    // model emitted before the interruption — useful context for the
    // "cancelled" chip). AI SDK's `output-error` state requires an
    // `errorText: string` field; `output` must remain absent.
    const rec = part as Record<string, unknown>;
    const preservedInput = "input" in rec ? rec.input : undefined;
    return {
      ...rec,
      state: "output-error" as const,
      input: preservedInput === undefined ? {} : preservedInput,
      errorText: reason,
      output: undefined,
    };
  });

  if (!changed) return message;
  return { ...message, parts: newParts as UIMessage["parts"] };
}

/**
 * Default deep-clone that prefers `structuredClone` (Node 17+, all modern
 * browsers) and gracefully degrades for messages that contain values
 * `structuredClone` refuses to serialize (e.g. functions stuffed into
 * `metadata`). Exported so tests can verify the exact cloning semantics.
 */
export function defaultCloneMessage(message: UIMessage): UIMessage {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(message);
    } catch {
      // fall through
    }
  }
  return shallowCloneMessage(message);
}

/**
 * Build the `UIMessage` we splice into `chat.messages` for the injected
 * prompt. The id MUST equal `data.messageId` (the DB row id), because:
 *
 *   - reconnect re-delivery sends the same id → we dedupe idempotently,
 *   - the assistant-ui `MessageRepository` uses this id as the parent of
 *     the post-injection assistant row,
 *   - user-edit/regenerate reads the id from the DOM data attr back to
 *     the DB row.
 */
export function buildInjectedUserMessage(data: InjectedUserMessageData): UIMessage {
  return {
    id: data.messageId,
    role: "user",
    parts: [{ type: "text", text: data.text ?? "" }],
    metadata: {
      livePromptInjected: true,
      orderingIndex: data.orderingIndex,
      sessionId: data.sessionId,
      source: data.source,
      stopIntent: data.stopIntent,
      createdAt: data.createdAt,
      ...(data.syntheticToolResults && data.syntheticToolResults.length > 0
        ? { syntheticToolResults: data.syntheticToolResults }
        : {}),
    },
  } as UIMessage;
}

/**
 * Pure splice implementation. MUTATES `input.activeState` in place when
 * present (rotates the id + clears active part trackers); returns the
 * computed `nextMessages` array WITHOUT mutating `input.prev`.
 *
 * The caller is responsible for:
 *   - calling `chat.setMessages(result.nextMessages)`,
 *   - remembering `data.messageId` in a dedupe set so a later retransmit
 *     short-circuits via `alreadyApplied = true`.
 *
 * All decisions (seal-vs-append, rotate-vs-skip, dedupe-vs-apply) are
 * reflected in the returned booleans so tests can assert every code path
 * without reaching into implementation details.
 */
export function computeInjectionSplice(
  input: ComputeInjectionSpliceInput,
): ComputeInjectionSpliceResult {
  const { prev, activeState, data, generateId } = input;
  const clone = input.clone ?? defaultCloneMessage;
  const tombstoneReason = input.tombstoneReason ?? DEFAULT_TOMBSTONE_REASON;

  const injectedMessage = buildInjectedUserMessage(data);

  // ── Diagnostic entry log ──────────────────────────────────────────────
  // Gated on DIAGNOSTIC_ENABLED inside the logger. Cheap when disabled
  // (the summary helpers short-circuit via the flag check in the logger).
  logSpliceEntry({
    injectedMessageId: data.messageId,
    injectedSource: data.source,
    prevLen: prev.length,
    prevSummary: summarizeMessages(prev),
    activeStateMessageId: activeState?.message?.id ?? null,
    activeStateActiveTextPartIds: activeState
      ? Object.keys(activeState.activeTextParts ?? {})
      : [],
    activeStateActiveReasoningIds: activeState
      ? Object.keys(activeState.activeReasoningParts ?? {})
      : [],
    activeStatePartialToolCallIds: activeState
      ? Object.keys(activeState.partialToolCalls ?? {})
      : [],
  });

  // Idempotency — dedupe on the injected message id. This guards against
  // reconnect re-delivery AND against a caller that forgets to maintain
  // its own dedupe set.
  if (prev.some((m) => m.id === data.messageId)) {
    logSpliceExit({
      injectedMessageId: data.messageId,
      alreadyApplied: true,
      sealedTail: false,
      sealedSnapshotId: null,
      newAssistantId: null,
      prevLen: prev.length,
      nextLen: prev.length,
      nextSummary: summarizeMessages(prev),
      duplicateIdsAfterSplice: findDuplicateIds(prev),
    });
    return {
      nextMessages: prev,
      sealedSnapshot: null,
      newAssistantId: null,
      alreadyApplied: true,
      sealedTail: false,
      injectedMessage,
    };
  }

  // Rotate the AI SDK active state if present. We rotate EVEN IF the tail
  // of `prev` is not the in-flight assistant — because `state.message` is
  // the reference that the next `write()` will either replaceMessage or
  // pushMessage with, and if we don't rotate the id, the pushMessage
  // branch appends the SAME mutating reference a second time, producing a
  // duplicate id in the array.
  let sealedSnapshot: UIMessage | null = null;
  let newAssistantId: string | null = null;

  if (activeState) {
    // Deep-clone first (pinning pre-injection content), THEN tombstone any
    // tool parts still in a non-terminal state. Tombstoning happens on the
    // clone so we don't mutate the live `activeState.message` — the SDK's
    // in-flight chunk pipeline may still hold that reference.
    const clonedSealed = clone(activeState.message);
    sealedSnapshot = tombstoneUnresolvedToolParts(clonedSealed, tombstoneReason);
    // Prefer the server-provided id when present so the post-injection
    // assistant row rendered on the client shares its id with the DB row
    // that the streaming→DB sync will persist. Without this, a later
    // `reloadSessionMessages({ force: true })` (fired by
    // `handleForegroundRunFinished`) replaces chat.messages with DB-derived
    // server-id rows and MessageRepository ends up holding BOTH the old
    // client-id assistant AND the new server-id assistant as siblings
    // under the injected user message — producing a branch picker.
    //
    // Fallback to `generateId()` keeps backward-compat with any server
    // that hasn't yet been updated to ship `nextAssistantMessageId`.
    newAssistantId = data.nextAssistantMessageId ?? generateId();
    activeState.message = {
      id: newAssistantId,
      role: "assistant",
      parts: [],
      metadata: undefined,
    } as UIMessage;
    activeState.activeTextParts = {};
    activeState.activeReasoningParts = {};
    activeState.partialToolCalls = {};
  }

  // Compute nextMessages. If the tail is the in-flight assistant we
  // sealed, replace it with our snapshot so the pre-injection content is
  // pinned at this instant and won't get mutated by any residual
  // in-flight reference. Otherwise append-only.
  if (prev.length === 0) {
    const nextMessages = [injectedMessage];
    logSpliceExit({
      injectedMessageId: data.messageId,
      alreadyApplied: false,
      sealedTail: false,
      sealedSnapshotId: sealedSnapshot?.id ?? null,
      newAssistantId,
      prevLen: 0,
      nextLen: nextMessages.length,
      nextSummary: summarizeMessages(nextMessages),
      duplicateIdsAfterSplice: findDuplicateIds(nextMessages),
    });
    return {
      nextMessages,
      sealedSnapshot,
      newAssistantId,
      alreadyApplied: false,
      sealedTail: false,
      injectedMessage,
    };
  }

  const lastIdx = prev.length - 1;
  const last = prev[lastIdx];
  const tailIsSealedAssistant =
    sealedSnapshot !== null &&
    !!last &&
    last.role === "assistant" &&
    last.id === sealedSnapshot.id;

  if (tailIsSealedAssistant) {
    const nextMessages = [...prev.slice(0, lastIdx), sealedSnapshot!, injectedMessage];
    logSpliceExit({
      injectedMessageId: data.messageId,
      alreadyApplied: false,
      sealedTail: true,
      sealedSnapshotId: sealedSnapshot?.id ?? null,
      newAssistantId,
      prevLen: prev.length,
      nextLen: nextMessages.length,
      nextSummary: summarizeMessages(nextMessages),
      duplicateIdsAfterSplice: findDuplicateIds(nextMessages),
    });
    return {
      nextMessages,
      sealedSnapshot,
      newAssistantId,
      alreadyApplied: false,
      sealedTail: true,
      injectedMessage,
    };
  }

  const nextMessages = [...prev, injectedMessage];
  logSpliceExit({
    injectedMessageId: data.messageId,
    alreadyApplied: false,
    sealedTail: false,
    sealedSnapshotId: sealedSnapshot?.id ?? null,
    newAssistantId,
    prevLen: prev.length,
    nextLen: nextMessages.length,
    nextSummary: summarizeMessages(nextMessages),
    duplicateIdsAfterSplice: findDuplicateIds(nextMessages),
  });
  return {
    nextMessages,
    sealedSnapshot,
    newAssistantId,
    alreadyApplied: false,
    sealedTail: false,
    injectedMessage,
  };
}

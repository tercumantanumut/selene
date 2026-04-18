/**
 * Mid-Stream User-Message Injection — Per-Prompt Handler
 *
 * Shared server-side flow that both the non-Claude-Code path
 * (`app/api/chat/route.ts` `prepareStep` :1219–1265) and the Claude Code
 * path (`lib/ai/providers/claudecode-provider.ts` `onQueueMessages`
 * :808–849) call when draining injected prompts.
 *
 * Responsibilities:
 *   1. Seal the pre-injection assistant streaming partial (flush to DB).
 *   2. Tag that sealed assistant row with `livePromptInjected: true` and,
 *      when relevant, the set of orphan tool_call ids that the message-
 *      shaping shim needs to re-synthesize on future turns.
 *   3. Reset `streamingState` so post-injection assistant content starts
 *      a fresh DB row.
 *   4. Persist each injected user prompt with a fresh monotonic
 *      `orderingIndex` (allocated AFTER the assistant seal, which is what
 *      preserves the edit/reload truncation invariant).
 *   5. Emit one `data-injected-user-message` chunk per persisted row onto
 *      the active UIMessageStream writer, in insertion (FIFO) order.
 *   6. Honor `stopIntent`: if any queued prompt requested a stop, return
 *      `abort: true` so the caller can cancel the current `streamText` via
 *      the chat AbortController and start a fresh step.
 *
 * The handlers do NOT construct the AI SDK `UserModelMessage` array or the
 * synthetic tool_result shim — those concerns live in the caller (route.ts
 * for non-CC, `streamInput` for CC). Keeping this module narrow makes it
 * unit-testable without mocking `streamText`.
 */

import { createMessage, updateMessage } from "@/lib/db/queries";
import { nextOrderingIndex } from "@/lib/session/message-ordering";
import type { LivePromptEntry } from "@/lib/background-tasks/live-prompt-queue-registry";
import {
  emitInjectedUserMessageChunk,
  type InjectedUserMessagePayload,
  type InjectedUserMessageSource,
  type InjectionStreamWriter,
  type SyntheticToolResultDescriptor,
} from "@/lib/ai/streaming/injection-stream-emitter";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subset of the streaming-state object that we mutate during the seal/reset
 * phase. Kept narrow so tests can pass a plain object and so both the route
 * handler and claudecode-provider can share the signature without leaking
 * their provider-specific extensions.
 */
export interface InjectionStreamingState {
  messageId: string | undefined;
  parts: unknown[];
  toolCallParts: Map<string, unknown>;
  loggedIncompleteToolCalls: Set<string>;
  lastBroadcastAt: number;
  lastBroadcastSignature: string;
  pendingBroadcast?: boolean;
  isCreating?: boolean;
  stepOffset?: number;
}

export interface HandleInjectedPromptsArgs {
  sessionId: string;
  prompts: LivePromptEntry[];
  streamingState: InjectionStreamingState | null | undefined;
  /**
   * Flush-on-truthy wrapper around the per-provider streaming→DB sync
   * helper. Matches the signature used in `app/api/chat/route.ts` and
   * `claudecode-provider.ts`.
   */
  syncStreamingMessage: ((flush?: boolean) => Promise<void>) | null | undefined;
  /**
   * Active UIMessageStream writer. May be null in background mode when the
   * stream has already been consumed / the client disconnected; in that
   * case we still persist the DB row but skip the frame emit — the client
   * will pick the row up via `reloadSessionMessages` on reconnect.
   */
  writer: InjectionStreamWriter | null | undefined;
  /**
   * Orphan tool_use ids on the pre-injection assistant row — forwarded to
   * both the metadata update (so future turns can rehydrate) and to the
   * emitted wire frame (so the client can render "cancelled" hints).
   * Caller computes this from the in-flight messages.
   */
  orphanToolCalls?: SyntheticToolResultDescriptor[];
  /**
   * Pre-generated assistant message id for the post-injection assistant row.
   * The caller generates this BEFORE calling the handler, passes it in here
   * so it is emitted on the wire frame, and THEN assigns the SAME value to
   * its own `assistantMessageId` variable so the post-injection streaming→DB
   * sync persists under the matching id.
   *
   * See `InjectedUserMessageData.nextAssistantMessageId` for the full
   * branch-picker fix rationale.
   *
   * Optional: when omitted, the wire frame has no next-id hint and the
   * client falls back to `generateId()` (pre-fix behavior).
   */
  nextAssistantMessageId?: string;
}

export interface HandleInjectedPromptsResult {
  /** True iff the queue included a stopIntent entry — caller must hard-abort. */
  abort: boolean;
  /** Number of DB rows actually persisted (may be 0 on empty queues). */
  persistedCount: number;
  /** DB row ids for persisted rows — useful for testing and for the caller
   * when assembling the next-step `messages` array. */
  persistedMessageIds: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// `LivePromptEntry.metadata` has no `source` field (see
// `lib/background-tasks/live-prompt-queue-registry.ts#LivePromptEntry`) — all
// channel producers enqueue without a channel tag, so every non-delegation
// injection surfaces as "web" on the wire. If/when channel producers start
// stamping `metadata.source`, extend LivePromptEntry first, then widen this
// helper to forward the typed value. Do NOT re-introduce the freeform
// `{ source?: string }` cast — it hid the fact that the branches were dead.
function sourceFor(entry: LivePromptEntry): InjectedUserMessageSource {
  return entry.metadata?.kind === "delegation_completion" ? "delegation" : "web";
}

async function sealPreInjectionAssistant(
  state: InjectionStreamingState,
  syncStreamingMessage: (flush?: boolean) => Promise<void>,
  orphanToolCalls: SyntheticToolResultDescriptor[] | undefined,
): Promise<void> {
  await syncStreamingMessage(true);

  if (state.messageId) {
    const preId = state.messageId;
    // livePromptInjected tags the row so `deleteMessagesNotIn` protects it
    // (route.ts edit/reload invariant) and so rehydration of synthetic
    // tool_results on subsequent turns knows where to look.
    const metadata: Record<string, unknown> = { livePromptInjected: true };
    if (orphanToolCalls && orphanToolCalls.length > 0) {
      metadata.custom = { orphanToolCalls };
    }
    void updateMessage(preId, { metadata }).catch(() => {
      /* best-effort tag — missing tag would only weaken edit/reload safety,
       * not corrupt data. Swallow to keep the hot injection path fast. */
    });
  }

  // Reset streaming state so post-injection assistant content starts a
  // fresh DB row (otherwise the continuation would collapse into the row
  // we just sealed, which in background mode has already been persisted).
  state.messageId = undefined;
  state.parts = [];
  state.toolCallParts = new Map();
  state.loggedIncompleteToolCalls = new Set();
  state.lastBroadcastAt = 0;
  state.lastBroadcastSignature = "";
  state.pendingBroadcast = false;
  state.isCreating = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-Claude-Code handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Covers `app/api/chat/route.ts` `prepareStep` :1219–1265 (primary inject
 * branch) and :1309–1363 (post-delegation inject branch). The caller is
 * responsible for the follow-up work unique to non-CC: building the
 * synthetic `ToolModelMessage` shim, composing the final `messages` array
 * for the SDK step, and rotating `assistantMessageId`. The caller also
 * owns `stepOffset` bookkeeping on `streamingState` — we deliberately
 * don't take `stepNumber` here because the handler has no use for it
 * and threading an unused param through both injection branches just
 * invites future drift.
 */
export async function handleInjectedPromptsNonCC(
  args: HandleInjectedPromptsArgs,
): Promise<HandleInjectedPromptsResult> {
  return runHandler(args);
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Covers `lib/ai/providers/claudecode-provider.ts` `onQueueMessages`
 * :808–849. The caller is responsible for calling `query.streamInput(...)`
 * after this handler returns — we handle only DB + wire, not the SDK-level
 * input injection.
 */
export async function handleInjectedPromptsCC(
  args: HandleInjectedPromptsArgs,
): Promise<HandleInjectedPromptsResult> {
  return runHandler(args);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared implementation
// ─────────────────────────────────────────────────────────────────────────────

async function runHandler(
  args: HandleInjectedPromptsArgs,
): Promise<HandleInjectedPromptsResult> {
  const {
    sessionId,
    prompts,
    streamingState,
    syncStreamingMessage,
    writer,
    orphanToolCalls,
    nextAssistantMessageId,
  } = args;

  if (prompts.length === 0) {
    return { abort: false, persistedCount: 0, persistedMessageIds: [] };
  }

  const stopRequested = prompts.some((p) => p.stopIntent);

  // Seal pre-injection assistant first so the ordering-index allocator
  // sees the finalized row and assigns a strictly-greater index to the
  // injected user row.
  if (streamingState && syncStreamingMessage) {
    await sealPreInjectionAssistant(
      streamingState,
      syncStreamingMessage,
      orphanToolCalls,
    );
  }

  const persistedMessageIds: string[] = [];

  for (const prompt of prompts) {
    try {
      const orderingIndex = await nextOrderingIndex(sessionId);

      const promptCustom: Record<string, unknown> = {};
      if (prompt.metadata?.inspectContext) {
        promptCustom.inspectContext = prompt.metadata.inspectContext;
      }
      if (prompt.metadata?.kind === "delegation_completion") {
        if (prompt.metadata.delegationId) {
          promptCustom.delegationId = prompt.metadata.delegationId;
        }
        if (prompt.metadata.delegateName) {
          promptCustom.delegateName = prompt.metadata.delegateName;
        }
      }

      const injected = await createMessage({
        sessionId,
        role: "user",
        content: [{ type: "text", text: prompt.content }],
        orderingIndex,
        metadata: {
          livePromptInjected: true,
          ...(prompt.stopIntent ? { stopIntent: true } : {}),
          ...(Object.keys(promptCustom).length > 0
            ? { custom: promptCustom }
            : {}),
        },
      });

      if (!injected) {
        // UNIQUE-constraint collision or driver returned no row. Skip wire
        // emit — the client will pick the message up on reconnect recovery
        // when it calls reloadSessionMessages.
        continue;
      }

      persistedMessageIds.push(injected.id);

      // Emit wire frame — CLIENT RENDER PATH.
      // If the writer is null (background mode, client disconnected), the
      // DB row alone is sufficient; reconnect recovery will hydrate via
      // `reloadSessionMessages({ force: true })`.
      if (writer) {
        const createdAtValue: unknown = injected.createdAt;
        const payload: InjectedUserMessagePayload = {
          messageId: injected.id,
          sessionId,
          orderingIndex,
          text: prompt.content,
          createdAt:
            createdAtValue instanceof Date
              ? createdAtValue.toISOString()
              : typeof createdAtValue === "string"
                ? createdAtValue
                : new Date().toISOString(),
          source: sourceFor(prompt),
          stopIntent: prompt.stopIntent,
          ...(orphanToolCalls && orphanToolCalls.length > 0
            ? { syntheticToolResults: orphanToolCalls }
            : {}),
          // Ship the server's pre-generated post-injection assistant id so
          // the client splice uses the matching id. This is what prevents
          // the branch-picker appearing after reloadSessionMessages replaces
          // chat.messages with DB-derived server-id rows.
          ...(nextAssistantMessageId
            ? { nextAssistantMessageId }
            : {}),
        };
        emitInjectedUserMessageChunk(writer, payload);
      }
    } catch (dbError) {
      // Fail closed: a genuine DB error (connection loss, constraint we
      // didn't anticipate, serialization failure) means the injected
      // prompt exists only in-memory for this function scope. If we
      // swallowed and continued, the caller would still pass this prompt
      // to the model and the assistant could reply to a user message that
      // has no row in the DB and no wire frame on the client — leaving
      // transcript and UI permanently inconsistent.
      //
      // Note: the `!injected` branch above is NOT treated as an error —
      // that's the idempotent retry path (UNIQUE-constraint collision)
      // where the row already exists and reconnect recovery hydrates it.
      console.error(
        "[injection-handler] Failed to persist injected user message (aborting stream):",
        dbError,
      );
      throw dbError;
    }
  }

  return {
    abort: stopRequested,
    persistedCount: persistedMessageIds.length,
    persistedMessageIds,
  };
}

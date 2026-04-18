/**
 * Mid-Stream User-Message Injection — Wire Protocol Emitter
 *
 * Emits a typed `data-*` custom data part on the active AI SDK v6
 * UIMessageStream writer so the client transport can splice a new user
 * message into the assistant-ui thread mid-stream.
 *
 * Contract defined in the Phase 3 design doc (see branch
 * `fix/mid-stream-injection-render`, docs/mid-stream-injection-design.md).
 *
 * Why a data part and not a second `start` chunk:
 *   AI SDK v6's UIMessageStream assumes one message per response —
 *   `generateMessageId` is scoped per-stream and `useChat`'s reducer appends
 *   deltas to the streaming assistant message id. A second `start` would be
 *   treated as a new assistant message. Typed `data-*` parts are the
 *   SDK-sanctioned out-of-band channel; see
 *   https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol and
 *   https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage#data-parts .
 */

/** Stable AI SDK v6 data-part type identifier. */
export const INJECTED_USER_MESSAGE_CHUNK_TYPE = "data-injected-user-message" as const;

/** Origin label for the injection. */
export type InjectedUserMessageSource =
  | "web"
  | "telegram"
  | "whatsapp"
  | "slack"
  | "discord"
  | "delegation"
  | "workflow"
  | "other";

export interface SyntheticToolResultDescriptor {
  /** Tool-call id on the pre-injection assistant row that had no matching result. */
  toolCallId: string;
  /** Tool name — informational, so clients can render "cancelled" chips. */
  toolName: string;
}

/**
 * Payload carried by the `data-injected-user-message` data part. This is the
 * full surface the client transport needs to:
 *   1) Splice a user UIMessage into `chat.messages` with a stable id.
 *   2) Dedupe on retransmit (idempotent on `messageId`).
 *   3) Render correct ordering relative to the in-flight assistant message.
 *   4) Surface origin / stop-intent hints.
 *   5) Optionally mark orphaned tool-call chips on the prior assistant row.
 */
export interface InjectedUserMessageData {
  /** Stable DB row id of the persisted user message — used as UIMessage.id on the client. */
  messageId: string;
  /** Session id the injection belongs to (defensive cross-session ignore). */
  sessionId: string;
  /** Monotonic ordering index assigned by the server allocator. */
  orderingIndex: number;
  /** Always `"user"` — explicit so client code branches safely. */
  role: "user";
  /** Flattened, sanitized text content. */
  text: string;
  /** ISO 8601 timestamp of the DB row creation. */
  createdAt: string;
  /** Origin channel. */
  source: InjectedUserMessageSource;
  /** True iff the injection requested a clean abort of the current stream. */
  stopIntent: boolean;
  /**
   * Present when the message-shaping shim synthesized `tool_result`s for
   * orphan `tool_use` ids on the pre-injection assistant row, so the UI can
   * render "cancelled by new user message" hints.
   */
  syntheticToolResults?: SyntheticToolResultDescriptor[];
  /**
   * The id the server will use for the post-injection assistant row it
   * persists via the streaming→DB sync after this wire frame is processed.
   *
   * Why this field exists (branch-picker fix):
   *   When `computeInjectionSplice` rotates `activeState.message.id` on the
   *   client, and separately the server rotates its own `assistantMessageId`
   *   on the next `prepareStep` iteration, the two random UUIDs disagree.
   *   The client renders the post-injection assistant under the CLIENT id,
   *   but the DB row is persisted under the SERVER id. When
   *   `handleForegroundRunFinished` later calls
   *   `reloadSessionMessages({ force: true })`, the DB-derived snapshot
   *   replaces `chat.messages` with SERVER-id messages. Assistant-UI's
   *   `__internal_setAdapter` reconciler then feeds the new server-id row to
   *   `MessageRepository.addOrUpdateMessage` without pruning the old
   *   client-id row, so both live under the same parent (the injected user
   *   message) — producing a `← 2 / 2 →` branch picker.
   *
   * Fix: the server pre-generates the post-injection assistant id BEFORE
   * calling the injection handler and ships it to the client on this wire
   * frame. `computeInjectionSplice` uses this id instead of calling its
   * local `generateId()`. After the frame is processed, the server assigns
   * the same id to `assistantMessageId` so the DB row matches. Reload then
   * finds the same id already in the tree — idempotent no-op, no branch.
   *
   * Optional for backward-compat with older clients: when absent, the
   * client falls back to `generateId()` (preserves the old buggy behavior
   * rather than crashing).
   */
  nextAssistantMessageId?: string;
}

/**
 * Input shape for the emitter. `role` is stamped by the emitter itself
 * (always `"user"` for injected user messages) so callers never have to
 * repeat it.
 */
export type InjectedUserMessagePayload = Omit<InjectedUserMessageData, "role">;

/**
 * Minimal writer shape we depend on. The real AI SDK v6
 * `UIMessageStreamWriter<ChatUIMessage>` exposes `.write(chunk)`; we stay
 * loose here so the emitter is trivially unit-testable with a recording
 * double.
 */
export interface InjectionStreamWriter {
  write: (chunk: unknown) => void;
}

/**
 * Write an injected-user-message data part to the active UIMessageStream.
 *
 * Called from:
 *   - `app/api/chat/route.ts` inside `prepareStep` (non-Claude-Code) AFTER
 *     the DB row is committed and BEFORE the post-injection assistant
 *     content resumes.
 *   - `lib/ai/providers/claudecode-provider.ts` inside the `onQueueMessages`
 *     callback in `pumpLivePromptQueue`.
 *
 * The `transient: false` flag keeps the frame in the message `parts[]` for
 * debugging and reconnect-idempotency. The client transport intercepts
 * before `useChat`'s reducer sees it, so the frame never becomes visible
 * content — the rendered output is a separate synthesized user UIMessage.
 */
/**
 * Generate the post-injection `nextAssistantMessageId` value.
 *
 * Centralized so all three injection call sites in `app/api/chat/route.ts`
 * (Claude-Code primary branch, non-CC primary branch, and the
 * delegation-completion branch) can't accidentally diverge on the id
 * format. The contract is documented on
 * {@link InjectedUserMessageData.nextAssistantMessageId} — the id has to
 * match `MessageRepository`'s expectations on the client (any stable,
 * unique string) and round-trip cleanly through SQLite as the canonical
 * `messages.id` column. `crypto.randomUUID()` satisfies both.
 */
export function generateNextAssistantMessageId(): string {
  return crypto.randomUUID();
}

export function emitInjectedUserMessageChunk(
  writer: InjectionStreamWriter,
  payload: InjectedUserMessagePayload,
): void {
  // Stamp `role: "user"` here so the wire frame is self-describing even
  // though callers never have to pass it — the role is invariant for this
  // chunk type by construction.
  const data: InjectedUserMessageData = { ...payload, role: "user" };
  writer.write({
    type: INJECTED_USER_MESSAGE_CHUNK_TYPE,
    // AI SDK v6 requires a stable `id` on data parts for dedupe across
    // reconnects. Using the DB messageId guarantees idempotence.
    id: payload.messageId,
    data,
    transient: false,
  });
}

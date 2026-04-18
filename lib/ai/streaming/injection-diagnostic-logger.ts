/**
 * Mid-Stream User-Message Injection — Diagnostic Logger
 *
 * Dev-only instrumentation to trace the exact sequence of operations that
 * lead to the `MessageRepository(performOp/link): A message with the same id
 * already exists in the parent tree` crash.
 *
 * Three layers of logging:
 *
 *   1. Splice layer  — `logSpliceEntry` / `logSpliceExit` inside
 *      `computeInjectionSplice` so we see the exact input state and the
 *      rotation/seal decisions taken.
 *
 *   2. Chat-state layer — `patchChatState(chat)` monkey-patches the AI SDK
 *      Chat's `state.pushMessage` and `state.replaceMessage` so we see
 *      EVERY mutation on the underlying UIMessage array AND the id being
 *      pushed/replaced at each step. This is the layer where the duplicate
 *      id is most likely introduced.
 *
 *   3. Repository layer — `patchMessageRepository()` monkey-patches
 *      `@assistant-ui/core`'s `MessageRepository.prototype.addOrUpdateMessage`
 *      so the `performOp/link` duplicate-id error is caught with rich
 *      context (full tree state at crash time, plus the parent chain walk
 *      that triggered the throw) before it bubbles up to React.
 *
 * All logging is gated on `DIAGNOSTIC_ENABLED` — default ON in
 * non-production when the window flag or localStorage flag is NOT
 * explicitly set to "off". Set `window.__SELENE_INJECTION_LOG = "off"`
 * (or `localStorage.setItem("SELENE_INJECTION_LOG", "off")`) to silence.
 */

import type { UIMessage } from "ai";

// ─── Enable/disable ─────────────────────────────────────────────────────────

function readFlag(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (typeof window === "undefined") return true; // SSR / node — keep on for tests
  try {
    const fromWindow = (window as unknown as { __SELENE_INJECTION_LOG?: string })
      .__SELENE_INJECTION_LOG;
    if (fromWindow === "off") return false;
    if (fromWindow === "on") return true;
    const fromStorage = window.localStorage?.getItem("SELENE_INJECTION_LOG");
    if (fromStorage === "off") return false;
  } catch {
    // localStorage inaccessible in some Electron contexts — fall through
  }
  return true;
}

export const DIAGNOSTIC_ENABLED = readFlag();

const PREFIX = "[InjectionDiag]";

function safeStringify(value: unknown, maxLen = 800): string {
  try {
    const s = JSON.stringify(value);
    if (typeof s !== "string") return String(value);
    return s.length > maxLen ? s.slice(0, maxLen) + "...[truncated]" : s;
  } catch (error) {
    return `<unserializable: ${(error as Error).message}>`;
  }
}

// ─── Stack capture helper ──────────────────────────────────────────────────

/**
 * Capture the current call stack, strip the leading "Error:" / "Error\n"
 * prefix emitted by V8, drop the first N frames that point into our own
 * diagnostic wrapper, and return the next `maxFrames` as a single
 * newline-joined string. Cheap enough to call on every repo op in dev.
 */
function captureStack(maxFrames = 25, skipLeadingFrames = 2): string {
  const raw = new Error("diag-stack").stack ?? "";
  const lines = raw.split("\n");
  // Drop the "Error: diag-stack" header line + diagnostic-wrapper frames.
  const body = lines.slice(1 + skipLeadingFrames, 1 + skipLeadingFrames + maxFrames);
  return body.map((l) => l.trim()).join("\n");
}

// ─── Latest chat-state bridge ──────────────────────────────────────────────

/**
 * Read by `patchMessageRepository`'s `addOrUpdateMessage` wrapper so every
 * repo log can correlate the repo tree with the current UIMessage array.
 * DEV-ONLY module-level handle — never relied on by production code.
 *
 * Two install paths:
 *
 *   - `patchChatState(chat)` — used when `chat.state.pushMessage /
 *     replaceMessage / messages-setter` are exposed (older SDK shapes). In
 *     that case the `state` ref is saved here AND push/replace/set are
 *     instrumented.
 *
 *   - `registerChatMessagesSource({ getMessages })` — fallback for
 *     AI SDK v6 `useChat` which returns a `UseChatHelpers` PLAIN OBJECT
 *     that does not expose `.state` but DOES expose a live `messages`
 *     getter. We read through the getter on every snapshot call so we
 *     always see the current array, not a stale captured reference.
 */
interface ChatStateMessagesHandle {
  messages: UIMessage[];
}
let latestChatState: ChatStateMessagesHandle | null = null;
let latestChatMessagesGetter: (() => UIMessage[] | undefined) | null = null;

/**
 * Used by chat-provider.tsx to plug the v6 `UseChatHelpers` object into
 * the diagnostic bridge since its `.state` is private/not exposed. The
 * getter is called on every repo op, so any re-render produces the
 * up-to-date message array. Returns an uninstall function.
 */
export function registerChatMessagesSource(args: {
  getMessages: () => UIMessage[] | undefined;
}): () => void {
  if (!DIAGNOSTIC_ENABLED) return () => {};
  latestChatMessagesGetter = args.getMessages;
  return () => {
    if (latestChatMessagesGetter === args.getMessages) {
      latestChatMessagesGetter = null;
    }
  };
}

export function getLatestChatStateSnapshot(): {
  source: "chat.state" | "chat.messages-getter";
  length: number;
  ids: string[];
  roles: string[];
  duplicateIds: string[];
  summary: MessageSummary[];
} | null {
  // Prefer the getter (v6 path) since the `chat.messages` accessor is
  // always current; the `chat.state` path is a fallback for older SDKs.
  if (latestChatMessagesGetter) {
    const msgs = latestChatMessagesGetter();
    if (Array.isArray(msgs)) {
      return {
        source: "chat.messages-getter",
        length: msgs.length,
        ids: msgs.map((m) => m.id),
        roles: msgs.map((m) => m.role),
        duplicateIds: findDuplicateIds(msgs),
        summary: summarizeMessages(msgs),
      };
    }
  }
  if (latestChatState) {
    const msgs = latestChatState.messages;
    if (Array.isArray(msgs)) {
      return {
        source: "chat.state",
        length: msgs.length,
        ids: msgs.map((m) => m.id),
        roles: msgs.map((m) => m.role),
        duplicateIds: findDuplicateIds(msgs),
        summary: summarizeMessages(msgs),
      };
    }
  }
  return null;
}

// ─── Message summary helpers ────────────────────────────────────────────────

export interface MessageSummary {
  idx: number;
  id: string;
  role: string;
  partsLen: number;
  partTypes: string[];
  /** First 80 chars of concatenated text parts for disambiguation. */
  textPreview?: string;
  /** When the UIMessage was metadata-tagged as an injection. */
  injected?: boolean;
}

export function summarizeMessages(messages: readonly UIMessage[]): MessageSummary[] {
  return messages.map((m, idx) => {
    const partTypes = Array.isArray(m.parts)
      ? m.parts.map((p) => (p as { type?: string }).type ?? "unknown")
      : [];
    const textParts = Array.isArray(m.parts)
      ? m.parts
          .filter((p) => (p as { type?: string }).type === "text")
          .map((p) => (p as { text?: string }).text ?? "")
      : [];
    const textPreview = textParts.join("").slice(0, 80) || undefined;
    const meta = m.metadata as { livePromptInjected?: boolean } | undefined;
    return {
      idx,
      id: m.id,
      role: m.role,
      partsLen: Array.isArray(m.parts) ? m.parts.length : 0,
      partTypes,
      textPreview,
      injected: meta?.livePromptInjected === true ? true : undefined,
    };
  });
}

/** Returns the set of ids that appear more than once. */
export function findDuplicateIds(messages: readonly UIMessage[]): string[] {
  const counts = new Map<string, number>();
  for (const m of messages) {
    counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, c]) => c > 1).map(([id]) => id);
}

// ─── Splice-layer logging (called from computeInjectionSplice) ─────────────

export interface SpliceEntryLog {
  injectedMessageId: string;
  injectedSource?: string;
  prevLen: number;
  prevSummary: MessageSummary[];
  activeStateMessageId: string | null;
  activeStateActiveTextPartIds: string[];
  activeStateActiveReasoningIds: string[];
  activeStatePartialToolCallIds: string[];
}

export function logSpliceEntry(args: SpliceEntryLog): void {
  if (!DIAGNOSTIC_ENABLED) return;
  console.debug(`${PREFIX} SPLICE_ENTRY`, args);
}

export interface SpliceExitLog {
  injectedMessageId: string;
  alreadyApplied: boolean;
  sealedTail: boolean;
  sealedSnapshotId: string | null;
  newAssistantId: string | null;
  prevLen: number;
  nextLen: number;
  nextSummary: MessageSummary[];
  duplicateIdsAfterSplice: string[];
}

export function logSpliceExit(args: SpliceExitLog): void {
  if (!DIAGNOSTIC_ENABLED) return;
  console.debug(`${PREFIX} SPLICE_EXIT`, args);
  if (args.duplicateIdsAfterSplice.length > 0) {
    console.error(
      `${PREFIX} SPLICE_EXIT produced duplicate ids!`,
      { duplicateIds: args.duplicateIdsAfterSplice, nextSummary: args.nextSummary },
    );
  }
}

// ─── Chat-state layer (pushMessage / replaceMessage wrappers) ──────────────

interface ChatStateLike {
  pushMessage: (message: UIMessage) => void;
  replaceMessage: (index: number, message: UIMessage) => void;
  messages: UIMessage[];
}

interface ChatLike {
  state?: ChatStateLike;
}

type Uninstall = () => void;

/**
 * Monkey-patches `pushMessage` and `replaceMessage` on the underlying
 * AI SDK chat state so we log every mutation, the id being pushed/replaced,
 * and — critically — detect the moment the messages array acquires a
 * duplicate id. Returns an uninstall function.
 */
export function patchChatState(chat: unknown): Uninstall {
  if (!DIAGNOSTIC_ENABLED) return () => {};
  const c = chat as ChatLike;
  const state = c?.state;
  if (!state) {
    console.warn(`${PREFIX} patchChatState: chat.state not found — skipping`);
    return () => {};
  }
  if ((state as unknown as { __seleneInjectionPatched?: boolean }).__seleneInjectionPatched) {
    // already patched (e.g. StrictMode double-mount) — still refresh the
    // bridge so the repo-layer log has a live pointer to the current state.
    latestChatState = state as unknown as ChatStateMessagesHandle;
    return () => {};
  }
  // Expose the chat state to the repo-layer wrapper so every repo op can
  // snapshot `state.messages` at the moment of the op. Dev-only bridge —
  // cleared by the uninstall closure below.
  latestChatState = state as unknown as ChatStateMessagesHandle;
  const originalPush = state.pushMessage.bind(state);
  const originalReplace = state.replaceMessage.bind(state);

  let opSeq = 0;

  state.pushMessage = (message: UIMessage) => {
    const seq = ++opSeq;
    const beforeSummary = summarizeMessages(state.messages);
    const beforeIds = beforeSummary.map((m) => m.id);
    const beforeDup = findDuplicateIds(state.messages);
    originalPush(message);
    const afterSummary = summarizeMessages(state.messages);
    const afterDup = findDuplicateIds(state.messages);
    const duplicateIntroduced = afterDup.length > beforeDup.length;
    console.debug(`${PREFIX} state.pushMessage #${seq}`, {
      pushedId: message.id,
      pushedRole: message.role,
      pushedPartsLen: Array.isArray(message.parts) ? message.parts.length : 0,
      beforeIds,
      afterIds: afterSummary.map((m) => m.id),
      beforeDup,
      afterDup,
      duplicateIntroduced,
    });
    if (duplicateIntroduced) {
      console.error(
        `${PREFIX} state.pushMessage #${seq} INTRODUCED a duplicate id!`,
        {
          pushedId: message.id,
          afterSummary,
          afterDup,
          stack: new Error("duplicate id push").stack,
        },
      );
    }
  };

  state.replaceMessage = (index: number, message: UIMessage) => {
    const seq = ++opSeq;
    const beforeSummary = summarizeMessages(state.messages);
    const beforeIds = beforeSummary.map((m) => m.id);
    const prev = state.messages[index];
    const beforeDup = findDuplicateIds(state.messages);
    originalReplace(index, message);
    const afterSummary = summarizeMessages(state.messages);
    const afterDup = findDuplicateIds(state.messages);
    const duplicateIntroduced = afterDup.length > beforeDup.length;
    console.debug(`${PREFIX} state.replaceMessage #${seq}`, {
      index,
      prevId: prev?.id,
      newId: message.id,
      idChanged: prev?.id !== message.id,
      beforeIds,
      afterIds: afterSummary.map((m) => m.id),
      beforeDup,
      afterDup,
      duplicateIntroduced,
    });
    if (duplicateIntroduced) {
      console.error(
        `${PREFIX} state.replaceMessage #${seq} INTRODUCED a duplicate id!`,
        {
          index,
          prevId: prev?.id,
          newId: message.id,
          afterSummary,
          afterDup,
          stack: new Error("duplicate id replace").stack,
        },
      );
    }
  };

  // Messages setter — chat.setMessages goes through `messages = newMessages`.
  // Patch that too by replacing the descriptor.
  const proto = Object.getPrototypeOf(state) as object;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "messages");
  if (descriptor && typeof descriptor.set === "function" && typeof descriptor.get === "function") {
    const origSet = descriptor.set.bind(state);
    const origGet = descriptor.get.bind(state);
    Object.defineProperty(state, "messages", {
      configurable: true,
      enumerable: true,
      get: origGet,
      set: (newMessages: UIMessage[]) => {
        const seq = ++opSeq;
        const before = origGet() as UIMessage[];
        const beforeSummary = summarizeMessages(before);
        const afterSummary = summarizeMessages(newMessages);
        const afterDup = findDuplicateIds(newMessages);
        console.debug(`${PREFIX} state.messages= #${seq}`, {
          beforeLen: before.length,
          afterLen: newMessages.length,
          beforeIds: beforeSummary.map((m) => m.id),
          afterIds: afterSummary.map((m) => m.id),
          afterDup,
        });
        if (afterDup.length > 0) {
          console.error(
            `${PREFIX} state.messages= #${seq} SET a list containing duplicate ids!`,
            {
              afterSummary,
              afterDup,
              stack: new Error("duplicate id setter").stack,
            },
          );
        }
        origSet(newMessages);
      },
    });
  } else {
    console.warn(
      `${PREFIX} patchChatState: could not patch 'messages' setter (descriptor missing)`,
    );
  }

  (state as unknown as { __seleneInjectionPatched: boolean }).__seleneInjectionPatched = true;

  return () => {
    state.pushMessage = originalPush;
    state.replaceMessage = originalReplace;
    (state as unknown as { __seleneInjectionPatched?: boolean }).__seleneInjectionPatched = false;
    if (latestChatState === (state as unknown as ChatStateMessagesHandle)) {
      latestChatState = null;
    }
  };
}

// ─── Reconciliation-input bridge ───────────────────────────────────────────

/**
 * Populated by `patchExternalStoreReconciliation`: captures the ThreadMessage[]
 * array that `ExternalStoreThreadRuntimeCore.__internal_setAdapter` is about
 * to iterate in its `addOrUpdateMessage` loop. Read by the repo-layer
 * `addOrUpdate` wrapper so collision logs include the order of the input
 * array — that's the artifact we need to prove whether the splice is
 * emitting messages in the wrong order relative to the existing repo tree.
 */
let lastReconciliationInput: {
  ts: number;
  storeSource: "messages" | "messageRepository" | "unknown";
  threadMessagesIds: string[];
  threadMessagesRoles: string[];
  storeMessagesIds: string[] | null;
  storeMessagesRoles: string[] | null;
  storeIsRunning: boolean | undefined;
  callerStack: string;
} | null = null;

export function getLastReconciliationInput() {
  return lastReconciliationInput;
}

// ─── MessageRepository layer (ancestor-walk failure context) ───────────────

/**
 * Monkey-patches `@assistant-ui/core`'s `MessageRepository.prototype.addOrUpdateMessage`
 * so the `performOp/link` duplicate-id error is wrapped with rich context:
 *
 *   - the messageId we were trying to link,
 *   - the parentId it was being linked under,
 *   - the full ancestor chain that was walked,
 *   - the full current repository state,
 *
 * before re-throwing. This lets us see EXACTLY which existing message in
 * the tree shares an id with the one we're linking.
 *
 * We also log every successful addOrUpdate so we can trace the sequence
 * leading to the failure.
 *
 * Safe to call multiple times — installs once and no-ops on subsequent
 * calls.
 */
let messageRepositoryPatched = false;

interface RepositoryMessageLike {
  current: { id: string; role?: string };
  prev: RepositoryMessageLike | null;
  level: number;
  children: string[];
}

interface MessageRepositoryProtoLike {
  addOrUpdateMessage: (parentId: string | null, message: { id: string; role?: string }) => void;
  messages: Map<string, RepositoryMessageLike>;
  head: RepositoryMessageLike | null;
}

export async function patchMessageRepository(): Promise<void> {
  if (!DIAGNOSTIC_ENABLED) return;
  if (messageRepositoryPatched) return;

  let repoModule: unknown;
  try {
    // dynamic import so the patch doesn't run at module-load time (avoids
    // touching the internal import during SSR or in non-browser tests).
    // The path is a documented internal entry that re-exports
    // MessageRepository (see node_modules/@assistant-ui/core/dist/runtime/internal.d.ts).
    repoModule = await import("@assistant-ui/core/runtime/internal");
  } catch (error) {
    console.warn(
      `${PREFIX} patchMessageRepository: import failed — skipping`,
      (error as Error).message,
    );
    return;
  }

  const MessageRepositoryCtor = (repoModule as { MessageRepository?: new () => unknown })
    .MessageRepository;
  if (!MessageRepositoryCtor) {
    console.warn(
      `${PREFIX} patchMessageRepository: MessageRepository export not found — skipping`,
    );
    return;
  }

  const proto = MessageRepositoryCtor.prototype as unknown as MessageRepositoryProtoLike;
  if (!proto?.addOrUpdateMessage) {
    console.warn(
      `${PREFIX} patchMessageRepository: addOrUpdateMessage not found on prototype`,
    );
    return;
  }

  const originalAdd = proto.addOrUpdateMessage;

  let opSeq = 0;

  // Ring buffer of the last 20 addOrUpdate calls. Flushed to console.error
  // on throw so we can see the full sequence of parent/msg pairs leading
  // up to the collision without having to re-enable debug-level logging.
  // Each entry captures enough to reconstruct the reconciliation loop's
  // messages[] argument at call time.
  const callRing: Array<{
    seq: number;
    parentId: string | null;
    messageId: string;
    messageRole: string | undefined;
    existedInMap: boolean;
    repoSizeBefore: number;
    headIdBefore: string | null;
    ancestorIds: string[];
  }> = [];
  const RING_CAPACITY = 20;

  proto.addOrUpdateMessage = function patchedAddOrUpdate(
    this: MessageRepositoryProtoLike,
    parentId: string | null,
    message: { id: string; role?: string },
  ) {
    const seq = ++opSeq;
    const existingInMap = this.messages?.get?.(message.id);

    // Walk the ancestor chain that `performOp/link` will walk. If we see
    // the same id, we know the throw is about to fire.
    const parentNode = parentId ? this.messages?.get?.(parentId) : null;
    const ancestorChain: Array<{ id: string; level: number; role?: string }> = [];
    {
      let cur: RepositoryMessageLike | null | undefined = parentNode ?? null;
      while (cur) {
        ancestorChain.push({
          id: cur.current.id,
          level: cur.level,
          role: cur.current.role,
        });
        cur = cur.prev;
      }
    }
    const collidingAncestor = ancestorChain.find((a) => a.id === message.id) ?? null;

    // Capture the stack trace for EVERY call. Cheap in V8. Only logged at
    // console.error level (collision-predicted / throw paths) to keep the
    // normal debug output readable. Reading the slice at the top of
    // `addOrUpdate` means frames 0-1 are our wrapper itself; frames 2+ are
    // the caller chain we care about (AISDKMessageConverter / runtime /
    // useAISDKRuntime / useExternalStoreRuntime).
    const callerStack = captureStack(30, 2);

    // Correlate with the live chat state so we can see whether
    // `state.messages` order matches the repo tree order at this instant.
    // If state.messages has user-injected BEFORE the pre-injection
    // assistant (i.e. reordered relative to prev chain), this snapshot
    // will show it and pin suspect 1 (splice reorder) conclusively.
    const chatStateSnapshot = getLatestChatStateSnapshot();

    // Push to ring buffer BEFORE the op runs. We log the lightweight ring
    // contents on both the collision-predict path AND the throw path so we
    // can reconstruct the exact parent/msg sequence even if the electron
    // console elides prior debug-level lines.
    callRing.push({
      seq,
      parentId,
      messageId: message.id,
      messageRole: message.role,
      existedInMap: Boolean(existingInMap),
      repoSizeBefore: this.messages?.size ?? 0,
      headIdBefore: this.head?.current.id ?? null,
      ancestorIds: ancestorChain.map((a) => a.id),
    });
    if (callRing.length > RING_CAPACITY) callRing.shift();

    console.debug(`${PREFIX} repo.addOrUpdateMessage #${seq}`, {
      parentId,
      messageId: message.id,
      messageRole: message.role,
      existedInMap: Boolean(existingInMap),
      repoSize: this.messages?.size ?? 0,
      headId: this.head?.current.id ?? null,
      ancestorChain,
      collidingAncestor,
    });

    if (collidingAncestor) {
      console.error(
        `${PREFIX} repo.addOrUpdateMessage #${seq} IS ABOUT TO THROW — collision predicted`,
        {
          parentId,
          messageId: message.id,
          collidingAncestor,
          ancestorChain,
          repoDump: dumpRepository(this),
          chatStateSnapshot,
          callerStack,
          recentCalls: callRing.slice(),
          lastReconciliationInput: lastReconciliationInput,
        },
      );
    }

    try {
      return originalAdd.call(this, parentId, message);
    } catch (error) {
      console.error(
        `${PREFIX} repo.addOrUpdateMessage #${seq} THREW`,
        {
          parentId,
          messageId: message.id,
          existedInMap: Boolean(existingInMap),
          ancestorChain,
          collidingAncestor,
          repoDump: dumpRepository(this),
          chatStateSnapshot,
          callerStack,
          recentCalls: callRing.slice(),
          lastReconciliationInput: lastReconciliationInput,
          error: (error as Error).message,
        },
      );
      throw error;
    }
  } as MessageRepositoryProtoLike["addOrUpdateMessage"];

  messageRepositoryPatched = true;
  console.debug(`${PREFIX} MessageRepository.addOrUpdateMessage patched`);
}

// ─── ExternalStoreThreadRuntimeCore.__internal_setAdapter patch ────────────

/**
 * Monkey-patches `ExternalStoreThreadRuntimeCore.prototype.__internal_setAdapter`
 * so every reconciliation call records the ThreadMessage[] it's about to
 * iterate. The repo-layer `addOrUpdate` wrapper reads `lastReconciliationInput`
 * so crash reports include both:
 *
 *   - the ORDER of `chat.messages` (UIMessage[], via `store.messages`),
 *   - the ORDER of `threadMessages` (ThreadMessage[], after converter),
 *
 * which is the data we need to prove where an order inversion came from.
 *
 * The hook runs `originalSetAdapter` unchanged — no semantic change.
 */
let reconciliationPatched = false;

interface ExternalStoreThreadRuntimeCoreLike {
  __internal_setAdapter: (store: {
    messages?: readonly { id: string; role?: string }[];
    messageRepository?: unknown;
    isRunning?: boolean;
    convertMessage?: unknown;
  }) => void;
  _messages?: readonly { id: string; role?: string }[];
}

export async function patchExternalStoreReconciliation(): Promise<void> {
  if (!DIAGNOSTIC_ENABLED) return;
  if (reconciliationPatched) return;

  let runtimeModule: unknown;
  try {
    runtimeModule = await import("@assistant-ui/core/runtime/internal");
  } catch (error) {
    console.warn(
      `${PREFIX} patchExternalStoreReconciliation: import failed — skipping`,
      (error as Error).message,
    );
    return;
  }

  const Ctor = (runtimeModule as {
    ExternalStoreThreadRuntimeCore?: new (...args: unknown[]) => unknown;
  }).ExternalStoreThreadRuntimeCore;
  if (!Ctor) {
    console.warn(
      `${PREFIX} patchExternalStoreReconciliation: ExternalStoreThreadRuntimeCore not found — skipping`,
    );
    return;
  }

  const proto = Ctor.prototype as unknown as ExternalStoreThreadRuntimeCoreLike;
  if (!proto?.__internal_setAdapter) {
    console.warn(
      `${PREFIX} patchExternalStoreReconciliation: __internal_setAdapter not found on prototype`,
    );
    return;
  }

  const originalSetAdapter = proto.__internal_setAdapter;

  let setAdapterSeq = 0;

  proto.__internal_setAdapter = function patchedSetAdapter(
    this: ExternalStoreThreadRuntimeCoreLike,
    store: {
      messages?: readonly { id: string; role?: string }[];
      messageRepository?: unknown;
      isRunning?: boolean;
      convertMessage?: unknown;
    },
  ) {
    const seq = ++setAdapterSeq;
    const storeMessages = store?.messages;
    const storeMessagesIds = Array.isArray(storeMessages)
      ? storeMessages.map((m) => m.id)
      : null;
    const storeMessagesRoles = Array.isArray(storeMessages)
      ? storeMessages.map((m) => m.role ?? "?")
      : null;
    const storeSource = store?.messageRepository
      ? "messageRepository"
      : store?.messages
        ? "messages"
        : "unknown";
    const callerStack = captureStack(20, 2);

    // Capture BEFORE the call so the repo-layer wrapper (which runs
    // synchronously inside the reconciliation loop) can read the bridge.
    // threadMessagesIds is populated AFTER the converter runs — we cannot
    // know it from here (it's a private local in `__internal_setAdapter`).
    // So we capture the BEFORE shape and trust that any ordering bug
    // would manifest as the repo-layer log recording a call with a
    // parentId that doesn't match storeMessages[i-1].id in order.
    lastReconciliationInput = {
      ts: Date.now(),
      storeSource,
      threadMessagesIds: [],
      threadMessagesRoles: [],
      storeMessagesIds,
      storeMessagesRoles,
      storeIsRunning: store?.isRunning,
      callerStack,
    };

    console.debug(`${PREFIX} __internal_setAdapter #${seq} ENTER`, {
      storeSource,
      storeIsRunning: store?.isRunning,
      storeMessagesLen: storeMessages?.length ?? null,
      storeMessagesIds,
      storeMessagesRoles,
    });

    const result = originalSetAdapter.call(this, store);

    // AFTER: capture the reconciled threadMessages order from _messages.
    const threadMessages = (this._messages ?? []) as ReadonlyArray<{ id: string; role?: string }>;
    if (lastReconciliationInput) {
      lastReconciliationInput.threadMessagesIds = threadMessages.map((m) => m.id);
      lastReconciliationInput.threadMessagesRoles = threadMessages.map((m) => m.role ?? "?");
    }

    console.debug(`${PREFIX} __internal_setAdapter #${seq} EXIT`, {
      threadMessagesLen: threadMessages.length,
      threadMessagesIds: threadMessages.map((m) => m.id),
      threadMessagesRoles: threadMessages.map((m) => m.role ?? "?"),
    });

    return result;
  } as ExternalStoreThreadRuntimeCoreLike["__internal_setAdapter"];

  reconciliationPatched = true;
  console.debug(
    `${PREFIX} ExternalStoreThreadRuntimeCore.__internal_setAdapter patched`,
  );
}

function dumpRepository(repo: MessageRepositoryProtoLike): unknown {
  const entries: Array<{
    id: string;
    role?: string;
    level: number;
    prevId: string | null;
    children: string[];
  }> = [];
  repo.messages?.forEach?.((value, key) => {
    entries.push({
      id: key,
      role: value.current.role,
      level: value.level,
      prevId: value.prev?.current.id ?? null,
      children: value.children,
    });
  });
  return {
    size: entries.length,
    headId: repo.head?.current.id ?? null,
    messages: entries,
  };
}

/**
 * Log a summary of the stream chunk. Called from the transport's
 * `processResponseStream` transform so we can correlate chunk sequence
 * with `state.*` mutations.
 */
export function logStreamChunk(
  chunk: { type?: string } & Record<string, unknown>,
  activeMessageId: string | null,
  messagesTailId: string | null,
): void {
  if (!DIAGNOSTIC_ENABLED) return;
  const type = chunk.type;
  if (!type) return;

  // Only log ID-relevant fields so the console stays readable. Full delta
  // text is logged at 20-char preview to keep noise down.
  const preview: Record<string, unknown> = { type };
  if ("id" in chunk && typeof chunk.id === "string") preview.id = chunk.id;
  if ("messageId" in chunk && typeof chunk.messageId === "string") preview.messageId = chunk.messageId;
  if ("toolCallId" in chunk && typeof chunk.toolCallId === "string") preview.toolCallId = chunk.toolCallId;
  if ("toolName" in chunk && typeof chunk.toolName === "string") preview.toolName = chunk.toolName;
  if ("delta" in chunk && typeof chunk.delta === "string") {
    preview.deltaLen = chunk.delta.length;
    preview.deltaPreview = chunk.delta.slice(0, 20);
  }

  console.debug(`${PREFIX} chunk`, {
    ...preview,
    activeMessageId,
    messagesTailId,
  });
}

// ─── One-shot bootstrap ─────────────────────────────────────────────────────

/**
 * Call once at app startup (e.g. from chat-provider.tsx). Safe to call
 * multiple times.
 */
let bootstrapStarted = false;
export function bootstrapInjectionDiagnostics(): void {
  if (!DIAGNOSTIC_ENABLED) return;
  if (bootstrapStarted) return;
  bootstrapStarted = true;
  console.debug(
    `${PREFIX} bootstrap starting (NODE_ENV=${process.env.NODE_ENV}). ` +
      `Set window.__SELENE_INJECTION_LOG = "off" or ` +
      `localStorage.setItem("SELENE_INJECTION_LOG", "off") to silence.`,
  );
  // Kick off the async MessageRepository patch without awaiting — any
  // addOrUpdateMessage call before the patch completes simply won't be
  // logged, but that's fine for the first few ms of app startup.
  void patchMessageRepository();
  // Also patch the reconciliation entry point so we see exactly what
  // ThreadMessage[] array the addOrUpdateMessage loop was iterating when
  // a collision fired. Data is exposed via `lastReconciliationInput` in
  // every repo-layer collision/throw log.
  void patchExternalStoreReconciliation();
  // Leave a global so the user can dump a snapshot from the devtools.
  if (typeof window !== "undefined") {
    (window as unknown as { __seleneInjectionDiag?: unknown }).__seleneInjectionDiag = {
      summarizeMessages,
      findDuplicateIds,
      safeStringify,
    };
  }
}

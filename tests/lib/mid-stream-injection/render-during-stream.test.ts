/**
 * Mid-Stream Injection Render — Phase 2 failing reproduction.
 *
 * Bug: When a user injects a message while an assistant stream is live, the
 * message is queued and eventually consumed by the model, but it is NEVER
 * rendered in the assistant-ui thread mid-stream. On long-history sessions
 * this manifests as a race: the `reloadSessionMessages({ force: true })`
 * recovery path fights `useChat`'s reconciliation of incremental `parts`
 * arrays and the injected user row is never visible.
 *
 * Root cause (see Phase 1 report): the AI SDK v5 `UIMessageChunk` wire
 * protocol as emitted from `app/api/chat/route.ts:1798` has NO frame that
 * tells the client "a new user turn appeared". The server persists the row
 * to DB (route.ts:1253 / claudecode-provider.ts:837) but emits nothing on
 * the active stream.
 *
 * Contract this test enforces (what Phase 4 must implement):
 *   1. A module `@/lib/ai/streaming/injection-stream-emitter` exports a
 *      stable `INJECTED_USER_MESSAGE_CHUNK_TYPE` constant and an
 *      `emitInjectedUserMessageChunk(writer, payload)` helper that writes a
 *      detectable wire chunk to the active UIMessageStream writer.
 *   2. A module `@/lib/ai/streaming/injection-handler` exports
 *      `handleInjectedPromptsNonCC` and `handleInjectedPromptsCC` which
 *      encapsulate the injection flow currently duplicated inline at
 *      route.ts:1219–1265 and claudecode-provider.ts:808–849. They must:
 *        a) seal the pre-injection assistant partial (syncStreamingMessage(true))
 *        b) rotate the assistant message ID + reset streaming state
 *        c) persist each injected user row via createMessage() with a fresh
 *           orderingIndex allocated after the sealed assistant row
 *        d) ALSO write an injected-user-message chunk to the UI stream
 *           writer for EACH queued prompt, in insertion order, AFTER the DB
 *           row exists and BEFORE the post-injection assistant content
 *           resumes
 *        e) honor stopIntent: if any queued prompt has stopIntent=true,
 *           signal a clean abort instead of queue-after
 *
 * The test imports both modules up front. Until Phase 4 creates them, the
 * entire suite fails at import — which is the correct "red" state for TDD.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================================
// DB mocks — same pattern as tests/lib/context-window/compaction-boundary.test.ts
// ============================================================================

const dbMocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  updateMessage: vi.fn(),
  nextOrderingIndex: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({
  createMessage: dbMocks.createMessage,
  updateMessage: dbMocks.updateMessage,
}));

// `nextOrderingIndex` lives in the session module (not @/lib/db/queries);
// mock it there so tests don't pull in SQLite driver initialization via
// the session/message-ordering → lib/db/sqlite-client chain.
vi.mock("@/lib/session/message-ordering", () => ({
  nextOrderingIndex: dbMocks.nextOrderingIndex,
}));

// ============================================================================
// Fixtures
// ============================================================================

import type { LivePromptEntry } from "@/lib/background-tasks/live-prompt-queue-registry";

function makeQueueEntry(
  overrides: Partial<LivePromptEntry> = {},
): LivePromptEntry {
  return {
    id: overrides.id ?? `inj-${Math.random().toString(36).slice(2, 8)}`,
    content: overrides.content ?? "injected from test",
    stopIntent: overrides.stopIntent ?? false,
    timestamp: overrides.timestamp ?? Date.now(),
    metadata: overrides.metadata,
  };
}

/**
 * Minimal simulation of an AI SDK v5 UIMessageStream writer. The emitter
 * under test must call `.write(chunk)` on this object. We record every
 * write for assertions.
 */
function makeRecordingWriter() {
  const chunks: unknown[] = [];
  return {
    writer: {
      write(chunk: unknown) {
        chunks.push(chunk);
      },
    },
    chunks,
  };
}

/**
 * Mirror of the streaming state object used in route.ts/claudecode-provider.
 * Only the fields the injection handler touches.
 */
function makeStreamingState(messageId: string) {
  return {
    messageId,
    parts: [] as unknown[],
    toolCallParts: new Map<string, unknown>(),
    loggedIncompleteToolCalls: new Set<string>(),
    lastBroadcastAt: 0,
    lastBroadcastSignature: "",
    pendingBroadcast: false,
    isCreating: false,
    stepOffset: 0,
  };
}

// ============================================================================
// Suite 1 — Wire protocol contract
// ============================================================================

describe("injection wire protocol (new UIMessageChunk extension)", () => {
  it("exposes a stable chunk type identifier and an emit helper", async () => {
    const mod = await import(
      "@/lib/ai/streaming/injection-stream-emitter"
    );

    expect(typeof mod.INJECTED_USER_MESSAGE_CHUNK_TYPE).toBe("string");
    // Must follow AI SDK v5 custom data-part naming so useChat treats it as
    // a typed data part rather than an unknown chunk.
    expect(mod.INJECTED_USER_MESSAGE_CHUNK_TYPE).toMatch(/^data-/);

    expect(typeof mod.emitInjectedUserMessageChunk).toBe("function");
  });

  it("writes a detectable chunk carrying messageId, role=user, text, orderingIndex, sessionId, source, and stopIntent", async () => {
    const { emitInjectedUserMessageChunk, INJECTED_USER_MESSAGE_CHUNK_TYPE } =
      await import("@/lib/ai/streaming/injection-stream-emitter");

    const { writer, chunks } = makeRecordingWriter();

    emitInjectedUserMessageChunk(writer, {
      messageId: "db-row-abc123",
      sessionId: "sess-1",
      orderingIndex: 42,
      text: "Stop — I meant ask about X instead",
      source: "web",
      stopIntent: false,
      createdAt: "2026-04-17T20:00:00.000Z",
    });

    expect(chunks).toHaveLength(1);
    const chunk = chunks[0] as Record<string, unknown>;

    expect(chunk.type).toBe(INJECTED_USER_MESSAGE_CHUNK_TYPE);
    // AI SDK v5 data-parts requirement: chunk `id` equals the DB row id so
    // re-delivery on reconnect is idempotent (transport will dedupe on id).
    expect(chunk.id).toBe("db-row-abc123");
    // Persist the frame in the assistant parts[] for debugging; transport
    // swallows before forwarding to useChat, so this never reaches the reducer.
    expect(chunk.transient).toBe(false);

    const data = chunk.data as Record<string, unknown>;
    expect(data).toBeDefined();
    expect(data.messageId).toBe("db-row-abc123");
    expect(data.sessionId).toBe("sess-1");
    expect(data.role).toBe("user");
    expect(data.text).toBe("Stop — I meant ask about X instead");
    expect(data.orderingIndex).toBe(42);
    expect(data.source).toBe("web");
    expect(data.stopIntent).toBe(false);
    expect(data.createdAt).toBe("2026-04-17T20:00:00.000Z");
  });

  it("roundtrips through JSON (SSE safety) without losing fields", async () => {
    const { emitInjectedUserMessageChunk } = await import(
      "@/lib/ai/streaming/injection-stream-emitter"
    );

    const { writer, chunks } = makeRecordingWriter();

    emitInjectedUserMessageChunk(writer, {
      messageId: "db-json-1",
      sessionId: "sess-j",
      orderingIndex: 7,
      text: "newline \n and \"quotes\" and emoji 👀",
      source: "telegram",
      stopIntent: false,
      createdAt: "2026-04-17T20:00:00.000Z",
    });

    const serialized = JSON.stringify(chunks[0]);
    const parsed = JSON.parse(serialized);

    expect(parsed.id).toBe("db-json-1");
    expect(parsed.data.text).toBe(
      "newline \n and \"quotes\" and emoji 👀",
    );
    expect(parsed.data.orderingIndex).toBe(7);
    expect(parsed.data.source).toBe("telegram");
  });

  it("preserves FIFO when multiple injections are emitted", async () => {
    const { emitInjectedUserMessageChunk } = await import(
      "@/lib/ai/streaming/injection-stream-emitter"
    );

    const { writer, chunks } = makeRecordingWriter();

    for (const [i, text] of ["first", "second", "third"].entries()) {
      emitInjectedUserMessageChunk(writer, {
        messageId: `db-${i + 1}`,
        sessionId: "sess-fifo",
        orderingIndex: 10 + i,
        text,
        source: "web",
        stopIntent: false,
        createdAt: "2026-04-17T20:00:00.000Z",
      });
    }

    expect(chunks.map((c) => (c as any).data.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(chunks.map((c) => (c as any).data.orderingIndex)).toEqual([
      10, 11, 12,
    ]);
  });

  it("propagates syntheticToolResultDescriptors when the shim produced them", async () => {
    const { emitInjectedUserMessageChunk } = await import(
      "@/lib/ai/streaming/injection-stream-emitter"
    );

    const { writer, chunks } = makeRecordingWriter();

    emitInjectedUserMessageChunk(writer, {
      messageId: "db-shim-1",
      sessionId: "sess-shim",
      orderingIndex: 50,
      text: "hi mid-tool",
      source: "web",
      stopIntent: false,
      createdAt: "2026-04-17T20:00:00.000Z",
      syntheticToolResults: [
        { toolCallId: "tc-open-1", toolName: "readFile" },
        { toolCallId: "tc-open-2", toolName: "bash" },
      ],
    });

    const data = (chunks[0] as any).data;
    expect(data.syntheticToolResults).toEqual([
      { toolCallId: "tc-open-1", toolName: "readFile" },
      { toolCallId: "tc-open-2", toolName: "bash" },
    ]);
  });
});

// ============================================================================
// Suite 2 — Non-Claude-Code injection handler
// ============================================================================

describe("handleInjectedPromptsNonCC — covers route.ts:1219–1265", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Allocate orderingIndex deterministically: start at 100.
    let next = 100;
    dbMocks.nextOrderingIndex.mockImplementation(async () => next++);
    dbMocks.createMessage.mockImplementation(async (args: any) => ({
      id: `db-${args.orderingIndex}`,
      ...args,
    }));
    dbMocks.updateMessage.mockResolvedValue(undefined);
  });

  it("seals the pre-injection assistant, persists the user row, and emits a chunk — in order", async () => {
    const { handleInjectedPromptsNonCC } = await import(
      "@/lib/ai/streaming/injection-handler"
    );

    const state = makeStreamingState("pre-assistant-msg-id");
    const syncCalls: Array<{ flush: boolean; order: number }> = [];
    let order = 0;

    const syncStreamingMessage = vi.fn(async (flush?: boolean) => {
      syncCalls.push({ flush: !!flush, order: order++ });
    });

    const { writer, chunks } = makeRecordingWriter();

    const result = await handleInjectedPromptsNonCC({
      sessionId: "sess-1",
      prompts: [makeQueueEntry({ id: "inj-1", content: "mid-stream hi" })],
      streamingState: state,
      syncStreamingMessage,
      writer,
      stepNumber: 3,
    });

    // 1. Pre-injection assistant was sealed with flush=true
    expect(syncStreamingMessage).toHaveBeenCalledTimes(1);
    expect(syncCalls[0]).toEqual({ flush: true, order: 0 });

    // 2. Pre-injection assistant row was tagged with livePromptInjected=true
    expect(dbMocks.updateMessage).toHaveBeenCalledWith(
      "pre-assistant-msg-id",
      expect.objectContaining({
        metadata: expect.objectContaining({ livePromptInjected: true }),
      }),
    );

    // 3. Injected user row persisted with fresh orderingIndex=100
    expect(dbMocks.createMessage).toHaveBeenCalledTimes(1);
    const createCall = dbMocks.createMessage.mock.calls[0]?.[0];
    expect(createCall).toMatchObject({
      sessionId: "sess-1",
      role: "user",
      content: [{ type: "text", text: "mid-stream hi" }],
      orderingIndex: 100,
      metadata: expect.objectContaining({ livePromptInjected: true }),
    });

    // 4. Wire chunk emitted — THE CORE BUG FIX
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0] as any;
    expect(chunk.type).toBe("data-injected-user-message");
    expect(chunk.data.role).toBe("user");
    expect(chunk.data.text).toBe("mid-stream hi");
    expect(chunk.data.orderingIndex).toBe(100);
    expect(chunk.data.sessionId).toBe("sess-1");
    expect(chunk.data.messageId).toBeTypeOf("string");

    // 5. Streaming state was reset so post-injection assistant content
    //    starts a new DB row.
    expect(state.messageId).toBeUndefined();
    expect(state.parts).toEqual([]);

    // 6. No abort signalled (stopIntent=false by default).
    expect(result.abort).toBe(false);
  });

  it("emits chunks in FIFO order when multiple injections stack", async () => {
    const { handleInjectedPromptsNonCC } = await import(
      "@/lib/ai/streaming/injection-handler"
    );

    const state = makeStreamingState("pre-msg");
    const syncStreamingMessage = vi.fn(async () => {});
    const { writer, chunks } = makeRecordingWriter();

    await handleInjectedPromptsNonCC({
      sessionId: "sess-1",
      prompts: [
        makeQueueEntry({ id: "inj-1", content: "one" }),
        makeQueueEntry({ id: "inj-2", content: "two" }),
        makeQueueEntry({ id: "inj-3", content: "three" }),
      ],
      streamingState: state,
      syncStreamingMessage,
      writer,
      stepNumber: 1,
    });

    expect(dbMocks.createMessage).toHaveBeenCalledTimes(3);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => (c as any).data.text)).toEqual([
      "one",
      "two",
      "three",
    ]);
    // Ordering indices must be monotonically increasing and contiguous from
    // the mock starting point (100), which preserves the
    // edit/reload truncation invariant in route.ts.
    expect(chunks.map((c) => (c as any).data.orderingIndex)).toEqual([
      100, 101, 102,
    ]);
  });

  it("signals abort=true when any prompt has stopIntent=true", async () => {
    const { handleInjectedPromptsNonCC } = await import(
      "@/lib/ai/streaming/injection-handler"
    );

    const state = makeStreamingState("pre-msg");
    const syncStreamingMessage = vi.fn(async () => {});
    const { writer } = makeRecordingWriter();

    const result = await handleInjectedPromptsNonCC({
      sessionId: "sess-1",
      prompts: [
        makeQueueEntry({ id: "inj-1", content: "nvm, stop" , stopIntent: true }),
      ],
      streamingState: state,
      syncStreamingMessage,
      writer,
      stepNumber: 2,
    });

    expect(result.abort).toBe(true);
  });

  it("does not seal or emit when the queue is empty", async () => {
    const { handleInjectedPromptsNonCC } = await import(
      "@/lib/ai/streaming/injection-handler"
    );

    const state = makeStreamingState("pre-msg");
    const syncStreamingMessage = vi.fn(async () => {});
    const { writer, chunks } = makeRecordingWriter();

    const result = await handleInjectedPromptsNonCC({
      sessionId: "sess-1",
      prompts: [],
      streamingState: state,
      syncStreamingMessage,
      writer,
      stepNumber: 0,
    });

    expect(syncStreamingMessage).not.toHaveBeenCalled();
    expect(dbMocks.createMessage).not.toHaveBeenCalled();
    expect(chunks).toHaveLength(0);
    expect(result.abort).toBe(false);
  });
});

// ============================================================================
// Suite 3 — Claude Code injection handler
// ============================================================================

describe("handleInjectedPromptsCC — covers claudecode-provider.ts:808–849", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let next = 200;
    dbMocks.nextOrderingIndex.mockImplementation(async () => next++);
    dbMocks.createMessage.mockImplementation(async (args: any) => ({
      id: `db-${args.orderingIndex}`,
      ...args,
    }));
    dbMocks.updateMessage.mockResolvedValue(undefined);
  });

  it("writes the same wire chunk as the non-CC path so the client treats both identically", async () => {
    const { handleInjectedPromptsCC } = await import(
      "@/lib/ai/streaming/injection-handler"
    );

    const state = makeStreamingState("cc-pre-msg");
    const syncStreamingMessage = vi.fn(async (_flush?: boolean) => {});
    const { writer, chunks } = makeRecordingWriter();

    await handleInjectedPromptsCC({
      sessionId: "sess-cc-1",
      prompts: [
        makeQueueEntry({ id: "cc-inj-1", content: "from CC mid-hook" }),
      ],
      streamingState: state,
      syncStreamingMessage,
      writer,
    });

    expect(dbMocks.createMessage).toHaveBeenCalledTimes(1);
    expect(chunks).toHaveLength(1);

    // Same wire format as non-CC path — the transport can't tell them apart,
    // so both providers behave identically from the client's perspective.
    const chunk = chunks[0] as any;
    expect(chunk.type).toBe("data-injected-user-message");
    expect(chunk.data.role).toBe("user");
    expect(chunk.data.text).toBe("from CC mid-hook");
    expect(chunk.data.orderingIndex).toBe(200);
    expect(chunk.data.sessionId).toBe("sess-cc-1");
  });

  it("emits one chunk per injected prompt in insertion order", async () => {
    const { handleInjectedPromptsCC } = await import(
      "@/lib/ai/streaming/injection-handler"
    );

    const state = makeStreamingState("cc-pre-msg");
    const syncStreamingMessage = vi.fn(async () => {});
    const { writer, chunks } = makeRecordingWriter();

    await handleInjectedPromptsCC({
      sessionId: "sess-cc-1",
      prompts: [
        makeQueueEntry({ id: "cc-1", content: "a" }),
        makeQueueEntry({ id: "cc-2", content: "b" }),
      ],
      streamingState: state,
      syncStreamingMessage,
      writer,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => (c as any).data.text)).toEqual(["a", "b"]);
  });
});

// ============================================================================
// Suite 4 — Long-history regression guard
// ============================================================================

describe("long-history session (100+ turns) — orderingIndex invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Simulate a session that already has 100 prior turns (orderingIndex 1..200).
    let next = 201;
    dbMocks.nextOrderingIndex.mockImplementation(async () => next++);
    dbMocks.createMessage.mockImplementation(async (args: any) => ({
      id: `db-${args.orderingIndex}`,
      ...args,
    }));
    dbMocks.updateMessage.mockResolvedValue(undefined);
  });

  it("allocates orderingIndex AFTER the sealed pre-injection row, preserving the truncation invariant", async () => {
    const { handleInjectedPromptsNonCC } = await import(
      "@/lib/ai/streaming/injection-handler"
    );

    const state = makeStreamingState("pre-assistant-turn-100");
    const syncStreamingMessage = vi.fn(async () => {});
    const { writer, chunks } = makeRecordingWriter();

    await handleInjectedPromptsNonCC({
      sessionId: "sess-long",
      prompts: [makeQueueEntry({ id: "inj-long", content: "on turn 100" })],
      streamingState: state,
      syncStreamingMessage,
      writer,
      stepNumber: 42,
    });

    // The orderingIndex allocator was invoked — AFTER sync() sealed the
    // pre-injection assistant row. Because nextOrderingIndex is a DB query
    // in production, this ordering guarantees the injection index is
    // strictly greater than the sealed assistant's index.
    expect(dbMocks.nextOrderingIndex).toHaveBeenCalledWith("sess-long");
    expect((chunks[0] as any).data.orderingIndex).toBe(201);

    // sync was called before the orderingIndex allocation (sealing first
    // is what establishes the "strictly greater" guarantee).
    const syncCallOrder =
      syncStreamingMessage.mock.invocationCallOrder[0] ?? Infinity;
    const allocateCallOrder =
      dbMocks.nextOrderingIndex.mock.invocationCallOrder[0] ?? -Infinity;
    expect(syncCallOrder).toBeLessThan(allocateCallOrder);
  });
});

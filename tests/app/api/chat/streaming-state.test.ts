import { describe, expect, it, vi, beforeEach } from "vitest";

// Use vi.hoisted to create the mock map before mocks are processed
const { mockActiveDelegations } = vi.hoisted(() => {
  return {
    mockActiveDelegations: new Map(),
  };
});

// Mock the module with a factory function that returns the mock
vi.mock("@/lib/ai/tools/delegate-to-subagent-types", () => {
  return {
    activeDelegations: mockActiveDelegations,
  };
});

import {
  sealDanglingToolCalls,
  shouldKeepDelegatedToolCallPending,
  appendReasoningPartToState,
  recordToolInputStart,
  recordToolInputDelta,
  recordStructuredToolCall,
  recordToolResultChunk,
  MAX_ARGS_TEXT_BYTES,
  type StreamingMessageState,
} from "@/app/api/chat/streaming-state";
import type { DBContentPart, DBToolCallPart } from "@/lib/messages/converter";

function makeState(parts: DBContentPart[]): StreamingMessageState {
  return {
    parts,
    toolCallParts: new Map(),
    loggedIncompleteToolCalls: new Set(),
    lastBroadcastAt: 0,
    lastBroadcastSignature: "",
  };
}

describe("sealDanglingToolCalls", () => {
  beforeEach(() => {
    mockActiveDelegations.clear();
  });

  it("seals tool calls without matching results as error", () => {
    const state = makeState([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "readFile",
        args: { filePath: "test.ts" },
        state: "input-available",
      },
    ]);

    const changed = sealDanglingToolCalls(state);

    expect(changed).toBe(true);
    expect(state.parts).toHaveLength(2);
    expect(state.parts[1]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-1",
      result: {
        status: "error",
        error: "Tool execution ended before a result was persisted.",
        reconstructed: true,
      },
      status: "error",
      state: "output-error",
    });
  });

  it("does not seal tool calls that already have results", () => {
    const state = makeState([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "readFile",
        args: { filePath: "test.ts" },
        state: "input-available",
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "readFile",
        result: { status: "success" },
        status: "success",
        state: "output-available",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const changed = sealDanglingToolCalls(state);

    expect(changed).toBe(false);
    expect(state.parts).toHaveLength(2);
  });

  it("does not seal observe calls for delegations that are still running", () => {
    // Set up a running delegation
    mockActiveDelegations.set("del-123", {
      id: "del-123",
      settled: false,
      sessionId: "sess-456",
    });

    const state = makeState([
      {
        type: "tool-call",
        toolCallId: "call-observe-1",
        toolName: "delegateToSubagent",
        args: { action: "observe", delegationId: "del-123" },
        state: "input-available",
      },
    ]);

    const changed = sealDanglingToolCalls(state);

    // Should NOT seal the observe call because the delegation is still running
    expect(changed).toBe(false);
    expect(state.parts).toHaveLength(1);
    expect(state.parts[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "call-observe-1",
      state: "input-available",
    });
  });

  it("seals observe calls for delegations that have settled", () => {
    // Set up a settled delegation
    mockActiveDelegations.set("del-123", {
      id: "del-123",
      settled: true,
      sessionId: "sess-456",
    });

    const state = makeState([
      {
        type: "tool-call",
        toolCallId: "call-observe-1",
        toolName: "delegateToSubagent",
        args: { action: "observe", delegationId: "del-123" },
        state: "input-available",
      },
    ]);

    const changed = sealDanglingToolCalls(state);

    // Should seal because the delegation is settled
    expect(changed).toBe(true);
    expect(state.parts).toHaveLength(2);
    expect(state.parts[1]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-observe-1",
      result: {
        status: "error",
        reconstructed: true,
      },
    });
  });

  it("seals observe calls for delegations that don't exist", () => {
    // No delegation in the map
    const state = makeState([
      {
        type: "tool-call",
        toolCallId: "call-observe-1",
        toolName: "delegateToSubagent",
        args: { action: "observe", delegationId: "del-nonexistent" },
        state: "input-available",
      },
    ]);

    const changed = sealDanglingToolCalls(state);

    // Should seal because the delegation doesn't exist
    expect(changed).toBe(true);
    expect(state.parts).toHaveLength(2);
  });

  it("does not seal active delegated start calls while the delegation is still running", () => {
    mockActiveDelegations.set("del-123", {
      id: "del-123",
      settled: false,
      sessionId: "sess-456",
    });

    const state = makeState([
      {
        type: "tool-call",
        toolCallId: "call-start-1",
        toolName: "delegateToSubagent",
        args: {
          action: "start",
          delegationId: "del-123",
          agentId: "agent-1",
          task: "do something",
        },
        state: "input-available",
        active: true,
        timestamp: new Date().toISOString(),
      },
    ]);

    const changed = sealDanglingToolCalls(state);

    expect(changed).toBe(false);
    expect(state.parts).toHaveLength(1);
    expect(state.parts[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "call-start-1",
      state: "input-available",
      active: true,
    });
  });

  it("seals inactive delegated start calls once they are no longer tracked as pending", () => {
    const state = makeState([
      {
        type: "tool-call",
        toolCallId: "call-start-inactive",
        toolName: "delegateToSubagent",
        args: { action: "start", delegationId: "del-unknown", task: "do something" },
        state: "input-available",
      },
    ]);

    const changed = sealDanglingToolCalls(state);

    expect(changed).toBe(true);
    expect(state.parts).toHaveLength(2);
    expect(state.parts[1]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-start-inactive",
      status: "error",
      state: "output-error",
    });
  });


  it("does not seal delegated observe calls flagged active even if the registry entry has been cleaned up", () => {
    const state = makeState([
      {
        type: "tool-call",
        toolCallId: "call-observe-active",
        toolName: "delegateToSubagent",
        args: { action: "observe", delegationId: "del-cleaned-up" },
        state: "input-available",
        active: true,
        timestamp: new Date().toISOString(),
      },
    ]);

    const changed = sealDanglingToolCalls(state);

    expect(changed).toBe(false);
    expect(state.parts).toHaveLength(1);
    expect(state.parts[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "call-observe-active",
      active: true,
      state: "input-available",
    });
  });

  it("handles mixed tool calls correctly - only seals non-observe dangling calls", () => {
    // Set up delegations: one running, one settled
    mockActiveDelegations.set("del-running", {
      id: "del-running",
      settled: false,
      sessionId: "sess-1",
    });
    mockActiveDelegations.set("del-settled", {
      id: "del-settled",
      settled: true,
      sessionId: "sess-2",
    });

    const state = makeState([
      // Regular tool call - should be sealed
      {
        type: "tool-call",
        toolCallId: "call-regular",
        toolName: "readFile",
        args: { filePath: "test.ts" },
        state: "input-available",
      },
      // Observe for running delegation - should NOT be sealed
      {
        type: "tool-call",
        toolCallId: "call-observe-running",
        toolName: "delegateToSubagent",
        args: { action: "observe", delegationId: "del-running" },
        state: "input-available",
      },
      // Observe for settled delegation - should be sealed
      {
        type: "tool-call",
        toolCallId: "call-observe-settled",
        toolName: "delegateToSubagent",
        args: { action: "observe", delegationId: "del-settled" },
        state: "input-available",
      },
    ]);

    const changed = sealDanglingToolCalls(state);

    expect(changed).toBe(true);
    // Should have 5 parts: 3 tool-calls + 2 sealed results (regular + observe-settled)
    expect(state.parts).toHaveLength(5);

    // Check that observe-running is NOT sealed
    const observeRunningResult = state.parts.find(
      (p) => p.type === "tool-result" && p.toolCallId === "call-observe-running"
    );
    expect(observeRunningResult).toBeUndefined();

    // Check that regular and observe-settled ARE sealed
    const regularResult = state.parts.find(
      (p) => p.type === "tool-result" && p.toolCallId === "call-regular"
    );
    expect(regularResult).toBeDefined();

    const observeSettledResult = state.parts.find(
      (p) => p.type === "tool-result" && p.toolCallId === "call-observe-settled"
    );
    expect(observeSettledResult).toBeDefined();
  });

  it("does not seal delegated tool calls projected as active while siblings settle", () => {
    mockActiveDelegations.set("del-running", {
      id: "del-running",
      settled: false,
      sessionId: "sess-1",
    });

    const state = makeState([
      {
        type: "tool-call",
        toolCallId: "call-delegate-running",
        toolName: "delegateToSubagent",
        args: { action: "start", delegationId: "del-running", agentId: "agent-1" },
        state: "input-available",
        active: true,
      },
      {
        type: "tool-call",
        toolCallId: "call-delegate-complete",
        toolName: "delegateToSubagent",
        args: { action: "observe", delegationId: "del-done" },
        state: "input-available",
      },
      {
        type: "tool-result",
        toolCallId: "call-delegate-complete",
        toolName: "delegateToSubagent",
        result: { completed: true, running: false },
        status: "success",
        state: "output-available",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const changed = sealDanglingToolCalls(state);

    expect(changed).toBe(false);
    expect(
      state.parts.find(
        (part) => part.type === "tool-result" && part.toolCallId === "call-delegate-running"
      )
    ).toBeUndefined();
  });
});

describe("shouldKeepDelegatedToolCallPending", () => {
  beforeEach(() => {
    mockActiveDelegations.clear();
  });

  it("keeps delegated tool calls pending when projected active", () => {
    expect(
      shouldKeepDelegatedToolCallPending({
        toolName: "delegateToSubagent",
        args: { action: "start" },
        active: true,
        timestamp: new Date().toISOString(),
      })
    ).toBe(true);
  });

  it("does not keep projected delegated calls pending once the active hint is stale", () => {
    const staleTimestamp = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString();

    expect(
      shouldKeepDelegatedToolCallPending({
        toolName: "delegateToSubagent",
        args: { action: "start" },
        active: true,
        timestamp: staleTimestamp,
      })
    ).toBe(false);
  });

  it("does not trust projected delegated calls without a timestamp", () => {
    expect(
      shouldKeepDelegatedToolCallPending({
        toolName: "delegateToSubagent",
        args: { action: "start" },
        active: true,
      })
    ).toBe(false);
  });

  it("keeps delegated tool calls pending when registry says delegation is unsettled", () => {
    mockActiveDelegations.set("del-running", {
      id: "del-running",
      settled: false,
      sessionId: "sess-1",
    });

    expect(
      shouldKeepDelegatedToolCallPending({
        toolName: "delegateToSubagent",
        args: { action: "observe", delegationId: "del-running" },
      })
    ).toBe(true);
  });

  it("does not keep delegated tool calls pending once the delegation settles", () => {
    mockActiveDelegations.set("del-done", {
      id: "del-done",
      settled: true,
      sessionId: "sess-2",
    });

    expect(
      shouldKeepDelegatedToolCallPending({
        toolName: "delegateToSubagent",
        args: { action: "observe", delegationId: "del-done" },
      })
    ).toBe(false);
  });
});

describe("appendReasoningPartToState", () => {
  it("creates a new reasoning part when none exists yet", () => {
    const state = makeState([]);
    const changed = appendReasoningPartToState(state, "Thinking about X.");
    expect(changed).toBe(true);
    expect(state.parts).toEqual([{ type: "reasoning", text: "Thinking about X." }]);
  });

  it("appends to the trailing reasoning part rather than creating a new one", () => {
    const state = makeState([{ type: "reasoning", text: "Thinking " }]);
    appendReasoningPartToState(state, "more.");
    expect(state.parts).toHaveLength(1);
    expect(state.parts[0]).toEqual({ type: "reasoning", text: "Thinking more." });
  });

  it("does not append to a text part (boundaries between modalities are respected)", () => {
    const state = makeState([{ type: "text", text: "visible answer" }]);
    appendReasoningPartToState(state, "hidden thought");
    expect(state.parts).toHaveLength(2);
    expect(state.parts[0]).toEqual({ type: "text", text: "visible answer" });
    expect(state.parts[1]).toEqual({ type: "reasoning", text: "hidden thought" });
  });

  it("returns false and leaves state untouched when delta is empty", () => {
    const state = makeState([{ type: "text", text: "hi" }]);
    const beforeLen = state.parts.length;
    expect(appendReasoningPartToState(state, "")).toBe(false);
    expect(appendReasoningPartToState(state, undefined)).toBe(false);
    expect(state.parts).toHaveLength(beforeLen);
  });
});

/**
 * Regression: GPT-5/Codex over the OpenAI Responses API occasionally streams
 * `tool-input-start` chunks without a `toolName`. Previously we substituted
 * the literal string "tool" as a fallback, which round-tripped to the model
 * on the next turn as a phantom function call named `tool`, producing
 * confused reasoning summaries. The fix defers part creation until a real
 * toolName arrives, buffering any deltas in the meantime.
 */
describe("unnamed tool-call handling", () => {
  beforeEach(() => {
    mockActiveDelegations.clear();
  });

  it("does not create a phantom part when tool-input-start lacks a toolName", () => {
    const state = makeState([]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const changed = recordToolInputStart(state, "call-1", undefined);

    expect(changed).toBe(false);
    expect(state.parts).toHaveLength(0);
    expect(state.toolCallParts.size).toBe(0);
    expect(state.loggedIncompleteToolCalls.has("unnamed:call-1")).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Deferring tool-input-start without toolName for call-1")
    );

    warnSpy.mockRestore();
  });

  it("buffers tool-input deltas that arrive before a toolName, then drops them silently if none arrives", () => {
    const state = makeState([]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    recordToolInputStart(state, "call-1", undefined);
    expect(recordToolInputDelta(state, "call-1", '{"path":')).toBe(false);
    expect(recordToolInputDelta(state, "call-1", '"a.ts"}')).toBe(false);

    expect(state.parts).toHaveLength(0);
    expect(state.toolCallParts.size).toBe(0);
    expect(state.pendingArgsDeltas?.get("call-1")).toBe('{"path":"a.ts"}');

    // sealDanglingToolCalls must not synthesize a phantom-named result.
    sealDanglingToolCalls(state);
    expect(state.parts.filter((p) => p.type === "tool-result")).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it("flushes buffered deltas into the part once a real toolName arrives via tool-call", () => {
    const state = makeState([]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    recordToolInputStart(state, "call-1", undefined);
    recordToolInputDelta(state, "call-1", '{"path":');
    recordToolInputDelta(state, "call-1", '"a.ts"}');

    const created = recordStructuredToolCall(state, "call-1", "Read", { path: "a.ts" });

    expect(created).toBe(true);
    expect(state.parts).toHaveLength(1);
    const part = state.parts[0] as DBToolCallPart;
    expect(part).toMatchObject({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "Read",
      args: { path: "a.ts" },
      state: "input-available",
    });
    expect(part.argsText).toBe('{"path":"a.ts"}');
    // pending buffer is consumed
    expect(state.pendingArgsDeltas?.get("call-1")).toBeUndefined();

    warnSpy.mockRestore();
  });

  it("recovers when the corrective tool-input-start arrives after deltas (deltas-before-name path)", () => {
    const state = makeState([]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // delta arrives before any start chunk at all
    recordToolInputDelta(state, "call-1", '{"q":1}');
    expect(state.parts).toHaveLength(0);
    expect(state.pendingArgsDeltas?.get("call-1")).toBe('{"q":1}');

    // later, a properly-named start arrives
    expect(recordToolInputStart(state, "call-1", "Search")).toBe(true);
    expect(state.parts).toHaveLength(1);
    const part = state.parts[0] as DBToolCallPart;
    expect(part.toolName).toBe("Search");
    expect(part.argsText).toBe('{"q":1}');
    expect(state.pendingArgsDeltas?.get("call-1")).toBeUndefined();

    warnSpy.mockRestore();
  });

  it("drops a tool-result chunk that has no toolName when no prior named call exists", () => {
    const state = makeState([]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const recorded = recordToolResultChunk(state, "call-1", "", { ok: true });

    expect(recorded).toBe(false);
    expect(state.parts).toHaveLength(0);
    expect(state.toolCallParts.size).toBe(0);
    expect(state.loggedIncompleteToolCalls.has("unnamed-result:call-1")).toBe(true);

    warnSpy.mockRestore();
  });

  it("attaches a tool-result to an existing named call even if the chunk's toolName is empty", () => {
    const state = makeState([]);
    recordStructuredToolCall(state, "call-1", "Read", { path: "a.ts" });

    const recorded = recordToolResultChunk(state, "call-1", "", { contents: "..." });

    expect(recorded).toBe(true);
    const result = state.parts.find((p) => p.type === "tool-result");
    expect(result).toMatchObject({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "Read",
    });
  });

  it("does not seal an unnamed tool-call part as a phantom-named tool-result", () => {
    // Construct a state that simulates pre-fix poison: a part with empty toolName
    // already on state.parts. sealDanglingToolCalls must skip it instead of
    // synthesizing a `toolName: "tool"` result.
    const poisoned: DBToolCallPart = {
      type: "tool-call",
      toolCallId: "call-poisoned",
      toolName: "",
      args: {},
      state: "input-available",
    };
    const state = makeState([poisoned]);

    const changed = sealDanglingToolCalls(state);

    expect(changed).toBe(false);
    expect(state.parts).toHaveLength(1);
    expect(state.parts.find((p) => p.type === "tool-result")).toBeUndefined();
  });
});

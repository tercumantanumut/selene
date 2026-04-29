import { describe, it, expect } from "vitest";
import {
  appendTextPartToState,
  recordToolResultChunk,
  recordToolInputDelta,
  recordToolInputStart,
  recordStructuredToolCall,
  finalizeStreamingToolCalls,
  MAX_ARGS_TEXT_BYTES,
  type StreamingMessageState,
} from "@/app/api/chat/streaming-state";

function normalizeJson(value: unknown): string {
  return JSON.stringify(value);
}

function expectArgsEqual(actual: unknown, expected: unknown): void {
  expect(normalizeJson(actual)).toBe(normalizeJson(expected));
}

function makeState(): StreamingMessageState {
  return {
    parts: [],
    toolCallParts: new Map(),
    loggedIncompleteToolCalls: new Set(),
    lastBroadcastAt: 0,
    lastBroadcastSignature: "",
  };
}

/** Generate a string of the given length with varied characters (won't trigger repetition detection). */
function variedString(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < len; i++) {
    result += chars[i % chars.length];
  }
  return result;
}

describe("recordToolInputDelta - argsText size cap", () => {
  it("accumulates deltas normally when under the limit", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-1", "editFile");

    const delta = "a".repeat(1000);
    const result = recordToolInputDelta(state, "tc-1", delta);

    expect(result).toBe(true);
    const part = state.toolCallParts.get("tc-1");
    expect(part?.argsText).toHaveLength(1000);
  });

  it("stops accumulating when combined size would exceed MAX_ARGS_TEXT_BYTES", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-1", "editFile");

    // Fill to just under the limit (use varied chars to avoid repetition detection)
    const bigChunk = variedString(MAX_ARGS_TEXT_BYTES - 100);
    recordToolInputDelta(state, "tc-1", bigChunk);
    const part = state.toolCallParts.get("tc-1");
    expect(part!.argsText!.length).toBe(MAX_ARGS_TEXT_BYTES - 100);

    // A small delta that fits should still be accepted
    const fitsChunk = variedString(50);
    const fitsResult = recordToolInputDelta(state, "tc-1", fitsChunk);
    expect(fitsResult).toBe(true);
    expect(part!.argsText!.length).toBe(MAX_ARGS_TEXT_BYTES - 50);

    // A delta that would push it over the limit should be rejected
    const overflowChunk = variedString(100);
    const overflowResult = recordToolInputDelta(state, "tc-1", overflowChunk);
    expect(overflowResult).toBe(false);

    // argsText should not have grown
    expect(part!.argsText!.length).toBe(MAX_ARGS_TEXT_BYTES - 50);
  });

  it("rejects a single oversized delta that exceeds the cap from zero", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-1", "editFile");

    // A single delta larger than the cap should be rejected
    const result = recordToolInputDelta(state, "tc-1", variedString(MAX_ARGS_TEXT_BYTES + 1));
    expect(result).toBe(false);

    const part = state.toolCallParts.get("tc-1");
    expect(part?.argsText).toBeUndefined();
  });

  it("logs the oversized warning exactly once per tool call", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-1", "editFile");

    // Fill to capacity (use varied chars to avoid repetition detection)
    recordToolInputDelta(state, "tc-1", variedString(MAX_ARGS_TEXT_BYTES));

    // Try two more deltas that would exceed
    recordToolInputDelta(state, "tc-1", "a");
    recordToolInputDelta(state, "tc-1", "b");

    // The oversized log key should appear exactly once
    const oversizedKeys = Array.from(state.loggedIncompleteToolCalls).filter(
      (k) => k.startsWith("oversized:")
    );
    expect(oversizedKeys).toHaveLength(1);
    expect(oversizedKeys[0]).toBe("oversized:tc-1");
  });

  it("does not affect separate tool calls", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-1", "editFile");
    recordToolInputStart(state, "tc-2", "readFile");

    // Fill tc-1 to capacity (varied chars), then try to exceed
    recordToolInputDelta(state, "tc-1", variedString(MAX_ARGS_TEXT_BYTES));
    const blocked = recordToolInputDelta(state, "tc-1", "more");
    expect(blocked).toBe(false);

    // tc-2 should still accept deltas
    const ok = recordToolInputDelta(state, "tc-2", '{"path": "/tmp"}');
    expect(ok).toBe(true);
    expect(state.toolCallParts.get("tc-2")?.argsText).toBe('{"path": "/tmp"}');
  });
});

describe("recordToolInputDelta - degenerate repetition detection", () => {
  it("halts accumulation when last 64 chars are all the same character", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-1", "readFile");

    // Start with valid JSON prefix
    const prefix = '{"filePath":"/tmp/test.ts","endLine":445';
    recordToolInputDelta(state, "tc-1", prefix);

    // Now simulate model stuck repeating '0'
    const zeros = "0".repeat(200);
    recordToolInputDelta(state, "tc-1", zeros);

    // At this point, argsText is prefix + zeros. Total > 200, last 64 chars are all '0'.
    // Next delta should be blocked.
    const blocked = recordToolInputDelta(state, "tc-1", "0".repeat(10));
    expect(blocked).toBe(false);

    // Should have logged degenerate detection
    expect(state.loggedIncompleteToolCalls.has("degenerate:tc-1")).toBe(true);
    // Should also set oversized flag to block all further deltas
    expect(state.loggedIncompleteToolCalls.has("oversized:tc-1")).toBe(true);
  });

  it("does not trigger for varied content even if long", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-1", "editFile");

    // Accumulate a large varied string
    recordToolInputDelta(state, "tc-1", variedString(500));

    // Should still accept more deltas (no repetition)
    const result = recordToolInputDelta(state, "tc-1", variedString(100));
    expect(result).toBe(true);
    expect(state.loggedIncompleteToolCalls.has("degenerate:tc-1")).toBe(false);
  });

  it("does not trigger for short accumulations even with repeated chars", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-1", "readFile");

    // Short repeated content (under 200 threshold) should be fine
    recordToolInputDelta(state, "tc-1", "x".repeat(100));

    const result = recordToolInputDelta(state, "tc-1", "y".repeat(10));
    expect(result).toBe(true);
    expect(state.loggedIncompleteToolCalls.has("degenerate:tc-1")).toBe(false);
  });
});

describe("finalizeStreamingToolCalls - log truncation", () => {
  it("finalizes valid JSON argsText normally", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-1", "readFile");
    recordToolInputDelta(state, "tc-1", '{"path": "/tmp/test.ts"}');

    const changed = finalizeStreamingToolCalls(state);

    expect(changed).toBe(true);
    const part = state.toolCallParts.get("tc-1");
    expect(part?.args).toEqual({ path: "/tmp/test.ts" });
    expect(part?.state).toBe("input-available");
  });

  it("repairs truncated JSON and finalizes", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-1", "editFile");
    // Missing closing brace
    recordToolInputDelta(state, "tc-1", '{"filePath": "/tmp/test.ts", "oldString": "hello');

    const changed = finalizeStreamingToolCalls(state);

    expect(changed).toBe(true);
    const part = state.toolCallParts.get("tc-1");
    expect(part?.state).toBe("input-available");
    // Should have repaired the JSON
    expect(part?.args).toBeDefined();
  });

  it("falls back to empty args for completely malformed argsText", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-1", "editFile");
    // Not even close to valid JSON
    recordToolInputDelta(state, "tc-1", "this is not json at all");

    const changed = finalizeStreamingToolCalls(state);

    expect(changed).toBe(true);
    const part = state.toolCallParts.get("tc-1");
    expect(part?.state).toBe("input-available");
    expect(part?.args).toEqual({});
  });
});


describe("recordStructuredToolCall", () => {
  it("preserves streamed args when structured input conflicts", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-structured", "readFile");
    recordToolInputDelta(state, "tc-structured", '{"filePath":"/tmp/a.ts"}');

    const changed = recordStructuredToolCall(state, "tc-structured", "readFile", {
      filePath: "/tmp/b.ts",
    });

    expect(changed).toBe(true);
    const part = state.toolCallParts.get("tc-structured");
    expectArgsEqual(part?.args, { filePath: "/tmp/a.ts" });
    expect(part?.argsText).toBe('{"filePath":"/tmp/a.ts"}');
    expect(part?.state).toBe("input-available");
  });

  it("accepts structured input when streamed args are still an unfinished prefix", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-prefix", "readFile");
    recordToolInputDelta(state, "tc-prefix", '{"filePath":"/tmp/a.ts"');

    const changed = recordStructuredToolCall(state, "tc-prefix", "readFile", {
      filePath: "/tmp/a.ts",
    });

    expect(changed).toBe(true);
    const part = state.toolCallParts.get("tc-prefix");
    expectArgsEqual(part?.args, { filePath: "/tmp/a.ts" });
    expect(part?.argsText).toBe('{"filePath":"/tmp/a.ts"');
    expect(part?.state).toBe("input-available");
  });

  it("accepts structured input when streamed args are incomplete and not repairable", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-incomplete", "readFile");
    recordToolInputDelta(state, "tc-incomplete", '{"startLine":');

    const changed = recordStructuredToolCall(state, "tc-incomplete", "readFile", {
      filePath: "/tmp/other.ts",
      startLine: 10,
    });

    expect(changed).toBe(true);
    const part = state.toolCallParts.get("tc-incomplete");
    expectArgsEqual(part?.args, {
      filePath: "/tmp/other.ts",
      startLine: 10,
    });
    expect(part?.argsText).toBe('{"startLine":');
    expect(part?.state).toBe("input-available");
  });

  it("recovers retrieveFullContent from incomplete streamed args by using structured args", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-retrieve", "retrieveFullContent");
    recordToolInputDelta(state, "tc-retrieve", '{"contentId":"trunc_QDAcWILS","head":');

    const changed = recordStructuredToolCall(state, "tc-retrieve", "retrieveFullContent", {
      contentId: "trunc_QDAcWILS",
      head: 60,
    });

    expect(changed).toBe(true);
    const part = state.toolCallParts.get("tc-retrieve");
    expectArgsEqual(part?.args, {
      contentId: "trunc_QDAcWILS",
      head: 60,
    });
    expect(part?.argsText).toBe('{"contentId":"trunc_QDAcWILS","head":');
    expect(part?.state).toBe("input-available");
  });

  it("keeps complete streamed args authoritative when structured input conflicts", () => {
    const state = makeState();
    recordToolInputStart(state, "tc-complete-conflict", "retrieveFullContent");
    recordToolInputDelta(state, "tc-complete-conflict", '{"contentId":"trunc_QDAcWILS","head":60}');

    const changed = recordStructuredToolCall(state, "tc-complete-conflict", "retrieveFullContent", {
      contentId: "trunc_QDAcWILS",
      range: [680, 870],
    });

    expect(changed).toBe(true);
    const part = state.toolCallParts.get("tc-complete-conflict");
    expectArgsEqual(part?.args, {
      contentId: "trunc_QDAcWILS",
      head: 60,
    });
    expect(part?.state).toBe("input-available");
  });
});

describe("streaming provenance", () => {
  it("attaches provenance to emitted text and tool-result parts", () => {
    const state: StreamingMessageState = {
      parts: [],
      toolCallParts: new Map(),
      loggedIncompleteToolCalls: new Set(),
      lastBroadcastAt: 0,
      lastBroadcastSignature: "",
      provenance: {
        contextScope: "delegated",
        delegationId: "del-1",
        provenanceVersion: 1,
      },
    };

    const textChanged = (recordToolInputStart(state, "tc-provenance", "Task") && true);
    expect(textChanged).toBe(true);

    // Add text via the exported API so provenance applies through append flow.
    const appendResult = appendTextPartToState(state, "delegated output");
    expect(appendResult).toBe(true);

    const resultChanged = recordToolResultChunk(state, "tc-provenance", "Task", { ok: true });
    expect(resultChanged).toBe(true);

    const textPart = state.parts.find((part) => part.type === "text") as any;
    const toolResultPart = state.parts.find((part) => part.type === "tool-result") as any;

    expect(textPart.contextScope).toBe("delegated");
    expect(textPart.delegationId).toBe("del-1");
    expect(toolResultPart.contextScope).toBe("delegated");
    expect(toolResultPart.delegationId).toBe("del-1");
  });
});


describe("streaming-state provenance tagging", () => {
  it("attaches provenance to new text/tool parts", () => {
    const state = makeState();
    state.provenance = {
      contextScope: "delegated",
      provenanceVersion: 1,
      delegationId: "d-1",
    };

    recordToolInputStart(state, "tc-prov", "Task");
    recordToolInputDelta(state, "tc-prov", '{"id":"1"}');

    const callPart = state.parts.find((part) => part.type === "tool-call") as any;
    expect(callPart?.contextScope).toBe("delegated");
    expect(callPart?.delegationId).toBe("d-1");

    const textState = makeState();
    textState.provenance = { contextScope: "main", provenanceVersion: 1 };
    textState.parts.push({ type: "text", text: "existing" } as any);

    // push a tool part to verify provenance on inserted parts in this test file's flow
    recordToolInputStart(textState, "tc-main", "readFile");
    const inserted = textState.parts.find((part) => part.type === "tool-call") as any;
    expect(inserted?.contextScope).toBe("main");
  });

  it("attaches provenance to tool-result replacement", () => {
    const state = makeState();
    state.provenance = { contextScope: "delegated", provenanceVersion: 1 };

    recordToolInputStart(state, "tc-result", "Task");

    recordToolResultChunk(state, "tc-result", "Task", { ok: true }, false);

    const resultPart = state.parts.find((part) => part.type === "tool-result") as any;
    expect(resultPart?.contextScope).toBe("delegated");
  });
});

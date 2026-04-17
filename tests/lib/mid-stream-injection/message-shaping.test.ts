/**
 * Phase 4c — tests for `lib/ai/providers/message-shaping.ts`
 *
 * The helper covers two concerns that the mid-stream injection path needs:
 *
 *   1. findOrphanToolCalls(parts)
 *      Given an assistant DB row's `content[]` array (DBContentPart[]), list
 *      the `{ toolCallId, toolName }` pairs whose matching `tool-result` part
 *      is NOT present in the same array. These are the "orphans" that the
 *      message-shaping shim needs to synthesize so the Anthropic API doesn't
 *      400 with "tool_use without tool_result" on the next streamText call.
 *
 *   2. buildSyntheticModelToolResults(orphans, reason)
 *      Produce ModelMessage content parts (NOT DB content parts — this goes
 *      into the in-memory messages[] handed to streamText) that match the
 *      shape `splitToolResultsFromAssistantMessages`'s
 *      `makeSyntheticToolResult` produces when rehydrating from DB history.
 *      Keeping the shapes identical means the shim injected pre-next-step
 *      looks indistinguishable from a later history rehydration, so behavior
 *      stays stable across edit/reload.
 */

import { describe, it, expect } from "vitest";

describe("findOrphanToolCalls", () => {
  it("returns [] for an empty parts array", async () => {
    const { findOrphanToolCalls } = await import(
      "@/lib/ai/providers/message-shaping"
    );
    expect(findOrphanToolCalls([])).toEqual([]);
  });

  it("returns [] when every tool-call has a matching tool-result", async () => {
    const { findOrphanToolCalls } = await import(
      "@/lib/ai/providers/message-shaping"
    );
    const parts = [
      { type: "text", text: "thinking..." },
      { type: "tool-call", toolCallId: "t1", toolName: "executeCommand" },
      { type: "tool-result", toolCallId: "t1", result: { ok: true } },
    ];
    expect(findOrphanToolCalls(parts)).toEqual([]);
  });

  it("returns every unmatched tool-call in stable order", async () => {
    const { findOrphanToolCalls } = await import(
      "@/lib/ai/providers/message-shaping"
    );
    const parts = [
      { type: "tool-call", toolCallId: "t1", toolName: "executeCommand" },
      { type: "tool-result", toolCallId: "t1", result: "done" },
      { type: "tool-call", toolCallId: "t2", toolName: "vectorSearch" },
      { type: "tool-call", toolCallId: "t3", toolName: "delegateToSubagent" },
      { type: "tool-result", toolCallId: "t3", result: { status: "ok" } },
      { type: "tool-call", toolCallId: "t4", toolName: "bash" },
    ];
    expect(findOrphanToolCalls(parts)).toEqual([
      { toolCallId: "t2", toolName: "vectorSearch" },
      { toolCallId: "t4", toolName: "bash" },
    ]);
  });

  it("falls back to 'tool' when toolName is missing on the orphan", async () => {
    const { findOrphanToolCalls } = await import(
      "@/lib/ai/providers/message-shaping"
    );
    const parts = [{ type: "tool-call", toolCallId: "tx" }];
    expect(findOrphanToolCalls(parts)).toEqual([
      { toolCallId: "tx", toolName: "tool" },
    ]);
  });

  it("skips malformed tool-call parts (no toolCallId)", async () => {
    const { findOrphanToolCalls } = await import(
      "@/lib/ai/providers/message-shaping"
    );
    const parts = [
      { type: "tool-call", toolName: "no-id" },
      { type: "tool-call", toolCallId: "keep", toolName: "keep-me" },
    ];
    expect(findOrphanToolCalls(parts)).toEqual([
      { toolCallId: "keep", toolName: "keep-me" },
    ]);
  });

  it("tolerates non-array / null inputs gracefully", async () => {
    const { findOrphanToolCalls } = await import(
      "@/lib/ai/providers/message-shaping"
    );
    expect(findOrphanToolCalls(null as unknown as never)).toEqual([]);
    expect(findOrphanToolCalls(undefined as unknown as never)).toEqual([]);
    expect(
      findOrphanToolCalls("oops" as unknown as never),
    ).toEqual([]);
  });
});

describe("buildSyntheticModelToolResults", () => {
  it("returns [] for an empty orphan list", async () => {
    const { buildSyntheticModelToolResults } = await import(
      "@/lib/ai/providers/message-shaping"
    );
    expect(buildSyntheticModelToolResults([], "any reason")).toEqual([]);
  });

  it("produces one ModelMessage tool-result content part per orphan", async () => {
    const { buildSyntheticModelToolResults } = await import(
      "@/lib/ai/providers/message-shaping"
    );
    const reason = "Cancelled — user interjected with a new message";
    const results = buildSyntheticModelToolResults(
      [
        { toolCallId: "t2", toolName: "vectorSearch" },
        { toolCallId: "t4", toolName: "bash" },
      ],
      reason,
    );

    expect(results).toHaveLength(2);

    for (const r of results) {
      expect(r.type).toBe("tool-result");
      expect(r.status).toBe("error");
      // ModelMessage tool_result uses `output: { type, value }` shape,
      // matching toModelToolResultOutput contract used by the splitter.
      expect(r.output).toBeDefined();
      expect((r.output as Record<string, unknown>).type).toBe("json");
      const value = (r.output as { value: Record<string, unknown> }).value;
      expect(value.status).toBe("error");
      expect(value.error).toBe(reason);
      expect(value.reconstructed).toBe(true);
    }

    expect(results[0].toolCallId).toBe("t2");
    expect(results[0].toolName).toBe("vectorSearch");
    expect(results[1].toolCallId).toBe("t4");
    expect(results[1].toolName).toBe("bash");
  });

  it("defaults toolName to 'tool' when missing", async () => {
    const { buildSyntheticModelToolResults } = await import(
      "@/lib/ai/providers/message-shaping"
    );
    const results = buildSyntheticModelToolResults(
      [{ toolCallId: "tx", toolName: "" as unknown as string }],
      "cancelled",
    );
    expect(results[0].toolName).toBe("tool");
  });
});

describe("integration: orphan detection → synthetic results", () => {
  it("end-to-end roundtrip produces a ModelMessage-safe shim", async () => {
    const { findOrphanToolCalls, buildSyntheticModelToolResults } =
      await import("@/lib/ai/providers/message-shaping");

    // Simulate a sealed assistant row from the DB where the 2nd tool_use
    // was interrupted by a live-prompt injection.
    const parts = [
      { type: "text", text: "looking at your question..." },
      { type: "tool-call", toolCallId: "a", toolName: "webSearch" },
      { type: "tool-result", toolCallId: "a", result: { items: [] } },
      {
        type: "tool-call",
        toolCallId: "b",
        toolName: "delegateToSubagent",
      },
    ];

    const orphans = findOrphanToolCalls(parts);
    expect(orphans).toEqual([
      { toolCallId: "b", toolName: "delegateToSubagent" },
    ]);

    const reason = "Cancelled — user interjected with a new message";
    const shim = buildSyntheticModelToolResults(orphans, reason);
    expect(shim).toHaveLength(1);
    expect(shim[0].toolCallId).toBe("b");
    expect((shim[0].output as { value: Record<string, unknown> }).value.error).toBe(reason);
  });
});

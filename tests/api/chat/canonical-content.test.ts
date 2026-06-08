import { describe, expect, it } from "vitest";

import {
  buildCanonicalAssistantContentFromSteps,
  mergeCanonicalAssistantContent,
  consolidateAdjacentTextParts,
  reconcileDbToolCallResultPairs,
  isReconstructedMissingResult,
  countCanonicalTruncationMarkers,
  isAbortLikeTerminationError,
  shouldTreatStreamErrorAsCancellation,
  stubEphemeralToolResults,
} from "@/app/api/chat/canonical-content";
import type { DBContentPart } from "@/lib/messages/converter";

// ── helpers ──────────────────────────────────────────────────────────────────

function textPart(text: string): DBContentPart {
  return { type: "text", text };
}

function toolCall(id: string, name = "tool", args: unknown = {}): DBContentPart {
  return { type: "tool-call", toolCallId: id, toolName: name, args };
}

function toolResult(id: string, name = "tool", result: unknown = { status: "ok" }): DBContentPart {
  return {
    type: "tool-result",
    toolCallId: id,
    toolName: name,
    result,
    status: "success",
    state: "output-available",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

const leakedPlanningText =
  "I need continue with actual tools available names. Only commentary tools under functions.* not tool. Need sequential edits. Must read current files before edit. Need use editFile and run tests. Let's implement carefully. Need add setting to app/settings/settings-types FormState.";

// ─────────────────────────────────────────────────────────────────────────────
// mergeCanonicalAssistantContent
// ─────────────────────────────────────────────────────────────────────────────

describe("mergeCanonicalAssistantContent", () => {
  // ── text dedup basics ───────────────────────────────────────────────────

  it("exact text match → skip duplicate", () => {
    const streamed = [textPart("hello world")];
    const step = [textPart("hello world")];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    const textParts = merged.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as { text: string }).text).toBe("hello world");
  });

  it("whitespace-only difference → skip (trim comparison)", () => {
    const streamed = [textPart("\n\nHey! What's up?")];
    const step = [textPart("Hey! What's up?")];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    const textParts = merged.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
  });

  it("existing superset of incoming → skip", () => {
    const streamed = [textPart("hello world, how are you?")];
    const step = [textPart("hello world")];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    const textParts = merged.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as { text: string }).text).toBe("hello world, how are you?");
  });

  it("incoming extends a single existing text → replace", () => {
    const streamed = [textPart("hello")];
    const step = [textPart("hello world")];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    const textParts = merged.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as { text: string }).text).toBe("hello world");
  });

  it("genuinely new text → append and consolidate", () => {
    const streamed = [textPart("alpha")];
    const step = [textPart("beta")];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    const textParts = merged.filter((p) => p.type === "text");
    // Adjacent text parts are consolidated with paragraph break
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as { text: string }).text).toBe("alpha\n\nbeta");
  });

  it("drops leaked streamed planning prose when tool parts are present", () => {
    const streamed: DBContentPart[] = [
      textPart(leakedPlanningText),
      toolCall("tc1", "Read", { filePath: "/a" }),
      toolResult("tc1", "Read", { content: "data" }),
    ];

    const merged = mergeCanonicalAssistantContent(streamed, []);

    expect(merged.filter((part) => part.type === "text")).toHaveLength(0);
    expect(merged.filter((part) => part.type === "tool-call")).toHaveLength(1);
    expect(merged.filter((part) => part.type === "tool-result")).toHaveLength(1);
  });

  // ── blob-drop heuristic (multi-part subsumption) ─────────────────────

  it("incoming subsumes 2+ existing parts → drop (concatenated step blob)", () => {
    const streamed: DBContentPart[] = [
      textPart("Let me check the code."),
      toolCall("tc1", "Read"),
      toolResult("tc1", "Read"),
      textPart("Now let me fix the bug."),
      toolCall("tc2", "Edit"),
      toolResult("tc2", "Edit"),
      textPart("Done. Here's the summary."),
    ];
    // AI SDK concatenates all text blocks in a step into one string
    const blob = "Let me check the code.Now let me fix the bug.Done. Here's the summary.";
    const step = [textPart(blob)];

    const merged = mergeCanonicalAssistantContent(streamed, step);
    const textParts = merged.filter((p) => p.type === "text");
    // Should keep the 3 original parts, NOT add the blob
    expect(textParts).toHaveLength(3);
  });

  // ── Fix #1: empty text parts don't corrupt subsumption count ──────────

  it("empty text parts in base don't trigger blob-drop heuristic", () => {
    const streamed: DBContentPart[] = [
      textPart(""),   // empty part #1
      textPart(""),   // empty part #2
    ];
    const step = [textPart("hello world")];

    const merged = mergeCanonicalAssistantContent(streamed, step);
    const textParts = merged.filter(
      (p) => p.type === "text" && (p as { text: string }).text.trim() !== ""
    );
    // "hello world" is genuinely new content — must NOT be dropped
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as { text: string }).text).toBe("hello world");
  });

  it("one empty + one real subsumable → single replacement, not blob-drop", () => {
    const streamed: DBContentPart[] = [
      textPart(""),
      textPart("hello"),
    ];
    const step = [textPart("hello world")];

    const merged = mergeCanonicalAssistantContent(streamed, step);
    const textParts = merged.filter(
      (p) => p.type === "text" && (p as { text: string }).text.trim() !== ""
    );
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as { text: string }).text).toBe("hello world");
  });

  // ── stripFakeToolCallJson gating ──────────────────────────────────────
  // With STRIP_FAKE_TOOL_JSON disabled (default), fake tool JSON stays in text.
  // The merge just compares raw trimmed text.

  it("fake tool JSON in streaming text: no stripping when flag is off (default)", () => {
    // Without the flag, fake JSON is NOT stripped — texts differ → 2 parts
    const fakeToolJson = '{"type":"tool-result","toolCallId":"tc_x","toolName":"Write","result":{}}';
    const streamedText = `Start.\n${fakeToolJson}`;
    const cleanText = "Start.";

    const streamed = [textPart(streamedText)];
    const step = [textPart(cleanText)];

    const merged = mergeCanonicalAssistantContent(streamed, step);
    const textParts = merged.filter((p) => p.type === "text");
    // Streaming text contains the fake JSON, step text doesn't — but step is a
    // substring of the trimmed streaming text → existing superset → 1 part
    expect(textParts).toHaveLength(1);
  });

  it("fake tool JSON as entire streaming text: step text appended and consolidated", () => {
    // Streaming text is ONLY fake tool JSON (no real text). Step has real text.
    // They don't overlap at all → step text appended → adjacent texts consolidated.
    const fakeToolJson = '{"type":"tool-call","toolCallId":"tc_123","toolName":"Read","args":{}}';
    const streamed = [textPart(fakeToolJson)];
    const step = [textPart("Let me check.")];

    const merged = mergeCanonicalAssistantContent(streamed, step);
    const textParts = merged.filter((p) => p.type === "text");
    // Adjacent text parts consolidated into 1
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as { text: string }).text).toContain("Let me check.");
  });

  // ── tool-call/result merging ──────────────────────────────────────────

  it("new tool-call from step gets appended", () => {
    const streamed = [toolCall("tc1", "Read")];
    const step = [toolCall("tc2", "Write")];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    expect(merged.filter((p) => p.type === "tool-call")).toHaveLength(2);
  });

  it("existing tool-call gets args filled from step", () => {
    const streamed: DBContentPart[] = [
      { type: "tool-call", toolCallId: "tc1", toolName: "Read" },
    ];
    const step = [toolCall("tc1", "Read", { filePath: "/foo" })];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    const tc = merged.find(
      (p) => p.type === "tool-call" && p.toolCallId === "tc1"
    ) as { args?: unknown };
    expect(tc?.args).toEqual({ filePath: "/foo" });
  });

  it("new tool-result from step gets appended", () => {
    const streamed: DBContentPart[] = [
      toolCall("tc1", "Read"),
    ];
    const step = [toolResult("tc1", "Read", { content: "file data" })];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    expect(merged.filter((p) => p.type === "tool-result")).toHaveLength(1);
  });

  it("reconstructed tool-result gets replaced by real result", () => {
    const streamed: DBContentPart[] = [
      toolCall("tc1", "Read"),
      {
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "Read",
        result: {
          error: "Tool execution did not return a persisted result in conversation history.",
          reconstructed: true,
        },
        status: "error",
        state: "output-error",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ];
    const step = [toolResult("tc1", "Read", { content: "real result" })];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    const tr = merged.find(
      (p) => p.type === "tool-result" && p.toolCallId === "tc1"
    ) as { result?: unknown };
    expect(tr?.result).toEqual({ content: "real result" });
  });

  // ── edge cases ────────────────────────────────────────────────────────

  it("empty streamed + step → returns step parts (reconciled)", () => {
    const step = [textPart("hello"), toolCall("tc1")];
    const merged = mergeCanonicalAssistantContent(undefined, step);
    expect(merged.length).toBeGreaterThanOrEqual(2);
  });

  it("streamed + empty step → returns base parts (reconciled)", () => {
    const streamed = [textPart("hello"), toolCall("tc1")];
    const merged = mergeCanonicalAssistantContent(streamed, []);
    expect(merged.length).toBeGreaterThanOrEqual(2);
  });

  it("both empty → returns empty", () => {
    const merged = mergeCanonicalAssistantContent([], []);
    expect(merged).toEqual([]);
  });

  it("empty incoming text is skipped", () => {
    const streamed = [textPart("hello")];
    const step = [textPart(""), textPart("   ")];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    const textParts = merged.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
  });

  // ── reasoning preservation (DeepSeek thinking mode replay) ───────────────

  it("preserves reasoning parts from streamed base when step adds none", () => {
    const streamed: DBContentPart[] = [
      { type: "reasoning", text: "I should read the file first." },
      textPart("reading now..."),
    ];
    const step: DBContentPart[] = [
      toolCall("tc1", "Read"),
      toolResult("tc1", "Read"),
    ];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    const reasoningParts = merged.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(1);
    expect((reasoningParts[0] as { text: string }).text).toBe(
      "I should read the file first."
    );
  });

  it("merges reasoning from step when streamed base has none", () => {
    const streamed: DBContentPart[] = [textPart("Let me do that.")];
    const step: DBContentPart[] = [
      { type: "reasoning", text: "User asked for a file. I'll read it." },
      toolCall("tc1", "Read"),
    ];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    const reasoningParts = merged.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(1);
    expect((reasoningParts[0] as { text: string }).text).toBe(
      "User asked for a file. I'll read it."
    );
  });

  it("deduplicates identical reasoning across streamed base and step", () => {
    const streamed: DBContentPart[] = [
      { type: "reasoning", text: "Same thought." },
      textPart("ok"),
    ];
    const step: DBContentPart[] = [
      { type: "reasoning", text: "Same thought." },
      toolCall("tc1", "Read"),
    ];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    const reasoningParts = merged.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(1);
  });

  it("keeps distinct reasoning blocks from multiple steps", () => {
    const streamed: DBContentPart[] = [
      { type: "reasoning", text: "First thought." },
    ];
    const step: DBContentPart[] = [
      { type: "reasoning", text: "Second thought." },
      toolCall("tc1", "Read"),
    ];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    const reasoningParts = merged.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(2);
  });

  it("skips empty reasoning text from step", () => {
    const streamed: DBContentPart[] = [textPart("ok")];
    const step: DBContentPart[] = [
      { type: "reasoning", text: "" },
      toolCall("tc1", "Read"),
    ];
    const merged = mergeCanonicalAssistantContent(streamed, step);
    const reasoningParts = merged.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reconcileDbToolCallResultPairs
// ─────────────────────────────────────────────────────────────────────────────

describe("reconcileDbToolCallResultPairs", () => {
  it("passes through well-formed call+result pairs", () => {
    const parts: DBContentPart[] = [
      toolCall("tc1", "Read"),
      toolResult("tc1", "Read"),
    ];
    const reconciled = reconcileDbToolCallResultPairs(parts);
    expect(reconciled).toHaveLength(2);
    expect(reconciled[0].type).toBe("tool-call");
    expect(reconciled[1].type).toBe("tool-result");
  });

  it("injects missing tool-call before orphaned tool-result", () => {
    const parts: DBContentPart[] = [
      toolResult("tc1", "Read", { content: "data" }),
    ];
    const reconciled = reconcileDbToolCallResultPairs(parts);
    expect(reconciled).toHaveLength(2);
    expect(reconciled[0].type).toBe("tool-call");
    expect((reconciled[0] as { toolCallId: string }).toolCallId).toBe("tc1");
    expect((reconciled[0] as { args?: unknown }).args).toEqual({
      __reconstructed: true,
      reason: "missing_tool_call_in_history",
    });
  });

  it("injects missing tool-result after orphaned tool-call", () => {
    const parts: DBContentPart[] = [
      toolCall("tc1", "Read"),
    ];
    const reconciled = reconcileDbToolCallResultPairs(parts);
    expect(reconciled).toHaveLength(2);
    expect(reconciled[1].type).toBe("tool-result");
    expect((reconciled[1] as { result?: unknown }).result).toMatchObject({
      status: "error",
      reconstructed: true,
    });
  });

  it("preserves text parts in order", () => {
    const parts: DBContentPart[] = [
      textPart("before"),
      toolCall("tc1", "Read"),
      toolResult("tc1", "Read"),
      textPart("after"),
    ];
    const reconciled = reconcileDbToolCallResultPairs(parts);
    expect(reconciled[0]).toEqual(textPart("before"));
    expect(reconciled[reconciled.length - 1]).toEqual(textPart("after"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildCanonicalAssistantContentFromSteps
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCanonicalAssistantContentFromSteps", () => {
  const leakedPlanningText =
    "I need continue with actual tools available names. Only commentary tools under functions.* not tool. Need sequential edits. Must read current files before edit. Need use editFile and run tests. Let's implement carefully. Need add setting to app/settings/settings-types FormState.";
  const exactNamespaceLeakText =
    "Need use actual tool names weird transcript says functions.tool due maybe alias? Need continue. Read route.";

  it("returns fallback text when no steps", () => {
    const parts = buildCanonicalAssistantContentFromSteps(undefined, "fallback text");
    expect(parts).toHaveLength(1);
    expect((parts[0] as { text: string }).text).toBe("fallback text");
  });

  it("returns empty for empty steps and no fallback", () => {
    const parts = buildCanonicalAssistantContentFromSteps([]);
    expect(parts).toHaveLength(0);
  });

  it("builds text from step text", () => {
    const parts = buildCanonicalAssistantContentFromSteps([{ text: "hello" }]);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
  });

  it("drops leaked internal planning prose when the step includes tool-call context", () => {
    const parts = buildCanonicalAssistantContentFromSteps([
      {
        text: leakedPlanningText,
        toolCalls: [{ toolCallId: "tc1", toolName: "Read", input: { filePath: "/a" } }],
      },
    ]);

    expect(parts).toEqual([
      {
        type: "tool-call",
        toolCallId: "tc1",
        toolName: "Read",
        args: { filePath: "/a" },
      },
    ]);
  });

  it("preserves the same text when there is no tool-call context", () => {
    const parts = buildCanonicalAssistantContentFromSteps([{ text: leakedPlanningText }]);
    expect(parts).toEqual([{ type: "text", text: leakedPlanningText }]);
  });

  it("drops the exact namespace leak even when no tool-call context exists yet", () => {
    const parts = buildCanonicalAssistantContentFromSteps([{ text: exactNamespaceLeakText }]);
    expect(parts).toEqual([]);
  });

  it("preserves fake tool-call JSON when STRIP_FAKE_TOOL_JSON is off (default)", () => {
    // With the env flag off, stripFakeToolCallJson is a passthrough (trim only)
    const fakeJson = '{"type":"tool-call","toolCallId":"tc_x","toolName":"Read","args":{}}';
    const parts = buildCanonicalAssistantContentFromSteps([
      { text: `Some text\n${fakeJson}\nMore text` },
    ]);
    expect(parts).toHaveLength(1);
    const textContent = (parts[0] as { text: string }).text;
    // Fake JSON is preserved since stripping is disabled
    expect(textContent).toContain("tool-call");
    expect(textContent).toContain("Some text");
    expect(textContent).toContain("More text");
  });

  it("deduplicates tool calls by ID", () => {
    const parts = buildCanonicalAssistantContentFromSteps([
      {
        toolCalls: [
          { toolCallId: "tc1", toolName: "Read", input: { filePath: "/a" } },
          { toolCallId: "tc1", toolName: "Read", input: { filePath: "/a" } },
        ],
      },
    ]);
    const calls = parts.filter((p) => p.type === "tool-call");
    expect(calls).toHaveLength(1);
  });

  it("deduplicates tool results by ID", () => {
    const parts = buildCanonicalAssistantContentFromSteps([
      {
        toolCalls: [{ toolCallId: "tc1", toolName: "Read", input: { filePath: "/a" } }],
        toolResults: [
          { toolCallId: "tc1", output: { content: "data" } },
          { toolCallId: "tc1", output: { content: "data" } },
        ],
      },
    ]);
    const results = parts.filter((p) => p.type === "tool-result");
    expect(results).toHaveLength(1);
  });

  it("deduplicates identical text across steps", () => {
    const parts = buildCanonicalAssistantContentFromSteps([
      { text: "All done. The task is complete." },
      {
        toolCalls: [{ toolCallId: "tc1", toolName: "executeCommand", input: { command: "git status" } }],
        toolResults: [{ toolCallId: "tc1", output: { stdout: "clean" } }],
        text: "All done. The task is complete.",
      },
    ]);
    const textParts = parts.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as { text: string }).text).toBe("All done. The task is complete.");
  });

  it("keeps genuinely different text across steps", () => {
    const parts = buildCanonicalAssistantContentFromSteps([
      { text: "Let me check the results." },
      {
        toolCalls: [{ toolCallId: "tc1", toolName: "executeCommand", input: { command: "npm test" } }],
        toolResults: [{ toolCallId: "tc1", output: { stdout: "ok" } }],
        text: "All tests pass. Done.",
      },
    ]);
    const textParts = parts.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(2);
  });

  // ── reasoning extraction (DeepSeek thinking mode) ────────────────────────

  it("extracts reasoning from reasoningText and emits before tool-calls", () => {
    const parts = buildCanonicalAssistantContentFromSteps([
      {
        reasoningText: "I need to check the file.",
        toolCalls: [{ toolCallId: "tc1", toolName: "Read", input: { filePath: "/a" } }],
      },
    ]);
    // Reasoning first, then tool-call
    expect(parts).toEqual([
      { type: "reasoning", text: "I need to check the file." },
      { type: "tool-call", toolCallId: "tc1", toolName: "Read", args: { filePath: "/a" } },
    ]);
  });

  it("extracts reasoning from structured reasoning[] parts when reasoningText absent", () => {
    const parts = buildCanonicalAssistantContentFromSteps([
      {
        reasoning: [
          { type: "reasoning", text: "First chunk. " },
          { type: "reasoning", text: "Second chunk." },
        ],
        text: "Done.",
      },
    ]);
    const reasoning = parts.filter((p) => p.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect((reasoning[0] as { text: string }).text).toBe("First chunk. Second chunk.");
  });

  it("dedupes repeated reasoning across steps by exact text", () => {
    const parts = buildCanonicalAssistantContentFromSteps([
      { reasoningText: "Same plan", text: "a" },
      { reasoningText: "Same plan", text: "b" },
    ]);
    const reasoning = parts.filter((p) => p.type === "reasoning");
    expect(reasoning).toHaveLength(1);
  });

  it("ignores empty/whitespace-only reasoning text", () => {
    const parts = buildCanonicalAssistantContentFromSteps([
      { reasoningText: "   ", text: "hi" },
    ]);
    expect(parts.filter((p) => p.type === "reasoning")).toHaveLength(0);
  });

  it("reasoning pass-through: stubEphemeralToolResults and truncation count do not touch reasoning", () => {
    const parts: DBContentPart[] = [
      { type: "reasoning", text: "think first" },
      toolCall("tc1", "someEphemeralTool"),
      toolResult("tc1", "someEphemeralTool"),
    ];
    // Fake ephemeral lookup marks the tool as ephemeral — reasoning should pass
    // through unchanged and the truncation counter should ignore reasoning.
    const rewritten = stubEphemeralToolResults(parts, () => true);
    expect(rewritten[0]).toEqual({ type: "reasoning", text: "think first" });
    expect(countCanonicalTruncationMarkers(rewritten)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// consolidateAdjacentTextParts
// ─────────────────────────────────────────────────────────────────────────────

describe("consolidateAdjacentTextParts", () => {
  it("merges adjacent text parts with paragraph break", () => {
    const parts: DBContentPart[] = [
      textPart("Typecheck passes — 0 errors."),
      textPart("All done. The test file is in place."),
    ];
    const consolidated = consolidateAdjacentTextParts(parts);
    expect(consolidated).toHaveLength(1);
    expect((consolidated[0] as { text: string }).text).toBe(
      "Typecheck passes — 0 errors.\n\nAll done. The test file is in place."
    );
  });

  it("does not merge text parts separated by tool parts", () => {
    const parts: DBContentPart[] = [
      textPart("Before tool."),
      toolCall("tc1", "Read"),
      toolResult("tc1", "Read"),
      textPart("After tool."),
    ];
    const consolidated = consolidateAdjacentTextParts(parts);
    const textParts = consolidated.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(2);
  });

  it("merges 3+ adjacent text parts", () => {
    const parts: DBContentPart[] = [
      textPart("Part 1."),
      textPart("Part 2."),
      textPart("Part 3."),
    ];
    const consolidated = consolidateAdjacentTextParts(parts);
    expect(consolidated).toHaveLength(1);
    expect((consolidated[0] as { text: string }).text).toBe(
      "Part 1.\n\nPart 2.\n\nPart 3."
    );
  });

  it("handles empty/whitespace text parts gracefully", () => {
    const parts: DBContentPart[] = [
      textPart("Hello."),
      textPart(""),
      textPart("World."),
    ];
    const consolidated = consolidateAdjacentTextParts(parts);
    expect(consolidated).toHaveLength(1);
  });

  it("returns single-element arrays unchanged", () => {
    const parts: DBContentPart[] = [textPart("Only one.")];
    const consolidated = consolidateAdjacentTextParts(parts);
    expect(consolidated).toHaveLength(1);
    expect((consolidated[0] as { text: string }).text).toBe("Only one.");
  });

  it("empty streamed + duplicate step text → deduplicated and consolidated", () => {
    // This is the regression scenario: base.length === 0, step content has
    // adjacent duplicate text parts from multi-step execution
    const stepContent = buildCanonicalAssistantContentFromSteps([
      { text: "All done. Task complete." },
      { text: "All done. Task complete." },
    ]);
    const merged = mergeCanonicalAssistantContent(undefined, stepContent);
    const textParts = merged.filter((p) => p.type === "text");
    // Should be deduplicated to 1 by buildCanonicalAssistantContentFromSteps
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as { text: string }).text).toBe("All done. Task complete.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isReconstructedMissingResult
// ─────────────────────────────────────────────────────────────────────────────

describe("isReconstructedMissingResult", () => {
  it("true for { reconstructed: true }", () => {
    expect(isReconstructedMissingResult({ reconstructed: true })).toBe(true);
  });

  it("true for error message with 'did not return a persisted result'", () => {
    expect(
      isReconstructedMissingResult({
        error: "Tool execution did not return a persisted result in conversation history.",
      })
    ).toBe(true);
  });

  it("false for null/undefined", () => {
    expect(isReconstructedMissingResult(null)).toBe(false);
    expect(isReconstructedMissingResult(undefined)).toBe(false);
  });

  it("false for arrays", () => {
    expect(isReconstructedMissingResult([1, 2, 3])).toBe(false);
  });

  it("false for normal objects", () => {
    expect(isReconstructedMissingResult({ status: "ok" })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// countCanonicalTruncationMarkers
// ─────────────────────────────────────────────────────────────────────────────

describe("countCanonicalTruncationMarkers", () => {
  it("counts truncated: true markers", () => {
    const parts: DBContentPart[] = [
      toolCall("tc1"),
      {
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "tool",
        result: { truncated: true, content: "..." },
        state: "output-available",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ];
    expect(countCanonicalTruncationMarkers(parts)).toBe(1);
  });

  it("counts truncatedContentId markers", () => {
    const parts: DBContentPart[] = [
      toolCall("tc1"),
      {
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "tool",
        result: { truncatedContentId: "trunc_abc123" },
        state: "output-available",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ];
    expect(countCanonicalTruncationMarkers(parts)).toBe(1);
  });

  it("returns 0 for no markers", () => {
    const parts: DBContentPart[] = [textPart("hello"), toolCall("tc1"), toolResult("tc1")];
    expect(countCanonicalTruncationMarkers(parts)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isAbortLikeTerminationError + shouldTreatStreamErrorAsCancellation
// ─────────────────────────────────────────────────────────────────────────────

describe("isAbortLikeTerminationError", () => {
  it.each([
    "Request was aborted",
    "Stream terminated early",
    "interrupted by user",
    "The controller was closed",
    "connection reset by peer",
    "socket hang up",
  ])("returns true for: %s", (msg) => {
    expect(isAbortLikeTerminationError(msg)).toBe(true);
  });

  it("returns false for normal errors", () => {
    expect(isAbortLikeTerminationError("Internal server error")).toBe(false);
    expect(isAbortLikeTerminationError("Rate limit exceeded")).toBe(false);
  });
});

describe("shouldTreatStreamErrorAsCancellation", () => {
  it("returns false for credit errors", () => {
    expect(
      shouldTreatStreamErrorAsCancellation({
        errorMessage: "aborted",
        isCreditError: true,
        streamAborted: true,
        classificationRecoverable: true,
      })
    ).toBe(false);
  });

  it("returns true when stream was aborted", () => {
    expect(
      shouldTreatStreamErrorAsCancellation({
        errorMessage: "some error",
        isCreditError: false,
        streamAborted: true,
        classificationRecoverable: false,
      })
    ).toBe(true);
  });

  it("returns true for user_abort classification", () => {
    expect(
      shouldTreatStreamErrorAsCancellation({
        errorMessage: "error",
        isCreditError: false,
        streamAborted: false,
        classificationRecoverable: false,
        classificationReason: "user_abort",
      })
    ).toBe(true);
  });

  it("returns true for recoverable abort-like errors", () => {
    expect(
      shouldTreatStreamErrorAsCancellation({
        errorMessage: "socket hang up",
        isCreditError: false,
        streamAborted: false,
        classificationRecoverable: true,
      })
    ).toBe(true);
  });

  it("returns false for non-recoverable non-abort errors", () => {
    expect(
      shouldTreatStreamErrorAsCancellation({
        errorMessage: "internal server error",
        isCreditError: false,
        streamAborted: false,
        classificationRecoverable: false,
      })
    ).toBe(false);
  });
});

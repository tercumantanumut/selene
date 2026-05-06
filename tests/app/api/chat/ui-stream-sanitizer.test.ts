import { describe, expect, it } from "vitest";

import { createVisibleAssistantChunkSanitizer } from "@/app/api/chat/ui-stream-sanitizer";

describe("createVisibleAssistantChunkSanitizer", () => {
  it("buffers safe text until punctuation, then emits the original spacing", () => {
    const sanitizer = createVisibleAssistantChunkSanitizer();

    expect(sanitizer.process({ type: "text-start", id: "txt-1" } as any)).toEqual([]);
    expect(sanitizer.process({ type: "text-delta", id: "txt-1", delta: "Hello" } as any)).toEqual([]);
    expect(
      sanitizer.process({ type: "text-delta", id: "txt-1", delta: " world." } as any)
    ).toEqual([
      { type: "text-start", id: "txt-1" },
      { type: "text-delta", id: "txt-1", delta: "Hello world." },
    ]);
    expect(sanitizer.process({ type: "text-end", id: "txt-1" } as any)).toEqual([
      { type: "text-end", id: "txt-1" },
    ]);
  });

  it("drops the exact internal namespace leak from the visible stream", () => {
    const sanitizer = createVisibleAssistantChunkSanitizer();

    sanitizer.process({ type: "text-start", id: "txt-1" } as any);
    expect(
      sanitizer.process({
        type: "text-delta",
        id: "txt-1",
        delta: "Need use actual tool names weird transcript says functions.tool due maybe alias?",
      } as any)
    ).toEqual([]);
    expect(
      sanitizer.process({ type: "text-delta", id: "txt-1", delta: " Need continue." } as any)
    ).toEqual([]);
    expect(sanitizer.process({ type: "text-end", id: "txt-1" } as any)).toEqual([]);
  });

  it("drops the leak when the stream tokenizer splits it at the period inside `functions.tool`", () => {
    // Regression for INTERNAL_TOOL_NAMESPACE_LEAK_BUG_REPORT.md (2026-05-06):
    // pre-fix `shouldFlushBufferedText` flushed at the bare `.` in `functions.`,
    // emitting half a leak fragment whose namespace match had not yet
    // assembled. The fix combines two changes:
    //   1) flush only on `.` followed by whitespace or end-of-buffer
    //   2) detector also catches HC≥2 + directive even without namespace
    const sanitizer = createVisibleAssistantChunkSanitizer();

    sanitizer.process({ type: "text-start", id: "txt-1" } as any);
    expect(
      sanitizer.process({
        type: "text-delta",
        id: "txt-1",
        delta: "Need use actual tool names weird transcript says functions.",
      } as any),
    ).toEqual([]);
    expect(
      sanitizer.process({
        type: "text-delta",
        id: "txt-1",
        delta: "tool due maybe alias? Need continue. Read route.",
      } as any),
    ).toEqual([]);
    expect(sanitizer.process({ type: "text-end", id: "txt-1" } as any)).toEqual([]);
  });

  it("does not flush at a period that sits between two letters", () => {
    // Defense-in-depth: a `.` between two word characters (e.g. `package.json`,
    // `functions.tool`) is not a sentence terminator and must not trigger a
    // mid-token flush. Without this rule, the AI SDK stream tokenizer can
    // split a leak fragment so neither half carries enough signal for the
    // detector to recognize it.
    const sanitizer = createVisibleAssistantChunkSanitizer();

    sanitizer.process({ type: "text-start", id: "txt-1" } as any);
    // `package.json` — `.` is followed by a letter, so no flush yet.
    expect(
      sanitizer.process({
        type: "text-delta",
        id: "txt-1",
        delta: "Open package.json",
      } as any),
    ).toEqual([]);
    // Real terminator arrives — flush emits the full clean text once.
    const flushed = sanitizer.process({
      type: "text-delta",
      id: "txt-1",
      delta: " now.",
    } as any);
    expect(flushed).toEqual([
      { type: "text-start", id: "txt-1" },
      { type: "text-delta", id: "txt-1", delta: "Open package.json now." },
    ]);
    expect(sanitizer.process({ type: "text-end", id: "txt-1" } as any)).toEqual([
      { type: "text-end", id: "txt-1" },
    ]);
  });
});

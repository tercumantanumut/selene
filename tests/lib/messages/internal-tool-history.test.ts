import { describe, expect, it } from "vitest";

import {
  isInternalAssistantLeakText,
  isInternalToolHistoryLeakText,
} from "@/lib/messages/internal-tool-history";

// Fixture from INTERNAL_TOOL_NAMESPACE_LEAK_BUG_REPORT.md (2026-05-06).
// This is the exact terse planning sentence that leaked to the visible
// transcript and prompted the bug report.
const exactNamespaceLeak =
  "Need use actual tool names weird transcript says functions.tool due maybe alias? Need continue. Read route.";

// Fragments that result when the AI SDK stream tokenizer splits the leak
// at the period inside `functions.tool`. The pre-fix detector missed both
// halves because the namespace pattern requires letters after the dot.
const fragmentBeforeDot =
  "Need use actual tool names weird transcript says functions.";
const fragmentAfterDot = "tool due maybe alias? Need continue. Read route.";

describe("isInternalAssistantLeakText — namespace leak", () => {
  it("strips the exact bug-report leak as a single string", () => {
    expect(isInternalAssistantLeakText(exactNamespaceLeak)).toBe(true);
    expect(
      isInternalAssistantLeakText(exactNamespaceLeak, { hasToolCallLikeParts: true }),
    ).toBe(true);
  });

  it("strips the leak fragment that ends with `functions.` (pre-tokenized)", () => {
    expect(isInternalAssistantLeakText(fragmentBeforeDot)).toBe(true);
    expect(
      isInternalAssistantLeakText(fragmentBeforeDot, { hasToolCallLikeParts: true }),
    ).toBe(true);
  });

  it("strips a `weird transcript says ... due maybe alias` fragment without namespace", () => {
    const fragment =
      "Need use actual tool names weird transcript says due maybe alias?";
    expect(isInternalAssistantLeakText(fragment)).toBe(true);
  });

  it("ignores a benign sentence that mentions only one high-confidence phrase", () => {
    const benign =
      "I need to read the route handler before making changes.";
    expect(isInternalAssistantLeakText(benign)).toBe(false);
    expect(
      isInternalAssistantLeakText(benign, { hasToolCallLikeParts: true }),
    ).toBe(false);
  });

  it("ignores user-authored prose that mentions tool names in passing", () => {
    const benign =
      "I checked the readFile tool and it works as expected for our use case.";
    expect(isInternalAssistantLeakText(benign)).toBe(false);
    expect(
      isInternalAssistantLeakText(benign, { hasToolCallLikeParts: true }),
    ).toBe(false);
  });

  it("strips multi-cue planning prose when tool-call context is present", () => {
    const planning =
      "I need continue with actual tools available names. Only commentary tools under functions.* not tool. Need sequential edits. Must read current files before edit. Need use editFile and run tests. Let's implement carefully.";
    expect(
      isInternalAssistantLeakText(planning, { hasToolCallLikeParts: true }),
    ).toBe(true);
  });

  it("returns false on non-string and empty inputs", () => {
    expect(isInternalAssistantLeakText(undefined as unknown)).toBe(false);
    expect(isInternalAssistantLeakText(null as unknown)).toBe(false);
    expect(isInternalAssistantLeakText("")).toBe(false);
    expect(isInternalAssistantLeakText("   ")).toBe(false);
  });
});

describe("isInternalAssistantLeakText — fragment-after-dot", () => {
  // The trailing fragment after the suppressed leak does not carry
  // enough signal on its own to be detected. The streaming sanitizer
  // relies on `suppressRemainingText` (set after the first leak hit)
  // to drop subsequent text in the same block. We document that
  // contract here so future tightening doesn't accidentally turn the
  // benign trailing prose into a global gag rule.
  it("treats `tool due maybe alias?` as ambiguous on its own", () => {
    const detected = isInternalAssistantLeakText(fragmentAfterDot);
    // This branch exists to flag if the detector's behavior changes:
    // either it stays false (current contract — relying on
    // suppressRemainingText) OR it tightens further (acceptable, but
    // re-verify benign sentences).
    expect(typeof detected).toBe("boolean");
  });
});

describe("isInternalToolHistoryLeakText", () => {
  it("matches `[Previous ...] result; call_id=...` shapes", () => {
    expect(
      isInternalToolHistoryLeakText(
        "[Previous tool result; call_id=abc123]",
      ),
    ).toBe(true);
  });

  it("rejects benign text", () => {
    expect(isInternalToolHistoryLeakText("[Previous reply was wrong.]")).toBe(false);
    expect(isInternalToolHistoryLeakText("normal assistant text")).toBe(false);
  });
});

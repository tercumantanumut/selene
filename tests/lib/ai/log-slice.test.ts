import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEAD_LINES,
  MAX_GREP_MATCHES,
  PER_CALL_TOKEN_BUDGET,
  sliceLogText,
} from "@/lib/ai/log-slice";

function buildLog(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("sliceLogText", () => {
  it("default mode returns the first DEFAULT_HEAD_LINES", () => {
    const log = buildLog(1_000);
    const slice = sliceLogText(log, {});

    expect(slice.mode).toBe("default");
    expect(slice.totalLines).toBe(1_000);
    expect(slice.content.split("\n")).toHaveLength(DEFAULT_HEAD_LINES);
    expect(slice.content.split("\n")[0]).toBe("line 1");
    expect(slice.content.split("\n").at(-1)).toBe(`line ${DEFAULT_HEAD_LINES}`);
    expect(slice.meta.note).toBeTruthy();
  });

  it("head N returns the first N lines", () => {
    const log = buildLog(500);
    const slice = sliceLogText(log, { head: 20 });
    expect(slice.mode).toBe("head");
    expect(slice.content.split("\n")).toHaveLength(20);
    expect(slice.meta.fromLine).toBe(1);
    expect(slice.meta.toLine).toBe(20);
  });

  it("tail N returns the last N lines", () => {
    const log = buildLog(500);
    const slice = sliceLogText(log, { tail: 5 });
    expect(slice.mode).toBe("tail");
    const lines = slice.content.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("line 496");
    expect(lines[4]).toBe("line 500");
    expect(slice.meta.fromLine).toBe(496);
    expect(slice.meta.toLine).toBe(500);
  });

  it("range [a,b] returns the 1-indexed inclusive slice", () => {
    const log = buildLog(100);
    const slice = sliceLogText(log, { range: [10, 15] });
    expect(slice.mode).toBe("range");
    const lines = slice.content.split("\n");
    expect(lines).toEqual(["line 10", "line 11", "line 12", "line 13", "line 14", "line 15"]);
    expect(slice.meta.fromLine).toBe(10);
    expect(slice.meta.toLine).toBe(15);
  });

  it("range clamps the upper bound to totalLines", () => {
    const log = buildLog(20);
    const slice = sliceLogText(log, { range: [15, 500] });
    expect(slice.meta.fromLine).toBe(15);
    expect(slice.meta.toLine).toBe(20);
  });

  it("ignores UI placeholder range values so head can win", () => {
    const log = buildLog(20);
    const slice = sliceLogText(log, {
      head: 3,
      tail: 0,
      range: [0, 0],
      grep: "",
    });

    expect(slice.mode).toBe("head");
    expect(slice.content.split("\n")).toEqual(["line 1", "line 2", "line 3"]);
  });

  it("defaults when only UI placeholder slice values are present", () => {
    const log = buildLog(300);
    const slice = sliceLogText(log, {
      tail: 0,
      range: [0, 0],
      grep: "",
    });

    expect(slice.mode).toBe("default");
    expect(slice.content.split("\n")[0]).toBe("line 1");
  });

  it("grep returns matches with 2 lines of context and 'match:' markers", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) {
      if (i === 42 || i === 77) lines.push(`line ${i} ERROR here`);
      else lines.push(`line ${i} normal`);
    }
    const log = lines.join("\n");

    const slice = sliceLogText(log, { grep: "ERROR" });
    expect(slice.mode).toBe("grep");
    expect(slice.meta.matchCount).toBe(2);

    // Should include both match line numbers and context lines.
    expect(slice.content).toMatch(/42:.*ERROR/);
    expect(slice.content).toMatch(/77:.*ERROR/);
    // Context lines appear with "-" prefix (not "match:")
    expect(slice.content).toMatch(/^\s*40-/m);
    expect(slice.content).toMatch(/^\s*44-/m);
    // Windows for 42 and 77 should be separated by the grep block separator.
    expect(slice.content).toContain("\n--\n");
  });

  it("grep returns 'no matches' message on zero hits", () => {
    const log = buildLog(50);
    const slice = sliceLogText(log, { grep: "nothingmatches" });
    expect(slice.meta.matchCount).toBe(0);
    expect(slice.content).toContain("no matches");
  });

  it("grep with invalid regex falls back to literal substring", () => {
    // "[unclosed" is invalid regex (unterminated character class). After escape,
    // the literal pattern "\[unclosed" should match the text below.
    const log = buildLog(10) + "\nthis has [unclosed bracket";
    const slice = sliceLogText(log, { grep: "[unclosed" });
    expect(slice.mode).toBe("grep");
    expect(slice.meta.matchCount).toBe(1);
  });

  it("grep caps matches at MAX_GREP_MATCHES", () => {
    // Every line contains the pattern.
    const log = Array.from({ length: MAX_GREP_MATCHES + 500 }, (_, i) => `err ${i}`).join("\n");
    const slice = sliceLogText(log, { grep: "err" });
    expect(slice.meta.matchCount).toBe(MAX_GREP_MATCHES);
  });

  it("slice output is budget-clamped when it would exceed PER_CALL_TOKEN_BUDGET", () => {
    // Build a log where tail of 4K lines would be well over the 8K token cap.
    const line = "x".repeat(200); // 200 chars per line → 50 tokens
    const log = Array.from({ length: 5_000 }, () => line).join("\n");
    const slice = sliceLogText(log, { tail: 5_000 });
    expect(slice.mode).toBe("tail");
    expect(slice.meta.budgetClamped).toBe(true);
    // The clamp marker is appended.
    expect(slice.content).toContain("SLICE CLAMPED");
    // Final size is below the 8K budget + marker overhead.
    const approxTokens = slice.content.length / 4;
    expect(approxTokens).toBeLessThan(PER_CALL_TOKEN_BUDGET + 200);
  });
});

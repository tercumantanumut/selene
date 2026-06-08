/**
 * Integration tests proving the bash → stream-guard handoff after the
 * char-cap removal. Bash now ships full stdout to the model, and the
 * stream-guard owns all sizing decisions in tokens.
 *
 * Tier reminder (tool-result-stream-guard.ts):
 *   - ≤ 10K tokens          → passthrough (verbatim)
 *   - 10K–25K tokens        → preview_plus_stub (stub + ~1.5K-token head)
 *   - > 25K tokens          → stub_only (outline + retrieval, no body)
 *
 * estimateTokens uses ~4 chars/token, so:
 *   - 20K chars  ≈ 5K tokens   → passthrough
 *   - 60K chars  ≈ 15K tokens  → preview_plus_stub
 *   - 200K chars ≈ 50K tokens  → stub_only
 */
import { describe, it, expect } from "vitest";
import { guardToolResultForStreaming } from "@/lib/ai/tool-result-stream-guard";

describe("bash → stream-guard handoff (post char-cap removal)", () => {
  it("passes bash output through verbatim when ≤ 10K tokens (the bug fix)", () => {
    // ~5K tokens — would have been chopped by the old 10K-char bash cap
    // (which fired at ~2.5K tokens) but lands well inside passthrough.
    const stdout = "x".repeat(20_000);
    const bashResult = {
      status: "success",
      stdout,
      stderr: "",
      exitCode: 0,
    };

    const guarded = guardToolResultForStreaming("bash", bashResult, {
      sessionId: "sess-1",
    });

    expect(guarded.blocked).toBe(false);
    expect((guarded.result as { stdout: string }).stdout).toBe(stdout);
    // No truncation marker — output is verbatim.
    expect((guarded.result as { stdout: string }).stdout).not.toContain("[TRUNCATED");
  });

  it("emits preview_plus_stub for 10K–25K-token bash output and reuses logId", () => {
    // ~15K tokens — squarely in the mid tier.
    const stdout = "y".repeat(60_000);
    const bashResult = {
      status: "error",
      stdout,
      stderr: "",
      exitCode: null,
      error: "Process terminated due to timeout or output limit",
      logId: "executor-log-X",
      isTruncated: true,
    };

    const guarded = guardToolResultForStreaming("bash", bashResult, {
      sessionId: "sess-1",
      initialActiveTools: new Set(["bash", "executeCommand"]),
    });

    expect(guarded.blocked).toBe(true);
    const result = guarded.result as { stdout: string; stderr: string; logId: string };
    // Original logId must be reused (not overwritten with a contentId).
    expect(result.logId).toBe("executor-log-X");
    // Stub references readLog with the executor's logId so the model can fetch the rest.
    expect(result.stdout).toContain('executeCommand({ command: "readLog"');
    expect(result.stdout).toContain("executor-log-X");
    // Body shorter than original — replaced by stub + head preview.
    expect(result.stdout.length).toBeLessThan(stdout.length);
  });

  it("emits stub_only for > 25K-token bash output and falls back to contentId when no logId", () => {
    // ~50K tokens — above the preview tier, no logId provided.
    const stdout = "z".repeat(200_000);
    const bashResult = {
      status: "success",
      stdout,
      stderr: "",
      exitCode: 0,
    };

    const guarded = guardToolResultForStreaming("bash", bashResult, {
      sessionId: "sess-stub-only",
      initialActiveTools: new Set(["bash", "retrieveFullContent"]),
    });

    expect(guarded.blocked).toBe(true);
    const result = guarded.result as { stdout: string; isTruncated?: boolean };
    expect(result.isTruncated).toBe(true);
    // No logId on the input → guard falls back to retrieveFullContent.
    expect(result.stdout).toContain("retrieveFullContent");
    // Body massively shrunk — stub-only carries no preview.
    expect(result.stdout.length).toBeLessThan(stdout.length / 10);
  });
});

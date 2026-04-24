/**
 * Tests for guardToolResultForStreaming — specifically the retrievalToolLoaded
 * resolver added in Phase 1 of the model-looping fix.
 */
import { describe, it, expect } from "vitest";
import { guardToolResultForStreaming } from "@/lib/ai/tool-result-stream-guard";

const LARGE_TEXT = "line ".repeat(12_000); // ~12K chars → ~3K tokens → mid-tier

describe("guardToolResultForStreaming — retrievalToolLoaded resolver", () => {
  it("passes retrievalToolLoaded=true when executeCommand is in initialActiveTools", () => {
    const result = guardToolResultForStreaming(
      "bash",
      { stdout: LARGE_TEXT, stderr: "", logId: "log_001" },
      {
        maxTokens: 25_000,
        initialActiveTools: new Set(["bash", "executeCommand", "readFile"]),
        discoveredTools: new Set(),
      }
    );

    expect(result.blocked).toBe(true);
    const stub = JSON.stringify(result.result);
    // Step-0 must NOT be present because executeCommand is loaded
    expect(stub).not.toMatch(/Step 0.*MANDATORY/i);
    expect(stub).toContain("executeCommand({ command: \\\"readLog\\\"");
  });

  it("passes retrievalToolLoaded=false when executeCommand is NOT loaded anywhere", () => {
    const result = guardToolResultForStreaming(
      "bash",
      { stdout: LARGE_TEXT, stderr: "", logId: "log_002" },
      {
        maxTokens: 25_000,
        initialActiveTools: new Set(["bash", "readFile"]), // executeCommand NOT here
        discoveredTools: new Set(["searchTools"]),          // executeCommand NOT here
      }
    );

    expect(result.blocked).toBe(true);
    const stub = JSON.stringify(result.result);
    // Step-0 MUST be present because executeCommand is not loaded
    expect(stub).toContain("Step 0 (MANDATORY)");
    expect(stub).toContain("select:executeCommand");
  });

  it("passes retrievalToolLoaded=true when executeCommand is in discoveredTools", () => {
    const result = guardToolResultForStreaming(
      "bash",
      { stdout: LARGE_TEXT, stderr: "", logId: "log_003" },
      {
        maxTokens: 25_000,
        initialActiveTools: new Set(["bash"]), // executeCommand NOT initially loaded
        discoveredTools: new Set(["executeCommand"]), // BUT discovered later
      }
    );

    expect(result.blocked).toBe(true);
    const stub = JSON.stringify(result.result);
    // Step-0 must NOT be present because executeCommand was discovered
    expect(stub).not.toMatch(/Step 0.*MANDATORY/i);
  });

  it("passes retrievalToolLoaded=true for contentId when retrieveFullContent is available", () => {
    const textNoLogId = "content ".repeat(12_000);
    const result = guardToolResultForStreaming(
      "readFile",
      textNoLogId,
      {
        maxTokens: 25_000,
        sessionId: "test-session-guard",
        initialActiveTools: new Set(["retrieveFullContent"]),
        discoveredTools: new Set(),
      }
    );

    expect(result.blocked).toBe(true);
    const stub = JSON.stringify(result.result);
    // No step-0 for retrieveFullContent since it's loaded
    expect(stub).not.toMatch(/Step 0.*MANDATORY/i);
  });

  it("passthrough (under limit) does NOT interfere with retrievalToolLoaded logic", () => {
    const short = "short output";
    const result = guardToolResultForStreaming(
      "bash",
      { stdout: short, logId: "log_small" },
      {
        maxTokens: 25_000,
        initialActiveTools: new Set(["bash"]),
        discoveredTools: new Set(),
      }
    );

    // Under 10K tokens → passthrough, no stub
    expect(result.blocked).toBe(false);
    expect(typeof result.result).toBe("object");
  });
});

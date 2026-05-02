import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeToolResultOutput } from "@/lib/ai/tool-result-utils";

// Mock the run context
vi.mock("@/lib/observability/run-context", () => ({
  getRunContext: vi.fn(() => ({ sessionId: "test-session-id" })),
}));

// Mock the output limiter
vi.mock("@/lib/ai/output-limiter", () => ({
  limitToolOutput: vi.fn((output, toolName, sessionId) => ({
    limited: false,
    output: typeof output === "string" ? output : JSON.stringify(output),
    originalLength: 0,
    truncatedLength: 0,
    estimatedTokens: 0,
  })),
  MAX_TOOL_OUTPUT_TOKENS: 3000,
  CHARS_PER_TOKEN: 4,
  MAX_TOOL_OUTPUT_CHARS: 12000,
  estimateTokens: vi.fn(() => 100),
}));

// Mock the truncated content store
vi.mock("@/lib/ai/truncated-content-store", () => ({
  storeFullContent: vi.fn(() => "trunc_test123"),
}));

describe("normalizeToolResultOutput - readFile exemption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not truncate readFile output with large content field", async () => {
    // Create a large content string (20,000 chars, exceeds 12,000 char limit)
    const largeContent = "x".repeat(20000);
    const output = {
      status: "success",
      content: largeContent,
      filePath: "test.ts",
      lineRange: "1-1000",
      totalLines: 1000,
      language: "typescript",
    };

    const result = normalizeToolResultOutput("readFile", output, undefined, {
      mode: "projection",
    });

    // Should NOT be truncated
    expect(result.output).toBeDefined();
    const resultOutput = result.output as Record<string, unknown>;
    expect(resultOutput.content).toBe(largeContent);
    expect(resultOutput.truncated).toBeUndefined(); // Should not be marked as truncated
    expect(resultOutput.truncatedContentId).toBeUndefined();
  });

  it("does not truncate skill output with large content fields", async () => {
    const { limitToolOutput } = await import("@/lib/ai/output-limiter");
    vi.mocked(limitToolOutput).mockClear();

    const hugeContent = "x".repeat(150_000);
    const output = {
      success: true,
      action: "inspect",
      skill: { skillId: "db:skill-1", name: "Test Skill" },
      content: hugeContent,
      contentWithLineNumbers: hugeContent,
    };

    const result = normalizeToolResultOutput("skill", output, undefined, {
      mode: "projection",
    });

    expect(limitToolOutput).not.toHaveBeenCalled();
    const resultOutput = result.output as Record<string, unknown>;
    expect(resultOutput.content).toBe(hugeContent);
    expect(resultOutput.contentWithLineNumbers).toBe(hugeContent);
    expect(resultOutput.truncated).toBeUndefined();
    expect(resultOutput.truncatedContentId).toBeUndefined();
  });

  it("preserves readFile result structure without modification", () => {
    const output = {
      status: "success",
      content: "line 1\nline 2\nline 3",
      filePath: "components/test.tsx",
      lineRange: "430-480",
      totalLines: 500,
      language: "typescript",
      source: "synced_folder",
    };

    const result = normalizeToolResultOutput("readFile", output, undefined, {
      mode: "projection",
    });

    // Should preserve all fields exactly
    expect(result.output).toEqual({
      ...output,
      summary: expect.any(String), // Summary is added by normalization
    });
    expect(result.status).toBe("success");
  });

  it("still applies output limiting to other tools like executeCommand", async () => {
    const { limitToolOutput } = await import("@/lib/ai/output-limiter");
    
    // Mock limitToolOutput to simulate truncation for other tools
    vi.mocked(limitToolOutput).mockReturnValueOnce({
      limited: true,
      output: "truncated output",
      originalLength: 50000,
      truncatedLength: 12000,
      estimatedTokens: 12500,
      contentId: "trunc_abc123",
    });

    const largeOutput = "x".repeat(50000);
    const output = {
      stdout: largeOutput,
      stderr: "",
      exitCode: 0,
    };

    const result = normalizeToolResultOutput("executeCommand", output, undefined, {
      mode: "projection",
    });

    // Should be truncated - limitToolOutput must be called for executeCommand
    expect(limitToolOutput).toHaveBeenCalled();
    
    const resultOutput = result.output as Record<string, unknown>;
    expect(resultOutput.truncated).toBe(true);
    expect(resultOutput.truncatedContentId).toBe("trunc_abc123");
  });

  it("still applies output limiting to localGrep", async () => {
    const { limitToolOutput } = await import("@/lib/ai/output-limiter");
    
    vi.mocked(limitToolOutput).mockReturnValueOnce({
      limited: true,
      output: "truncated results",
      originalLength: 100000,
      truncatedLength: 12000,
      estimatedTokens: 25000,
      contentId: "trunc_xyz789",
    });

    const largeResults = "match line\n".repeat(10000);
    const output = {
      results: largeResults,
      matchCount: 10000,
    };

    const result = normalizeToolResultOutput("localGrep", output, undefined, {
      mode: "projection",
    });

    // Should be truncated - limitToolOutput must be called for localGrep
    expect(limitToolOutput).toHaveBeenCalled();
  });

  it("handles readFile error results without modification", () => {
    const output = {
      status: "error",
      error: "File not found: test.ts",
      allowedFolders: ["/path/to/folder"],
    };

    const result = normalizeToolResultOutput("readFile", output, undefined, {
      mode: "projection",
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("File not found: test.ts");
  });

  it("does not apply projection limiter in canonical mode", async () => {
    const { limitToolOutput } = await import("@/lib/ai/output-limiter");
    vi.mocked(limitToolOutput).mockClear();

    const output = {
      status: "success",
      content: "x".repeat(50000),
    };

    const result = normalizeToolResultOutput("webBrowse", output, undefined, {
      mode: "canonical",
    });

    expect(limitToolOutput).not.toHaveBeenCalled();
    expect((result.output as Record<string, unknown>).content).toBe(output.content);
  });

  it("keeps executeCommand payload lossless in canonical mode", () => {
    const output = {
      status: "success",
      stdout: "x".repeat(5000),
      stderr: "",
      logId: "log_123",
      exitCode: 0,
    };

    const result = normalizeToolResultOutput("executeCommand", output, undefined, {
      mode: "canonical",
    });

    const normalized = result.output as Record<string, unknown>;
    expect(normalized.stdout).toBe(output.stdout);
    expect(normalized.logId).toBe("log_123");
    expect(normalized.truncatedContentId).toBeUndefined();
  });

  it("compacts bash output in projection mode before model input limiting", async () => {
    const { limitToolOutput } = await import("@/lib/ai/output-limiter");

    const stdout = "x".repeat(50_000);
    const result = normalizeToolResultOutput("bash", {
      status: "success",
      stdout,
      stderr: "",
      logId: "log_bash_123",
      exitCode: 0,
    }, undefined, {
      mode: "projection",
    });

    const firstCallOutput = vi.mocked(limitToolOutput).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstCallOutput.stdout).toHaveLength(2032);
    expect(firstCallOutput.logId).toBe("log_bash_123");

    const normalized = result.output as Record<string, unknown>;
    expect(normalized.stdout).not.toBe(stdout);
    expect(normalized.logId).toBe("log_bash_123");
  });

  it("unwraps MCP CallToolResult text payloads into structured objects", () => {
    const output = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            expression: "14 + 5",
            result: 19,
            type: "number",
          }),
        },
      ],
    };

    const result = normalizeToolResultOutput("mcp__selene-platform__calculator", output, undefined, {
      mode: "canonical",
    });

    const normalized = result.output as Record<string, unknown>;
    expect(normalized.success).toBe(true);
    expect(normalized.expression).toBe("14 + 5");
    expect(normalized.result).toBe(19);
    expect(normalized.status).toBe("success");
  });

  it("unwraps double-encoded JSON strings inside MCP text payloads", () => {
    const onceEncoded = JSON.stringify({
      status: "success",
      query: "calculator math arithmetic",
      results: [{ name: "calculator", isAvailable: true }],
    });
    const doubleEncoded = JSON.stringify(onceEncoded);
    const output = {
      content: [{ type: "text", text: doubleEncoded }],
    };

    const result = normalizeToolResultOutput("mcp__selene-platform__searchTools", output, undefined, {
      mode: "canonical",
    });

    const normalized = result.output as Record<string, unknown>;
    expect(normalized.status).toBe("success");
    expect(normalized.query).toBe("calculator math arithmetic");
    expect(Array.isArray(normalized.results)).toBe(true);
  });

  it("preserves error status when MCP payload is marked isError", () => {
    const output = {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            message: "calculation failed",
          }),
        },
      ],
    };

    const result = normalizeToolResultOutput("mcp__selene-platform__calculator", output, undefined, {
      mode: "canonical",
    });

    const normalized = result.output as Record<string, unknown>;
    expect(normalized.status).toBe("error");
    expect(normalized.error).toBeTruthy();
  });
});

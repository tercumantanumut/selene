import { describe, expect, it, vi } from "vitest";

import {
  filterCodexInput,
  MAX_CODEX_PAYLOAD_BYTES,
  MAX_CODEX_VISION_PAYLOAD_BYTES,
  normalizeOrphanedToolOutputs,
  truncateCodexInput,
  type CodexInputItem,
} from "@/lib/auth/codex-input-utils";
import { UNKNOWN_TOOL_NAME } from "@/lib/messages/tool-name-placeholder";

describe("codex-input-utils", () => {
  it("strips item references and transient ids from codex input", () => {
    const input: CodexInputItem[] = [
      { type: "item_reference", id: "ref_1" },
      { type: "message", id: "msg_1", role: "user", content: "hello" },
    ];

    const filtered = filterCodexInput(input);

    expect(filtered).toEqual([{ type: "message", role: "user", content: "hello" }]);
  });

  it("strips leaked internal tool-history fallback assistant messages", () => {
    const input: CodexInputItem[] = [
      {
        type: "message",
        role: "assistant",
        content:
          '[Previous tool result; call_id=call_legacy]: {"status":"success","stdout":"..."}',
      },
      { type: "message", role: "assistant", content: "real assistant text" },
    ];

    const filtered = filterCodexInput(input);

    expect(filtered).toEqual([
      { type: "message", role: "assistant", content: "real assistant text" },
    ]);
  });

  it("preserves tool correlation when call id is provided via id", () => {
    const input: CodexInputItem[] = [
      { type: "function_call", id: "call_legacy", name: "executeCommand", arguments: "{\"command\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call_legacy", name: "executeCommand", output: { status: "success" } },
    ];

    const filtered = filterCodexInput(input);
    expect(filtered?.[0]).toMatchObject({
      type: "function_call",
      call_id: "call_legacy",
      name: "executeCommand",
    });
    expect(filtered?.[0]).not.toHaveProperty("id");

    const normalized = normalizeOrphanedToolOutputs(filtered ?? []);
    expect(normalized).toEqual(filtered);
  });

  it("keeps matched function call and output pairs", () => {
    const input: CodexInputItem[] = [
      { type: "function_call", call_id: "call_1", name: "executeCommand", arguments: "{\"command\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call_1", name: "executeCommand", output: { status: "success" } },
    ];

    const normalized = normalizeOrphanedToolOutputs(input);

    expect(normalized).toEqual(input);
  });

  it("reconstructs missing output for orphaned calls without converting to assistant text", () => {
    const input: CodexInputItem[] = [
      { type: "function_call", call_id: "call_1", name: "executeCommand", arguments: "{\"command\":\"ls\"}" },
      { type: "message", role: "user", content: "next prompt" },
    ];

    const normalized = normalizeOrphanedToolOutputs(input);

    expect(normalized[0]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "executeCommand",
    });
    expect(normalized[1]).toMatchObject({
      type: "message",
      role: "user",
    });
    expect(normalized[2]).toMatchObject({
      type: "function_call_output",
      call_id: "call_1",
      name: "executeCommand",
      output: {
        status: "error",
        reconstructed: true,
      },
    });
    expect(normalized.some((item) => item.type === "message" && String(item.content).includes("[Previous"))).toBe(false);
  });

  it("reconstructs missing call before orphaned outputs", () => {
    const input: CodexInputItem[] = [
      { type: "function_call_output", call_id: "call_2", name: "executeCommand", output: { status: "success" } },
    ];

    const normalized = normalizeOrphanedToolOutputs(input);

    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toMatchObject({
      type: "function_call",
      call_id: "call_2",
      name: "executeCommand",
    });
    expect(normalized[1]).toEqual(input[0]);
  });

  it("synthesizes UNKNOWN_TOOL_NAME (never the literal 'tool') when an orphan output has no name", () => {
    // Regression: the AI SDK serializes `function_call_output` items WITHOUT a
    // `name` field (the OpenAI Responses spec does not require one). When the
    // matching `function_call` is missing (e.g. it was replaced with an
    // `item_reference` by the AI SDK and stripped by filterCodexInput), we used
    // to synthesize the call with `name: "tool"`, which made Codex log
    // `functions.tool` as a missing tool and burn reasoning cycles. The
    // synthesized name must instead be the sentinel UNKNOWN_TOOL_NAME so
    // downstream sanitizers can recognize and route it correctly.
    const input: CodexInputItem[] = [
      { type: "function_call_output", call_id: "call_orphan", output: { status: "success" } },
    ];

    const normalized = normalizeOrphanedToolOutputs(input);

    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toMatchObject({
      type: "function_call",
      call_id: "call_orphan",
      name: UNKNOWN_TOOL_NAME,
    });
    expect(normalized[0].name).not.toBe("tool");
  });

  it("synthesizes UNKNOWN_TOOL_NAME when an orphan call has no name", () => {
    // Symmetric guard for the reverse case: a `function_call` without `name`
    // that needs a synthetic `function_call_output` paired to it.
    const input: CodexInputItem[] = [
      { type: "function_call", call_id: "call_no_name", arguments: "{}" },
      { type: "message", role: "user", content: "next" },
    ];

    const normalized = normalizeOrphanedToolOutputs(input);

    const syntheticOutput = normalized.find(
      (item) => item.type === "function_call_output" && item.call_id === "call_no_name",
    );
    expect(syntheticOutput).toBeDefined();
    expect(syntheticOutput?.name).toBe(UNKNOWN_TOOL_NAME);
    expect(syntheticOutput?.name).not.toBe("tool");
  });

  it("drops duplicate tool call/output events by call_id", () => {
    const input: CodexInputItem[] = [
      { type: "function_call", call_id: "call_dup", name: "executeCommand", arguments: "{\"command\":\"pwd\"}" },
      { type: "function_call", call_id: "call_dup", name: "executeCommand", arguments: "{\"command\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call_dup", name: "executeCommand", output: { status: "success" } },
      { type: "function_call_output", call_id: "call_dup", name: "executeCommand", output: { status: "success" } },
    ];

    const normalized = normalizeOrphanedToolOutputs(input);

    expect(normalized).toHaveLength(2);
    expect(normalized[0].type).toBe("function_call");
    expect(normalized[1].type).toBe("function_call_output");
  });

  it("does NOT extract nested tool-call parts from assistant content (regression: prevents orphan loop)", () => {
    // This test validates that nested tool-call parts inside assistant message
    // content arrays are kept in-place, NOT extracted to top-level function_call
    // items. Extracting them caused orphaned calls → synthetic error outputs →
    // model retries → infinite loop.
    const input: CodexInputItem[] = [
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Let me search the codebase." },
          { type: "tool-call", toolCallId: "call_nested_1", toolName: "localGrep", input: { pattern: "foo" } },
          { type: "tool-call", toolCallId: "call_nested_2", toolName: "readFile", input: { filePath: "/bar.ts" } },
        ],
      },
    ];

    const filtered = filterCodexInput(input);

    // All nested tool-call parts should stay inside the assistant message
    expect(filtered).toHaveLength(1);
    expect(filtered![0].type).toBe("message");
    expect(filtered![0].role).toBe("assistant");
    expect(Array.isArray(filtered![0].content)).toBe(true);
    expect((filtered![0].content as unknown[]).length).toBe(3);

    // No top-level function_call items should have been created
    const topLevelCalls = filtered!.filter((item) => item.type === "function_call");
    expect(topLevelCalls).toHaveLength(0);
  });

  it("drops invalid image payloads from message history before Codex transform", () => {
    const input: CodexInputItem[] = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "what is this?" },
          { type: "input_image", image_url: "[Base64 image data removed - use image URL instead]" },
        ],
      },
    ];

    const filtered = filterCodexInput(input);

    expect(filtered).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "what is this?" },
        ],
      },
    ]);
  });
});

describe("truncateCodexInput", () => {
  it("returns input unchanged when within limits", () => {
    const input: CodexInputItem[] = [
      { type: "message", role: "user", content: "hello" },
      { type: "function_call", call_id: "call_1", name: "tool", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", name: "tool", output: "ok" },
    ];

    const result = truncateCodexInput(input);
    expect(result).toEqual(input);
  });

  it("drops oldest tool pairs when payload exceeds byte limit", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Create 50 tool pairs with 20KB outputs each ≈ 1MB total (exceeds 990KB limit)
    const bigOutput = "x".repeat(20 * 1024); // 20 KB each
    const input: CodexInputItem[] = [
      { type: "message", role: "user", content: "search" },
    ];

    for (let i = 0; i < 50; i++) {
      input.push({ type: "function_call", call_id: `call_${i}`, name: "readFile", arguments: `{"filePath":"/big_${i}.ts"}` });
      input.push({ type: "function_call_output", call_id: `call_${i}`, name: "readFile", output: bigOutput });
    }

    input.push({ type: "message", role: "user", content: "now fix it" });

    // Verify payload exceeds limit before truncation
    const originalSize = JSON.stringify(input).length;
    expect(originalSize).toBeGreaterThan(990 * 1024);

    const result = truncateCodexInput(input);

    // Payload should be under limit after truncation
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(990 * 1024);

    // Some pairs dropped, but most preserved (only slightly over limit)
    const calls = result.filter((item) => item.type === "function_call");
    const outputs = result.filter((item) => item.type === "function_call_output");
    expect(calls.length).toBeLessThan(50);
    expect(calls.length).toBeGreaterThan(40);
    expect(calls.length).toBe(outputs.length);

    // Most recent pair preserved
    expect(calls.some((c) => c.call_id === "call_49")).toBe(true);
    expect(outputs.some((o) => o.call_id === "call_49")).toBe(true);

    // Summary message inserted so model knows about dropped context
    const summary = result.find(
      (item) => item.type === "message" && item.role === "developer" &&
        typeof item.content === "string" && (item.content as string).includes("Context trimmed")
    );
    expect(summary).toBeDefined();

    // User messages preserved
    expect(result[0].content).toBe("search");
    expect(result[result.length - 1].content).toBe("now fix it");

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("preserves all items unchanged when payload is under 990KB", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 50 tool pairs with 15KB outputs each ≈ 750KB (under 990KB limit)
    const input: CodexInputItem[] = [
      { type: "message", role: "user", content: "Search the codebase" },
    ];

    for (let i = 0; i < 50; i++) {
      input.push({
        type: "function_call",
        call_id: `call_${i}`,
        name: "readFile",
        arguments: `{"filePath":"/file_${i}.ts"}`,
      });
      input.push({
        type: "function_call_output",
        call_id: `call_${i}`,
        name: "readFile",
        output: "x".repeat(15 * 1024),
      });
    }

    input.push({ type: "message", role: "user", content: "Now fix everything" });

    // Verify payload is under limit
    expect(JSON.stringify(input).length).toBeLessThan(990 * 1024);

    const result = truncateCodexInput(input);

    // All items preserved unchanged — no truncation needed
    expect(result).toEqual(input);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("does not cap individual tool outputs — only drops pairs when over byte limit", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Create 10 tool pairs with 120KB outputs each ≈ 1.2MB (exceeds 990KB limit)
    const hugeOutput = "x".repeat(120 * 1024);
    const input: CodexInputItem[] = [
      { type: "message", role: "user", content: "read all" },
    ];

    for (let i = 0; i < 10; i++) {
      input.push({ type: "function_call", call_id: `call_${i}`, name: "readFile", arguments: `{"f":"${i}"}` });
      input.push({ type: "function_call_output", call_id: `call_${i}`, name: "readFile", output: hugeOutput });
    }

    const result = truncateCodexInput(input);

    // Surviving outputs should NOT be capped — full content preserved
    const survivingOutputs = result.filter(
      (item) => item.type === "function_call_output"
    );
    for (const item of survivingOutputs) {
      expect(item.output).toBe(hugeOutput);
    }

    // Most recent pairs preserved
    const calls = result.filter((item) => item.type === "function_call");
    expect(calls.some((c) => c.call_id === "call_9")).toBe(true);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("preserves image-bearing user messages under the vision payload budget", () => {
    const imageData = `data:image/png;base64,${"A".repeat(1200 * 1024)}`;
    const input: CodexInputItem[] = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "whats in the image" },
          { type: "input_image", image_url: imageData },
        ],
      },
      {
        type: "message",
        role: "assistant",
        content: "I don't see an image attached yet.",
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "try again" },
          { type: "input_image", image_url: imageData },
        ],
      },
    ];

    const originalSize = JSON.stringify(input).length;
    expect(originalSize).toBeGreaterThan(MAX_CODEX_PAYLOAD_BYTES);
    expect(originalSize).toBeLessThan(MAX_CODEX_VISION_PAYLOAD_BYTES);

    const result = truncateCodexInput(input);

    expect(result).toEqual(input);
    expect((result[0].content as Array<Record<string, unknown>>).some((part) => part.type === "input_image")).toBe(true);
    expect((result[2].content as Array<Record<string, unknown>>).some((part) => part.type === "input_image")).toBe(true);
  });
});

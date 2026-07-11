import { describe, it, expect } from "vitest";
import {
  isDictionary,
  sanitizeJsonStringValues,
  normalizeClaudeSdkToolName,
  normalizeAnthropicToolUseInputs,
} from "@/lib/ai/providers/claudecode-sdk/sanitize";

describe("isDictionary", () => {
  it("recognizes plain objects only", () => {
    expect(isDictionary({})).toBe(true);
    expect(isDictionary({ a: 1 })).toBe(true);
    expect(isDictionary([])).toBe(false);
    expect(isDictionary(null)).toBe(false);
    expect(isDictionary("x")).toBe(false);
  });
});

describe("sanitizeJsonStringValues", () => {
  it("leaves clean strings untouched", () => {
    const result = sanitizeJsonStringValues({ a: "hello", b: ["x", 1] });
    expect(result.changed).toBe(false);
    expect(result.value).toEqual({ a: "hello", b: ["x", 1] });
  });

  it("replaces a lone high surrogate with U+FFFD", () => {
    const lone = "bad\uD800end";
    const result = sanitizeJsonStringValues(lone);
    expect(result.changed).toBe(true);
    expect(result.value).toBe("bad�end");
  });

  it("replaces a lone low surrogate with U+FFFD", () => {
    const result = sanitizeJsonStringValues("\uDC00");
    expect(result.changed).toBe(true);
    expect(result.value).toBe("�");
  });

  it("preserves valid surrogate pairs (emoji)", () => {
    const emoji = "ok 😀";
    const result = sanitizeJsonStringValues(emoji);
    expect(result.changed).toBe(false);
    expect(result.value).toBe(emoji);
  });

  it("recurses into nested objects/arrays", () => {
    const result = sanitizeJsonStringValues({ list: [{ s: "x\uD800" }] });
    expect(result.changed).toBe(true);
    expect(result.value).toEqual({ list: [{ s: "x�" }] });
  });
});

describe("normalizeClaudeSdkToolName", () => {
  it("strips the selene-platform MCP prefix", () => {
    expect(normalizeClaudeSdkToolName("mcp__selene-platform__calculator")).toBe("calculator");
  });

  it("returns plain names unchanged", () => {
    expect(normalizeClaudeSdkToolName("Bash")).toBe("Bash");
  });

  it("recovers a name from a name=\"...\" fragment", () => {
    expect(normalizeClaudeSdkToolName('name="Task"')).toBe("Task");
  });

  it("recovers from dangling-quote corruption", () => {
    expect(normalizeClaudeSdkToolName('Task" subagent_type="Explore')).toBe("Task");
  });

  it("returns undefined for non-strings / empty", () => {
    expect(normalizeClaudeSdkToolName(undefined)).toBeUndefined();
    expect(normalizeClaudeSdkToolName(42)).toBeUndefined();
    expect(normalizeClaudeSdkToolName("   ")).toBeUndefined();
  });
});

describe("normalizeAnthropicToolUseInputs", () => {
  it("returns body unchanged when there are no messages", () => {
    const body = { model: "claude-sonnet-4-6" };
    const result = normalizeAnthropicToolUseInputs(body);
    expect(result.fixedCount).toBe(0);
    expect(result.body).toBe(body);
  });

  it("leaves valid object tool_use inputs untouched", () => {
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      ],
    };
    const result = normalizeAnthropicToolUseInputs(body);
    expect(result.fixedCount).toBe(0);
  });

  it("repairs a stringified-JSON tool_use input", () => {
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: '{"command":"ls"}' }] },
      ],
    };
    const result = normalizeAnthropicToolUseInputs(body);
    expect(result.fixedCount).toBe(1);
    const part = (result.body.messages as any[])[0].content[0];
    expect(part.input).toEqual({ command: "ls" });
  });

  it("replaces an unrecoverable input with a recovery placeholder", () => {
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: 12345 }] },
      ],
    };
    const result = normalizeAnthropicToolUseInputs(body);
    expect(result.fixedCount).toBe(1);
    const part = (result.body.messages as any[])[0].content[0];
    expect(part.input._recoveredInvalidToolUseInput).toBe(true);
    expect(part.input._inputType).toBe("number");
  });
});

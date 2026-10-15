import { describe, expect, it } from "vitest";
import { stripRedundantArgsText } from "@/app/api/chat/canonical-content";
import type { DBContentPart } from "@/lib/messages/converter";

describe("stripRedundantArgsText", () => {
  it("drops argsText only where args are set and the call finished streaming", () => {
    const parts = [
      { type: "text", text: "hi" },
      { type: "tool-call", toolCallId: "a", toolName: "Bash", args: { command: "ls" }, argsText: '{"command":"ls"}', state: "input-available" },
      { type: "tool-call", toolCallId: "b", toolName: "Bash", argsText: '{"comm', state: "input-streaming" },
      { type: "tool-call", toolCallId: "c", toolName: "Bash", args: {}, argsText: "{", state: "input-streaming" },
    ] as unknown as DBContentPart[];

    const result = stripRedundantArgsText(parts) as Array<Record<string, unknown>>;

    expect(result[0]).toBe(parts[0]);
    expect(result[1]).toEqual({ type: "tool-call", toolCallId: "a", toolName: "Bash", args: { command: "ls" }, state: "input-available" });
    expect(result[2]).toBe(parts[2]);
    expect(result[3]).toBe(parts[3]);
    expect((parts[1] as unknown as Record<string, unknown>).argsText).toBe('{"command":"ls"}');
  });

  it("returns the same array when nothing changes", () => {
    const parts = [{ type: "text", text: "hi" }] as unknown as DBContentPart[];
    expect(stripRedundantArgsText(parts)).toBe(parts);
  });
});

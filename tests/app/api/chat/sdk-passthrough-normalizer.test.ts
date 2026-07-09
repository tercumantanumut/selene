import { describe, it, expect } from "vitest";
import {
  normalizeSdkPassthroughOutput,
  buildMissingSdkPassthroughOutput,
} from "@/app/api/chat/sdk-passthrough-normalizer";

describe("normalizeSdkPassthroughOutput", () => {
  it("returns a canonical object output for a string result", () => {
    const out = normalizeSdkPassthroughOutput("Bash", "hello", { command: "echo hi" });
    expect(out).toBeTypeOf("object");
    expect(out).not.toBeNull();
  });

  it("strips the mcp__server__ prefix from the tool name", () => {
    // Should not throw and should normalize under the leaf name.
    const out = normalizeSdkPassthroughOutput("mcp__selene-platform__calculator", { result: 4 }, { a: 2, b: 2 });
    expect(out).toBeTypeOf("object");
  });
});

describe("buildMissingSdkPassthroughOutput", () => {
  it("produces a structured error result with the missing marker", () => {
    const out = buildMissingSdkPassthroughOutput("Read", { file_path: "/x" }, { reason: "no result" });
    expect(out.status).toBe("error");
    expect(out.sdkPassthroughMissing).toBe(true);
    expect(String(out.error)).toContain("Read");
  });

  it("adds heredoc guidance for Bash commands", () => {
    const out = buildMissingSdkPassthroughOutput(
      "Bash",
      { command: "cat <<EOF\nhi\nEOF" },
      { reason: "timeout" },
    );
    expect(out.status).toBe("error");
    expect(String(out.stderr)).toMatch(/heredoc/i);
    expect(out.command).toBe("cat <<EOF\nhi\nEOF");
  });

  it("includes the runtime reason in stderr details", () => {
    const out = buildMissingSdkPassthroughOutput("Bash", { command: "ls" }, { reason: "bridge wait failed" });
    expect(String(out.stderr)).toContain("bridge wait failed");
  });
});

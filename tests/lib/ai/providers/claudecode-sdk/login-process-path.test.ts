import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { getCliPath } from "@/lib/ai/providers/claudecode-sdk/login-process";

describe("Claude Agent SDK executable resolution", () => {
  it("resolves the native platform package executable", () => {
    const executablePath = getCliPath();
    const executableName = process.platform === "win32" ? "claude.exe" : "claude";

    expect(path.basename(executablePath)).toBe(executableName);
    expect(executablePath).toContain(
      path.join("@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`),
    );
    expect(fs.existsSync(executablePath)).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const filesystemMocks = vi.hoisted(() => ({
  resolveWorkspaceAwarePaths: vi.fn(),
}));

const commandExecutionMocks = vi.hoisted(() => ({
  executeCommandWithValidation: vi.fn(),
}));

const validatorMocks = vi.hoisted(() => ({
  validateExecutionDirectory: vi.fn(),
}));

const fspMocks = vi.hoisted(() => ({
  access: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("@/lib/ai/filesystem", () => ({
  resolveWorkspaceAwarePaths: filesystemMocks.resolveWorkspaceAwarePaths,
}));

vi.mock("@/lib/command-execution", () => ({
  executeCommandWithValidation: commandExecutionMocks.executeCommandWithValidation,
}));

vi.mock("@/app/api/chat/delegation-waiting", () => ({
  registerBackgroundTask: vi.fn(),
}));

vi.mock("@/lib/command-execution/validator", () => ({
  validateExecutionDirectory: validatorMocks.validateExecutionDirectory,
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    default: {
      ...actual,
      access: fspMocks.access,
      readdir: fspMocks.readdir,
      readFile: fspMocks.readFile,
    },
    access: fspMocks.access,
    readdir: fspMocks.readdir,
    readFile: fspMocks.readFile,
  };
});

const childProcessMocks = vi.hoisted(() => ({
  execSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: childProcessMocks.execSync,
}));

import {
  createExecuteCommandTool,
  normalizeExecuteCommandInput,
} from "@/lib/ai/tools/execute-command-tool";

function createToolContext() {
  return {
    toolCallId: "tc-1",
    messages: [],
    abortSignal: new AbortController().signal,
  };
}

describe("execute-command-tool normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    filesystemMocks.resolveWorkspaceAwarePaths.mockResolvedValue(["C:\\workspace"]);

    // Mock path validation to pass (returns valid result with resolved path)
    validatorMocks.validateExecutionDirectory.mockResolvedValue({
      valid: true,
      resolvedPath: "C:\\workspace",
    });

    commandExecutionMocks.executeCommandWithValidation.mockResolvedValue({
      success: true,
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      signal: null,
      executionTime: 12,
    });
  });

  it("normalizes inline python -c from single command string", () => {
    const normalized = normalizeExecuteCommandInput(
      "python -c from math import sin;print(sin(0))",
      []
    );

    expect(normalized).toEqual({
      command: "python",
      args: ["-c", "from math import sin;print(sin(0))"],
    });
  });

  it("normalizes split python -c script args into one script argument", () => {
    const normalized = normalizeExecuteCommandInput("python", [
      "-c",
      "from",
      "math",
      "import",
      "sin;print(sin(0))",
    ]);

    expect(normalized).toEqual({
      command: "python",
      args: ["-c", "from math import sin;print(sin(0))"],
    });
  });

  it("keeps non-python commands unchanged", () => {
    const normalized = normalizeExecuteCommandInput("git", ["status"]);

    expect(normalized).toEqual({
      command: "git",
      args: ["status"],
    });
  });

  it("tags progress updates with the executeCommand tool name", async () => {
    const onProgress = vi.fn();
    const tool = createExecuteCommandTool({
      sessionId: "sess-1",
      characterId: "char-1",
      onProgress,
    });

    commandExecutionMocks.executeCommandWithValidation.mockImplementation(async (options) => {
      options.onProgress?.({
        command: "git",
        args: ["status"],
        cwd: "C:\\workspace",
        stdout: "partial output",
        stderr: "",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      });
      return {
        success: true,
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        signal: null,
        executionTime: 12,
        startedAt: "2026-01-01T00:00:00.000Z",
      };
    });

    await tool.execute({ command: "git", args: ["status"] }, createToolContext());

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "tc-1",
        toolName: "executeCommand",
        status: "running",
      })
    );
  });

  it("applies normalization before executeCommandWithValidation", async () => {
    const tool = createExecuteCommandTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    await tool.execute(
      {
        command: "python -c from math import sin;print(sin(0))",
      },
      createToolContext()
    );

    expect(commandExecutionMocks.executeCommandWithValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "python",
        // The tool may wrap the `-c` payload in quotes on Windows for compatibility.
        args: ["-c", expect.any(String)],
        cwd: "C:\\workspace",
        characterId: "char-1",
      }),
      ["C:\\workspace"]
    );

    const call = commandExecutionMocks.executeCommandWithValidation.mock.calls[0]?.[0];
    expect(call.args[1]).toContain("from math import sin;print(sin(0))");
  });

  it("uses workspace-aware paths for explicit subagent worktree execution", async () => {
    filesystemMocks.resolveWorkspaceAwarePaths.mockResolvedValue([
      "C:\\worktrees\\feature-x",
      "C:\\repo",
    ]);

    const tool = createExecuteCommandTool({
      sessionId: "subagent-sess-1",
      characterId: "subagent-char-1",
    });

    await tool.execute(
      {
        command: "git",
        args: ["status"],
        cwd: "C:\\worktrees\\feature-x",
      },
      createToolContext()
    );

    expect(filesystemMocks.resolveWorkspaceAwarePaths).toHaveBeenCalledWith(
      "subagent-char-1",
      "subagent-sess-1"
    );
    expect(commandExecutionMocks.executeCommandWithValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "C:\\worktrees\\feature-x",
        characterId: "subagent-char-1",
      }),
      ["C:\\worktrees\\feature-x", "C:\\repo"]
    );
  });

  it("moves apply_patch payloads into stdin automatically", async () => {
    const tool = createExecuteCommandTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    await tool.execute(
      {
        command: "apply_patch",
        args: [
          "*** Begin Patch",
          "*** Add File: tmp.txt",
          "+hello",
          "*** End Patch",
        ],
      },
      createToolContext()
    );

    expect(commandExecutionMocks.executeCommandWithValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "apply_patch",
        args: [],
        stdin: "*** Begin Patch\n*** Add File: tmp.txt\n+hello\n*** End Patch\n",
      }),
      ["C:\\workspace"]
    );
  });

  it("returns structured inlineDiff with computed file diffs on successful apply_patch", async () => {
    commandExecutionMocks.executeCommandWithValidation.mockResolvedValue({
      success: true,
      stdout: "Done!",
      stderr: "",
      exitCode: 0,
      signal: null,
      executionTime: 5,
    });

    // Mock reading the patched file
    fspMocks.readFile.mockResolvedValue("hello world\n");
    // Mock git show for before content (throws = new file)
    childProcessMocks.execSync.mockImplementation(() => {
      throw new Error("not in git");
    });

    const tool = createExecuteCommandTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    const result = await tool.execute(
      {
        command: "apply_patch",
        args: [
          "*** Begin Patch",
          "*** Add File: tmp.txt",
          "+hello world",
          "*** End Patch",
        ],
      },
      createToolContext()
    );

    expect(result.inlineDiff).toBeDefined();
    expect(typeof result.inlineDiff).toBe("object");
    const payload = result.inlineDiff as { files: Array<{ path: string; operation: string; diff: string }>; rawPatch: string };
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].path).toBe("tmp.txt");
    expect(payload.files[0].operation).toBe("add");
    expect(payload.files[0].diff).toContain("+hello world");
    expect(payload.rawPatch).toContain("*** Begin Patch");
  });

  it("falls back to raw patch string when apply_patch fails", async () => {
    commandExecutionMocks.executeCommandWithValidation.mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "patch failed",
      exitCode: 1,
      signal: null,
      executionTime: 3,
    });

    const tool = createExecuteCommandTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    const result = await tool.execute(
      {
        command: "apply_patch",
        args: [
          "*** Begin Patch",
          "*** Modify File: foo.ts",
          "@@ -1,1 +1,1 @@",
          "-old",
          "+new",
          "*** End Patch",
        ],
      },
      createToolContext()
    );

    // When apply_patch fails, inlineDiff should be the raw string (not structured)
    expect(typeof result.inlineDiff).toBe("string");
    expect(result.inlineDiff).toContain("*** Begin Patch");
  });

  it("returns structured inlineDiff with modify operation showing before/after", async () => {
    commandExecutionMocks.executeCommandWithValidation.mockResolvedValue({
      success: true,
      stdout: "Done!",
      stderr: "",
      exitCode: 0,
      signal: null,
      executionTime: 5,
    });

    // Mock reading the patched (after) file
    fspMocks.readFile.mockResolvedValue("line1\nnew line\nline3\n");
    // Mock git show returning the before content
    childProcessMocks.execSync.mockReturnValue("line1\nold line\nline3\n");

    const tool = createExecuteCommandTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    const result = await tool.execute(
      {
        command: "apply_patch",
        args: [
          "*** Begin Patch",
          "*** Modify File: src/foo.ts",
          "@@ -1,3 +1,3 @@",
          " line1",
          "-old line",
          "+new line",
          " line3",
          "*** End Patch",
        ],
      },
      createToolContext()
    );

    expect(result.inlineDiff).toBeDefined();
    expect(typeof result.inlineDiff).toBe("object");
    const payload = result.inlineDiff as { files: Array<{ path: string; operation: string; diff: string }>; rawPatch: string };
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].path).toBe("src/foo.ts");
    expect(payload.files[0].operation).toBe("modify");
    expect(payload.files[0].diff).toContain("-old line");
    expect(payload.files[0].diff).toContain("+new line");
  });

  it("resolves ${CLAUDE_PLUGIN_ROOT} command placeholders from local plugin folders", async () => {
    // Mock fs/promises so resolveClaudePluginRootPlaceholder finds the plugin on disk
    const testPluginsBase = path.join(process.cwd(), "test_plugins");
    const candidateRoot = path.join(testPluginsBase, "ralph-loop");

    fspMocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === testPluginsBase) {
        return [{ name: "ralph-loop", isDirectory: () => true }];
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    fspMocks.access.mockImplementation(async (p: string) => {
      if (p === path.join(candidateRoot, "scripts", "setup-ralph-loop.sh")) {
        return undefined; // success
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const tool = createExecuteCommandTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    await tool.execute(
      {
        command: "${CLAUDE_PLUGIN_ROOT}/scripts/setup-ralph-loop.sh",
      },
      createToolContext()
    );

    expect(commandExecutionMocks.executeCommandWithValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringMatching(/test_plugins[\\/]ralph-loop[\\/]scripts[\\/]setup-ralph-loop\.sh/),
      }),
      ["C:\\workspace"]
    );
  });
});

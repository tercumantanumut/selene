import { beforeEach, describe, expect, it, vi } from "vitest";

const filesystemMocks = vi.hoisted(() => ({
  resolveWorkspaceAwarePaths: vi.fn(),
}));

const commandExecutionMocks = vi.hoisted(() => ({
  executeCommandWithValidation: vi.fn(),
  startBackgroundProcess: vi.fn(),
  getBackgroundProcess: vi.fn(),
  markBackgroundProcessObserved: vi.fn(),
  killBackgroundProcess: vi.fn(),
  listBackgroundProcesses: vi.fn(),
  cleanupBackgroundProcesses: vi.fn(),
}));

const cwdStateMocks = vi.hoisted(() => ({
  getPersistedCommandCwd: vi.fn(),
  setPersistedCommandCwd: vi.fn(),
}));

const validatorMocks = vi.hoisted(() => ({
  validateExecutionDirectory: vi.fn(),
  validateShellCommand: vi.fn(),
}));

const delegationWaitingMocks = vi.hoisted(() => ({
  registerBackgroundTask: vi.fn(),
}));

vi.mock("@/lib/ai/filesystem", () => ({
  resolveWorkspaceAwarePaths: filesystemMocks.resolveWorkspaceAwarePaths,
}));

vi.mock("@/lib/command-execution", () => ({
  executeCommandWithValidation: commandExecutionMocks.executeCommandWithValidation,
  startBackgroundProcess: commandExecutionMocks.startBackgroundProcess,
  getBackgroundProcess: commandExecutionMocks.getBackgroundProcess,
  markBackgroundProcessObserved: commandExecutionMocks.markBackgroundProcessObserved,
  killBackgroundProcess: commandExecutionMocks.killBackgroundProcess,
  listBackgroundProcesses: commandExecutionMocks.listBackgroundProcesses,
  cleanupBackgroundProcesses: commandExecutionMocks.cleanupBackgroundProcesses,
}));

vi.mock("@/lib/command-execution/cwd-state", () => ({
  getPersistedCommandCwd: cwdStateMocks.getPersistedCommandCwd,
  setPersistedCommandCwd: cwdStateMocks.setPersistedCommandCwd,
}));

vi.mock("@/lib/command-execution/validator", () => ({
  validateExecutionDirectory: validatorMocks.validateExecutionDirectory,
  validateShellCommand: validatorMocks.validateShellCommand,
}));

vi.mock("@/app/api/chat/delegation-waiting", () => ({
  registerBackgroundTask: delegationWaitingMocks.registerBackgroundTask,
}));

import { createBashTool } from "@/lib/ai/tools/bash-tool";

const isWindows = process.platform === "win32";

function createToolContext() {
  return {
    toolCallId: "tc-1",
    messages: [],
    abortSignal: new AbortController().signal,
  };
}

describe("bash-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    filesystemMocks.resolveWorkspaceAwarePaths.mockResolvedValue(["/workspace"]);
    cwdStateMocks.getPersistedCommandCwd.mockResolvedValue(null);
    cwdStateMocks.setPersistedCommandCwd.mockResolvedValue(undefined);
    validatorMocks.validateExecutionDirectory.mockResolvedValue({ valid: true, resolvedPath: "/workspace" });
    validatorMocks.validateShellCommand.mockReturnValue({ valid: true });

    commandExecutionMocks.executeCommandWithValidation.mockResolvedValue({
      success: true,
      stdout: "status ok\n__SELENE_CWD__:/workspace/app",
      stderr: "",
      exitCode: 0,
      signal: null,
      executionTime: 25,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("wraps a shell command and persists cwd markers", async () => {
    const tool = createBashTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    const result = await tool.execute(
      { command: "git status" },
      createToolContext()
    );

    expect(result.status).toBe("success");
    expect(result.stdout).toBe("status ok");
    expect(cwdStateMocks.setPersistedCommandCwd).toHaveBeenCalledWith(
      "sess-1",
      "/workspace/app"
    );
  });

  it("tags progress updates with the bash tool name", async () => {
    const onProgress = vi.fn();
    const tool = createBashTool({
      sessionId: "sess-1",
      characterId: "char-1",
      onProgress,
    });

    commandExecutionMocks.executeCommandWithValidation.mockImplementation(async (options) => {
      options.onProgress?.({
        command: "/bin/sh",
        args: ["-lc", "git status"],
        cwd: "/workspace",
        stdout: "partial output",
        stderr: "",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      });
      return {
        success: true,
        stdout: "status ok\n__SELENE_CWD__:/workspace/app",
        stderr: "",
        exitCode: 0,
        signal: null,
        executionTime: 25,
        startedAt: "2026-01-01T00:00:00.000Z",
      };
    });

    await tool.execute({ command: "git status" }, createToolContext());

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "tc-1",
        toolName: "bash",
        status: "running",
      })
    );

    if (isWindows) {
      expect(commandExecutionMocks.executeCommandWithValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          command: process.env.ComSpec || "cmd.exe",
          cwd: "/workspace",
          characterId: "char-1",
          args: expect.arrayContaining(["/v:on", "/d", "/s", "/c"]),
          windowsVerbatimArguments: true,
        }),
        ["/workspace"]
      );
      // Verify the command string is inside the args (last element)
      const callArgs = commandExecutionMocks.executeCommandWithValidation.mock.calls[0][0];
      const cmdArg = callArgs.args[callArgs.args.length - 1];
      expect(cmdArg).toContain("git status");
    } else {
      expect(commandExecutionMocks.executeCommandWithValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "/bin/sh",
          cwd: "/workspace",
          characterId: "char-1",
          args: ["-lc", expect.stringContaining("git status")],
          stdin: undefined,
        }),
        ["/workspace"]
      );
    }
  });

  it("reuses persisted cwd when available", async () => {
    cwdStateMocks.getPersistedCommandCwd.mockResolvedValue("/workspace/app");
    validatorMocks.validateExecutionDirectory.mockResolvedValue({ valid: true, resolvedPath: "/workspace/app" });

    const tool = createBashTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    await tool.execute(
      { command: "npm test" },
      createToolContext()
    );

    expect(commandExecutionMocks.executeCommandWithValidation).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/workspace/app" }),
      ["/workspace"]
    );
  });

  it("uses workspace-aware paths when persisted cwd is inside a subagent worktree", async () => {
    filesystemMocks.resolveWorkspaceAwarePaths.mockResolvedValue([
      "/worktrees/feature-x",
      "/repo",
    ]);
    cwdStateMocks.getPersistedCommandCwd.mockResolvedValue("/worktrees/feature-x/app");
    validatorMocks.validateExecutionDirectory.mockResolvedValue({
      valid: true,
      resolvedPath: "/worktrees/feature-x/app",
    });

    const tool = createBashTool({
      sessionId: "subagent-sess-1",
      characterId: "subagent-char-1",
    });

    await tool.execute({ command: "pwd" }, createToolContext());

    expect(filesystemMocks.resolveWorkspaceAwarePaths).toHaveBeenCalledWith(
      "subagent-char-1",
      "subagent-sess-1"
    );
    expect(validatorMocks.validateExecutionDirectory).toHaveBeenCalledWith(
      "/worktrees/feature-x/app",
      ["/worktrees/feature-x", "/repo"]
    );
    expect(commandExecutionMocks.executeCommandWithValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/worktrees/feature-x/app",
        characterId: "subagent-char-1",
      }),
      ["/worktrees/feature-x", "/repo"]
    );
  });

  it("blocks dangerous shell removal commands", async () => {
    validatorMocks.validateShellCommand.mockReturnValue({
      valid: false,
      error: "Shell contains a removal command (rm). Use confirmRemoval to proceed.",
    });

    const tool = createBashTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    const result = await tool.execute(
      { command: "rm -rf node_modules" },
      createToolContext()
    );

    expect(result.status).toBe("blocked");
    expect(result.error).toContain("removal command");
    expect(commandExecutionMocks.executeCommandWithValidation).not.toHaveBeenCalled();
  });


  it("rejects background status actions without processId", async () => {
    const tool = createBashTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    const result = await tool.execute(
      { action: "status" },
      createToolContext()
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe('bash action "status" requires processId.');
    expect(commandExecutionMocks.executeCommandWithValidation).not.toHaveBeenCalled();
  });

  it("ignores action/processId when command is present (model hallucination tolerance)", async () => {
    const tool = createBashTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    const result = await tool.execute(
      { command: "git status", processId: "bg-123", action: "status" },
      createToolContext()
    );

    // When command is provided, action/processId are ignored — command execution wins
    expect(result.status).toBe("success");
    expect(commandExecutionMocks.executeCommandWithValidation).toHaveBeenCalled();
  });

  it("moves apply_patch heredoc payloads into stdin automatically", async () => {
    commandExecutionMocks.executeCommandWithValidation.mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "patch failed",
      exitCode: 1,
      signal: null,
      executionTime: 3,
    });

    const tool = createBashTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    const result = await tool.execute(
      {
        command: [
          "apply_patch <<'PATCH'",
          "*** Begin Patch",
          "*** Add File: tmp.txt",
          "+hello",
          "*** End Patch",
          "PATCH",
        ].join("\n"),
      },
      createToolContext()
    );

    expect(commandExecutionMocks.executeCommandWithValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "apply_patch",
        args: [],
        stdin: "*** Begin Patch\n*** Add File: tmp.txt\n+hello\n*** End Patch\n",
      }),
      ["/workspace"]
    );
    expect(result.inlineDiff).toContain("*** Begin Patch");
  });

  it("extracts apply_patch heredoc with cd prefix (Windows pattern)", async () => {
    commandExecutionMocks.executeCommandWithValidation.mockResolvedValue({
      success: true,
      stdout: "patched",
      stderr: "",
      exitCode: 0,
      signal: null,
      executionTime: 5,
    });

    const tool = createBashTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    const result = await tool.execute(
      {
        command: [
          "cd /d C:\\Users\\test\\project && apply_patch <<'PATCH'",
          "*** Begin Patch",
          "*** Update File: src/index.ts",
          "@@",
          "+console.log('hello');",
          "*** End Patch",
          "PATCH",
        ].join("\n"),
      },
      createToolContext()
    );

    expect(commandExecutionMocks.executeCommandWithValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "apply_patch",
        args: [],
        stdin: "*** Begin Patch\n*** Update File: src/index.ts\n@@\n+console.log('hello');\n*** End Patch\n",
        cwd: "C:\\Users\\test\\project",
      }),
      ["/workspace"]
    );
    expect(result.status).toBe("success");
    expect(result.inlineDiff).toContain("*** Begin Patch");
  });

  it("extracts apply_patch from PowerShell here-string syntax", async () => {
    commandExecutionMocks.executeCommandWithValidation.mockResolvedValue({
      success: true,
      stdout: "patched",
      stderr: "",
      exitCode: 0,
      signal: null,
      executionTime: 2,
    });

    const tool = createBashTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    const result = await tool.execute(
      {
        command: "@'\n*** Begin Patch\n*** Add File: foo.txt\n+bar\n*** End Patch\n'@ | apply_patch",
      },
      createToolContext()
    );

    expect(commandExecutionMocks.executeCommandWithValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "apply_patch",
        args: [],
        stdin: "*** Begin Patch\n*** Add File: foo.txt\n+bar\n*** End Patch\n",
      }),
      ["/workspace"]
    );
    expect(result.status).toBe("success");
  });

  it("handles \\r\\n line endings in apply_patch heredoc", async () => {
    commandExecutionMocks.executeCommandWithValidation.mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      executionTime: 1,
    });

    const tool = createBashTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    const result = await tool.execute(
      {
        command: "apply_patch <<'PATCH'\r\n*** Begin Patch\r\n*** Add File: test.txt\r\n+hello\r\n*** End Patch\r\nPATCH",
      },
      createToolContext()
    );

    expect(commandExecutionMocks.executeCommandWithValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "apply_patch",
        args: [],
        stdin: "*** Begin Patch\n*** Add File: test.txt\n+hello\n*** End Patch\n",
      }),
      ["/workspace"]
    );
    expect(result.status).toBe("success");
  });

  it("starts background shell commands", async () => {
    commandExecutionMocks.startBackgroundProcess.mockResolvedValue({
      processId: "bg-123",
    });

    const tool = createBashTool({
      sessionId: "sess-1",
      characterId: "char-1",
    });

    const result = await tool.execute(
      { command: "npm run dev", run_in_background: true },
      createToolContext()
    );

    expect(result.status).toBe("background_started");
    expect(result.processId).toBe("bg-123");
    if (isWindows) {
      expect(commandExecutionMocks.startBackgroundProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          command: process.env.ComSpec || "cmd.exe",
          cwd: "/workspace",
          args: expect.arrayContaining(["/v:on", "/d", "/s", "/c"]),
          windowsVerbatimArguments: true,
        }),
        ["/workspace"]
      );
      const callArgs = commandExecutionMocks.startBackgroundProcess.mock.calls[0][0];
      const cmdArg = callArgs.args[callArgs.args.length - 1];
      expect(cmdArg).toContain("npm run dev");
    } else {
      expect(commandExecutionMocks.startBackgroundProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "/bin/sh",
          cwd: "/workspace",
          args: ["-lc", expect.stringContaining("npm run dev")],
          stdin: undefined,
          onBackgroundProcessSettled: expect.any(Function),
        }),
        ["/workspace"]
      );
    }
  });

  if (isWindows) {
    it("preserves inner quotes in Windows cmd.exe wrapping for rg patterns with spaces", async () => {
      const tool = createBashTool({
        sessionId: "sess-1",
        characterId: "char-1",
      });

      await tool.execute(
        { command: 'rg -n "design workspace|Component not found" "C:/project"' },
        createToolContext()
      );

      const callArgs = commandExecutionMocks.executeCommandWithValidation.mock.calls[0][0];
      // The entire command should be wrapped in outer quotes for cmd.exe /s /c
      const cmdArg = callArgs.args[callArgs.args.length - 1];
      expect(cmdArg).toMatch(/^"/); // starts with quote
      expect(cmdArg).toMatch(/"$/); // ends with quote
      expect(cmdArg).toContain("design workspace|Component not found");
      expect(cmdArg).toContain("C:/project");
      expect(callArgs.windowsVerbatimArguments).toBe(true);
    });

    it("sets windowsVerbatimArguments on background processes for Windows", async () => {
      commandExecutionMocks.startBackgroundProcess.mockResolvedValue({
        processId: "bg-456",
      });

      const tool = createBashTool({
        sessionId: "sess-1",
        characterId: "char-1",
      });

      await tool.execute(
        { command: 'echo "hello world"', run_in_background: true },
        createToolContext()
      );

      const callArgs = commandExecutionMocks.startBackgroundProcess.mock.calls[0][0];
      expect(callArgs.windowsVerbatimArguments).toBe(true);
    });
  }
});

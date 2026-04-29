import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const filesystemMocks = vi.hoisted(() => ({
    resolveWorkspaceAwarePaths: vi.fn(),
}));

const executorMocks = vi.hoisted(() => ({
    executeCommandWithValidation: vi.fn(),
    startBackgroundProcess: vi.fn(),
    getBackgroundProcess: vi.fn(),
    markBackgroundProcessObserved: vi.fn(),
    killBackgroundProcess: vi.fn(),
    listBackgroundProcesses: vi.fn(),
    cleanupBackgroundProcesses: vi.fn(),
}));

const validatorMocks = vi.hoisted(() => ({
    validateExecutionDirectory: vi.fn(),
}));

vi.mock("@/lib/ai/filesystem", () => ({
    resolveWorkspaceAwarePaths: filesystemMocks.resolveWorkspaceAwarePaths,
}));

vi.mock("@/lib/command-execution", () => ({
    executeCommandWithValidation: executorMocks.executeCommandWithValidation,
    startBackgroundProcess: executorMocks.startBackgroundProcess,
    getBackgroundProcess: executorMocks.getBackgroundProcess,
    markBackgroundProcessObserved: executorMocks.markBackgroundProcessObserved,
    killBackgroundProcess: executorMocks.killBackgroundProcess,
    listBackgroundProcesses: executorMocks.listBackgroundProcesses,
    cleanupBackgroundProcesses: executorMocks.cleanupBackgroundProcesses,
}));

vi.mock("@/lib/command-execution/validator", () => ({
    validateExecutionDirectory: validatorMocks.validateExecutionDirectory,
}));

import { createExecuteCommandTool } from "@/lib/ai/tools/execute-command-tool";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createToolContext() {
    return {
        toolCallId: "tc-1",
        messages: [],
        abortSignal: new AbortController().signal,
    };
}

function makeTool() {
    return createExecuteCommandTool({
        sessionId: "sess-1",
        characterId: "char-1",
    });
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();

    filesystemMocks.resolveWorkspaceAwarePaths.mockResolvedValue(["C:\\workspace"]);

    validatorMocks.validateExecutionDirectory.mockResolvedValue({
        valid: true,
        resolvedPath: "C:\\workspace",
    });

    executorMocks.executeCommandWithValidation.mockResolvedValue({
        success: true,
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        signal: null,
        executionTime: 12,
    });
});

// ── Background execution ─────────────────────────────────────────────────────

describe("background execution", () => {
    it("should start a background process and return processId", async () => {
        executorMocks.startBackgroundProcess.mockResolvedValue({
            processId: "bg-123",
        });

        const tool = makeTool();
        const result = await tool.execute(
            {
                command: "npx",
                args: ["-y", "create-vite@latest", "my-app"],
                background: true,
            },
            createToolContext(),
        );

        expect(result.status).toBe("background_started");
        expect(result.processId).toBe("bg-123");
        expect(executorMocks.startBackgroundProcess).toHaveBeenCalledWith(
            expect.objectContaining({
                command: "npx",
                args: ["-y", "create-vite@latest", "my-app"],
                cwd: "C:\\workspace",
                characterId: "char-1",
                onBackgroundProcessSettled: expect.any(Function),
            }),
            expect.any(Array), // allowedPaths (syncedFolders)
        );
    });

    it("should return error when background spawn fails", async () => {
        executorMocks.startBackgroundProcess.mockResolvedValue({
            processId: "",
            error: "spawn failed",
        });

        const tool = makeTool();
        const result = await tool.execute(
            { command: "bad-cmd", background: true },
            createToolContext(),
        );

        expect(result.status).toBe("error");
        expect(result.error).toBe("spawn failed");
    });
});

// ── Process status checking ──────────────────────────────────────────────────

describe("process status checking", () => {
    it("should return running status for an active background process", async () => {
        executorMocks.getBackgroundProcess.mockReturnValue({
            id: "bg-456",
            command: "npm",
            args: ["install"],
            cwd: "C:\\workspace",
            startedAt: Date.now() - 5000,
            running: true,
            stdout: "installing...",
            stderr: "",
            exitCode: null,
            signal: null,
            logId: "log-running",
        });

        const tool = makeTool();
        const result = await tool.execute(
            { processId: "bg-456" },
            createToolContext(),
        );

        expect(result.status).toBe("running");
        expect(result.processId).toBe("bg-456");
        expect(result.stdout).toBe("installing...");
        expect(result.logId).toBe("log-running");
        expect(result.message).toContain('executeCommand({ command: "readLog", logId: "log-running" })');
        expect(executorMocks.markBackgroundProcessObserved).toHaveBeenCalledWith("bg-456");
    });

    it("should return completed status for a finished background process", async () => {
        executorMocks.getBackgroundProcess.mockReturnValue({
            id: "bg-789",
            command: "npm",
            args: ["install"],
            cwd: "C:\\workspace",
            startedAt: Date.now() - 10000,
            running: false,
            stdout: "added 100 packages",
            stderr: "",
            exitCode: 0,
            signal: null,
            logId: "log-finished",
        });

        const tool = makeTool();
        const result = await tool.execute(
            { processId: "bg-789" },
            createToolContext(),
        );

        expect(result.status).toBe("success");
        expect(result.processId).toBe("bg-789");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("added 100 packages");
        expect(result.logId).toBe("log-finished");
        expect(result.message).toContain('executeCommand({ command: "readLog", logId: "log-finished" })');
    });

    it("should return error for a failed background process", async () => {
        executorMocks.getBackgroundProcess.mockReturnValue({
            id: "bg-err",
            command: "npm",
            args: ["install"],
            cwd: "C:\\workspace",
            startedAt: Date.now() - 10000,
            running: false,
            stdout: "",
            stderr: "ERR! code ENOENT",
            exitCode: 1,
            signal: null,
        });

        const tool = makeTool();
        const result = await tool.execute(
            { processId: "bg-err" },
            createToolContext(),
        );

        expect(result.status).toBe("error");
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe("ERR! code ENOENT");
    });

    it("should return error for non-existent processId", async () => {
        executorMocks.getBackgroundProcess.mockReturnValue(null);

        const tool = makeTool();
        const result = await tool.execute(
            { processId: "bg-nope" },
            createToolContext(),
        );

        expect(result.status).toBe("error");
        expect(result.error).toContain("bg-nope");
    });
});

// ── Kill background process ──────────────────────────────────────────────────

describe("kill background process", () => {
    it("should kill a background process by processId", async () => {
        executorMocks.killBackgroundProcess.mockReturnValue(true);

        const tool = makeTool();
        const result = await tool.execute(
            { command: "kill", processId: "bg-123" },
            createToolContext(),
        );

        expect(result.status).toBe("success");
        expect(result.message).toContain("terminated");
        expect(executorMocks.killBackgroundProcess).toHaveBeenCalledWith("bg-123");
    });

    it("should return error when process to kill is not found", async () => {
        executorMocks.killBackgroundProcess.mockReturnValue(false);

        const tool = makeTool();
        const result = await tool.execute(
            { command: "kill", processId: "bg-ghost" },
            createToolContext(),
        );

        expect(result.status).toBe("error");
        expect(result.error).toContain("bg-ghost");
    });
});

// ── List background processes ────────────────────────────────────────────────

describe("list background processes", () => {
    it("should list running and finished background processes", async () => {
        executorMocks.listBackgroundProcesses.mockReturnValue([
            { id: "bg-1", command: "npm install", running: true, elapsed: 5000 },
            { id: "bg-2", command: "npx create-vite", running: false, elapsed: 30000 },
        ]);

        const tool = makeTool();
        const result = await tool.execute(
            { command: "list" },
            createToolContext(),
        );

        expect(result.status).toBe("success");
        expect(result.stdout).toContain("bg-1");
        expect(result.stdout).toContain("RUNNING");
        expect(result.stdout).toContain("bg-2");
        expect(result.stdout).toContain("DONE");
    });

    it("should report when no background processes exist", async () => {
        executorMocks.listBackgroundProcesses.mockReturnValue([]);

        const tool = makeTool();
        const result = await tool.execute(
            { command: "list" },
            createToolContext(),
        );

        expect(result.status).toBe("success");
        expect(result.message).toContain("No background processes");
    });
});

// ── Foreground execution still works ─────────────────────────────────────────

describe("foreground execution", () => {
    it("should pass timeout to executor when explicitly provided", async () => {
        const tool = makeTool();
        await tool.execute(
            { command: "npm", args: ["test"], timeout: 120_000 },
            createToolContext(),
        );

        expect(executorMocks.executeCommandWithValidation).toHaveBeenCalledWith(
            expect.objectContaining({
                timeout: 120_000,
            }),
            expect.any(Array),
        );
    });

    it("should let executor pick default timeout when not explicitly provided", async () => {
        const tool = makeTool();
        await tool.execute(
            { command: "npm", args: ["install"] },
            createToolContext(),
        );

        // timeout should be undefined so executor uses its smart default
        const call = executorMocks.executeCommandWithValidation.mock.calls[0][0];
        expect(call.timeout).toBeUndefined();
    });

    it("should cap timeout at 10 minutes", async () => {
        const tool = makeTool();
        await tool.execute(
            { command: "node", args: ["-e", "1"], timeout: 999_999_999 },
            createToolContext(),
        );

        const call = executorMocks.executeCommandWithValidation.mock.calls[0][0];
        expect(call.timeout).toBeLessThanOrEqual(600_000);
    });

    it("should return error when no characterId", async () => {
        const tool = createExecuteCommandTool({
            sessionId: "sess-1",
            characterId: null,
        });

        const result = await tool.execute(
            { command: "node", args: ["-e", "1"] },
            createToolContext(),
        );

        expect(result.status).toBe("error");
        expect(result.error).toContain("No agent context");
    });

    it("should return no_folders when agent has no synced folders", async () => {
        filesystemMocks.resolveWorkspaceAwarePaths.mockResolvedValue([]);

        const tool = makeTool();
        const result = await tool.execute(
            { command: "node", args: ["-e", "1"] },
            createToolContext(),
        );

        expect(result.status).toBe("no_folders");
    });

});

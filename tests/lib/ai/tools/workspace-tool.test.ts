import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => {
  const execFileAsync = vi.fn();
  const execFile = vi.fn();
  (execFile as any)[Symbol.for("nodejs.util.promisify.custom")] = execFileAsync;
  return { execFile, execFileAsync };
});

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  realpathSync: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateSession: vi.fn(),
}));

const syncServiceMocks = vi.hoisted(() => ({
  addSyncFolder: vi.fn(),
  setSyncFolderStatus: vi.fn(),
  removeSyncFolder: vi.fn(),
}));

const workspaceMetadataMocks = vi.hoisted(() => ({
  resolveWorkspaceInfoFromSession: vi.fn(async (session: { metadata?: { workspaceInfo?: unknown } }) => session.metadata?.workspaceInfo ?? null),
  writeWorkspaceInfo: vi.fn(),
  updateWorkspaceLifecycleMetadata: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: childProcessMocks.execFile,
}));

vi.mock("fs", () => ({
  existsSync: fsMocks.existsSync,
  mkdirSync: fsMocks.mkdirSync,
  realpathSync: fsMocks.realpathSync,
}));

vi.mock("@/lib/db/queries", () => ({
  getSession: dbMocks.getSession,
  updateSession: dbMocks.updateSession,
}));

vi.mock("@/lib/vectordb/sync-service", () => ({
  addSyncFolder: syncServiceMocks.addSyncFolder,
  setSyncFolderStatus: syncServiceMocks.setSyncFolderStatus,
  removeSyncFolder: syncServiceMocks.removeSyncFolder,
}));

vi.mock("@/lib/workspace/metadata", () => workspaceMetadataMocks);

import { createWorkspaceTool } from "@/lib/ai/tools/workspace-tool";

describe("workspace-tool create action", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    dbMocks.getSession.mockResolvedValue({ id: "sess-1", metadata: {} });
    dbMocks.updateSession.mockResolvedValue(undefined);

    syncServiceMocks.addSyncFolder.mockResolvedValue("sync-folder-1");
    syncServiceMocks.setSyncFolderStatus.mockResolvedValue(undefined);

    workspaceMetadataMocks.writeWorkspaceInfo.mockImplementation(async (_sessionId: string, workspaceInfo: Record<string, unknown>) => workspaceInfo);
    workspaceMetadataMocks.updateWorkspaceLifecycleMetadata.mockImplementation(async (_sessionId: string, patch: Record<string, unknown>) => ({
      type: "worktree",
      branch: "feature/windows-path-fix",
      baseBranch: "main",
      worktreePath: "C:\\repo\\worktrees\\feature-windows-path-fix",
      status: "active",
      ...patch,
    }));

    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.mkdirSync.mockReturnValue(undefined);
    fsMocks.realpathSync.mockImplementation((p: string) => p);
  });

  it.skipIf(process.platform !== "win32")("accepts Windows absolute repoPath and verifies repo via git rev-parse", async () => {
    childProcessMocks.execFileAsync
      .mockResolvedValueOnce({ stdout: "true\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "main\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const tool = createWorkspaceTool({
      sessionId: "sess-1",
      characterId: "char-1",
      userId: "user-1",
    });

    const result = await (tool as any).execute({
      action: "create",
      branch: "feature/windows-path-fix",
      repoPath: "C:\\repo\\project",
    });

    expect(result.status).toBe("success");
    expect(childProcessMocks.execFileAsync).toHaveBeenNthCalledWith(
      1,
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      expect.objectContaining({ cwd: "C:\\repo\\project" }),
    );
    expect(childProcessMocks.execFileAsync).toHaveBeenNthCalledWith(
      2,
      "git",
      ["branch", "--show-current"],
      expect.objectContaining({ cwd: "C:\\repo\\project" }),
    );
    expect(childProcessMocks.execFileAsync).toHaveBeenNthCalledWith(
      3,
      "git",
      [
        "worktree",
        "add",
        "-b",
        "feature/windows-path-fix",
        "C:\\repo\\worktrees\\feature-windows-path-fix",
        "main",
      ],
      expect.objectContaining({ cwd: "C:\\repo\\project" }),
    );
    expect(syncServiceMocks.addSyncFolder).toHaveBeenCalledWith(
      expect.objectContaining({
        folderPath: "C:\\repo\\worktrees\\feature-windows-path-fix",
        // Workspace registrations must flag source: "workspace" so the sync
        // pipeline skips UI notifications, workflow propagation, and the
        // pending→synced status race the previous separate setSyncFolderStatus
        // call introduced.
        source: "workspace",
      }),
    );
    // The redundant "set status to synced" call was removed — addSyncFolder
    // now inserts workspace folders with status="synced" directly.
    expect(syncServiceMocks.setSyncFolderStatus).not.toHaveBeenCalled();
    expect(workspaceMetadataMocks.writeWorkspaceInfo).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        type: "worktree",
        branch: "feature/windows-path-fix",
      }),
      "workspace-tool:create",
    );
  });

  it("returns a clear error when git rev-parse says repoPath is not a repository", async () => {
    childProcessMocks.execFileAsync.mockRejectedValueOnce(
      new Error("Git command failed: fatal: not a git repository"),
    );

    const tool = createWorkspaceTool({
      sessionId: "sess-1",
      characterId: "char-1",
      userId: "user-1",
    });

    const result = await (tool as any).execute({
      action: "create",
      branch: "feature/windows-path-fix",
      repoPath: "C:\\not-a-repo",
    });

    expect(result.status).toBe("error");
    expect(String(result.error || "")).toContain("not a valid git repository");
    expect(String(result.error || "")).toContain("fatal: not a git repository");
  });

  it("routes update-metadata through the lifecycle helper", async () => {
    dbMocks.getSession.mockResolvedValue({
      id: "sess-1",
      metadata: {
        workspaceInfo: {
          type: "worktree",
          branch: "feature/windows-path-fix",
          baseBranch: "main",
          worktreePath: "C:\\repo\\worktrees\\feature-windows-path-fix",
          status: "active",
        },
      },
    });

    const tool = createWorkspaceTool({
      sessionId: "sess-1",
      characterId: "char-1",
      userId: "user-1",
    });

    const result = await (tool as any).execute({
      action: "update-metadata",
      prUrl: "https://example.com/pr/1",
      prNumber: 1,
      prStatus: "open",
      status: "pr-open",
    });

    expect(result.status).toBe("success");
    expect(workspaceMetadataMocks.updateWorkspaceLifecycleMetadata).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        prUrl: "https://example.com/pr/1",
        prNumber: 1,
        prStatus: "open",
        status: "pr-open",
      }),
      "workspace-tool:update-metadata",
    );
  });
});

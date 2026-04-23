import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the tool test from the DB-backed filesystem helpers. `path-utils` pulls in
// `@/lib/db/sqlite-client` at import time, which loads better-sqlite3's native binding.
// The tool only needs `isOtherWorktreePath` from that module, so a lightweight stub
// keeps the test hermetic for local runs regardless of native-module ABI.
vi.mock("@/lib/ai/filesystem/path-utils", () => ({
  isOtherWorktreePath: vi.fn(() => false),
}));

const settingsMock = vi.hoisted(() => {
  const state = {
    settings: {
      localGrepEnabled: true,
      localGrepMaxResults: 50,
      localGrepContextLines: 2,
      localGrepRespectGitignore: true,
      searchBackend: "auto" as "auto" | "ripgrep" | "fff",
      searchBackendFallback: true,
    },
  };

  return {
    state,
    loadSettings: vi.fn(() => state.settings),
  };
});

const ripgrepMock = vi.hoisted(() => ({
  isRipgrepAvailable: vi.fn(() => true),
  searchWithRipgrep: vi.fn(),
}));

vi.mock("@/lib/settings/settings-manager", () => ({
  loadSettings: settingsMock.loadSettings,
}));

vi.mock("@/lib/ai/ripgrep/ripgrep", () => ({
  isRipgrepAvailable: ripgrepMock.isRipgrepAvailable,
  searchWithRipgrep: ripgrepMock.searchWithRipgrep,
}));

const syncFolderMock = vi.hoisted(() => ({
  getAccessibleSyncFolders: vi.fn(async () => []),
}));

const pathValidationMock = vi.hoisted(() => ({
  validateSyncFolderPath: vi.fn(async (folderPath: string) => ({ normalizedPath: folderPath, error: null })),
}));

const sessionQueriesMock = vi.hoisted(() => ({
  getSession: vi.fn(async () => null),
}));

const workspaceTypesMock = vi.hoisted(() => ({
  getWorkspaceInfo: vi.fn(() => null),
}));

vi.mock("@/lib/vectordb/accessible-sync-folders", () => ({
  getAccessibleSyncFolders: syncFolderMock.getAccessibleSyncFolders,
}));

vi.mock("@/lib/vectordb/path-validation", () => ({
  validateSyncFolderPath: pathValidationMock.validateSyncFolderPath,
}));

vi.mock("@/lib/db/queries", () => ({
  getSession: sessionQueriesMock.getSession,
}));

vi.mock("@/lib/workspace/types", () => ({
  getWorkspaceInfo: workspaceTypesMock.getWorkspaceInfo,
}));

import { createLocalGrepTool } from "@/lib/ai/ripgrep/tool";

describe("localGrep tool contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.state.settings.localGrepEnabled = true;
    settingsMock.state.settings.localGrepRespectGitignore = true;
    settingsMock.state.settings.searchBackend = "auto";
    settingsMock.state.settings.searchBackendFallback = true;
    ripgrepMock.isRipgrepAvailable.mockReturnValue(true);
    syncFolderMock.getAccessibleSyncFolders.mockResolvedValue([]);
    sessionQueriesMock.getSession.mockResolvedValue(null);
    workspaceTypesMock.getWorkspaceInfo.mockReturnValue(null);
    pathValidationMock.validateSyncFolderPath.mockImplementation(async (folderPath: string) => ({
      normalizedPath: folderPath,
      error: null,
    }));
  });

  it("uses literal mode by default even when pattern has regex metacharacters", async () => {
    ripgrepMock.searchWithRipgrep.mockResolvedValue({
      matches: [],
      totalMatches: 0,
      wasTruncated: false,
    });

    const tool = createLocalGrepTool({ sessionId: "sess-1", characterId: null });
    const result = await tool.execute(
      {
        pattern: "updateCharacter(",
        paths: ["/repo"],
      },
      { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
    );

    expect(result).toMatchObject({ status: "success", regex: false });
    expect(ripgrepMock.searchWithRipgrep).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: "updateCharacter(",
        regex: false,
      })
    );
  });

  it("uses regex mode only when explicitly requested", async () => {
    ripgrepMock.searchWithRipgrep.mockResolvedValue({
      matches: [],
      totalMatches: 0,
      wasTruncated: false,
    });

    const tool = createLocalGrepTool({ sessionId: "sess-1", characterId: null });
    const result = await tool.execute(
      {
        pattern: "updateCharacter(",
        regex: true,
        paths: ["/repo"],
      },
      { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
    );

    expect(result).toMatchObject({ status: "success", regex: true });
    expect(ripgrepMock.searchWithRipgrep).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: "updateCharacter(",
        regex: true,
      })
    );
  });

  it("skips stale synced folders and still searches valid paths", async () => {
    syncFolderMock.getAccessibleSyncFolders.mockResolvedValue([
      { folderPath: "/missing-worktree" },
      { folderPath: "/repo" },
    ]);
    pathValidationMock.validateSyncFolderPath.mockImplementation(async (folderPath: string) => ({
      normalizedPath: folderPath,
      error: folderPath === "/missing-worktree" ? "Folder does not exist." : null,
    }));
    ripgrepMock.searchWithRipgrep.mockResolvedValue({
      matches: [],
      totalMatches: 0,
      wasTruncated: false,
    });

    const tool = createLocalGrepTool({ sessionId: "sess-1", characterId: "char-1" });
    const result = await tool.execute(
      {
        pattern: "localGrep",
      },
      { toolCallId: "tc-4", messages: [], abortSignal: new AbortController().signal }
    );

    expect(result).toMatchObject({
      status: "success",
      searchedPaths: ["/repo"],
    });
    expect(result.message).toContain("Skipped 1 unavailable synced folder path");
    expect(ripgrepMock.searchWithRipgrep).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ["/repo"] })
    );
  });

  it("returns no_paths with guidance when all synced folders are stale", async () => {
    syncFolderMock.getAccessibleSyncFolders.mockResolvedValue([{ folderPath: "/missing-worktree" }]);
    pathValidationMock.validateSyncFolderPath.mockResolvedValue({
      normalizedPath: "/missing-worktree",
      error: "Folder does not exist.",
    });

    const tool = createLocalGrepTool({ sessionId: "sess-1", characterId: "char-1" });
    const result = await tool.execute(
      {
        pattern: "localGrep",
      },
      { toolCallId: "tc-5", messages: [], abortSignal: new AbortController().signal }
    );

    expect(result.status).toBe("no_paths");
    expect(result.message).toContain("No valid synced folders are currently available");
  });

  it("prefers workspace path when no explicit paths are provided", async () => {
    sessionQueriesMock.getSession.mockResolvedValue({
      metadata: { workspaceInfo: { status: "active", worktreePath: "/worktree" } },
    });
    workspaceTypesMock.getWorkspaceInfo.mockReturnValue({
      status: "active",
      worktreePath: "/worktree",
    });
    ripgrepMock.searchWithRipgrep.mockResolvedValue({
      matches: [{ file: "/worktree/file.ts", line: 1, column: 0, text: "localGrep" }],
      totalMatches: 1,
      wasTruncated: false,
    });

    const tool = createLocalGrepTool({ sessionId: "sess-1", characterId: "char-1" });
    const result = await tool.execute(
      { pattern: "localGrep" },
      { toolCallId: "tc-6", messages: [], abortSignal: new AbortController().signal }
    );

    expect(result).toMatchObject({
      status: "success",
      pathSource: "workspace",
      searchedPaths: ["/worktree"],
      fallbackUsed: false,
      attemptedScopes: ["workspace"],
    });
    expect(ripgrepMock.searchWithRipgrep).toHaveBeenCalledTimes(1);
    expect(ripgrepMock.searchWithRipgrep).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ["/worktree"] })
    );
  });

  it("retries with synced folders in same call when workspace search has zero matches", async () => {
    sessionQueriesMock.getSession.mockResolvedValue({
      metadata: { workspaceInfo: { status: "active", worktreePath: "/worktree" } },
    });
    workspaceTypesMock.getWorkspaceInfo.mockReturnValue({
      status: "active",
      worktreePath: "/worktree",
    });
    syncFolderMock.getAccessibleSyncFolders.mockResolvedValue([{ folderPath: "/repo" }]);

    ripgrepMock.searchWithRipgrep
      .mockResolvedValueOnce({
        matches: [],
        totalMatches: 0,
        wasTruncated: false,
      })
      .mockResolvedValueOnce({
        matches: [{ file: "/repo/file.ts", line: 1, column: 0, text: "localGrep" }],
        totalMatches: 1,
        wasTruncated: false,
      });

    const tool = createLocalGrepTool({ sessionId: "sess-1", characterId: "char-1" });
    const result = await tool.execute(
      { pattern: "localGrep" },
      { toolCallId: "tc-7", messages: [], abortSignal: new AbortController().signal }
    );

    expect(result).toMatchObject({
      status: "success",
      pathSource: "workspace_then_synced",
      searchedPaths: ["/repo"],
      fallbackUsed: true,
      attemptedScopes: ["workspace", "synced_folders"],
    });
    expect(result.message).toContain("retried with synced folders");
    expect(ripgrepMock.searchWithRipgrep).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ paths: ["/worktree"] })
    );
    expect(ripgrepMock.searchWithRipgrep).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ paths: ["/repo"] })
    );
  });

  it("adds a regex-specific hint when regex parse fails", async () => {
    ripgrepMock.searchWithRipgrep.mockRejectedValue(new Error("ripgrep error: regex parse error: unclosed group"));

    const tool = createLocalGrepTool({ sessionId: "sess-1", characterId: null });
    const result = await tool.execute(
      {
        pattern: "updateCharacter(",
        regex: true,
        paths: ["/repo"],
      },
      { toolCallId: "tc-3", messages: [], abortSignal: new AbortController().signal }
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("regex parse error");
    expect(result.error).toContain("set regex: false");
    expect(result.error).toContain("escape metacharacters");
  });

  it("tags each successful result with the backend that produced it", async () => {
    ripgrepMock.searchWithRipgrep.mockResolvedValue({
      matches: [{ file: "/repo/a.ts", line: 1, column: 0, text: "match" }],
      totalMatches: 1,
      wasTruncated: false,
    });

    const tool = createLocalGrepTool({ sessionId: "sess-1", characterId: null });
    const result = await tool.execute(
      { pattern: "match", paths: ["/repo"] },
      { toolCallId: "tc-backend-1", messages: [], abortSignal: new AbortController().signal }
    );

    expect(result).toMatchObject({ status: "success", backend: "ripgrep" });
  });

  it("passes respectGitignore from settings through to the backend", async () => {
    settingsMock.state.settings.localGrepRespectGitignore = false;
    ripgrepMock.searchWithRipgrep.mockResolvedValue({
      matches: [],
      totalMatches: 0,
      wasTruncated: false,
    });

    const tool = createLocalGrepTool({ sessionId: "sess-1", characterId: null });
    await tool.execute(
      { pattern: "match", paths: ["/repo"] },
      { toolCallId: "tc-gitignore", messages: [], abortSignal: new AbortController().signal }
    );

    // Ripgrep must still run (fff would be filtered out by the tool's respectGitignore guard).
    expect(ripgrepMock.searchWithRipgrep).toHaveBeenCalledWith(
      expect.objectContaining({ respectGitignore: false })
    );
  });

  it("clamps excessive maxResults to the hard cap before invoking the backend", async () => {
    ripgrepMock.searchWithRipgrep.mockResolvedValue({
      matches: [],
      totalMatches: 0,
      wasTruncated: false,
    });

    const tool = createLocalGrepTool({ sessionId: "sess-1", characterId: null });
    await tool.execute(
      { pattern: "match", paths: ["/repo"], maxResults: 100_000 },
      { toolCallId: "tc-clamp-hi", messages: [], abortSignal: new AbortController().signal }
    );

    // MAX_RESULTS_HARD_CAP is 1000; anything larger must be clamped down so
    // downstream backends (especially fff, which multiplies into pageSize)
    // cannot receive unbounded values.
    expect(ripgrepMock.searchWithRipgrep).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 1000 })
    );
  });

  it("clamps non-positive maxResults up to at least 1", async () => {
    ripgrepMock.searchWithRipgrep.mockResolvedValue({
      matches: [],
      totalMatches: 0,
      wasTruncated: false,
    });

    const tool = createLocalGrepTool({ sessionId: "sess-1", characterId: null });
    await tool.execute(
      { pattern: "match", paths: ["/repo"], maxResults: 0 },
      { toolCallId: "tc-clamp-lo", messages: [], abortSignal: new AbortController().signal }
    );

    expect(ripgrepMock.searchWithRipgrep).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 1 })
    );
  });
});

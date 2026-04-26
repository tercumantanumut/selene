import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionStore = new Map<string, any>();
const syncFoldersStore = new Map<string, Array<any>>();

const queryMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (id: string) => sessionStore.get(id) ?? null),
  updateSession: vi.fn(async (id: string, data: Record<string, unknown>) => {
    const current = sessionStore.get(id) ?? { id, metadata: {}, characterId: null };
    const updated = {
      ...current,
      ...data,
      metadata: data.metadata,
    };
    sessionStore.set(id, updated);
    return updated;
  }),
}));

const syncFolderMocks = vi.hoisted(() => ({
  getSyncFolders: vi.fn(async (characterId: string) => syncFoldersStore.get(characterId) ?? []),
}));

vi.mock("@/lib/db/queries", () => queryMocks);
vi.mock("@/lib/vectordb/sync-folder-crud", () => syncFolderMocks);

import {
  resolveSessionWorkspaceInfo,
  resolveWorkspaceInfoFromSession,
  updateWorkspaceLifecycleMetadata,
  writeWorkspaceInfo,
} from "@/lib/workspace/metadata";
import type { WorkspaceInfo } from "@/lib/workspace/types";

const BASE_WORKSPACE: WorkspaceInfo = {
  type: "worktree",
  branch: "feat/original",
  baseBranch: "main",
  worktreePath: "/repo/worktrees/feat-original",
  syncFolderId: "folder-1",
  status: "active",
  changedFiles: 2,
  lastSyncedAt: "2026-04-26T09:00:00.000Z",
};

function seedSession(overrides: Record<string, unknown> = {}) {
  sessionStore.set("sess-1", {
    id: "sess-1",
    characterId: "char-1",
    metadata: { workspaceInfo: { ...BASE_WORKSPACE } },
    ...overrides,
  });
}

describe("workspace metadata helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStore.clear();
    syncFoldersStore.clear();
    seedSession();
    syncFoldersStore.set("char-1", [
      { id: "folder-1", folderPath: "/repo/worktrees/feat-original", source: "workspace" },
      { id: "repo-folder", folderPath: "/repo", source: "user" },
    ]);
  });

  it("keeps workspace identity stable during lifecycle updates", async () => {
    const updated = await updateWorkspaceLifecycleMetadata(
      "sess-1",
      {
        branch: "feat/attempted-rebind",
        worktreePath: "/repo/other",
        prUrl: "https://example.com/pr/1",
        status: "pr-open",
      },
      "test:lifecycle"
    );

    expect(updated.branch).toBe("feat/original");
    expect(updated.worktreePath).toBe("/repo/worktrees/feat-original");
    expect(updated.prUrl).toBe("https://example.com/pr/1");
    expect(updated.status).toBe("pr-open");
  });

  it("rejects implicit workspace identity overwrite", async () => {
    await expect(
      writeWorkspaceInfo(
        "sess-1",
        {
          ...BASE_WORKSPACE,
          branch: "feat/other",
          worktreePath: "/repo/worktrees/feat-other",
        },
        "test:write"
      )
    ).rejects.toThrow("Workspace identity changed during the operation");
  });

  it("resolves worktree workspace only when a workspace sync folder matches", async () => {
    await expect(resolveSessionWorkspaceInfo("sess-1")).resolves.toMatchObject({
      worktreePath: "/repo/worktrees/feat-original",
    });

    syncFoldersStore.set("char-1", [{ id: "folder-1", folderPath: "/repo/worktrees/feat-original", source: "user" }]);
    await expect(resolveSessionWorkspaceInfo("sess-1")).resolves.toBeNull();
  });

  it("allows local git mode when the synced folder matches without workspace source", async () => {
    const localSession = {
      id: "sess-local",
      characterId: "char-1",
      metadata: {
        workspaceInfo: {
          ...BASE_WORKSPACE,
          type: "local",
          worktreePath: "/repo",
          syncFolderId: "repo-folder",
        },
      },
    };

    await expect(resolveWorkspaceInfoFromSession(localSession)).resolves.toMatchObject({
      type: "local",
      worktreePath: "/repo",
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const promptMocks = vi.hoisted(() => ({
  getSystemPrompt: vi.fn(() => "BASE_PROMPT"),
  buildDefaultCacheableSystemPrompt: vi.fn(() => "BASE_PROMPT"),
  buildCharacterSystemPrompt: vi.fn(() => "CHAR_PROMPT"),
  buildCacheableCharacterPrompt: vi.fn(() => "CHAR_PROMPT"),
  getCharacterAvatarUrl: vi.fn(() => null),
}));

const characterMocks = vi.hoisted(() => ({
  getCharacterFull: vi.fn(async () => ({
    id: "char-1",
    userId: "user-1",
    name: "Selene",
    metadata: {},
    tagline: null,
  })),
}));

const skillMocks = vi.hoisted(() => ({
  getSkillsSummaryForPrompt: vi.fn(async () => []),
}));

const syncFolderMocks = vi.hoisted(() => ({
  getAccessibleSyncFolders: vi.fn(async () => []),
}));

const workspaceMetadataMocks = vi.hoisted(() => ({
  resolveSessionWorkspaceInfo: vi.fn(async () => null),
}));

vi.mock("@/lib/ai/config", () => ({
  getSystemPrompt: promptMocks.getSystemPrompt,
}));

vi.mock("@/lib/ai/character-prompt", () => ({
  buildCharacterSystemPrompt: promptMocks.buildCharacterSystemPrompt,
  buildCacheableCharacterPrompt: promptMocks.buildCacheableCharacterPrompt,
  getCharacterAvatarUrl: promptMocks.getCharacterAvatarUrl,
}));

vi.mock("@/lib/ai/prompts/base-system-prompt", () => ({
  buildDefaultCacheableSystemPrompt: promptMocks.buildDefaultCacheableSystemPrompt,
}));

vi.mock("@/lib/characters/queries", () => characterMocks);
vi.mock("@/lib/skills/queries", () => skillMocks);
vi.mock("@/lib/vectordb/accessible-sync-folders", () => syncFolderMocks);
vi.mock("@/lib/workspace/metadata", () => workspaceMetadataMocks);
vi.mock("@/lib/ai/filesystem", () => ({
  isWorktreePath: (p: string) => p.includes("/worktrees/"),
}));
vi.mock("@/app/api/chat/message-splitter", () => ({
  buildContextWindowPromptBlock: vi.fn(() => "CTX_BLOCK"),
}));
vi.mock("@/lib/ai/tools/delegation-completion-store", () => ({
  peekDelegationCompletions: vi.fn(() => []),
}));

import { buildSystemPromptForRequest } from "@/app/api/chat/system-prompt-builder";

describe("buildSystemPromptForRequest workspace verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    promptMocks.getSystemPrompt.mockReturnValue("BASE_PROMPT");
    promptMocks.buildDefaultCacheableSystemPrompt.mockReturnValue("BASE_PROMPT");
    promptMocks.buildCharacterSystemPrompt.mockReturnValue("CHAR_PROMPT");
    promptMocks.buildCacheableCharacterPrompt.mockReturnValue("CHAR_PROMPT");
    syncFolderMocks.getAccessibleSyncFolders.mockResolvedValue([
      { folderPath: "/repo", isPrimary: true, displayName: "Repo", status: "synced", fileCount: 12 },
      { folderPath: "/repo/worktrees/feat-a", isPrimary: false, displayName: "Workspace", status: "synced", fileCount: 2 },
    ]);
    workspaceMetadataMocks.resolveSessionWorkspaceInfo.mockResolvedValue({
      type: "worktree",
      branch: "feat/a",
      baseBranch: "main",
      worktreePath: "/repo/worktrees/feat-a",
      status: "active",
    });
  });

  it("uses the verified workspace resolver for synced folders and active workspace prompt blocks", async () => {
    const result = await buildSystemPromptForRequest({
      characterId: "char-1",
      userId: "user-1",
      sessionId: "sess-1",
      toolLoadingMode: "deferred",
      useCaching: false,
      sessionMetadata: {
        workspaceInfo: {
          type: "worktree",
          branch: "stale/branch",
          baseBranch: "main",
          worktreePath: "/repo/worktrees/stale",
          status: "active",
        },
      },
      contextWindowStatus: {
        currentTokens: 0,
        maxTokens: 1000,
        usagePercent: 0,
        warningThreshold: 80,
        criticalThreshold: 92,
        hardThreshold: 97,
      },
      workflowPromptContext: null,
      devWorkspaceEnabled: true,
    });

    expect(workspaceMetadataMocks.resolveSessionWorkspaceInfo).toHaveBeenCalledTimes(2);
    expect(workspaceMetadataMocks.resolveSessionWorkspaceInfo).toHaveBeenNthCalledWith(1, "sess-1");
    expect(workspaceMetadataMocks.resolveSessionWorkspaceInfo).toHaveBeenNthCalledWith(2, "sess-1");

    const prompt = String(result.systemPromptValue);
    expect(prompt).toContain("`/repo/worktrees/feat-a` (active workspace)");
    expect(prompt).toContain("Branch: feat/a");
    expect(prompt).not.toContain("stale/branch");
    expect(prompt).not.toContain("/repo/worktrees/stale");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const foldersByCharacter = new Map<string, any[]>();
  const workflowByAgentId = new Map<string, any>();
  const membersByWorkflowId = new Map<string, any[]>();
  const metadataByCharacter = new Map<string, Record<string, unknown> | null>();
  const sharedFolderRows: any[] = [];

  const reset = () => {
    foldersByCharacter.clear();
    workflowByAgentId.clear();
    membersByWorkflowId.clear();
    metadataByCharacter.clear();
    sharedFolderRows.length = 0;
  };

  const columnName = (column: any) => column?.name;

  const evaluateCondition = (condition: any, row: any): boolean => {
    if (!condition) return true;
    switch (condition.kind) {
      case "eq":
        return row[columnName(condition.column)] === condition.value;
      case "ne":
        return row[columnName(condition.column)] !== condition.value;
      case "isNull":
        return row[columnName(condition.column)] == null;
      case "inArray":
        return condition.values.includes(row[columnName(condition.column)]);
      case "and":
        return condition.conditions.every((child: any) => evaluateCondition(child, row));
      default:
        throw new Error(`Unhandled condition kind in test mock: ${condition.kind}`);
    }
  };

  return {
    foldersByCharacter,
    workflowByAgentId,
    membersByWorkflowId,
    metadataByCharacter,
    sharedFolderRows,
    evaluateCondition,
    reset,
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...conditions: any[]) => ({ kind: "and", conditions }),
  eq: (column: any, value: any) => ({ kind: "eq", column, value }),
  ne: (column: any, value: any) => ({ kind: "ne", column, value }),
  inArray: (column: any, values: any[]) => ({ kind: "inArray", column, values }),
  isNull: (column: any) => ({ kind: "isNull", column }),
}));

vi.mock("@/lib/agents/workflows", () => ({
  getWorkflowByAgentId: vi.fn(async (agentId: string) => mocks.workflowByAgentId.get(agentId) ?? null),
  getWorkflowMembers: vi.fn(async (workflowId: string) => mocks.membersByWorkflowId.get(workflowId) ?? []),
}));

vi.mock("@/lib/agents/workflow-types", () => ({
  toObject: (value: unknown) => (value && typeof value === "object" ? value : {}),
}));

vi.mock("@/lib/db/sqlite-character-schema", () => ({
  agentSyncFolders: {
    characterId: { name: "characterId" },
    inheritedFromWorkflowId: { name: "inheritedFromWorkflowId" },
    source: { name: "source" },
  },
  characters: {
    id: { name: "id" },
    metadata: { name: "metadata" },
  },
}));

vi.mock("@/lib/vectordb/path-validation", () => ({
  normalizeFolderPath: (value: string) => value.toLowerCase(),
}));

vi.mock("@/lib/vectordb/sync-folder-crud", () => ({
  getSyncFolders: vi.fn(async (characterId: string) => mocks.foldersByCharacter.get(characterId) ?? []),
}));

vi.mock("@/lib/db/sqlite-client", () => ({
  db: {
    select(selection?: any) {
      return {
        from(table: any) {
          if (selection?.metadata) {
            return {
              where(condition: any) {
                const id = condition.value;
                const metadata = mocks.metadataByCharacter.get(id) ?? null;
                return {
                  limit() {
                    return Promise.resolve(metadata == null ? [] : [{ metadata }]);
                  },
                };
              },
            };
          }

          return {
            where(condition: any) {
              return Promise.resolve(
                mocks.sharedFolderRows.filter((row) => mocks.evaluateCondition(condition, row))
              );
            },
          };
        },
      };
    },
  },
}));

import { getAccessibleSyncFolders } from "@/lib/vectordb/accessible-sync-folders";

describe("getAccessibleSyncFolders", () => {
  beforeEach(() => {
    mocks.reset();
  });

  it("returns own folders when agent is not in a workflow", async () => {
    mocks.foldersByCharacter.set("agent-a", [{ id: "own-1", folderPath: "C:/repo" }]);

    await expect(getAccessibleSyncFolders("agent-a")).resolves.toEqual([{ id: "own-1", folderPath: "C:/repo" }]);
  });

  it("includes other members' own folders when shared folders are allowed", async () => {
    mocks.foldersByCharacter.set("agent-a", [{ id: "own-1", folderPath: "C:/repo" }]);
    mocks.workflowByAgentId.set("agent-a", { workflow: { id: "wf-1" } });
    mocks.membersByWorkflowId.set("wf-1", [
      { agentId: "agent-a" },
      { agentId: "agent-b" },
      { agentId: "agent-c" },
    ]);
    mocks.metadataByCharacter.set("agent-a", {});
    mocks.sharedFolderRows.push(
      { id: "shared-1", characterId: "agent-b", folderPath: "C:/other", inheritedFromWorkflowId: null },
      { id: "shared-2", characterId: "agent-c", folderPath: "C:/repo", inheritedFromWorkflowId: null }
    );

    const result = await getAccessibleSyncFolders("agent-a");
    expect(result.map((folder) => folder.id)).toEqual(["own-1", "shared-1"]);
  });

  it("keeps a member's own workspace folder available but does not share other members' workspace folders", async () => {
    mocks.foldersByCharacter.set("agent-a", [
      { id: "own-worktree", characterId: "agent-a", folderPath: "C:/worktrees/feature-a", source: "workspace" },
    ]);
    mocks.workflowByAgentId.set("agent-a", { workflow: { id: "wf-1" } });
    mocks.membersByWorkflowId.set("wf-1", [{ agentId: "agent-a" }, { agentId: "agent-b" }]);
    mocks.metadataByCharacter.set("agent-a", {});
    mocks.sharedFolderRows.push(
      { id: "shared-worktree", characterId: "agent-b", folderPath: "C:/worktrees/feature-b", source: "workspace", inheritedFromWorkflowId: null },
      { id: "shared-user", characterId: "agent-b", folderPath: "C:/repo", source: "user", inheritedFromWorkflowId: null }
    );

    const result = await getAccessibleSyncFolders("agent-a");
    expect(result.map((folder) => folder.id)).toEqual(["own-worktree", "shared-user"]);
  });

  it("respects workflow sandbox policy disabling shared folders", async () => {
    mocks.foldersByCharacter.set("agent-a", [{ id: "own-1", folderPath: "C:/repo" }]);
    mocks.workflowByAgentId.set("agent-a", { workflow: { id: "wf-1" } });
    mocks.membersByWorkflowId.set("wf-1", [{ agentId: "agent-a" }, { agentId: "agent-b" }]);
    mocks.metadataByCharacter.set("agent-a", { workflowSandboxPolicy: { allowSharedFolders: false } });
    mocks.sharedFolderRows.push({ id: "shared-1", characterId: "agent-b", folderPath: "C:/other", inheritedFromWorkflowId: null });

    await expect(getAccessibleSyncFolders("agent-a")).resolves.toEqual([{ id: "own-1", folderPath: "C:/repo" }]);
  });
});

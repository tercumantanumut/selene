import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillRecord } from "@/lib/skills/types";
import type { InstalledPlugin } from "@/lib/plugins/types";

const mocks = vi.hoisted(() => ({
  getWorkflowByAgentId: vi.fn(),
  getWorkflowResources: vi.fn(),
  getEnabledPluginsForAgent: vi.fn(),
  getInstalledPlugins: vi.fn(),
  getLatestPluginSkillRevisionsForPlugins: vi.fn(),
  getSkillById: vi.fn(),
  listSkillsForUser: vi.fn(),
}));

vi.mock("@/lib/agents/workflows", () => ({
  getWorkflowByAgentId: mocks.getWorkflowByAgentId,
}));

vi.mock("@/lib/agents/workflow-resource-context", () => ({
  getWorkflowResources: mocks.getWorkflowResources,
}));

vi.mock("@/lib/plugins/registry", () => ({
  getEnabledPluginsForAgent: mocks.getEnabledPluginsForAgent,
  getInstalledPlugins: mocks.getInstalledPlugins,
}));

vi.mock("@/lib/plugins/skill-revision-queries", () => ({
  getLatestPluginSkillRevisionsForPlugins: mocks.getLatestPluginSkillRevisionsForPlugins,
}));

vi.mock("@/lib/skills/queries", () => ({
  getSkillById: mocks.getSkillById,
  listSkillsForUser: mocks.listSkillsForUser,
}));

function makeDbSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: "skill-1",
    userId: "user-1",
    characterId: "char-1",
    name: "Trend Digest",
    description: "Summarize trends",
    icon: null,
    promptTemplate: "Run trend digest",
    inputParameters: [],
    toolHints: [],
    triggerExamples: [],
    category: "general",
    version: 1,
    copiedFromSkillId: null,
    copiedFromCharacterId: null,
    sourceType: "manual",
    sourceSessionId: null,
    catalogId: null,
    runCount: 0,
    successCount: 0,
    lastRunAt: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makePlugin(input: {
  id: string;
  name: string;
  skillName?: string;
  namespacedName?: string;
}): InstalledPlugin {
  const skillName = input.skillName || "summarize";
  const namespacedName = input.namespacedName || `${input.name}:${skillName}`;

  return {
    id: input.id,
    name: input.name,
    description: `${input.name} plugin`,
    version: "1.0.0",
    scope: "user",
    status: "active",
    manifest: {
      name: input.name,
      description: `${input.name} plugin`,
      version: "1.0.0",
    },
    components: {
      skills: [
        {
          name: skillName,
          namespacedName,
          description: `${skillName} skill`,
          content: `# ${skillName}`,
          relativePath: `skills/${skillName}.md`,
        },
      ],
      agents: [],
      hooks: null,
      mcpServers: null,
      lspServers: null,
    },
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("resolveRuntimeSkill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkflowByAgentId.mockResolvedValue(null);
    mocks.getWorkflowResources.mockResolvedValue(null);
    mocks.getEnabledPluginsForAgent.mockResolvedValue([]);
    mocks.getInstalledPlugins.mockResolvedValue([]);
    mocks.getLatestPluginSkillRevisionsForPlugins.mockResolvedValue(new Map());
    mocks.getSkillById.mockResolvedValue(null);
    mocks.listSkillsForUser.mockResolvedValue([]);
  });

  it("resolves a name-only call when the skill name is unique", async () => {
    const { resolveRuntimeSkill } = await import("@/lib/skills/runtime-catalog");
    mocks.listSkillsForUser.mockResolvedValue([makeDbSkill()]);

    const result = await resolveRuntimeSkill({
      userId: "user-1",
      characterId: "char-1",
      skillName: " trend   digest ",
    });

    expect(result.error).toBeUndefined();
    expect(result.skill?.canonicalId).toBe("db:skill-1");
  });

  it("resolves an ID-only call", async () => {
    const { resolveRuntimeSkill } = await import("@/lib/skills/runtime-catalog");
    mocks.getSkillById.mockResolvedValue(makeDbSkill());

    const result = await resolveRuntimeSkill({
      userId: "user-1",
      characterId: "char-1",
      skillId: "db:skill-1",
    });

    expect(result.error).toBeUndefined();
    expect(result.skill?.name).toBe("Trend Digest");
  });

  it("resolves when skillId and skillName target the same skill", async () => {
    const { resolveRuntimeSkill } = await import("@/lib/skills/runtime-catalog");
    mocks.getSkillById.mockResolvedValue(makeDbSkill());

    const result = await resolveRuntimeSkill({
      userId: "user-1",
      characterId: "char-1",
      skillId: "db:skill-1",
      skillName: "Trend Digest",
    });

    expect(result.error).toBeUndefined();
    expect(result.skill?.canonicalId).toBe("db:skill-1");
  });

  it("errors when skillId and skillName target different skills", async () => {
    const { resolveRuntimeSkill } = await import("@/lib/skills/runtime-catalog");
    mocks.getSkillById.mockResolvedValue(makeDbSkill());

    const result = await resolveRuntimeSkill({
      userId: "user-1",
      characterId: "char-1",
      skillId: "db:skill-1",
      skillName: "Weekly Brief",
    });

    expect(result.skill).toBeUndefined();
    expect(result.error).toContain('skillId "db:skill-1" resolved to "Trend Digest"');
    expect(result.error).toContain('skillName "Weekly Brief" does not match');
  });

  it("errors for an unknown skillName", async () => {
    const { resolveRuntimeSkill } = await import("@/lib/skills/runtime-catalog");

    const result = await resolveRuntimeSkill({
      userId: "user-1",
      characterId: "char-1",
      skillName: "Missing Skill",
    });

    expect(result.skill).toBeUndefined();
    expect(result.error).toBe('No skill found with name "Missing Skill".');
  });

  it("errors with candidate IDs when a skillName is ambiguous", async () => {
    const { resolveRuntimeSkill } = await import("@/lib/skills/runtime-catalog");
    mocks.listSkillsForUser.mockResolvedValue([
      makeDbSkill({ id: "skill-1", name: "Digest" }),
      makeDbSkill({ id: "skill-2", name: "Digest" }),
    ]);

    const result = await resolveRuntimeSkill({
      userId: "user-1",
      characterId: "char-1",
      skillName: "Digest",
    });

    expect(result.skill).toBeUndefined();
    expect(result.error).toContain('skillName "Digest" is ambiguous');
    expect(result.error).toContain("db:skill-1, db:skill-2");
    expect(result.matches?.map((match) => match.canonicalId)).toEqual([
      "db:skill-1",
      "db:skill-2",
    ]);
  });

  it("errors with candidate IDs when a DB skill and plugin skill share the same name", async () => {
    const { resolveRuntimeSkill } = await import("@/lib/skills/runtime-catalog");
    mocks.listSkillsForUser.mockResolvedValue([
      makeDbSkill({ id: "skill-1", name: "summarize" }),
    ]);
    mocks.getEnabledPluginsForAgent.mockResolvedValue([
      makePlugin({ id: "plugin-1", name: "writer", skillName: "summarize" }),
    ]);

    const result = await resolveRuntimeSkill({
      userId: "user-1",
      characterId: "char-1",
      skillName: "summarize",
    });

    expect(result.skill).toBeUndefined();
    expect(result.error).toContain('skillName "summarize" is ambiguous');
    expect(result.error).toContain("db:skill-1");
    expect(result.error).toContain("plugin:plugin-1:writer:summarize");
    expect(result.matches?.map((match) => match.canonicalId)).toEqual([
      "db:skill-1",
      "plugin:plugin-1:writer:summarize",
    ]);
  });

  it("uses source to narrow a cross-source skillName collision", async () => {
    const { resolveRuntimeSkill } = await import("@/lib/skills/runtime-catalog");
    mocks.listSkillsForUser.mockResolvedValue([
      makeDbSkill({ id: "skill-1", name: "summarize" }),
    ]);
    mocks.getEnabledPluginsForAgent.mockResolvedValue([
      makePlugin({ id: "plugin-1", name: "writer", skillName: "summarize" }),
    ]);

    const result = await resolveRuntimeSkill({
      userId: "user-1",
      characterId: "char-1",
      skillName: "summarize",
      source: "plugin",
    });

    expect(result.error).toBeUndefined();
    expect(result.skill?.canonicalId).toBe("plugin:plugin-1:writer:summarize");
  });

  it("matches plugin displayName when skillId and skillName are both provided", async () => {
    const { resolveRuntimeSkill } = await import("@/lib/skills/runtime-catalog");
    mocks.getEnabledPluginsForAgent.mockResolvedValue([
      makePlugin({ id: "plugin-1", name: "writer", skillName: "summarize" }),
    ]);

    const result = await resolveRuntimeSkill({
      userId: "user-1",
      characterId: "char-1",
      skillId: "plugin:plugin-1:writer:summarize",
      skillName: "writer:summarize",
    });

    expect(result.error).toBeUndefined();
    expect(result.skill?.canonicalId).toBe("plugin:plugin-1:writer:summarize");
  });
});

// Source filtering and blank-name cases guard the dual-key resolver contract.
describe("resolveRuntimeSkill source and input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkflowByAgentId.mockResolvedValue(null);
    mocks.getWorkflowResources.mockResolvedValue(null);
    mocks.getEnabledPluginsForAgent.mockResolvedValue([]);
    mocks.getInstalledPlugins.mockResolvedValue([]);
    mocks.getLatestPluginSkillRevisionsForPlugins.mockResolvedValue(new Map());
    mocks.getSkillById.mockResolvedValue(null);
    mocks.listSkillsForUser.mockResolvedValue([]);
  });

  it("rejects a DB canonical skillId when plugin source is requested", async () => {
    const { resolveRuntimeSkill } = await import("@/lib/skills/runtime-catalog");

    const result = await resolveRuntimeSkill({
      userId: "user-1",
      characterId: "char-1",
      skillId: "db:skill-1",
      source: "plugin",
    });

    expect(result.skill).toBeUndefined();
    expect(result.error).toBe(
      'skillId "db:skill-1" identifies a DB skill, but source "plugin" was requested.',
    );
    expect(mocks.getSkillById).not.toHaveBeenCalled();
  });

  it("rejects a plugin canonical skillId when DB source is requested", async () => {
    const { resolveRuntimeSkill } = await import("@/lib/skills/runtime-catalog");

    const result = await resolveRuntimeSkill({
      userId: "user-1",
      characterId: "char-1",
      skillId: "plugin:plugin-1:writer:summarize",
      source: "db",
    });

    expect(result.skill).toBeUndefined();
    expect(result.error).toBe(
      'skillId "plugin:plugin-1:writer:summarize" identifies a plugin skill, but source "db" was requested.',
    );
    expect(mocks.getEnabledPluginsForAgent).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only skillName as invalid", async () => {
    const { resolveRuntimeSkill } = await import("@/lib/skills/runtime-catalog");
    mocks.listSkillsForUser.mockResolvedValue([makeDbSkill()]);

    const result = await resolveRuntimeSkill({
      userId: "user-1",
      characterId: "char-1",
      skillName: "   ",
    });

    expect(result.skill).toBeUndefined();
    expect(result.error).toBe("skillName must not be empty.");
    expect(mocks.listSkillsForUser).not.toHaveBeenCalled();
  });
});

import { getWorkflowByAgentId } from "@/lib/agents/workflows";
import { getWorkflowResources } from "@/lib/agents/workflow-resource-context";
import { getEnabledPluginsForAgent, getInstalledPlugins } from "@/lib/plugins/registry";
import { getLatestPluginSkillRevisionsForPlugins } from "@/lib/plugins/skill-revision-queries";
import type { InstalledPlugin, PluginSkillEntry } from "@/lib/plugins/types";
import {
  getSkillById,
  listSkillsForUser,
} from "@/lib/skills/queries";
import type { SkillRecord } from "@/lib/skills/types";

type RuntimeSkillSource = "db" | "plugin";

interface RuntimeSkillBase {
  canonicalId: string;
  source: RuntimeSkillSource;
  name: string;
  displayName: string;
  description: string;
  modelInvocationAllowed: boolean;
  versionRef: number;
}

interface RuntimeDbSkill extends RuntimeSkillBase {
  source: "db";
  dbSkill: SkillRecord;
}

interface RuntimePluginSkill extends RuntimeSkillBase {
  source: "plugin";
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  pluginCachePath?: string;
  namespacedName: string;
  pluginSkill: PluginSkillEntry;
  content: string;
}

export type RuntimeSkill = RuntimeDbSkill | RuntimePluginSkill;

interface ListRuntimeSkillsInput {
  userId: string;
  characterId?: string;
  source?: RuntimeSkillSource;
  query?: string;
  limit?: number;
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildDbCanonicalId(skillId: string): string {
  return `db:${skillId}`;
}

function buildPluginCanonicalId(pluginId: string, namespacedName: string): string {
  return `plugin:${pluginId}:${namespacedName}`;
}

function parseDbCanonicalId(canonicalId: string): string | null {
  if (!canonicalId.startsWith("db:")) return null;
  return canonicalId.slice(3) || null;
}

type ParsedPluginCanonicalId = {
  pluginId: string;
  namespacedName: string;
};

function parsePluginCanonicalId(canonicalId: string): ParsedPluginCanonicalId | null {
  if (!canonicalId.startsWith("plugin:")) return null;
  const remainder = canonicalId.slice("plugin:".length);
  const firstColon = remainder.indexOf(":");
  if (firstColon <= 0) return null;
  return {
    pluginId: remainder.slice(0, firstColon),
    namespacedName: remainder.slice(firstColon + 1),
  };
}

async function resolveScopedPlugins(
  userId: string,
  characterId?: string,
): Promise<InstalledPlugin[]> {
  if (!characterId) {
    return getInstalledPlugins(userId, { status: "active" });
  }

  const scoped = await getEnabledPluginsForAgent(userId, characterId, characterId);
  const scopedById = new Map(scoped.map((plugin) => [plugin.id, plugin]));

  const workflowMembership = await getWorkflowByAgentId(characterId);
  if (!workflowMembership) {
    return Array.from(scopedById.values());
  }

  const workflowResources = await getWorkflowResources(workflowMembership.workflow.id, characterId);
  if (!workflowResources) {
    return Array.from(scopedById.values());
  }

  if (workflowResources.sharedResources.pluginIds.length === 0) {
    return Array.from(scopedById.values());
  }

  const allActive = await getInstalledPlugins(userId, { status: "active" });
  for (const plugin of allActive) {
    if (
      workflowResources.sharedResources.pluginIds.includes(plugin.id) &&
      !scopedById.has(plugin.id)
    ) {
      scopedById.set(plugin.id, plugin);
    }
  }

  return Array.from(scopedById.values());
}

function mapDbSkill(skill: SkillRecord): RuntimeDbSkill {
  return {
    canonicalId: buildDbCanonicalId(skill.id),
    source: "db",
    name: skill.name,
    displayName: skill.name,
    description: skill.description || "",
    modelInvocationAllowed: true,
    versionRef: skill.version,
    dbSkill: skill,
  };
}

function mapPluginSkill(input: {
  plugin: InstalledPlugin;
  skill: PluginSkillEntry;
  contentOverride?: string;
  versionRef: number;
}): RuntimePluginSkill {
  const { plugin, skill, contentOverride, versionRef } = input;
  const content = contentOverride ?? skill.content;

  return {
    canonicalId: buildPluginCanonicalId(plugin.id, skill.namespacedName),
    source: "plugin",
    name: skill.name,
    displayName: skill.namespacedName,
    description: skill.description || "",
    modelInvocationAllowed: skill.disableModelInvocation !== true,
    versionRef,
    pluginId: plugin.id,
    pluginName: plugin.name,
    pluginVersion: plugin.version,
    pluginCachePath: plugin.cachePath,
    namespacedName: skill.namespacedName,
    pluginSkill: skill,
    content,
  };
}

export async function listRuntimeSkills(
  input: ListRuntimeSkillsInput,
): Promise<RuntimeSkill[]> {
  const { userId, characterId, source, query, limit } = input;
  const normalizedQuery = query ? normalizeLookup(query) : "";

  const rows: RuntimeSkill[] = [];

  if (!source || source === "db") {
    const dbSkills = await listSkillsForUser(userId, {
      characterId,
      status: "active",
      limit: 500,
    });
    for (const dbSkill of dbSkills) {
      rows.push(mapDbSkill(dbSkill));
    }
  }

  if (!source || source === "plugin") {
    const scopedPlugins = await resolveScopedPlugins(userId, characterId);
    const revisionMap = await getLatestPluginSkillRevisionsForPlugins(
      scopedPlugins.map((plugin) => plugin.id),
    );

    for (const plugin of scopedPlugins) {
      const pluginSkills = plugin.components.skills || [];
      for (const pluginSkill of pluginSkills) {
        const key = `${plugin.id}:${pluginSkill.namespacedName}`;
        const revision = revisionMap.get(key);
        rows.push(
          mapPluginSkill({
            plugin,
            skill: pluginSkill,
            contentOverride: revision?.content,
            versionRef: revision?.version || 1,
          }),
        );
      }
    }
  }

  const dedup = new Map<string, RuntimeSkill>();
  for (const row of rows) {
    if (!dedup.has(row.canonicalId)) {
      dedup.set(row.canonicalId, row);
    }
  }

  let values = Array.from(dedup.values());

  if (normalizedQuery) {
    values = values.filter((item) => {
      const haystack = [
        item.name,
        item.displayName,
        item.description,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }

  values.sort((a, b) => {
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.displayName.localeCompare(b.displayName);
  });

  if (limit && limit > 0) {
    return values.slice(0, limit);
  }

  return values;
}

export async function resolveRuntimeSkill(input: {
  userId: string;
  characterId?: string;
  skillId?: string;
  skillName?: string;
  source?: RuntimeSkillSource;
}): Promise<{
  skill?: RuntimeSkill;
  error?: string;
  matches?: Array<{ canonicalId: string; source: RuntimeSkillSource; name: string; displayName: string }>;
}> {
  const { userId, characterId, skillId, skillName, source } = input;
  const requestedSkillName = typeof skillName === "string" ? skillName.trim() : "";
  const normalizedRequestedSkillName = requestedSkillName ? normalizeLookup(requestedSkillName) : "";

  const matchesRequestedName = (skill: RuntimeSkill) =>
    normalizeLookup(skill.displayName) === normalizedRequestedSkillName ||
    normalizeLookup(skill.name) === normalizedRequestedSkillName;

  const buildAmbiguousNameResult = (matches: RuntimeSkill[]) => ({
    error: `skillName "${requestedSkillName}" is ambiguous. Use skillId. Candidates: ${matches.map((item) => item.canonicalId).join(", ")}`,
    matches: matches.map((item) => ({
      canonicalId: item.canonicalId,
      source: item.source,
      name: item.name,
      displayName: item.displayName,
    })),
  });

  if (skillId) {
    const dbCanonicalId = parseDbCanonicalId(skillId);
    if (dbCanonicalId) {
      if (source === "plugin") {
        return { error: `skillId "${skillId}" identifies a DB skill, but source "plugin" was requested.` };
      }
      const dbSkill = await getSkillById(dbCanonicalId, userId);
      if (!dbSkill) {
        return { error: `Skill not found: ${skillId}` };
      }
      if (characterId && dbSkill.characterId !== characterId) {
        return { error: "DB skill does not belong to the active agent." };
      }
      const resolved = mapDbSkill(dbSkill);
      if (normalizedRequestedSkillName && !matchesRequestedName(resolved)) {
        return {
          error: `skillId "${skillId}" resolved to "${resolved.displayName}", but skillName "${requestedSkillName}" does not match.`,
        };
      }
      return { skill: resolved };
    }

    const pluginCanonicalId = parsePluginCanonicalId(skillId);
    if (pluginCanonicalId) {
      if (source === "db") {
        return { error: `skillId "${skillId}" identifies a plugin skill, but source "db" was requested.` };
      }
      const allSkills = await listRuntimeSkills({
        userId,
        characterId,
        source: "plugin",
      });
      const match = allSkills.find(
        (item) =>
          item.source === "plugin" &&
          item.pluginId === pluginCanonicalId.pluginId &&
          item.namespacedName === pluginCanonicalId.namespacedName,
      );
      if (!match) {
        return { error: `Plugin skill not found: ${skillId}` };
      }
      if (normalizedRequestedSkillName && !matchesRequestedName(match)) {
        return {
          error: `skillId "${skillId}" resolved to "${match.displayName}", but skillName "${requestedSkillName}" does not match.`,
        };
      }
      return { skill: match };
    }

    const legacyDb = await getSkillById(skillId, userId);
    if (legacyDb) {
      if (characterId && legacyDb.characterId !== characterId) {
        return { error: "DB skill does not belong to the active agent." };
      }
      const resolved = mapDbSkill(legacyDb);
      if (normalizedRequestedSkillName && !matchesRequestedName(resolved)) {
        return {
          error: `skillId "${skillId}" resolved to "${resolved.displayName}", but skillName "${requestedSkillName}" does not match.`,
        };
      }
      return { skill: resolved };
    }

    const allSkills = await listRuntimeSkills({ userId, characterId, source });
    const canonicalMatch = allSkills.find((item) => item.canonicalId === skillId);
    if (canonicalMatch) {
      if (normalizedRequestedSkillName && !matchesRequestedName(canonicalMatch)) {
        return {
          error: `skillId "${skillId}" resolved to "${canonicalMatch.displayName}", but skillName "${requestedSkillName}" does not match.`,
        };
      }
      return { skill: canonicalMatch };
    }
  }

  if (!skillName) {
    return { error: "Provide skillId or skillName." };
  }
  if (!normalizedRequestedSkillName) {
    return { error: "skillName must not be empty." };
  }

  const allSkills = await listRuntimeSkills({ userId, characterId, source });

  const exactMatches = allSkills.filter(
    (item) =>
      normalizeLookup(item.displayName) === normalizedRequestedSkillName ||
      normalizeLookup(item.name) === normalizedRequestedSkillName,
  );
  if (exactMatches.length === 1) {
    return { skill: exactMatches[0] };
  }
  if (exactMatches.length > 1) {
    return buildAmbiguousNameResult(exactMatches);
  }

  const partialMatches = allSkills.filter((item) => {
    const name = normalizeLookup(item.name);
    const display = normalizeLookup(item.displayName);
    return name.includes(normalizedRequestedSkillName) || display.includes(normalizedRequestedSkillName);
  });
  if (partialMatches.length === 1) {
    return { skill: partialMatches[0] };
  }
  if (partialMatches.length > 1) {
    return buildAmbiguousNameResult(partialMatches);
  }

  return { error: `No skill found with name "${requestedSkillName}".` };
}

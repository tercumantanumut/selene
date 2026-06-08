/**
 * system-prompt-builder.ts
 *
 * Builds the system prompt for a chat request, handling:
 * - Character-specific prompts (with skill summaries)
 * - Default assistant prompts
 * - Context-window block injection
 * - Workflow context block
 * - Skills runtime hint
 * - Developer workspace hint
 */

import { getSystemPrompt } from "@/lib/ai/config";
import { buildCharacterSystemPrompt, buildCacheableCharacterPrompt, getCharacterAvatarUrl } from "@/lib/ai/character-prompt";
import { buildDefaultCacheableSystemPrompt } from "@/lib/ai/prompts/base-system-prompt";
import { getSkillsSummaryForPrompt } from "@/lib/skills/queries";
import type { CacheableSystemBlock } from "@/lib/ai/cache/types";
import { buildContextWindowPromptBlock } from "./message-splitter";
import type { ContextWindowStatus } from "@/lib/context-window/manager";
import { peekDelegationCompletions } from "@/lib/ai/tools/delegation-completion-store";

// Re-use hasStylyApiKey check
const hasStylyApiKey = () => !!process.env.STYLY_AI_API_KEY;

// ─── Helper to append to system prompt ───────────────────────────────────────

function appendBlock(
  systemPromptValue: string | CacheableSystemBlock[],
  block: string
): string | CacheableSystemBlock[] {
  if (typeof systemPromptValue === "string") {
    return systemPromptValue + block;
  }
  return [...systemPromptValue, { role: "system" as const, content: block }];
}

// ─── Public interface ─────────────────────────────────────────────────────────

interface SystemPromptBuildArgs {
  characterId: string | null;
  userId: string;
  sessionId: string;
  toolLoadingMode: "deferred" | "always";
  useCaching: boolean;
  sessionMetadata: Record<string, unknown>;
  contextWindowStatus: ContextWindowStatus;
  workflowPromptContext: string | null;
  devWorkspaceEnabled: boolean;
  /** When true, skip the channel formatting block so code blocks render freely. */
  rawMode?: boolean;
  /** LLM provider name for provider-specific prompt adjustments. */
  provider?: string;
}

interface SystemPromptBuildResult {
  systemPromptValue: string | CacheableSystemBlock[];
  characterAvatarUrl: string | null;
  characterAppearanceDescription: string | null;
  enabledTools: string[] | undefined;
  pluginContext: { agentId?: string; characterId?: string } | undefined;
}

// ─── Main builder ─────────────────────────────────────────────────────────────

export async function buildSystemPromptForRequest(
  args: SystemPromptBuildArgs
): Promise<SystemPromptBuildResult> {
  const {
    characterId,
    userId,
    sessionId,
    toolLoadingMode,
    useCaching,
    sessionMetadata,
    contextWindowStatus,
    workflowPromptContext,
    devWorkspaceEnabled,
    rawMode,
  } = args;

  let systemPromptValue: string | CacheableSystemBlock[];
  let characterAvatarUrl: string | null = null;
  let characterAppearanceDescription: string | null = null;
  let enabledTools: string[] | undefined;
  let pluginContext: { agentId?: string; characterId?: string } | undefined;

  if (characterId) {
    const { getCharacterFull } = await import("@/lib/characters/queries");
    const character = await getCharacterFull(characterId);
    if (character && character.userId === userId) {
      let hydratedSkillSummaries: Array<{ id: string; name: string; description: string }> = [];
      const metadata = character.metadata as { enabledTools?: string[]; skills?: unknown[] } | null;
      enabledTools = metadata?.enabledTools;

      try {
        const skillSummaries = await getSkillsSummaryForPrompt(character.id);
        if (skillSummaries.length > 0) {
          hydratedSkillSummaries = skillSummaries.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
          }));
        }
      } catch (skillError) {
        console.warn("[CHAT API] Failed to hydrate skill summaries for prompt:", skillError);
      }

      pluginContext = { agentId: characterId, characterId };
      // rawMode: suppress channel formatting block so code blocks render freely
      const channelType = rawMode ? null : ((sessionMetadata?.channelType as string | undefined) ?? null);
      systemPromptValue = useCaching
        ? buildCacheableCharacterPrompt(character, { toolLoadingMode, channelType, enableCaching: true, skillSummaries: hydratedSkillSummaries })
        : buildCharacterSystemPrompt(character, { toolLoadingMode, channelType, skillSummaries: hydratedSkillSummaries });

      characterAvatarUrl = getCharacterAvatarUrl(character);
      characterAppearanceDescription = character.tagline || null;
      console.log(`[CHAT API] Using character: ${character.name} (${characterId}), avatar: ${characterAvatarUrl || "none"}, enabledTools: ${enabledTools?.join(", ") || "all"}`);
    } else {
      systemPromptValue = useCaching
        ? buildDefaultCacheableSystemPrompt({ includeToolDiscovery: hasStylyApiKey(), toolLoadingMode, enableCaching: true })
        : getSystemPrompt({ stylyApiEnabled: hasStylyApiKey(), toolLoadingMode });
      console.log(`[CHAT API] Character not found or unauthorized, using default prompt`);
    }
  } else {
    systemPromptValue = useCaching
      ? buildDefaultCacheableSystemPrompt({ includeToolDiscovery: hasStylyApiKey(), toolLoadingMode, enableCaching: true })
      : getSystemPrompt({ stylyApiEnabled: hasStylyApiKey(), toolLoadingMode });
  }

  // Append synced folder paths so the agent knows its indexed directories upfront
  // When a worktree workspace is active, annotate the worktree as (active workspace)
  // and demote the base repo to avoid the AI defaulting to base paths.
  if (characterId) {
    try {
      const { getAccessibleSyncFolders } = await import("@/lib/vectordb/accessible-sync-folders");
      const { resolveSessionWorkspaceInfo } = await import("@/lib/workspace/metadata");
      const { normalize } = await import("path");
      const syncFolders = await getAccessibleSyncFolders(characterId);
      if (syncFolders.length > 0) {
        const { isWorktreePath } = await import("@/lib/ai/filesystem");
        // Use the verified resolver so prompt context doesn't trust stale raw metadata.
        const wsInfo = await resolveSessionWorkspaceInfo(sessionId);
        const activeWorktreePath = wsInfo?.worktreePath ?? null;

        // Only apply worktree scoping if the worktree is actually in the sync folders list.
        // If addSyncFolder failed during workspace creation, we shouldn't demote the primary
        // since there'd be no active alternative.
        const worktreeInFolders = activeWorktreePath
          ? syncFolders.some((f) => normalize(f.folderPath) === normalize(activeWorktreePath))
          : false;

        // Filter folders: hide worktrees that don't belong to this session.
        // - Session HAS workspace → only show active worktree + non-worktree folders
        // - Session has NO workspace → hide all worktrees (they belong to other sessions)
        const visibleFolders = syncFolders.filter((f) => {
          const fp = normalize(f.folderPath);
          if (!isWorktreePath(fp)) return true; // non-worktree folders always visible
          if (worktreeInFolders && activeWorktreePath && fp === normalize(activeWorktreePath)) return true; // own worktree
          return false; // other worktrees → hidden
        });

        const folderLines = visibleFolders.map((f) => {
          const fp = normalize(f.folderPath);
          const name = f.displayName ? ` — ${f.displayName}` : "";
          const files = f.fileCount ? `, ${f.fileCount} files indexed` : "";

          if (worktreeInFolders && activeWorktreePath && fp === normalize(activeWorktreePath)) {
            return `- \`${f.folderPath}\` (active workspace)${name}${files}`;
          }
          // Demote primary repo folder when worktree is confirmed present
          if (worktreeInFolders && f.isPrimary) {
            return `- \`${f.folderPath}\` (index only — do not use for file operations)${name}${files}`;
          }
          // Default: no active worktree, or non-worktree folders
          const primary = f.isPrimary ? " (primary)" : "";
          const status = f.status !== "synced" ? `, status: ${f.status}` : "";
          return `- \`${f.folderPath}\`${primary}${name}${files}${status}`;
        });

        // Ensure active workspace is listed first
        if (worktreeInFolders && activeWorktreePath) {
          const wtIdx = folderLines.findIndex((l) => l.includes("(active workspace)"));
          if (wtIdx > 0) {
            const [wtLine] = folderLines.splice(wtIdx, 1);
            folderLines.unshift(wtLine);
          }
        }

        systemPromptValue = appendBlock(
          systemPromptValue,
          `\n\n[Synced Folders]\n` +
            `These directories are indexed and available to you via localGrep, vectorSearch, and readFile:\n` +
            folderLines.join("\n")
        );
      }
    } catch (e) {
      console.warn("[CHAT API] Failed to fetch sync folders for prompt:", e);
    }
  }

  // Append context-window block
  systemPromptValue = appendBlock(
    systemPromptValue,
    buildContextWindowPromptBlock(contextWindowStatus)
  );

  // Append workflow context if provided
  if (workflowPromptContext) {
    systemPromptValue = appendBlock(systemPromptValue, `\n\n[Workflow Context]\n${workflowPromptContext}`);
  }

  const completedDelegations = peekDelegationCompletions(sessionId);
  if (completedDelegations.length > 0) {
    const completionLines = completedDelegations.map((completion) => {
      const ageSeconds = Math.max(0, Math.floor((Date.now() - completion.completedAt) / 1000));
      const suffix = completion.error ? ` with error: ${completion.error}` : "";
      return `- ${completion.delegationId}: "${completion.delegateName}" completed ${ageSeconds}s ago${suffix}. Results will be delivered automatically as inline messages.`;
    });

    systemPromptValue = appendBlock(
      systemPromptValue,
      `\n\n[Delegation Completions]\n${completionLines.join("\n")}`
    );
  }

  // Append runtime skills hint
  systemPromptValue = appendBlock(
    systemPromptValue,
    "\n\n[Skills Runtime]\n" +
      "Use skill for action=list|inspect|run (DB + plugin skills).\n" +
      "If the user asks for a workflow, campaign, template, playbook, or other reusable task, check for related skills first.\n" +
      "Use skill for action=create|patch|replace|metadata|copy|archive.\n" +
      "Prefer tool-first skill discovery instead of relying on static prompt catalogs."
  );

  // Append workspace context when Developer Workspace is enabled
  if (devWorkspaceEnabled) {
    const { resolveSessionWorkspaceInfo } = await import("@/lib/workspace/metadata");
    const wsInfo = await resolveSessionWorkspaceInfo(sessionId);
    // Sanitize a workspace field to prevent prompt injection via branch names / paths
    const sanitizeWsField = (v: unknown): string =>
      String(v || "").replace(/[\r\n]/g, " ").replace(/^[#\[]/g, "");
    let workspaceBlock: string;
    if (wsInfo?.status) {
      const workspaceType = sanitizeWsField(wsInfo.type) || "worktree";
      const workspaceLabel = workspaceType === "local" ? "local git repository workspace" : "git worktree workspace";
      const pathLabel = workspaceType === "local" ? "Repository Path" : "Path";
      const cleanupGuidance = workspaceType === "local"
        ? `When done, disable Git Mode by clearing workspace metadata instead of removing the repository.`
        : `When done, use workspace({ action: "delete" }) to clean up.`;

      workspaceBlock =
        `\n\n## Active Workspace\n` +
        `You are working in a ${workspaceLabel}:\n` +
        `- Type: ${workspaceType}\n` +
        `- Branch: ${sanitizeWsField(wsInfo.branch) || "unknown"}\n` +
        `- Base: ${sanitizeWsField(wsInfo.baseBranch) || "unknown"}\n` +
        `- ${pathLabel}: ${sanitizeWsField(wsInfo.worktreePath) || "unknown"}\n` +
        `- Status: ${sanitizeWsField(wsInfo.status)}\n` +
        (wsInfo.prUrl ? `- PR: ${sanitizeWsField(wsInfo.prUrl)}\n` : "") +
        `\nFile tools (readFile, editFile, writeFile, localGrep) work in the workspace path. ` +
        `Use executeCommand for git operations (commit, push, gh pr create) and builds. ` +
        `When changes are ready, ask the user if they want to keep local, push, or create a PR. ` +
        `NEVER fabricate PR URLs — only use real URLs from gh CLI output. ` +
        cleanupGuidance;
    } else {
      workspaceBlock =
        `\n\n[Developer Workspace]\n` +
        `You have the "workspace" tool available. When the user asks you to execute a task on a standalone workspace, worktree, or isolated branch, ` +
        `create an isolated workspace (git worktree) so their main branch stays clean.\n` +
        `Do NOT use executeCommand/bash to create branches (git checkout -b, git switch -c, git worktree add) — ` +
        `use the workspace tool instead, as raw git commands bypass the workspace UI and frontend integration.\n` +
        `File tools will automatically work in the worktree once created.\n` +
        `Use: workspace({ action: "create", branch: "feature/...", repoPath: "/path/to/repo" })`;
    }
    systemPromptValue = appendBlock(systemPromptValue, workspaceBlock);
  }

  // Provider-specific tool disambiguation for models that confuse Skill with searchTools
  if (args.provider === "kimi") {
    systemPromptValue = appendBlock(
      systemPromptValue,
      `\n\n## CRITICAL: Tool Disambiguation\n` +
        `The "skill" tool is ONLY for platform skills and workflows (e.g., simplify, update-config, claude-api). It is NOT for file operations.\n\n` +
        `When you need to edit, read, or write files:\n` +
        `1. Use "searchTools" with query "select:editFile" (or readFile, writeFile, etc.) to load the tool schema\n` +
        `2. Then call the loaded tool directly\n\n` +
        `NEVER use the "skill" tool for: editing files, reading files, writing files, running grep, or any file system operation.\n` +
        `ALWAYS use "searchTools" first to discover and load file operation tools.`,
    );
  }

  return {
    systemPromptValue,
    characterAvatarUrl,
    characterAppearanceDescription,
    enabledTools,
    pluginContext,
  };
}

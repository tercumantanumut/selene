/**
 * tools-builder.ts
 *
 * Builds the complete set of tools for a chat request, including:
 * - Registry-based tools (non-deferred and all-tools map)
 * - MCP tools for the character
 * - Plugin MCP servers
 * - Custom ComfyUI tools
 * - Plugin hook wrapping (PreToolUse / PostToolUse / PostToolUseFailure)
 * - Streaming result guardrails
 *
 * NOTE: Plugin loading (getInstalledPlugins / getEnabledPluginsForAgent / workflow
 * resources) and hook registration happen in the caller (route.ts) because the
 * workflow resources also modify the system prompt. The caller passes in the
 * resolved `scopedPlugins` and `pluginRoots`.
 */

import { type Tool } from "ai";
import type { ExecuteCommandProgressUpdate } from "@/lib/command-execution/types";
import {
  createRetrieveFullContentTool,
} from "@/lib/ai/tools";
import { createWebSearchTool } from "@/lib/ai/web-search";
import { createVectorSearchToolV2 } from "@/lib/ai/vector-search";
import { createReadFileTool } from "@/lib/ai/tools/read-file-tool";
import { createLocalGrepTool } from "@/lib/ai/ripgrep";
import { createExecuteCommandTool } from "@/lib/ai/tools/execute-command-tool";
import { createBashTool } from "@/lib/ai/tools/bash-tool";
import { createEditFileTool } from "@/lib/ai/tools/edit-file-tool";
import { createWriteFileTool } from "@/lib/ai/tools/write-file-tool";
import { createPatchFileTool } from "@/lib/ai/tools/patch-file-tool";
import { createUpdatePlanTool } from "@/lib/ai/tools/update-plan-tool";
import { createSendMessageToChannelTool } from "@/lib/ai/tools/channel-tools";
import { createSkillTool } from "@/lib/ai/tools/skill-tool";
import { createCompactSessionTool } from "@/lib/ai/tools/compact-session-tool";
import { createWorkspaceTool } from "@/lib/ai/tools/workspace-tool";
import { createDesignWorkspaceTool } from "@/lib/ai/tools/design-workspace-tool";
import {
  ToolRegistry,
  createToolSearchTool,
} from "@/lib/ai/tool-registry";
import { getCharacterFull } from "@/lib/characters/queries";
import { getRegisteredHooks } from "@/lib/plugins/hooks-engine";
import {
  runPreToolUseHooks,
  runPostToolUseHooks,
  runPostToolUseFailureHooks,
} from "@/lib/plugins/hook-integration";
import { guardToolResultForStreaming } from "@/lib/ai/tool-result-stream-guard";
import {
  normalizeWebSearchQuery,
  getWebSearchSourceCount,
  buildWebSearchLoopGuardResult,
  normalizeReadFileInputArgs,
  WEB_SEARCH_NO_RESULT_GUARD,
} from "./content-sanitizer";
// ─── Public interfaces ────────────────────────────────────────────────────────

interface ToolsBuildContext {
  sessionId: string;
  userId: string;
  characterId: string | null;
  characterAvatarUrl: string | null;
  characterAppearanceDescription: string | null;
  sessionMetadata: Record<string, unknown>;
  enabledTools: string[] | undefined;
  previouslyDiscoveredTools: Set<string>;
  toolLoadingMode: "deferred" | "always";
  devWorkspaceEnabled: boolean;
  streamToolResultBudgetTokens: number;
  onExecuteCommandProgress?: (update: ExecuteCommandProgressUpdate) => void;
  /** Pre-resolved plugin roots for ${CLAUDE_PLUGIN_ROOT} substitution */
  pluginRoots: Map<string, string>;
  /** Pre-resolved scoped plugin names for hook filtering */
  allowedPluginNames: Set<string>;
  /** Workflow context input for subagent discovery in searchTools */
  workflowPromptContextInput: import("@/lib/agents/workflows").WorkflowPromptContextInput | null;
  /** LLM provider name — used to register SDK agent passthrough tools for claudecode */
  provider?: string;
  /**
   * Client-forwarded active design workspace preview theme (from the Zustand
   * `useDesignWorkspaceStore`). Forwarded to `createDesignWorkspaceTool`
   * as the `defaultPreviewTheme` option so mutating tool calls capture
   * screenshots that match the theme the user currently sees — closes the
   * Sprint 1 Rev-A2 Gap 1 reviewer blocker. Undefined when the request
   * did not include the header (legacy clients / non-design sessions).
   */
  designPreviewTheme?: import("@/lib/design/workspace/types").DesignPreviewTheme;
}

interface ToolsBuildResult {
  allToolsWithMCP: Record<string, Tool>;
  initialActiveToolNames: string[];
  hasStopHooks: boolean;
  hasPreHooks: boolean;
  hasPostHooks: boolean;
  hasFailureHooks: boolean;
  discoveredTools: Set<string>;
  initialActiveTools: Set<string>;
  /** MCP server names enabled for the current agent (forwarded to SeleneMcpContext) */
  enabledMcpServers?: string[];
  /** Specific MCP tool IDs enabled for the current agent (forwarded to SeleneMcpContext) */
  enabledMcpTools?: string[];
  /** MCP tool IDs that are alwaysLoad (forwarded to SeleneMcpContext for deferred gating) */
  alwaysLoadMcpToolIds: string[];
}

// ─── Main builder ────────────────────────────────────────────────────────────

export async function buildToolsForRequest(
  ctx: ToolsBuildContext
): Promise<ToolsBuildResult> {
  const {
    sessionId,
    userId,
    characterId,
    characterAvatarUrl,
    characterAppearanceDescription,
    sessionMetadata,
    enabledTools,
    previouslyDiscoveredTools,
    toolLoadingMode,
    devWorkspaceEnabled,
    streamToolResultBudgetTokens,
    onExecuteCommandProgress,
    pluginRoots,
    allowedPluginNames,
    workflowPromptContextInput,
    designPreviewTheme,
  } = ctx;

  const useDeferredLoading = toolLoadingMode !== "always";

  // Create tools via the centralized Tool Registry.
  // CRITICAL: Create agentEnabledTools Set for strict filtering.
  // Migration aliases: remap old tool names to their merged successors so
  // agents created before the merge still resolve correctly.
  const TOOL_ALIASES: Record<string, string> = {
    runSkill: "skill",
    updateSkill: "skill",
  };
  const agentEnabledTools = enabledTools
    ? new Set(
        Array.from(new Set(enabledTools)).map((t) => TOOL_ALIASES[t] ?? t),
      )
    : undefined;

  const registry = ToolRegistry.getInstance();

  // First, get non-deferred tools to build the initial active set.
  // When devWorkspace is enabled, force-include workspace in the initial active set
  // so the model sees it without needing searchTools discovery.
  const eagerIncludeTools = devWorkspaceEnabled ? ["workspace"] : undefined;

  const nonDeferredTools = registry.getTools({
    sessionId,
    userId,
    characterId: characterId || undefined,
    characterAvatarUrl: characterAvatarUrl || undefined,
    characterAppearanceDescription: characterAppearanceDescription || undefined,
    includeDeferredTools: false,
    includeTools: eagerIncludeTools,
    agentEnabledTools,
    provider: ctx.provider,
  });
  const initialActiveTools = new Set(Object.keys(nonDeferredTools));

  // Load ALL authorized tools for the implementation map.
  const allTools = registry.getTools({
    sessionId,
    userId,
    characterId: characterId || undefined,
    characterAvatarUrl: characterAvatarUrl || undefined,
    characterAppearanceDescription: characterAppearanceDescription || undefined,
    agentEnabledTools,
    includeDeferredTools: true,
    provider: ctx.provider,
  });

  // Companion-tool enforcement: bash and executeCommand are coupled by the
  // stub-retrieval protocol.  bash produces logId-bearing stubs that need
  // executeCommand's readLog sub-command to retrieve; pre-loading one without
  // the other is a protocol violation that causes model looping.
  if (
    initialActiveTools.has("bash") &&
    !initialActiveTools.has("executeCommand") &&
    allTools.executeCommand
  ) {
    initialActiveTools.add("executeCommand");
    console.log(
      "[CHAT API] Companion-tool enforcement: promoted executeCommand to always-loaded because bash is loaded"
    );
  }

  // Mutable set to track tools discovered via searchTools during this request.
  const discoveredTools = new Set<string>(previouslyDiscoveredTools);

  if (previouslyDiscoveredTools.size > 0) {
    console.log(
      `[CHAT API] Restored ${previouslyDiscoveredTools.size} previously discovered tools: ${[...previouslyDiscoveredTools].join(", ")}`
    );
  }

  // Context for search/list tools.
  const toolSearchContext = {
    initialActiveTools,
    discoveredTools,
    enabledTools: enabledTools ? new Set(enabledTools) : undefined,
    subagentDirectory: workflowPromptContextInput?.subagentDirectory,
    enableAnthropicToolReferences:
      useDeferredLoading && ctx.provider === "anthropic",
  };

  // Build tools object with context-aware overrides.
  const tools: Record<string, Tool> = {
    ...allTools,
    ...(allTools.sendMessageToChannel && {
      sendMessageToChannel: createSendMessageToChannelTool({
        sessionId,
        userId,
        sessionMetadata,
      }),
    }),
    // searchTools ALWAYS overrides (alwaysLoad: true)
    searchTools: createToolSearchTool(toolSearchContext),
    // retrieveFullContent ALWAYS overrides (alwaysLoad: true)
    retrieveFullContent: createRetrieveFullContentTool({ sessionId }),
    ...(allTools.vectorSearch && {
      vectorSearch: createVectorSearchToolV2({
        sessionId,
        userId,
        characterId: characterId || null,
        sessionMetadata,
      }),
    }),
    ...(allTools.readFile && {
      readFile: createReadFileTool({
        sessionId,
        userId,
        characterId: characterId || null,
      }),
    }),
    ...(allTools.localGrep && {
      localGrep: createLocalGrepTool({
        sessionId,
        characterId: characterId || null,
      }),
    }),
    ...(allTools.webSearch && {
      webSearch: createWebSearchTool({
        sessionId,
        userId,
        characterId: characterId || null,
      }),
    }),
    ...(allTools.executeCommand && {
      executeCommand: createExecuteCommandTool({
        sessionId,
        userId,
        characterId: characterId || null,
        onProgress: onExecuteCommandProgress,
      }),
    }),
    ...(allTools.bash && {
      bash: createBashTool({
        sessionId,
        userId,
        characterId: characterId || null,
        onProgress: onExecuteCommandProgress,
      }),
    }),
    ...(allTools.editFile && {
      editFile: createEditFileTool({
        sessionId,
        characterId: characterId || null,
      }),
    }),
    ...(allTools.writeFile && {
      writeFile: createWriteFileTool({
        sessionId,
        characterId: characterId || null,
      }),
    }),
    ...(allTools.patchFile && {
      patchFile: createPatchFileTool({
        sessionId,
        characterId: characterId || null,
      }),
    }),
    ...(allTools.updatePlan && {
      updatePlan: createUpdatePlanTool({ sessionId }),
    }),
    ...(allTools.skill && {
      skill: createSkillTool({
        sessionId,
        userId,
        characterId: characterId || "",
      }),
    }),
    ...(allTools.compactSession && {
      compactSession: createCompactSessionTool({ sessionId }),
    }),
    ...(allTools.workspace &&
      devWorkspaceEnabled && {
        workspace: createWorkspaceTool({
          sessionId,
          characterId: characterId || "",
          userId,
        }),
      }),
    // Override the registry-produced designWorkspace factory with one that
    // carries the request-scoped `defaultPreviewTheme` forwarded from the
    // client. The registry factory defaults to dark (compiler default) when
    // the LLM omits `input.previewTheme`; this override closes the Sprint 1
    // Rev-A2 Gap 1 blocker so light/system previews capture matching
    // screenshots even when the model does not populate the schema field.
    ...(allTools.designWorkspace && {
      designWorkspace: createDesignWorkspaceTool({
        sessionId: sessionId || "UNSCOPED",
        userId: userId || "UNSCOPED",
        characterId: characterId || undefined,
        defaultPreviewTheme: designPreviewTheme,
      }),
    }),
  };

  // Load MCP tools for this character (if configured).
  let mcpToolResult: {
    allTools: Record<string, Tool>;
    alwaysLoadToolIds: string[];
    deferredToolIds: string[];
    enabledMcpServers?: string[];
    enabledMcpTools?: string[];
  } = { allTools: {}, alwaysLoadToolIds: [], deferredToolIds: [] };

  try {
    const { loadMCPToolsForCharacter } = await import(
      "@/lib/mcp/chat-integration"
    );
    const character = characterId
      ? await getCharacterFull(characterId)
      : undefined;
    mcpToolResult = await loadMCPToolsForCharacter(character || undefined);

    if (Object.keys(mcpToolResult.allTools).length > 0) {
      console.log(
        `[CHAT API] Loaded ${Object.keys(mcpToolResult.allTools).length} MCP tools: ${Object.keys(mcpToolResult.allTools).join(", ")}`
      );
      console.log(
        `[CHAT API] MCP always-load: ${mcpToolResult.alwaysLoadToolIds.join(", ") || "none"}`
      );
      console.log(
        `[CHAT API] MCP deferred: ${mcpToolResult.deferredToolIds.join(", ") || "none"}`
      );

      if (toolSearchContext.enabledTools) {
        Object.keys(mcpToolResult.allTools).forEach((name) =>
          toolSearchContext.enabledTools!.add(name)
        );
        console.log(
          `[CHAT API] Added ${Object.keys(mcpToolResult.allTools).length} MCP tools to enabledTools set for discovery`
        );
      }
    }
  } catch (error) {
    console.error("[CHAT API] Failed to load MCP tools:", error);
  }

  // Load MCP servers from scoped plugins (namespaced as plugin:name:server).
  // Uses DB (plugin_mcp_servers) as source of truth so user-provided config overrides are respected.
  try {
    const { connectPluginMCPServers } = await import(
      "@/lib/plugins/mcp-integration"
    );
    const { getActivePluginMCPServers } = await import("@/lib/plugins/registry");
    const pluginMcpRows = await getActivePluginMCPServers();
    // Filter to only plugins in scope
    const scopedRows = pluginMcpRows.filter((r) => allowedPluginNames.has(r.pluginName));

    // Group by plugin name
    const byPlugin = new Map<string, { config: Record<string, unknown>; cachePath?: string }>();
    for (const row of scopedRows) {
      if (!byPlugin.has(row.pluginName)) {
        byPlugin.set(row.pluginName, { config: {}, cachePath: row.cachePath || undefined });
      }
      byPlugin.get(row.pluginName)!.config[row.serverName] = row.config;
    }

    let totalConnected = 0;
    let totalFailed = 0;

    for (const [pluginName, { config, cachePath }] of byPlugin) {
      const result = await connectPluginMCPServers(
        pluginName,
        config as Record<string, import("@/lib/plugins/types").PluginMCPServerEntry>,
        characterId || undefined,
        cachePath
      );
      totalConnected += result.connected.length;
      totalFailed += result.failed.length;
    }

    if (totalConnected > 0) {
      console.log(
        `[CHAT API] Connected ${totalConnected} plugin MCP server(s)`
      );
    }
    if (totalFailed > 0) {
      console.warn(
        `[CHAT API] Failed to connect ${totalFailed} plugin MCP server(s)`
      );
    }
  } catch (pluginMcpError) {
    console.warn(
      "[CHAT API] Failed to load plugin MCP servers (non-fatal):",
      pluginMcpError
    );
  }

  let customComfyUIToolResult: {
    allTools: Record<string, Tool>;
    alwaysLoadToolIds: string[];
    deferredToolIds: string[];
  } = { allTools: {}, alwaysLoadToolIds: [], deferredToolIds: [] };

  try {
    const { loadCustomComfyUITools } = await import(
      "@/lib/comfyui/custom/chat-integration"
    );
    customComfyUIToolResult = await loadCustomComfyUITools(sessionId);

    if (Object.keys(customComfyUIToolResult.allTools).length > 0) {
      console.log(
        `[CHAT API] Loaded ${Object.keys(customComfyUIToolResult.allTools).length} Custom ComfyUI tools.`
      );

      if (toolSearchContext.enabledTools) {
        Object.keys(customComfyUIToolResult.allTools).forEach((name) =>
          toolSearchContext.enabledTools!.add(name)
        );
        console.log(
          `[CHAT API] Added ${Object.keys(customComfyUIToolResult.allTools).length} Custom ComfyUI tools to enabledTools set for discovery`
        );
      }
    }
  } catch (error) {
    console.error("[CHAT API] Failed to load Custom ComfyUI tools:", error);
  }

  // Merge MCP + Custom ComfyUI tools with regular tools.
  let allToolsWithMCP: Record<string, Tool> = {
    ...tools,
    ...mcpToolResult.allTools,
    ...customComfyUIToolResult.allTools,
  };

  // Claude Code no longer goes through the Agent SDK — with the CLIProxyAPI
  // bridge it consumes the same `tools` map as every other provider, with
  // real descriptions and real executors. The previous SDK-passthrough block
  // (which stamped every tool with "passthrough tool" and routed execution
  // through an in-process tool-result bridge) was Agent-SDK-era glue and has
  // been removed.

  // Wrap tools with plugin hooks and streaming guardrails.
  const hasPreHooks = getRegisteredHooks("PreToolUse").length > 0;
  const hasPostHooks = getRegisteredHooks("PostToolUse").length > 0;
  const hasFailureHooks = getRegisteredHooks("PostToolUseFailure").length > 0;
  const hasStopHooks = getRegisteredHooks("Stop").length > 0;

  const wrappedTools: Record<string, Tool> = {};
  let consecutiveZeroResultWebSearches = 0;
  const zeroResultWebSearchCountsByQuery = new Map<string, number>();
  let webSearchDisabledByLoopGuard = false;
  let webSearchDisableReason: string | null = null;
  let webSearchDisableLogged = false;


  for (const [toolId, originalTool] of Object.entries(allToolsWithMCP)) {
    if (!originalTool.execute) {
      wrappedTools[toolId] = originalTool;
      continue;
    }
    const origExecute = originalTool.execute;
    wrappedTools[toolId] = {
      ...originalTool,
      execute: async (args: unknown, options: unknown) => {
        const baseNormalizedArgs = (
          args && typeof args === "object" ? args : {}
        ) as Record<string, unknown>;
        const {
          normalizedArgs,
          droppedSelectors: droppedReadFileSelectors,
        } = toolId === "readFile"
          ? normalizeReadFileInputArgs(baseNormalizedArgs)
          : { normalizedArgs: baseNormalizedArgs, droppedSelectors: [] as string[] };

        if (toolId === "readFile" && droppedReadFileSelectors.length > 0) {
          console.warn(
            `[CHAT API] readFile args normalized: dropped selectors (${droppedReadFileSelectors.join(", ")}) to enforce a single selection mode`
          );
        }


        if (toolId === "webSearch") {
          const normalizedQuery = normalizeWebSearchQuery(normalizedArgs.query);

          if (webSearchDisabledByLoopGuard) {
            if (!webSearchDisableLogged) {
              console.warn(
                `[CHAT API] webSearch disabled for remaining response after loop guard trigger (${webSearchDisableReason ?? "unknown reason"})`
              );
              webSearchDisableLogged = true;
            }
            return buildWebSearchLoopGuardResult(
              normalizedQuery,
              webSearchDisableReason ?? "loop guard active"
            );
          }

          if (normalizedQuery) {
            const queryZeroResultCount =
              zeroResultWebSearchCountsByQuery.get(normalizedQuery) ?? 0;
            if (
              queryZeroResultCount >=
              WEB_SEARCH_NO_RESULT_GUARD.maxZeroResultRepeatsPerQuery
            ) {
              const reason = `same query repeated ${queryZeroResultCount} times`;
              webSearchDisabledByLoopGuard = true;
              webSearchDisableReason = reason;
              console.warn(
                `[CHAT API] webSearch loop guard triggered (${reason}) for query: ${normalizedQuery}`
              );
              return buildWebSearchLoopGuardResult(normalizedQuery, reason);
            }
          }

          if (
            consecutiveZeroResultWebSearches >=
            WEB_SEARCH_NO_RESULT_GUARD.maxConsecutiveZeroResultCalls
          ) {
            const reason = `consecutive zero-result calls: ${consecutiveZeroResultWebSearches}`;
            webSearchDisabledByLoopGuard = true;
            webSearchDisableReason = reason;
            console.warn(
              `[CHAT API] webSearch loop guard triggered (${reason})`
            );
            return buildWebSearchLoopGuardResult(normalizedQuery, reason);
          }
        }

        // PreToolUse: can block tool execution
        if (hasPreHooks) {
          const hookResult = await runPreToolUseHooks(
            toolId,
            normalizedArgs,
            sessionId,
            allowedPluginNames,
            pluginRoots
          );
          if (hookResult.blocked) {
            console.log(
              `[Hooks] Tool "${toolId}" blocked by plugin hook: ${hookResult.blockReason}`
            );
            return `Tool blocked by plugin hook: ${hookResult.blockReason}`;
          }
        }

        try {
          const rawResult = await origExecute(normalizedArgs, options as any);
          const toolCallId =
            options && typeof options === "object" && "toolCallId" in options &&
            typeof (options as { toolCallId?: unknown }).toolCallId === "string"
              ? (options as { toolCallId: string }).toolCallId
              : undefined;
          const guardedResult = guardToolResultForStreaming(toolId, rawResult, {
            maxTokens: streamToolResultBudgetTokens,
            sessionId,
            toolCallId,
            metadata: {
              sourceFileName: "app/api/chat/tools-builder.ts",
            },
            // Pass the live tool sets so the guard can determine whether the
            // retrieval tool referenced in a stub is currently loaded.
            initialActiveTools,
            discoveredTools,
          });
          if (guardedResult.blocked) {
            console.warn(
              `[CHAT API] Tool result validated as oversized: ${toolId} ` +
                `(~${guardedResult.estimatedTokens.toLocaleString()} tokens, ` +
                `budget=${streamToolResultBudgetTokens.toLocaleString()})`
            );
          }

          if (toolId === "webSearch") {
            const normalizedQuery = normalizeWebSearchQuery(
              normalizedArgs.query
            );
            const sourceCount = getWebSearchSourceCount(guardedResult.result);

            if (sourceCount === 0) {
              consecutiveZeroResultWebSearches += 1;
              if (normalizedQuery) {
                const previousCount =
                  zeroResultWebSearchCountsByQuery.get(normalizedQuery) ?? 0;
                zeroResultWebSearchCountsByQuery.set(
                  normalizedQuery,
                  previousCount + 1
                );
              }
            } else if (sourceCount !== null) {
              consecutiveZeroResultWebSearches = 0;
              if (normalizedQuery) {
                zeroResultWebSearchCountsByQuery.delete(normalizedQuery);
              }
            }
          } else {
            consecutiveZeroResultWebSearches = 0;
          }


          // PostToolUse: fire-and-forget
          if (hasPostHooks) {
            try {
              runPostToolUseHooks(
                toolId,
                normalizedArgs,
                guardedResult.result,
                sessionId,
                allowedPluginNames,
                pluginRoots
              );
            } catch (hookError) {
              console.error(
                "[Hooks] PostToolUse hook dispatch failed:",
                hookError
              );
            }
          }

          return guardedResult.result;
        } catch (error) {
          // PostToolUseFailure: fire-and-forget
          if (hasFailureHooks) {
            try {
              runPostToolUseFailureHooks(
                toolId,
                normalizedArgs,
                error instanceof Error ? error.message : String(error),
                sessionId,
                allowedPluginNames,
                pluginRoots
              );
            } catch (hookError) {
              console.error(
                "[Hooks] PostToolUseFailure hook dispatch failed:",
                hookError
              );
            }
          }
          throw error;
        }
      },
    };
  }

  allToolsWithMCP = wrappedTools;
  console.log(
    `[CHAT API] Wrapped ${Object.keys(wrappedTools).length} tools with stream guard ` +
      `(budget=${streamToolResultBudgetTokens.toLocaleString()} tokens, ` +
      `pre:${hasPreHooks}, post:${hasPostHooks}, failure:${hasFailureHooks})`
  );

  const initialActiveToolNames = useDeferredLoading
    ? [
        ...new Set([
          ...initialActiveTools,
          ...previouslyDiscoveredTools,
          ...mcpToolResult.alwaysLoadToolIds,
          ...customComfyUIToolResult.alwaysLoadToolIds,
        ]),
      ]
    : Object.keys(allToolsWithMCP);

  console.log(
    `[CHAT API] Loaded ${Object.keys(allToolsWithMCP).length} tools (including ${Object.keys(mcpToolResult.allTools).length} MCP tools and ${Object.keys(customComfyUIToolResult.allTools).length} Custom ComfyUI tools)`
  );
  console.log(
    `[CHAT API] Tool loading mode: ${useDeferredLoading ? "deferred" : "always-include"}, initial active tools: ${initialActiveToolNames.length}`
  );
  if (useDeferredLoading) {
    console.log(
      `[CHAT API] Previously discovered (restored): ${previouslyDiscoveredTools.size > 0 ? [...previouslyDiscoveredTools].join(", ") : "none"}`
    );
  }

  return {
    allToolsWithMCP,
    initialActiveToolNames,
    hasStopHooks,
    hasPreHooks,
    hasPostHooks,
    hasFailureHooks,
    discoveredTools,
    initialActiveTools,
    enabledMcpServers: mcpToolResult.enabledMcpServers,
    enabledMcpTools: mcpToolResult.enabledMcpTools,
    alwaysLoadMcpToolIds: mcpToolResult.alwaysLoadToolIds,
  };
}

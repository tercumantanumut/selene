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

import { tool, jsonSchema, type Tool } from "ai";
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
  buildMissingSdkPassthroughOutput,
  normalizeSdkPassthroughOutput,
} from "./sdk-passthrough-normalizer";
import { sanitizeToolResultForBase64, attachMediaRefs } from "@/lib/media/base64-extract";
import {
  normalizeWebSearchQuery,
  getWebSearchSourceCount,
  buildWebSearchLoopGuardResult,
  normalizeReadFileInputArgs,
  WEB_SEARCH_NO_RESULT_GUARD,
} from "./content-sanitizer";
import { mcpContextStore } from "@/lib/ai/providers/mcp-context-store";

const SDK_PASSTHROUGH_LARGE_INPUT_BYTES = (() => {
  const parsed = Number(process.env.SDK_PASSTHROUGH_LARGE_INPUT_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 262_144;
})();

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
        characterId: characterId || null,
        onProgress: onExecuteCommandProgress,
      }),
    }),
    ...(allTools.bash && {
      bash: createBashTool({
        sessionId,
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

  // ── Claude Agent SDK passthrough tools ─────────────────────────────────────
  // When using the claudecode provider, the SDK agent streams back tool_use
  // blocks for its built-in tools (Bash, Read, Write, etc.) and Selene MCP
  // tools (prefixed as mcp__selene-platform__<name>). The Vercel AI SDK
  // validates tool names against the tools map and rejects unknown ones.
  // These passthrough tools have an immediate no-op execute so the tool
  // lifecycle completes (UI shows "completed"). Loop prevention is handled
  // in route.ts via stopWhen(1) for claudecode provider.
  const sdkPassthroughNames = new Set<string>();
  const mcpPassthroughNames = new Set<string>();

  if (ctx.provider === "claudecode") {
    const createSdkPassthroughTool = (registeredToolName: string): Tool =>
      tool({
        description: "Claude Agent SDK passthrough tool (executed internally by the SDK agent)",
        inputSchema: jsonSchema<Record<string, unknown>>({
          type: "object",
          additionalProperties: true,
        }),
        // Resolve the real SDK tool output from the per-request bridge.
        // Fallback to passthrough marker only if no bridged output arrives in time.
        execute: async (args, options) => {
          const serializedArgs = (() => {
            try {
              return JSON.stringify(args ?? {});
            } catch {
              return "";
            }
          })();
          const largeInputMetadata =
            serializedArgs.length > SDK_PASSTHROUGH_LARGE_INPUT_BYTES
              ? {
                  _sdkLargeInput: true,
                  _sdkLargeInputBytes: serializedArgs.length,
                  _sdkLargeInputPreview: serializedArgs.slice(0, 2_000),
                }
              : null;

          const toolCallId =
            options && typeof options === "object" && "toolCallId" in options &&
            typeof (options as { toolCallId?: unknown }).toolCallId === "string"
              ? (options as { toolCallId: string }).toolCallId
              : "";

          const abortSignal =
            options && typeof options === "object" && "abortSignal" in options &&
            (options as { abortSignal?: unknown }).abortSignal instanceof AbortSignal
              ? (options as { abortSignal: AbortSignal }).abortSignal
              : undefined;

          const bridge = mcpContextStore.getStore()?.sdkToolResultBridge;
          if (bridge && toolCallId) {
            // MCP tools (delegateToSubagent, etc.) are executed by the MCP
            // server and can run arbitrarily long — never time them out.
            // SDK agent tools (Task, Agent, etc.) also run long.
            const isLongRunningTool =
              mcpPassthroughNames.has(registeredToolName) ||
              registeredToolName === "Task" ||
              registeredToolName === "Agent" ||
              registeredToolName === "TaskCreate" ||
              registeredToolName === "TaskGet" ||
              registeredToolName === "TaskUpdate" ||
              registeredToolName === "TaskList";

            try {
              const resolved = await bridge.waitFor(toolCallId, {
                // Long-running tools (SDK agents, MCP tools) can run well beyond
                // the default 5-minute passthrough timeout; keep waiting unless aborted.
                timeoutMs: isLongRunningTool ? null : 300_000,
                abortSignal,
              });
              if (resolved) {
                // Strip any base64 image/document envelopes (Anthropic shape)
                // emitted by SDK-native built-ins like Read before the payload
                // reaches the AI SDK executor. This protects the current turn's
                // model-facing context, not just persisted history.
                const { sanitized, mediaRefs } = await sanitizeToolResultForBase64(
                  resolved.output,
                  { sessionId, role: "generated" }
                );
                const normalized = normalizeSdkPassthroughOutput(
                  resolved.toolName || registeredToolName,
                  sanitized,
                  args
                );
                const withMediaRefs = attachMediaRefs(normalized, mediaRefs);
                if (largeInputMetadata) {
                  return { ...withMediaRefs, ...largeInputMetadata };
                }
                return withMediaRefs;
              }
              console.warn(
                `[CHAT API] SDK passthrough wait ended without result: ${toolCallId} tool=${registeredToolName}`
              );
              return buildMissingSdkPassthroughOutput(registeredToolName, args, {
                reason: `No bridged SDK tool result arrived for toolCallId=${toolCallId}. The underlying tool likely failed before publishing a structured result.`,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.warn(
                `[CHAT API] SDK passthrough bridge wait failed: toolCallId=${toolCallId} tool=${registeredToolName} bridge=sdkToolResultBridge error=${message}`
              );
              return buildMissingSdkPassthroughOutput(registeredToolName, args, {
                reason: `SDK passthrough bridge wait failed for toolCallId=${toolCallId}: ${message}`,
              });
            }
          }

          return { _sdkPassthrough: true, ...(largeInputMetadata ?? {}) };
        },
      });

    // (a) SDK built-in tools (Bash, Read, Write, etc.)
    const SDK_AGENT_TOOLS = [
      "Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep",
      "Task", "WebFetch", "WebSearch", "NotebookEdit", "TodoRead",
      "TodoWrite", "AskFollowupQuestion",
      // Additional Claude Code tools that stream during agent runs:
      "AskUserQuestion", "Agent", "TaskOutput", "TaskStop",
      "Skill", "EnterPlanMode", "ExitPlanMode",
      "TaskCreate", "TaskGet", "TaskUpdate", "TaskList",
      "EnterWorktree",
    ] as const;

    for (const name of SDK_AGENT_TOOLS) {
      if (!allToolsWithMCP[name]) {
        allToolsWithMCP[name] = createSdkPassthroughTool(name);
        sdkPassthroughNames.add(name);
      }
    }

    // (b) Selene platform MCP tools — the SDK agent calls these via the
    // "selene-platform" MCP server, which handles real execution. Replace
    // the original tool entries with passthrough versions so the Vercel AI
    // SDK doesn't double-execute. The mcp__<server>__ prefix is stripped
    // in normalizeClaudeSdkToolName so tool names arrive unprefixed.
    const existingToolNames = Object.keys(allToolsWithMCP);
    for (const name of existingToolNames) {
      if (sdkPassthroughNames.has(name)) continue;
      allToolsWithMCP[name] = createSdkPassthroughTool(name);
      sdkPassthroughNames.add(name);
      mcpPassthroughNames.add(name);
    }
  }

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

  // executeCommand oversized-output loop guard
  let consecutiveOversizedExecCommands = 0;
  let execCommandDisabledByLoopGuard = false;
  let execCommandDisableReason: string | null = null;
  const EXEC_COMMAND_OVERSIZED_LIMIT = 2;

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

        // executeCommand oversized-output loop guard (pre-execution check)
        if ((toolId === "executeCommand" || toolId === "bash") && execCommandDisabledByLoopGuard) {
          console.warn(
            `[CHAT API] ${toolId} disabled for remaining response (${execCommandDisableReason ?? "unknown reason"})`
          );
          return {
            status: "error",
            error:
              `${toolId} has been temporarily disabled for this response ` +
              `(${execCommandDisableReason}). ` +
              `The previous commands produced output too large for the context window. ` +
              `To recover: run specific test files (e.g., npm test -- path/to/file.test.ts), ` +
              `use head/tail to limit output, or use a compact reporter (--reporter=dot).`,
          };
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
          const guardedResult = guardToolResultForStreaming(toolId, rawResult, {
            maxTokens: streamToolResultBudgetTokens,
            metadata: {
              sourceFileName: "app/api/chat/tools-builder.ts",
            },
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

          // Shell-command oversized-output loop guard (executeCommand + bash)
          if (toolId === "executeCommand" || toolId === "bash") {
            if (guardedResult.blocked) {
              consecutiveOversizedExecCommands += 1;
              if (consecutiveOversizedExecCommands >= EXEC_COMMAND_OVERSIZED_LIMIT) {
                execCommandDisableReason =
                  `${consecutiveOversizedExecCommands} consecutive oversized shell command results`;
                execCommandDisabledByLoopGuard = true;
                console.warn(
                  `[CHAT API] ${toolId} loop guard triggered (${execCommandDisableReason})`
                );
              }
            } else {
              consecutiveOversizedExecCommands = 0;
            }
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

  // Build the initial activeTools array.
  // SDK agent passthrough tools must always be active so the Vercel AI SDK
  // accepts tool_use blocks from the SDK agent on any step.
  const sdkPassthroughToolNames = ctx.provider === "claudecode"
    ? Object.keys(allToolsWithMCP).filter((name) => sdkPassthroughNames.has(name))
    : [];

  const initialActiveToolNames = useDeferredLoading
    ? [
        ...new Set([
          ...initialActiveTools,
          ...previouslyDiscoveredTools,
          ...mcpToolResult.alwaysLoadToolIds,
          ...customComfyUIToolResult.alwaysLoadToolIds,
          ...sdkPassthroughToolNames,
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

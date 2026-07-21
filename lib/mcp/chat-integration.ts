import type { Tool } from "ai";
import type { Character } from "@/lib/db/schema";
import type { AgentMetadata } from "@/lib/characters/validation";
import { MCPClientManager, resolveMCPConfig } from "@/lib/mcp/client-manager";
import { ToolRegistry } from "@/lib/ai/tool-registry/registry";
import {
    createMCPToolWrapper,
    getMCPToolId,
    getMCPToolsForAgent,
    mcpToolToMetadata,
    type MCPToolLoadingPreference,
} from "@/lib/ai/tool-registry/mcp-tool-adapter";
import { resolveToolLoadingPolicy } from "@/lib/ai/tool-registry/loading-policy";
import type { ToolLoadingPreference } from "@/lib/ai/tool-registry/types";
import { loadSettings } from "@/lib/settings/settings-manager";
import { getGhostOsServerConfig, GHOST_OS_SERVER_NAME } from "@/lib/ghost-os/config";

/**
 * Result structure for MCP tool loading with loading mode separation
 */
interface MCPToolLoadResult {
    /** All enabled MCP tools (both alwaysLoad and deferred) */
    allTools: Record<string, Tool>;
    /** Tool IDs that should be in initialActiveTools (alwaysLoad: true) */
    alwaysLoadToolIds: string[];
    /** Tool IDs that are deferred (discoverable via searchTools) */
    deferredToolIds: string[];
    /**
     * MCP server names enabled for this agent (from character metadata).
     * Forwarded to SeleneMcpContext so the SDK MCP server can scope
     * MCPClientManager.getAllTools() to only this agent's servers.
     */
    enabledMcpServers?: string[];
    /**
     * Specific MCP tool IDs (format: "serverName:toolName") enabled for this agent.
     * Forwarded to SeleneMcpContext for per-tool isolation in the SDK bridge.
     */
    enabledMcpTools?: string[];
}

/**
 * Load MCP tools for a specific character/agent with loading mode support
 * Connects to configured MCP servers and creates AI SDK tool wrappers.
 * Also syncs with current config - disconnects servers no longer in config
 * and clears their tools from the registry.
 */
export async function loadMCPToolsForCharacter(
    character?: Character,
    options: {
        toolLoadingMode?: "deferred" | "always";
        toolLoadingPreferences?: Record<string, ToolLoadingPreference>;
    } = {}
): Promise<MCPToolLoadResult> {
    const settings = loadSettings();
    const manager = MCPClientManager.getInstance();
    const registry = ToolRegistry.getInstance();
    const env = settings.mcpEnvironment || {};

    // Combine global and per-agent MCP configs
    const globalConfig = settings.mcpServers?.mcpServers || {};
    const metadata = character?.metadata as AgentMetadata | undefined;
    const agentConfig = metadata?.mcpServers?.mcpServers || {};
    let combinedConfig = { ...globalConfig, ...agentConfig };

    // Auto-inject Ghost OS MCP server if installed and not already configured
    if (process.platform === "darwin" && !combinedConfig[GHOST_OS_SERVER_NAME]) {
        try {
            const ghostConfig = await getGhostOsServerConfig();
            if (Object.keys(ghostConfig).length > 0) {
                combinedConfig = { ...ghostConfig, ...combinedConfig } as typeof combinedConfig;
                console.log("[MCP] Ghost OS auto-detected, injecting MCP server config");
            }
        } catch (error) {
            console.warn("[MCP] Failed to detect Ghost OS:", error);
        }
    }

    // Get enabled servers and tools for this agent
    const enabledServers = metadata?.enabledMcpServers;
    const enabledTools = metadata?.enabledMcpTools;

    // Legacy MCP preferences and canonical generic loading preferences.
    const mcpToolPreferences = metadata?.mcpToolPreferences ?? {};
    const toolLoadingPreferences = options.toolLoadingPreferences ?? metadata?.toolLoadingPreferences;
    const toolLoadingMode = options.toolLoadingMode ?? settings.toolLoadingMode ?? "deferred";

    // Build set of servers that should be connected based on current config
    const configuredServerNames = new Set<string>(Object.keys(combinedConfig));

    // CRITICAL: Sync with config - disconnect servers that are no longer configured
    // and clean up their tools from the registry
    const { disconnectedServers, deferred } = await manager.syncWithConfigSafely(configuredServerNames);
    for (const serverName of disconnectedServers) {
        // Remove tools from registry for disconnected servers
        // Tool IDs have format: mcp_{sanitizedServerName}_{toolName}
        const sanitizedName = serverName.replace(/[^a-zA-Z0-9]/g, "_");
        const prefix = `mcp_${sanitizedName}_`;
        registry.unregisterByPrefix(prefix);
    }

    // If no servers are configured, also clear any remaining MCP tools from registry
    // This handles edge cases where state got out of sync
    if (configuredServerNames.size === 0 && !deferred) {
        // Use category-based cleanup as a fallback
        registry.unregisterByCategory("mcp");
        console.log("[MCP] No MCP servers configured, cleared all MCP tools from registry");
    }

    // Connect to any servers that aren't already connected
    // Use Promise.all with individual error handling to parallelize connections
    const connectionPromises: Promise<void>[] = [];
    
    for (const [serverName, config] of Object.entries(combinedConfig)) {
        // Skip if server is not enabled for this agent AND no individual tools from it are enabled
        if (enabledServers && !enabledServers.includes(serverName)) {
            const hasEnabledTools = enabledTools?.some(t => t.startsWith(`${serverName}:`));
            if (!hasEnabledTools) {
                continue;
            }
        }

        // Check if already connected with compatible context
        const isConnected = manager.isConnected(serverName);
        const connectedContext = manager.getConnectedCharacterId(serverName);
        
        // Skip if already connected with:
        // 1. Same character context, OR
        // 2. No character context (from instrumentation) - this is compatible with any character
        if (isConnected) {
            if (connectedContext === character?.id || connectedContext === undefined) {
                console.log(`[MCP] Server ${serverName} already connected with compatible context, skipping`);
                continue;
            }
        }

        // Need to connect (or reconnect for different character)
        const connectPromise = (async () => {
            try {
                const resolved = await resolveMCPConfig(
                    serverName,
                    config as any,
                    env,
                    character?.id
                );
                await manager.connect(serverName, resolved, character?.id);
            } catch (error) {
                console.error(`[MCP] Failed to connect to ${serverName}:`, error);
            }
        })();
        
        connectionPromises.push(connectPromise);
    }
    
    // Wait for all connections to complete
    if (connectionPromises.length > 0) {
        await Promise.all(connectionPromises);
    }

    // Get filtered MCP tools for this agent
    // Guard: getMCPToolsForAgent may return an empty array if tools were deleted
    // between metadata save and this load. This is expected and handled gracefully.
    let mcpTools: ReturnType<typeof getMCPToolsForAgent>;
    try {
        mcpTools = getMCPToolsForAgent(enabledServers, enabledTools);
    } catch (error) {
        console.warn("[MCP] Failed to get MCP tools for agent, falling back to empty set:", error);
        mcpTools = [];
    }

    // Convert to AI SDK tools with loading mode awareness
    const allTools: Record<string, Tool> = {};
    const alwaysLoadToolIds: string[] = [];
    const deferredToolIds: string[] = [];

    for (const mcpTool of mcpTools) {
        // Defensive: skip tools with missing critical fields (can happen if
        // the tool was removed from the MCP server between discovery and use)
        if (!mcpTool.name || !mcpTool.serverName) {
            console.warn("[MCP] Skipping tool with missing name or serverName:", mcpTool);
            continue;
        }

        const toolKey = `${mcpTool.serverName}:${mcpTool.name}`;
        const toolId = getMCPToolId(mcpTool.serverName, mcpTool.name);

        // Get per-tool preference (default: enabled with deferred loading)
        // Guard: if metadata references a deleted tool's preference, fall back to defaults
        const preference = mcpToolPreferences[toolKey] ?? {
            enabled: true,
            loadingMode: "deferred" as const,
            displayMode: "compact" as const,
        };

        // Skip disabled tools
        if (!preference.enabled) {
            continue;
        }

        const baseMetadata = mcpToolToMetadata(mcpTool, preference);
        const resolved = resolveToolLoadingPolicy({
            toolId,
            metadata: baseMetadata,
            isAvailable: true,
            toolLoadingPreferences,
            toolLoadingMode,
            legacyMcpPreference: preference,
        });

        if (resolved.policy === "disabled") {
            continue;
        }

        const effectivePreference: MCPToolLoadingPreference = {
            ...preference,
            loadingMode: resolved.initiallyActive ? "always" : "deferred",
        };

        // Register with ToolRegistry using resolved policy-aware metadata.
        // Wrap in try/catch to tolerate schema errors or missing tool data.
        try {
            const toolMetadata = mcpToolToMetadata(mcpTool, effectivePreference);
            const factory = () => createMCPToolWrapper(mcpTool);
            registry.register(toolId, toolMetadata, factory);

            allTools[toolId] = createMCPToolWrapper(mcpTool);
        } catch (error) {
            console.warn(`[MCP] Skipping tool ${toolId} due to error (tool may have been removed):`, error);
            continue;
        }

        if (resolved.initiallyActive) {
            alwaysLoadToolIds.push(toolId);
        } else {
            deferredToolIds.push(toolId);
        }
    }

    // Log when metadata references tools that no longer exist (stale references)
    if (enabledTools && enabledTools.length > 0) {
        const loadedToolKeys = new Set(mcpTools.map(t => `${t.serverName}:${t.name}`));
        const staleRefs = enabledTools.filter(t => !loadedToolKeys.has(t));
        if (staleRefs.length > 0) {
            console.warn(`[MCP] Agent metadata references ${staleRefs.length} MCP tool(s) that no longer exist: ${staleRefs.join(", ")}. These will be skipped.`);
        }
    }

    if (Object.keys(allTools).length > 0) {
        console.log(`[MCP] Loaded ${Object.keys(allTools).length} MCP tools (${alwaysLoadToolIds.length} always-load, ${deferredToolIds.length} deferred)`);
    }

    return {
        allTools,
        alwaysLoadToolIds,
        deferredToolIds,
        enabledMcpServers: enabledServers,
        enabledMcpTools: enabledTools,
    };
}

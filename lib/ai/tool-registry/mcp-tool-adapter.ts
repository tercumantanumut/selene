/**
 * MCP Tool Adapter
 *
 * Converts MCP tools to Selene's ToolMetadata format and creates AI SDK-compatible wrappers.
 */

import { tool, jsonSchema } from "ai";
import type { Tool } from "ai";
import type { ToolMetadata, ToolFactory } from "@/lib/ai/tool-registry/types";
import { ToolRegistry } from "@/lib/ai/tool-registry/registry";
import { MCPClientManager } from "@/lib/mcp/client-manager";
import type { MCPDiscoveredTool } from "@/lib/mcp/types";
import { formatMCPToolResult } from "@/lib/mcp/result-formatter";
import {
    normalizeInputSchema,
    ensureSchemaCompleteness,
    BASE_ALLOWED_SCHEMA_KEYS,
    BASE_STRING_KEYS,
    BASE_NUMBER_KEYS,
    BASE_BOOLEAN_KEYS,
} from "@/lib/ai/json-schema-sanitizer";

const MCP_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";

const DEFAULT_MCP_INPUT_SCHEMA: Record<string, unknown> = {
    $schema: MCP_SCHEMA_DRAFT,
    type: "object",
    properties: {},
    additionalProperties: true,
};

// MCP schemas carry an explicit "$schema" declaration that Antigravity does not,
// so we extend the base sets with that single additional key.
const MCP_ALLOWED_SCHEMA_KEYS = new Set(["$schema", ...BASE_ALLOWED_SCHEMA_KEYS]);
const MCP_STRING_KEYS = new Set(["$schema", ...BASE_STRING_KEYS]);
const MCP_NUMBER_KEYS = BASE_NUMBER_KEYS;
const MCP_BOOLEAN_KEYS = BASE_BOOLEAN_KEYS;

function normalizeMcpInputSchema(
    inputSchema: unknown,
    mcpTool: MCPDiscoveredTool
): Record<string, unknown> {
    const normalized = normalizeInputSchema(
        inputSchema,
        MCP_ALLOWED_SCHEMA_KEYS,
        MCP_STRING_KEYS,
        MCP_NUMBER_KEYS,
        MCP_BOOLEAN_KEYS,
        DEFAULT_MCP_INPUT_SCHEMA,
        () => console.warn(`[MCP] Empty input schema for ${mcpTool.serverName}:${mcpTool.name}; using default schema.`),
        () => console.warn(`[MCP] Invalid input schema for ${mcpTool.serverName}:${mcpTool.name}; using default schema.`),
    );

    // MCP schemas carry an explicit $schema declaration; add it after normalization
    // (normalizeInputSchema may return the default which already has it, but set
    // it unconditionally to ensure it's always present on a non-default result).
    if (normalized !== DEFAULT_MCP_INPUT_SCHEMA) {
        normalized.$schema = MCP_SCHEMA_DRAFT;
        // Re-run completeness after injecting $schema in case the object was mutated
        return ensureSchemaCompleteness(normalized);
    }
    return normalized;
}

/**
 * Category for MCP tools - they get their own category
 */
const MCP_TOOL_CATEGORY = "mcp" as const;

/**
 * Per-tool loading preference from agent settings
 */
export interface MCPToolLoadingPreference {
    enabled: boolean;
    loadingMode: "always" | "deferred";
    displayMode?: "compact" | "detailed";
}

/**
 * Generate a human-readable display name for an MCP tool.
 * Uses the original tool name (before ID sanitization) and title-cases it.
 * "ghost_press" → "Ghost Press", "read_file" → "Read File"
 */
function humanizeMcpToolName(toolName: string, _serverName: string): string {
    let result = toolName
        // camelCase boundary: lowercase/digit followed by uppercase
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        // acronym boundary: uppercase run followed by uppercase+lowercase (e.g. "HTTPStatus" → "HTTP Status")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
    // snake_case / kebab-case → space-separated
    result = result.replace(/[_-]/g, " ");
    // Title Case each word
    return result.replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

/**
 * Convert an MCP tool to Selene's ToolMetadata format
 * @param mcpTool - The MCP tool from the server
 * @param preference - Optional per-tool loading preference from agent settings
 */
export function mcpToolToMetadata(
    mcpTool: MCPDiscoveredTool,
    preference?: MCPToolLoadingPreference
): ToolMetadata {
    // Determine loading configuration based on preference
    const loadingConfig = preference?.loadingMode === "always"
        ? { alwaysLoad: true, deferLoading: false, defaultPolicy: "always" as const }
        : { alwaysLoad: false, deferLoading: true, defaultPolicy: "deferred" as const };  // Default to deferred

    // Defensive: handle missing name/serverName from a deleted or partially-loaded tool
    const toolName = mcpTool.name || "unknown_tool";
    const serverName = mcpTool.serverName || "unknown_server";
    const description = mcpTool.description || "";

    return {
        displayName: humanizeMcpToolName(toolName, serverName),
        category: MCP_TOOL_CATEGORY,
        keywords: [
            toolName,
            serverName,
            "mcp",
            "external",
            ...(description.toLowerCase().split(/\s+/).slice(0, 5)),
        ].filter(Boolean),
        shortDescription: description || `MCP tool from ${serverName}`,
        fullInstructions: description || undefined,
        loading: loadingConfig,  // Now dynamic based on preference
        requiresSession: false,
        // MCP tool results are shown in UI but excluded from AI conversation history
        // to save tokens (large outputs like browser snapshots are processed once)
        ephemeralResults: true,
    };
}

/**
 * Create an AI SDK tool wrapper for an MCP tool
 */
export function createMCPToolWrapper(mcpTool: MCPDiscoveredTool): Tool {
    const manager = MCPClientManager.getInstance();

    // Defensive: ensure we have valid identifiers even if tool was partially deleted
    const toolName = mcpTool.name || "unknown_tool";
    const serverName = mcpTool.serverName || "unknown_server";

    // Convert MCP input schema to AI SDK jsonSchema format
    const normalizedSchema = normalizeMcpInputSchema(mcpTool.inputSchema, mcpTool);
    console.debug(`[MCP] Normalized schema for ${serverName}:${toolName}:`, JSON.stringify(normalizedSchema));
    const schema = jsonSchema<Record<string, unknown>>(normalizedSchema as any);

    return tool({
        description: mcpTool.description || `MCP tool: ${toolName}`,
        inputSchema: schema,
        execute: async (args: Record<string, unknown>) => {
            try {
                // Guard: check if the server is still connected before executing.
                // The tool may have been removed from the agent's config mid-session.
                if (!manager.isConnected(serverName)) {
                    const msg = `MCP server "${serverName}" is no longer connected. The tool "${toolName}" may have been removed.`;
                    console.warn(`[MCP Tool] ${msg}`);
                    return await formatMCPToolResult(
                        serverName,
                        toolName,
                        msg,
                        true
                    );
                }

                // Ghost OS vision sidecar pre-flight:
                // ghost_parse_screen and ghost_annotate need the vision sidecar running,
                // but unlike ghost_ground they don't auto-start it. We trigger ghost_ground
                // as a boot mechanism if the sidecar isn't responding.
                if (serverName === "ghostos") {
                    const { isVisionSidecarTool, ensureVisionSidecar } = await import("@/lib/ghost-os/vision-sidecar");
                    if (isVisionSidecarTool(toolName)) {
                        const sidecarError = await ensureVisionSidecar(
                            (sn, tn, a) => manager.executeTool(sn, tn, a)
                        );
                        if (sidecarError) {
                            return await formatMCPToolResult(
                                serverName,
                                toolName,
                                sidecarError,
                                true
                            );
                        }
                    }
                }

                const result = await manager.executeTool(
                    serverName,
                    toolName,
                    args
                );

                // Format result according to Selene's conventions (strip base64 payloads)
                return await formatMCPToolResult(
                    serverName,
                    toolName,
                    result,
                    false
                );
            } catch (error) {
                console.error(`[MCP Tool] Error executing ${serverName}:${toolName}:`, error);
                return await formatMCPToolResult(
                    serverName,
                    toolName,
                    error instanceof Error ? error.message : String(error),
                    true
                );
            }
        },
    });
}

/**
 * Generate a unique tool ID for an MCP tool
 * Format: mcp_{serverName}_{toolName}
 */
export function getMCPToolId(serverName: string, toolName: string): string {
    // Sanitize names for use as identifiers
    const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "_");
    return `mcp_${sanitize(serverName)}_${sanitize(toolName)}`;
}

/**
 * Register all tools from connected MCP servers with the ToolRegistry
 */
function registerMCPTools(): void {
    const manager = MCPClientManager.getInstance();
    const registry = ToolRegistry.getInstance();

    const allTools = manager.getAllTools();

    for (const mcpTool of allTools) {
        const toolId = getMCPToolId(mcpTool.serverName, mcpTool.name);
        const metadata = mcpToolToMetadata(mcpTool);
        const factory: ToolFactory = () => createMCPToolWrapper(mcpTool);

        registry.register(toolId, metadata, factory);
        console.debug(`[MCP] Registered tool: ${toolId}`);
    }

    console.debug(`[MCP] Registered ${allTools.length} MCP tools`);
}

/**
 * Get MCP tools filtered by enabled servers/tools for an agent.
 * 
 * Returns only tools that are currently available from connected MCP servers.
 * If the agent's metadata references tools that no longer exist (e.g., removed
 * mid-session), those tools are silently excluded rather than causing errors.
 */
export function getMCPToolsForAgent(
    enabledServers?: string[],
    enabledTools?: string[]
): MCPDiscoveredTool[] {
    const manager = MCPClientManager.getInstance();
    let tools: MCPDiscoveredTool[];

    try {
        tools = manager.getAllTools();
    } catch (error) {
        console.warn("[MCP] Failed to retrieve tools from MCPClientManager:", error);
        return [];
    }

    // Defensive: filter out any tools with missing critical fields
    tools = tools.filter(t => t && t.name && t.serverName);

    // If enabled tools are explicitly specified, honor that list directly.
    // This allows per-tool enablement even when a server isn't globally enabled.
    // Tools referenced in enabledTools but not present in the manager are silently skipped.
    if (enabledTools) {
        if (enabledTools.length === 0) {
            return [];
        }
        const toolSet = new Set(enabledTools);
        tools = tools.filter(t => toolSet.has(`${t.serverName}:${t.name}`));
        return tools;
    }

    // Otherwise filter by enabled servers (if provided)
    if (enabledServers) {
        if (enabledServers.length === 0) {
            return [];
        }
        const serverSet = new Set(enabledServers);
        tools = tools.filter(t => serverSet.has(t.serverName));
    }

    return tools;
}

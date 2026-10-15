/**
 * MCP Configuration API Route
 * 
 * Handles MCP server configuration management.
 */

import { NextRequest, NextResponse } from "next/server";
import { loadSettings, saveSettings } from "@/lib/settings/settings-manager";
import { MCPClientManager } from "@/lib/mcp/client-manager";
import { ToolRegistry } from "@/lib/ai/tool-registry/registry";
import { getActivePluginMCPServers, updatePluginMCPServerConfig } from "@/lib/plugins/registry";
import type { MCPConfig, MCPServerConfig } from "@/lib/mcp/types";
import { getGhostOsServerConfig, GHOST_OS_SERVER_NAME } from "@/lib/ghost-os/config";
import { getMCPOAuthStatus } from "@/lib/mcp/oauth-provider";

/**
 * GET /api/mcp
 * Get MCP server configurations and status
 */
export async function GET() {
    try {
        const settings = loadSettings();
        const manager = MCPClientManager.getInstance();

        // Mask headers in server configs
        let mcpServers = settings.mcpServers?.mcpServers || {};

        // Auto-inject Ghost OS if installed and not already in user config
        if (process.platform === "darwin" && !mcpServers[GHOST_OS_SERVER_NAME]) {
            try {
                const ghostConfig = await getGhostOsServerConfig();
                if (Object.keys(ghostConfig).length > 0) {
                    mcpServers = { ...ghostConfig, ...mcpServers } as Record<string, MCPServerConfig>;
                }
            } catch { /* Ghost OS not installed — skip */ }
        }

        const maskedServers: Record<string, MCPServerConfig> = {};

        for (const [name, config] of Object.entries(mcpServers)) {
            maskedServers[name] = {
                ...config,
                headers: config.headers ? maskHeaders(config.headers) : undefined,
            };
        }

        // Gather plugin-declared MCP servers with connection status
        const allStatus = manager.getAllStatus();
        const statusNames = new Set(allStatus.map(s => s.serverName));

        for (const [name, config] of Object.entries(mcpServers)) {
            const transportType = config.command ? "stdio" : (config.type || "sse");
            const oauthConfigured = !config.command && Boolean(config.url) && (
                config.auth?.type === "oauth" ||
                (transportType === "http" && config.auth?.type !== "none" && config.auth?.type !== "headers")
            );

            if (config.enabled === false || statusNames.has(name) || !oauthConfigured || !config.url) continue;

            const oauthStatus = getMCPOAuthStatus(name, config.url);
            const connectionState = oauthStatus.authState === "connected"
                ? "not_connected"
                : oauthStatus.authState === "unauthenticated"
                    ? "authorization_required"
                    : oauthStatus.authState;

            allStatus.push({
                serverName: name,
                connected: false,
                lastError: oauthStatus.lastError,
                connectionState,
                authRequired: connectionState === "authorization_required" || connectionState === "authorizing" || connectionState === "expired" || connectionState === "failed",
                authorizationUrl: oauthStatus.authorizationUrl,
                serverUrl: config.url,
                transportType,
                details: oauthStatus.hasTokens
                    ? "OAuth credentials are saved. Reconnect to discover tools."
                    : "This URL-based MCP server is configured for browser authorization.",
                recovery: oauthStatus.hasTokens
                    ? "Reconnect this MCP server. Selene will reuse saved OAuth credentials."
                    : "Use Connect with browser to authorize this MCP server.",
                toolCount: 0,
                tools: [],
            });
        }

        const statusByName = new Map(allStatus.map(s => [s.serverName, s]));

        let pluginServers: Array<{
            namespacedName: string;
            serverName: string;
            pluginName: string;
            pluginId: string;
            pluginVersion: string;
            connected: boolean;
            toolCount: number;
            tools: string[];
            lastError?: string;
            connectionState?: string;
            authRequired?: boolean;
            authorizationUrl?: string;
            details?: string;
            recovery?: string;
            config: Record<string, unknown>;
            incomplete?: boolean;
            incompleteReason?: string;
        }> = [];

        try {
            const pluginMcpRows = await getActivePluginMCPServers();
            pluginServers = pluginMcpRows.map(row => {
                const namespacedName = `plugin:${row.pluginName}:${row.serverName}`;
                const status = statusByName.get(namespacedName);
                const cfg = row.config as { command?: string; url?: string; type?: string };

                // Detect incomplete configs: SSE/HTTP transport without a URL
                const transportType = cfg.command ? "stdio" : (cfg.type || "sse");
                const needsUrl = transportType === "sse" || transportType === "http";
                const incomplete = needsUrl && !cfg.url;

                return {
                    namespacedName,
                    serverName: row.serverName,
                    pluginName: row.pluginName,
                    pluginId: row.pluginId,
                    pluginVersion: row.pluginVersion,
                    connected: status?.connected ?? false,
                    toolCount: status?.toolCount ?? 0,
                    tools: status?.tools ?? [],
                    lastError: incomplete ? undefined : status?.lastError,
                    connectionState: status?.connectionState,
                    authRequired: status?.authRequired,
                    authorizationUrl: status?.authorizationUrl,
                    details: status?.details,
                    recovery: status?.recovery,
                    config: row.config,
                    incomplete: incomplete || undefined,
                    incompleteReason: incomplete
                        ? `This server uses ${transportType} transport but has no URL configured.`
                        : undefined,
                };
            });
        } catch (error) {
            // Non-critical — settings page still works without plugin server data
            console.warn("[MCP API] Failed to load plugin MCP servers:", error);
        }

        return NextResponse.json({
            config: { mcpServers: maskedServers },
            environment: maskEnvironment(settings.mcpEnvironment || {}),
            status: allStatus,
            pluginServers,
        });
    } catch (error) {
        console.error("[MCP API] Error:", error);
        return NextResponse.json({ error: "Failed to get MCP config" }, { status: 500 });
    }
}

/**
 * PUT /api/mcp
 * Update MCP server configuration
 * Also syncs MCP connections - disconnects servers no longer in config
 */
export async function PUT(request: NextRequest) {
    try {
        const body = await request.json();
        const { mcpServers, mcpEnvironment } = body as {
            mcpServers?: MCPConfig;
            mcpEnvironment?: Record<string, string>;
        };

        const settings = loadSettings();

        if (mcpServers !== undefined) {
            // Merge headers, skipping masked values (containing •)
            const existingServers = settings.mcpServers?.mcpServers || {};
            const updatedServers: Record<string, MCPServerConfig> = {};
            
            for (const [name, config] of Object.entries(mcpServers.mcpServers || {})) {
                const existingConfig = existingServers[name];
                const mergedHeaders: Record<string, string> = {};
                
                // Merge headers, preserving existing values if new ones are masked
                if (config.headers || existingConfig?.headers) {
                    const existing = existingConfig?.headers || {};
                    const incoming = config.headers || {};
                    
                    // Start with existing headers
                    Object.assign(mergedHeaders, existing);
                    
                    // Update with incoming headers, but skip masked values
                    for (const [key, value] of Object.entries(incoming)) {
                        if (!value.includes("•")) {
                            mergedHeaders[key] = value;
                        }
                    }
                }
                
                updatedServers[name] = {
                    ...config,
                    headers: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
                };
            }
            
            settings.mcpServers = { mcpServers: updatedServers };
        }

        if (mcpEnvironment !== undefined) {
            // Merge with existing, only update non-masked values
            settings.mcpEnvironment = {
                ...settings.mcpEnvironment,
                ...Object.fromEntries(
                    Object.entries(mcpEnvironment).filter(([_, v]) => !v.includes("•"))
                ),
            };
        }

        saveSettings(settings);

        // CRITICAL: Sync MCP connections with the new config
        // This disconnects servers that were removed and clears their tools
        const manager = MCPClientManager.getInstance();
        const registry = ToolRegistry.getInstance();
        const mcpConfig = mcpServers?.mcpServers || settings.mcpServers?.mcpServers || {};
        const configuredServers = new Set<string>(
            Object.entries(mcpConfig)
                .filter(([_, config]) => config.enabled !== false)
                .map(([name]) => name)
        );

        const { disconnectedServers, deferred } = await manager.syncWithConfigSafely(configuredServers);

        // Clean up tools from registry for disconnected servers
        for (const serverName of disconnectedServers) {
            const sanitizedName = serverName.replace(/[^a-zA-Z0-9]/g, "_");
            const prefix = `mcp_${sanitizedName}_`;
            registry.unregisterByPrefix(prefix);
        }

        // If no servers configured, clear all MCP tools as a safety measure
        if (configuredServers.size === 0) {
            registry.unregisterByCategory("mcp");
            console.log("[MCP API] No servers configured, cleared all MCP tools");
        }

        return NextResponse.json({
            success: true,
            disconnectedServers: disconnectedServers.length,
            deferred,
        });
    } catch (error) {
        console.error("[MCP API] Error:", error);
        return NextResponse.json({ error: "Failed to save MCP config" }, { status: 500 });
    }
}

/**
 * PATCH /api/mcp
 * Update a plugin MCP server's config (e.g. add a missing URL for SSE servers).
 * Body: { pluginId: string; serverName: string; url: string }
 */
export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const { pluginId, serverName, url } = body as {
            pluginId?: string;
            serverName?: string;
            url?: string;
        };

        if (!pluginId || !serverName) {
            return NextResponse.json(
                { error: "pluginId and serverName are required" },
                { status: 400 }
            );
        }

        if (!url || !url.trim()) {
            return NextResponse.json(
                { error: "url is required" },
                { status: 400 }
            );
        }

        // Validate URL format and protocol
        try {
            const parsed = new URL(url);
            if (!["http:", "https:"].includes(parsed.protocol)) {
                return NextResponse.json(
                    { error: "Only http and https URLs are supported" },
                    { status: 400 }
                );
            }
        } catch {
            return NextResponse.json(
                { error: "Invalid URL format. Provide a full URL (e.g. https://example.com/sse)" },
                { status: 400 }
            );
        }

        const updated = await updatePluginMCPServerConfig(pluginId, serverName, { url });

        if (!updated) {
            return NextResponse.json(
                { error: "Plugin MCP server not found" },
                { status: 404 }
            );
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("[MCP API] PATCH error:", error);
        return NextResponse.json(
            { error: "Failed to update plugin server config" },
            { status: 500 }
        );
    }
}

/**
 * Mask sensitive environment variable values for display
 */
function maskEnvironment(env: Record<string, string>): Record<string, string> {
    const masked: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value.length > 8) {
            masked[key] = value.slice(0, 4) + "••••••••" + value.slice(-4);
        } else {
            masked[key] = "••••••••";
        }
    }
    return masked;
}

/**
 * Mask sensitive header values for display
 * Applies to Authorization, X-API-Key, and any header containing "token" or "key"
 */
function maskHeaders(headers: Record<string, string>): Record<string, string> {
    const masked: Record<string, string> = {};
    const sensitivePatterns = ['authorization', 'x-api-key', 'token', 'key', 'secret', 'bearer'];
    
    for (const [key, value] of Object.entries(headers)) {
        const isSensitive = sensitivePatterns.some(pattern => 
            key.toLowerCase().includes(pattern)
        );
        
        if (isSensitive && value.length > 8) {
            masked[key] = value.slice(0, 4) + "••••••••" + value.slice(-4);
        } else if (isSensitive) {
            masked[key] = "••••••••";
        } else {
            // Non-sensitive headers are shown as-is
            masked[key] = value;
        }
    }
    return masked;
}

/**
 * Check if a value is masked (contains bullet characters)
 */
function isMasked(value: string): boolean {
    return value.includes("•");
}

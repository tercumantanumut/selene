/**
 * MCP Connect API Route
 *
 * Handles connecting to MCP servers and discovering tools.
 */

import { NextRequest, NextResponse } from "next/server";
import { loadSettings } from "@/lib/settings/settings-manager";
import { MCPClientManager, resolveMCPConfig } from "@/lib/mcp/client-manager";
import { clearMCPAuthCache, clearMCPAuthCacheForServer } from "@/lib/mcp/auth-cache";
import { buildDefaultMCPOAuthRedirectUrl, clearAllMCPOAuth, clearMCPOAuthForServer } from "@/lib/mcp/oauth-provider";
import { getActivePluginMCPServers } from "@/lib/plugins/registry";
import { connectPluginMCPServers } from "@/lib/plugins/mcp-integration";
import type { PluginMCPServerEntry } from "@/lib/plugins/types";
import { getGhostOsServerConfig, GHOST_OS_SERVER_NAME } from "@/lib/ghost-os/config";

/**
 * POST /api/mcp/connect
 * Connect to MCP servers and discover tools
 *
 * Body options:
 * - serverNames: string[] - specific servers to connect (default: all configured)
 * - forceReauth: boolean - clear OAuth cache before connecting to force re-authentication
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { serverNames, forceReauth, characterId } = body as {
            serverNames?: string[];
            forceReauth?: boolean;
            characterId?: string;
        };

        const settings = loadSettings();
        const manager = MCPClientManager.getInstance();
        const env = settings.mcpEnvironment || {};

        let mcpConfig = settings.mcpServers?.mcpServers || {};

        // Auto-inject Ghost OS if installed and not already in user config
        if (process.platform === "darwin" && !mcpConfig[GHOST_OS_SERVER_NAME]) {
            try {
                const ghostConfig = await getGhostOsServerConfig();
                if (Object.keys(ghostConfig).length > 0) {
                    mcpConfig = { ...ghostConfig, ...mcpConfig } as typeof mcpConfig;
                }
            } catch { /* Ghost OS not installed — skip */ }
        }

        // Filter to only enabled servers (undefined or true = enabled)
        const enabledServers = Object.entries(mcpConfig)
            .filter(([_, config]) => config.enabled !== false)
            .map(([name]) => name);

        // If specific servers requested, intersect with enabled list
        const serversToConnect = serverNames
            ? serverNames.filter(name => {
                const config = mcpConfig[name];
                return config && config.enabled !== false;
            })
            : enabledServers;

        // If forceReauth is true, clear the OAuth cache for the specified servers
        // This forces mcp-remote to re-authenticate with the OAuth provider
        if (forceReauth) {
            if (serverNames && serverNames.length > 0) {
                // Clear cache for specific servers
                for (const serverName of serverNames) {
                    const config = mcpConfig[serverName];
                    if (config) {
                        // Extract the URL from config to generate the cache key
                        const url = (config as { url?: string }).url;
                        if (url) {
                            await clearMCPAuthCacheForServer(url);
                            clearMCPOAuthForServer(serverName, url);
                        }
                    }
                }
            } else {
                // Clear all MCP auth cache
                await clearMCPAuthCache();
                clearAllMCPOAuth();
            }
        }

        // Separate plugin servers (plugin:*) from user-configured servers
        const pluginServerNames = serverNames?.filter(n => n.startsWith("plugin:")) || [];
        const userServerNames = serversToConnect.filter(n => !n.startsWith("plugin:"));

        const results: Record<string, {
            success: boolean;
            error?: string;
            toolCount?: number;
            authRequired?: boolean;
            authorizationUrl?: string;
            connectionState?: string;
            recovery?: string;
            details?: string;
            serverUrl?: string;
            transportType?: string;
            errorStatus?: number | string;
        }> = {};

        // Connect user-configured servers
        for (const serverName of userServerNames) {
            const config = mcpConfig[serverName];
            if (!config) {
                results[serverName] = { success: false, error: "Server not configured" };
                continue;
            }

            // Upfront validation: SSE/HTTP servers need a URL
            const transportType = config.command ? "stdio" : (config.type || "sse");
            if ((transportType === "sse" || transportType === "http") && !config.url) {
                results[serverName] = {
                    success: false,
                    error: `Server "${serverName}" uses ${transportType} transport but has no URL configured. Edit the server and add a URL to connect.`,
                };
                continue;
            }

            try {
                // Disconnect first if forceReauth to ensure clean state
                if (forceReauth && manager.isConnected(serverName)) {
                    await manager.disconnect(serverName);
                }

                const resolved = await resolveMCPConfig(serverName, config, env, characterId);
                resolved.oauthRedirectUrl = buildDefaultMCPOAuthRedirectUrl(request.url);
                const status = await manager.connect(serverName, resolved, characterId);
                results[serverName] = {
                    success: status.connected,
                    error: status.lastError,
                    toolCount: status.toolCount,
                    authRequired: status.authRequired,
                    authorizationUrl: status.authorizationUrl,
                    connectionState: status.connectionState,
                    recovery: status.recovery,
                    details: status.details,
                    serverUrl: status.serverUrl,
                    transportType: status.transportType,
                    errorStatus: status.errorStatus,
                };
            } catch (error) {
                results[serverName] = {
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }

        // Connect plugin-declared servers (namespaced as plugin:{pluginName}:{serverName})
        if (pluginServerNames.length > 0) {
            try {
                const pluginMcpRows = await getActivePluginMCPServers();

                for (const namespacedName of pluginServerNames) {
                    // Parse plugin:{pluginName}:{serverName}
                    const parts = namespacedName.split(":");
                    if (parts.length < 3) {
                        results[namespacedName] = { success: false, error: "Invalid plugin server name" };
                        continue;
                    }
                    const pluginName = parts[1];
                    const serverName = parts.slice(2).join(":");

                    const row = pluginMcpRows.find(
                        r => r.pluginName === pluginName && r.serverName === serverName
                    );
                    if (!row) {
                        results[namespacedName] = { success: false, error: "Plugin server not found" };
                        continue;
                    }

                    // Upfront validation: SSE/HTTP plugin servers need a URL
                    const cfg = row.config as { command?: string; url?: string; type?: string };
                    const pluginTransport = cfg.command ? "stdio" : (cfg.type || "sse");
                    if ((pluginTransport === "sse" || pluginTransport === "http") && !cfg.url) {
                        results[namespacedName] = {
                            success: false,
                            error: `Server "${serverName}" uses ${pluginTransport} transport but has no URL configured. Add a URL in Settings → MCP Servers.`,
                        };
                        continue;
                    }

                    try {
                        // Disconnect first if reconnecting
                        if (manager.isConnected(namespacedName)) {
                            await manager.disconnect(namespacedName);
                        }

                        const singleServerConfig: Record<string, PluginMCPServerEntry> = {
                            [serverName]: row.config as unknown as PluginMCPServerEntry,
                        };
                        const { connected, failed } = await connectPluginMCPServers(
                            pluginName,
                            singleServerConfig,
                            characterId,
                            row.cachePath || undefined
                        );

                        if (connected.length > 0) {
                            const status = manager.getAllStatus().find(s => s.serverName === namespacedName);
                            results[namespacedName] = {
                                success: true,
                                toolCount: status?.toolCount ?? 0,
                                connectionState: status?.connectionState,
                            };
                        } else {
                            const status = manager.getAllStatus().find(s => s.serverName === namespacedName);
                            results[namespacedName] = {
                                success: false,
                                error: status?.lastError ?? `Failed to connect plugin server: ${failed.join(", ")}`,
                                authRequired: status?.authRequired,
                                authorizationUrl: status?.authorizationUrl,
                                connectionState: status?.connectionState,
                                recovery: status?.recovery,
                                details: status?.details,
                                serverUrl: status?.serverUrl,
                                transportType: status?.transportType,
                                errorStatus: status?.errorStatus,
                            };
                        }
                    } catch (error) {
                        results[namespacedName] = {
                            success: false,
                            error: error instanceof Error ? error.message : String(error),
                        };
                    }
                }
            } catch (error) {
                // Mark all plugin servers as failed
                for (const name of pluginServerNames) {
                    results[name] = {
                        success: false,
                        error: error instanceof Error ? error.message : "Failed to query plugin servers",
                    };
                }
            }
        }

        return NextResponse.json({ results });
    } catch (error) {
        console.error("[MCP API] Connect error:", error);
        return NextResponse.json({ error: "Failed to connect to MCP servers" }, { status: 500 });
    }
}

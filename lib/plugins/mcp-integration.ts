/**
 * Plugin-scoped MCP Integration
 *
 * Connects/disconnects MCP servers defined in plugin manifests.
 * Each plugin can declare MCP servers in its .mcp.json or manifest.
 * These are managed as part of the plugin lifecycle (install/uninstall/disable).
 */

import { MCPClientManager, resolveMCPConfig } from "@/lib/mcp/client-manager";
import type { PluginMCPConfig, PluginMCPServerEntry } from "./types";
import { getActivePluginMCPServers } from "./registry";

/**
 * Connect MCP servers declared by a plugin.
 * Server names are namespaced as `plugin:{pluginName}:{serverName}`.
 */
export async function connectPluginMCPServers(
  pluginName: string,
  mcpConfig: PluginMCPConfig,
  characterId?: string,
  pluginRoot?: string
): Promise<{ connected: string[]; failed: string[] }> {
  const manager = MCPClientManager.getInstance();
  const connected: string[] = [];
  const failed: string[] = [];

  for (const [serverName, entry] of Object.entries(mcpConfig)) {
    const namespacedName = `plugin:${pluginName}:${serverName}`;

    try {
      // Resolve ${CLAUDE_PLUGIN_ROOT} in command and args
      const resolvedEntry = resolvePluginRoot(entry, pluginRoot || "");

      const resolved = await resolveMCPConfig(
        namespacedName,
        {
          command: resolvedEntry.command,
          args: resolvedEntry.args,
          env: resolvedEntry.env,
          url: resolvedEntry.url,
          headers: resolvedEntry.headers,
          type: resolvedEntry.type,
        },
        {}, // No additional env vars
        characterId
      );

      const status = await manager.connect(namespacedName, resolved, characterId);
      if (status.connected) {
        connected.push(namespacedName);
        console.log(`[Plugin MCP] Connected: ${namespacedName}`);
      } else {
        failed.push(namespacedName);
        console.warn(`[Plugin MCP] ${namespacedName} did not connect: ${status.lastError ?? status.connectionState ?? "unknown error"}`);
      }
    } catch (error) {
      console.error(`[Plugin MCP] Failed to connect ${namespacedName}:`, error);
      failed.push(namespacedName);
    }
  }

  return { connected, failed };
}

/**
 * Disconnect MCP servers for a plugin.
 */
async function disconnectPluginMCPServers(
  pluginName: string,
  mcpConfig: PluginMCPConfig
): Promise<void> {
  const manager = MCPClientManager.getInstance();

  for (const serverName of Object.keys(mcpConfig)) {
    const namespacedName = `plugin:${pluginName}:${serverName}`;
    try {
      await manager.disconnect(namespacedName);
      console.log(`[Plugin MCP] Disconnected: ${namespacedName}`);
    } catch (error) {
      console.warn(`[Plugin MCP] Failed to disconnect ${namespacedName}:`, error);
    }
  }
}

/**
 * Load and connect MCP servers from all active plugins.
 * Uses the DB (plugin_mcp_servers) as source of truth so user-provided
 * config overrides (e.g. URLs added via Settings) are respected.
 * Call on app startup or when switching agents.
 */
async function loadAllPluginMCPServers(
  _userId: string,
  characterId?: string
): Promise<{ totalConnected: number; totalFailed: number }> {
  const rows = await getActivePluginMCPServers();
  let totalConnected = 0;
  let totalFailed = 0;

  // Group by plugin name for connectPluginMCPServers calls
  const byPlugin = new Map<string, { config: PluginMCPConfig; cachePath?: string }>();
  for (const row of rows) {
    if (!byPlugin.has(row.pluginName)) {
      byPlugin.set(row.pluginName, { config: {}, cachePath: row.cachePath || undefined });
    }
    byPlugin.get(row.pluginName)!.config[row.serverName] =
      row.config as unknown as PluginMCPServerEntry;
  }

  for (const [pluginName, { config, cachePath }] of byPlugin) {
    const { connected, failed } = await connectPluginMCPServers(
      pluginName,
      config,
      characterId,
      cachePath
    );
    totalConnected += connected.length;
    totalFailed += failed.length;
  }

  if (totalConnected > 0 || totalFailed > 0) {
    console.log(
      `[Plugin MCP] Loaded plugin MCP servers: ${totalConnected} connected, ${totalFailed} failed`
    );
  }

  return { totalConnected, totalFailed };
}

/**
 * Replace ${CLAUDE_PLUGIN_ROOT} in MCP server config values.
 */
function resolvePluginRoot(
  entry: PluginMCPServerEntry,
  pluginRoot: string
): PluginMCPServerEntry {
  const resolve = (value: string | undefined): string | undefined => {
    if (!value) return value;
    return value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot);
  };

  return {
    ...entry,
    command: resolve(entry.command),
    args: entry.args?.map((arg) =>
      arg.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
    ),
    url: resolve(entry.url),
    env: entry.env
      ? Object.fromEntries(
          Object.entries(entry.env).map(([k, v]) => [
            k,
            v.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot),
          ])
        )
      : undefined,
  };
}

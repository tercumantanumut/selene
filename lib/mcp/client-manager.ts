/**
 * MCP Client Manager
 * 
 * Singleton manager for MCP client connections.
 * Handles connection lifecycle, tool discovery, and execution.
 * Supports both HTTP/SSE and stdio transports.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@/lib/mcp/stdio-transport";
import type { ResolvedMCPServer, MCPDiscoveredTool, MCPServerStatus } from "./types";
import { onFolderChange } from "@/lib/vectordb/folder-events";
import { taskRegistry } from "@/lib/background-tasks/registry";
import { hasFilesystemPathArg, resolveMCPConfig } from "./mcp-config-resolver";

// Re-export resolveMCPConfig so existing callers importing from client-manager still work
export { resolveMCPConfig } from "./mcp-config-resolver";

/**
 * Lifecycle events for MCP servers — consumed by electron main to surface
 * sidecar state to the Ghost OS settings UI (spawn → handshake → crash, etc.).
 *
 * These are intentionally framework-agnostic: emit in lib/mcp, bridge to IPC
 * in electron/ipc-ghost-os-handlers.ts.
 */
export type MCPLifecycleEventType =
    | "spawned"
    | "handshake"
    | "disconnected"
    | "crashed"
    | "permission-error";

export interface MCPLifecycleEvent {
    type: MCPLifecycleEventType;
    serverName: string;
    detail?: string;
    error?: string;
    pid?: number;
    exitCode?: number | null;
    /** Epoch ms */
    timestamp: number;
}

/** Signature the screen-recording error pattern used by ghost-os tools */
export const SCREEN_PERMISSION_ERROR_RE =
    /screen\s*recording|screen\s*capture\s*permission|not\s+authorized\s+(?:to|for)\s+screen|cgdisplaycreate|kcgerror|permission\s+not\s+granted/i;


/**
 * Singleton manager for MCP client connections
 * Handles connection lifecycle, tool discovery, and execution
 */
// Use global var to persist across HMR in development
const globalForMCP = globalThis as unknown as {
    mcpClientManager: MCPClientManager | undefined;
};

class MCPClientManager {
    private clients: Map<string, Client> = new Map();
    private tools: Map<string, MCPDiscoveredTool[]> = new Map();
    private status: Map<string, MCPServerStatus> = new Map();
    private transports: Map<string, StdioClientTransport | SSEClientTransport> = new Map();
    private characterMcpServers: Map<string, string[]> = new Map(); // Track which servers belong to which character
    private serverCharacterContext: Map<string, string | undefined> = new Map(); // Track characterId used for each server connection
    /**
     * Last-known resolved config per server. Needed by `reconnect(serverName)`
     * so the UI can ask for a restart without having to re-resolve the entire
     * character's MCP config — the common case after a silent sidecar hang.
     */
    private serverConfigs: Map<string, ResolvedMCPServer> = new Map();

    /** Track servers currently being connected to prevent race conditions */
    private connectingServers: Map<string, Promise<MCPServerStatus>> = new Map();

    /** Default timeout for tool calls in milliseconds (5 minutes) */
    private readonly toolCallTimeoutMs: number = 300000;

    /** Track reload state per character */
    private reloadState: Map<string, {
        isReloading: boolean;
        startedAt: Date | null;
        totalServers: number;
        completedServers: number;
        failedServers: string[];
    }> = new Map();
    private pendingReconnects: Map<string, NodeJS.Timeout> = new Map();
    private pendingConfigSync: {
        configuredServers: Set<string>;
        timeoutId: NodeJS.Timeout;
    } | null = null;

    /**
     * Per-server lifecycle-event subscribers.
     * Used by electron main to bridge spawn/crash/handshake events to IPC.
     * Keyed by serverName; "*" subscribers receive events for every server.
     */
    private lifecycleSubscribers: Map<
        string,
        Set<(event: MCPLifecycleEvent) => void>
    > = new Map();

    private constructor() {
        // Register folder change listener for auto-reconnection
        onFolderChange(async (characterId, event) => {
            console.log(`[MCP] Folder change detected for character ${characterId}:`, event);

            // Reconnect on any change (added, removed, or primary_changed) 
            // because SYNCED_FOLDERS_ARRAY and SYNCED_FOLDERS change on any folder update.
            await this.reconnectForCharacter(characterId);
        });
    }

    static getInstance(): MCPClientManager {
        if (!globalForMCP.mcpClientManager) {
            globalForMCP.mcpClientManager = new MCPClientManager();
        }
        return globalForMCP.mcpClientManager;
    }

    /**
     * Subscribe to lifecycle events for a server (or "*" for all servers).
     * Returns an unsubscribe function.
     *
     * This is a pure in-memory event bus; no IPC or EventEmitter dependency.
     * Electron main uses it to forward ghost-os sidecar state to the settings UI.
     */
    subscribeLifecycle(
        serverName: string,
        callback: (event: MCPLifecycleEvent) => void,
    ): () => void {
        let set = this.lifecycleSubscribers.get(serverName);
        if (!set) {
            set = new Set();
            this.lifecycleSubscribers.set(serverName, set);
        }
        set.add(callback);
        return () => {
            set?.delete(callback);
            if (set && set.size === 0) {
                this.lifecycleSubscribers.delete(serverName);
            }
        };
    }

    private emitLifecycle(event: Omit<MCPLifecycleEvent, "timestamp">): void {
        const fullEvent: MCPLifecycleEvent = { ...event, timestamp: Date.now() };
        // Fan out to subscribers for this specific server
        const specific = this.lifecycleSubscribers.get(event.serverName);
        if (specific) {
            for (const cb of specific) {
                try {
                    cb(fullEvent);
                } catch (err) {
                    console.warn(`[MCP] lifecycle subscriber threw for ${event.serverName}:`, err);
                }
            }
        }
        // Fan out to wildcard subscribers
        const wildcard = this.lifecycleSubscribers.get("*");
        if (wildcard) {
            for (const cb of wildcard) {
                try {
                    cb(fullEvent);
                } catch (err) {
                    console.warn(`[MCP] wildcard lifecycle subscriber threw:`, err);
                }
            }
        }
    }

    /**
     * Connect to an MCP server and discover its tools
     */
    async connect(
        serverName: string,
        config: ResolvedMCPServer,
        characterId?: string
    ): Promise<MCPServerStatus> {
        // CRITICAL: Prevent double-spawning race condition
        // If already connecting to this server, wait for that connection to complete
        const existingConnection = this.connectingServers.get(serverName);
        if (existingConnection) {
            console.log(`[MCP] Connection to ${serverName} already in progress, waiting...`);
            return existingConnection;
        }

        // Create a promise that will be resolved when connection completes
        const connectionPromise = this._doConnect(serverName, config, characterId);
        this.connectingServers.set(serverName, connectionPromise);
        
        try {
            return await connectionPromise;
        } finally {
            this.connectingServers.delete(serverName);
        }
    }

    /**
     * Internal connection logic - called by connect() with race protection
     */
    private async _doConnect(
        serverName: string,
        config: ResolvedMCPServer,
        characterId?: string
    ): Promise<MCPServerStatus> {
        // Track character association
        if (characterId) {
            const servers = this.characterMcpServers.get(characterId) || [];
            if (!servers.includes(serverName)) {
                servers.push(serverName);
                this.characterMcpServers.set(characterId, servers);
            }
        }
        
        // Skip if already connected with same context
        if (this.isConnected(serverName)) {
            const existingContext = this.serverCharacterContext.get(serverName);
            // If connected with same character context (or both undefined), skip reconnection
            if (existingContext === characterId) {
                console.log(`[MCP] Server ${serverName} already connected with same context, skipping`);
                return this.status.get(serverName) || {
                    serverName,
                    connected: true,
                    toolCount: this.tools.get(serverName)?.length || 0,
                    tools: this.tools.get(serverName)?.map(t => t.name) || [],
                };
            }
        }
        
        // Disconnect existing connection if any
        await this.disconnect(serverName);

        // Wait a brief moment for OS to reclaim resources (ports/files)
        // This helps with servers like Linear that bind local ports
        await new Promise(resolve => setTimeout(resolve, 500));

        try {
            let transport: StdioClientTransport | SSEClientTransport;

            if (config.type === "stdio") {
                // Stdio transport - run command as subprocess
                if (!config.command) {
                    throw new Error("Stdio transport requires 'command' to be specified");
                }

                console.log(`[MCP] Starting stdio transport: ${config.command} ${config.args?.join(" ") || ""}`);

                transport = new StdioClientTransport({
                    command: config.command,
                    args: config.args || [],
                    env: config.env,
                    // Pass the logical server name so the transport can open a
                    // stable per-sidecar stderr log at
                    // ELECTRON_USER_DATA_PATH/logs/mcp/<serverName>-stderr.log
                    // instead of dropping errors into /dev/null under Electron.
                    serverName,
                });
            } else {
                // HTTP/SSE transport
                if (!config.url) {
                    throw new Error(
                        `MCP server "${serverName}" uses ${config.type || "sse"} transport but has no URL configured. ` +
                        `Add a URL to this server's configuration to connect.`
                    );
                }

                console.log(`[MCP] Connecting to SSE endpoint: ${config.url}`);

                transport = new SSEClientTransport(new URL(config.url), {
                    requestInit: {
                        headers: config.headers,
                        signal: AbortSignal.timeout(config.timeout),
                    },
                });
            }

            // Validate filesystem args if applicable
            if (config.command && (serverName === "filesystem" || serverName === "filesystem-multi")) {
                const hasValidPath = hasFilesystemPathArg(config.args);
                if (!hasValidPath) {
                    throw new Error(
                        `Filesystem MCP server requires synced folder paths. ` +
                        `Please sync a folder in Settings → Synced Folders before enabling this server.`
                    );
                }
            }

            // Create and connect client
            const client = new Client({
                name: "selene-mcp-client",
                version: "1.0.0",
            }, {
                capabilities: {},
            });

            // ------------------------------------------------------------------
            // Hook transport lifecycle BEFORE connect().
            //
            // Previously the manager never listened to `transport.onclose`, so
            // when a sidecar crashed or was killed externally its Client would
            // mark itself disconnected internally but `this.clients` still held
            // a reference. `isConnected(serverName)` returned true and the next
            // `executeTool` call would throw "Not connected" from deep inside
            // the SDK — with no way to recover short of a full app restart.
            //
            // Hooking onclose here evicts the stale entries the moment the
            // transport dies, so the UI's Reconnect button (and any future
            // auto-respawn policy) works against a clean slate.
            //
            // We attach BEFORE connect() so the handler also catches immediate
            // close events during handshake.
            // ------------------------------------------------------------------
            transport.onclose = () => {
                console.warn(`[MCP] Transport closed for ${serverName}`);
                // Only clear state if this transport is still the registered
                // one for this serverName — a rapid disconnect/reconnect cycle
                // may have already replaced it, in which case the stale close
                // event must not wipe the fresh connection.
                if (this.transports.get(serverName) === transport) {
                    this.clients.delete(serverName);
                    this.transports.delete(serverName);
                    this.tools.delete(serverName);
                    this.serverCharacterContext.delete(serverName);
                    const previousStatus = this.status.get(serverName);
                    this.status.set(serverName, {
                        serverName,
                        connected: false,
                        lastConnected: previousStatus?.lastConnected,
                        lastError: previousStatus?.lastError,
                        toolCount: 0,
                        tools: [],
                    });
                    this.emitLifecycle({ type: "disconnected", serverName });
                }
            };

            transport.onerror = (err: Error) => {
                console.error(`[MCP] Transport error for ${serverName}:`, err);
                this.emitLifecycle({
                    type: "crashed",
                    serverName,
                    error: err instanceof Error ? err.message : String(err),
                });
            };

            try {
                await client.connect(transport);

                // Emit "spawned" — process is running and initialize handshake succeeded.
                // For stdio, pid is available after transport.start(); SSE has no pid.
                const spawnedPid =
                    transport instanceof StdioClientTransport
                        ? (transport.pid ?? undefined)
                        : undefined;
                this.emitLifecycle({
                    type: "spawned",
                    serverName,
                    pid: spawnedPid ?? undefined,
                    detail: config.type === "stdio"
                        ? `${config.command ?? ""} ${(config.args ?? []).join(" ")}`.trim()
                        : config.url,
                });
            } catch (error: any) {
                // Emit "crashed" — spawn or initialize failed.
                this.emitLifecycle({
                    type: "crashed",
                    serverName,
                    error: error instanceof Error ? error.message : String(error),
                });

                // Check for ENOENT specifically (command not found)
                if (error?.code === "ENOENT" || error?.message?.includes("ENOENT")) {
                    const command = config.command || "npx";
                    throw new Error(
                        `Failed to start MCP server "${serverName}": Could not find "${command}". ` +
                        `This usually means Node.js is not installed or not in the system PATH. ` +
                        `\n\nTo fix this:\n` +
                        `1. Install Node.js from https://nodejs.org\n` +
                        `2. If using nvm/volta, ensure it's properly configured\n` +
                        `3. Restart Selene after installation\n` +
                        `\nOriginal error: ${error.message}`
                    );
                }

                // MCP -32000 "Connection closed" — process started but died before handshake
                if (error?.code === -32000 || error?.message?.includes("Connection closed")) {
                    throw new Error(
                        `MCP server "${serverName}" connection closed unexpectedly. ` +
                        `The server process started but exited before completing initialization.\n\n` +
                        `Common causes:\n` +
                        `- The bundled Node.js binary could not run (check macOS Gatekeeper)\n` +
                        `- The MCP package failed to install (network/proxy issue)\n` +
                        `- The MCP server crashed during startup\n` +
                        `\nOriginal error: ${error.message}`
                    );
                }

                throw error;
            }

            // Discover tools
            const toolsResponse = await client.listTools();
            const discoveredTools: MCPDiscoveredTool[] = toolsResponse.tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema as Record<string, unknown>,
                serverName,
            }));

            // Emit "handshake" — tools/list succeeded. This is the first signal that
            // end-to-end JSON-RPC works over the stdio pipes.
            this.emitLifecycle({
                type: "handshake",
                serverName,
                detail: `${discoveredTools.length} tools`,
            });

            // Store client, transport, tools, and context
            this.clients.set(serverName, client);
            this.transports.set(serverName, transport);
            this.tools.set(serverName, discoveredTools);
            this.serverCharacterContext.set(serverName, characterId);
            // Remember the resolved config so `reconnect(serverName)` can
            // re-spawn this server without re-resolving the whole character
            // config (the UI's Reconnect button calls us with just a name).
            this.serverConfigs.set(serverName, config);

            const status: MCPServerStatus = {
                serverName,
                connected: true,
                lastConnected: new Date(),
                toolCount: discoveredTools.length,
                tools: discoveredTools.map(t => t.name),
            };
            this.status.set(serverName, status);

            console.log(`[MCP] Connected to ${serverName}: ${discoveredTools.length} tools discovered`);
            console.log(`[MCP] Tools: ${discoveredTools.map(t => t.name).join(", ")}`);
            return status;

        } catch (error) {
            const status: MCPServerStatus = {
                serverName,
                connected: false,
                lastError: error instanceof Error ? error.message : String(error),
                toolCount: 0,
                tools: [],
            };
            this.status.set(serverName, status);
            console.error(`[MCP] Failed to connect to ${serverName}:`, error);
            return status;
        }
    }

    /**
     * Disconnect from an MCP server
     */
    async disconnect(serverName: string): Promise<void> {
        const client = this.clients.get(serverName);
        const transport = this.transports.get(serverName);
        const wasConnected = !!(client || transport);

        // Detach the lifecycle handlers BEFORE we trigger close() — otherwise
        // `transport.onclose` (registered in connect()) would fire as a side
        // effect of our own teardown and emit a second `disconnected` event,
        // duplicating the one this method emits at the bottom. We only want
        // onclose to fire for *unsolicited* transport deaths (sidecar crash,
        // OS killed the process, etc.).
        if (transport) {
            transport.onclose = undefined;
            transport.onerror = undefined;
        }

        if (client) {
            try {
                await client.close();
            } catch (error) {
                console.warn(`[MCP] Error closing client for ${serverName}:`, error);
            }
            this.clients.delete(serverName);
        }

        if (transport) {
            try {
                await transport.close();
            } catch (error) {
                console.warn(`[MCP] Error closing transport for ${serverName}:`, error);
            }
            this.transports.delete(serverName);
        }

        this.serverCharacterContext.delete(serverName);
        this.tools.delete(serverName);
        this.status.delete(serverName);
        this.serverConfigs.delete(serverName);

        if (wasConnected) {
            this.emitLifecycle({ type: "disconnected", serverName });
        }

        // Clean up character tracking
        for (const [characterId, servers] of this.characterMcpServers.entries()) {
            const index = servers.indexOf(serverName);
            if (index > -1) {
                servers.splice(index, 1);
                if (servers.length === 0) {
                    this.characterMcpServers.delete(characterId);
                }
            }
        }
    }

    /**
     * Reconnect a single MCP server — the recovery path for a hung or
     * crashed sidecar. Uses the last-known resolved config stored during
     * {@link connect}; does NOT re-resolve the character's MCP config
     * (which would require a settings/characters lookup the UI doesn't
     * have easy access to).
     *
     * Returns null if we have no remembered config for this server — in
     * that case the caller must fall back to a full `connect()` with a
     * freshly resolved config (for example, via `loadMCPToolsForCharacter`).
     */
    async reconnect(serverName: string): Promise<MCPServerStatus | null> {
        const config = this.serverConfigs.get(serverName);
        if (!config) {
            console.warn(
                `[MCP] reconnect(${serverName}) called but no remembered config — ` +
                `the server may have never been connected in this session.`
            );
            return null;
        }
        const characterId = this.serverCharacterContext.get(serverName);
        console.log(`[MCP] Reconnecting ${serverName} (characterId=${characterId ?? "none"})`);

        // Full disconnect so we start from a clean slate — this is the whole
        // point of the UI button: the client may be registered but wedged.
        await this.disconnect(serverName);

        // `disconnect` clears `serverConfigs`. Restore before `connect()` runs
        // so a rapid second call (double-click on the button) can still find
        // the config. `connect()` will overwrite it on success anyway.
        this.serverConfigs.set(serverName, config);

        return this.connect(serverName, config, characterId);
    }

    /**
     * Reconnect all MCP servers for a specific character
     */
    private async reconnectForCharacter(characterId: string): Promise<void> {
        const serverNames = this.characterMcpServers.get(characterId) || [];

        if (serverNames.length === 0) {
            console.log(`[MCP] No servers to reconnect for character ${characterId}`);
            return;
        }

        if (this.hasActiveScheduledTasks(characterId)) {
            this.deferReconnect(characterId);
            return;
        }

        // Initialize reload state
        this.reloadState.set(characterId, {
            isReloading: true,
            startedAt: new Date(),
            totalServers: serverNames.length,
            completedServers: 0,
            failedServers: [],
        });

        // Emit reload started event
        const { notifyFolderChange } = await import("@/lib/vectordb/folder-events");
        notifyFolderChange(characterId, {
            type: "mcp_reload_started",
            folderId: "", // Not folder-specific
            totalServers: serverNames.length,
            estimatedDuration: serverNames.length * 5000, // 5s per server estimate
        });

        console.log(`[MCP] Reconnecting ${serverNames.length} servers for character ${characterId} due to folder change...`);

        // Dynamic imports to avoid circular dependencies
        const { loadSettings } = await import("@/lib/settings/settings-manager");
        const { getCharacter } = await import("@/lib/characters");

        const settings = loadSettings();
        const character = await getCharacter(characterId);

        if (!character) {
            console.warn(`[MCP] Character ${characterId} not found for reconnection`);
            return;
        }

        const metadata = character.metadata as any;
        const globalConfig = settings.mcpServers?.mcpServers || {};
        const agentConfig = metadata?.mcpServers?.mcpServers || {};
        const combinedConfig = { ...globalConfig, ...agentConfig };
        const env = settings.mcpEnvironment || {};

        for (const serverName of serverNames) {
            try {
                // Disconnect existing
                await this.disconnect(serverName);

                // Reconnect with updated config
                const config = combinedConfig[serverName];
                if (config) {
                    const resolved = await resolveMCPConfig(serverName, config, env, characterId);
                    await this.connect(serverName, resolved, characterId);
                    console.log(`[MCP] Successfully reconnected ${serverName} for ${characterId}`);

                    // Update progress
                    const state = this.reloadState.get(characterId);
                    if (state) {
                        state.completedServers++;

                        // Emit progress update
                        notifyFolderChange(characterId, {
                            type: "mcp_reload_started", // Use same type for progress updates
                            folderId: "",
                            serverName,
                            totalServers: state.totalServers,
                            completedServers: state.completedServers,
                        });
                    }
                }
            } catch (error) {
                console.error(`[MCP] Failed to reconnect ${serverName}:`, error);

                // Track failed servers
                const state = this.reloadState.get(characterId);
                if (state) {
                    state.failedServers.push(serverName);
                    state.completedServers++; // Count as completed (failed)
                }
            }
        }

        // Mark reload as complete
        const state = this.reloadState.get(characterId);
        if (state) {
            state.isReloading = false;

            notifyFolderChange(characterId, {
                type: state.failedServers.length > 0 ? "mcp_reload_failed" : "mcp_reload_completed",
                folderId: "",
                totalServers: state.totalServers,
                completedServers: state.completedServers,
                error: state.failedServers.length > 0
                    ? `Failed to reload: ${state.failedServers.join(", ")}`
                    : undefined,
            });
        }
    }

    /**
     * Sync connections with config with scheduled-task safety.
     * Defers disconnects while scheduled tasks are running.
     */
    async syncWithConfigSafely(configuredServers: Set<string>): Promise<{
        disconnectedServers: string[];
        deferred: boolean;
    }> {
        if (this.hasActiveScheduledTasks()) {
            this.deferConfigSync(configuredServers);
            return { disconnectedServers: [], deferred: true };
        }

        if (this.pendingConfigSync) {
            clearTimeout(this.pendingConfigSync.timeoutId);
            this.pendingConfigSync = null;
        }

        const disconnectedServers = await this.syncWithConfig(configuredServers);
        return { disconnectedServers, deferred: false };
    }

    /**
     * Execute a tool on an MCP server with timeout protection
     */
    async executeTool(
        serverName: string,
        toolName: string,
        args: Record<string, unknown>
    ): Promise<unknown> {
        const client = this.clients.get(serverName);
        if (!client) {
            throw new Error(`MCP server "${serverName}" is not connected`);
        }

        console.log(`[MCP] Executing ${serverName}:${toolName} with args:`, args);

        // Create timeout promise with cleanup
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(
                    `MCP tool call timed out after ${this.toolCallTimeoutMs}ms: ${serverName}:${toolName}`
                ));
            }, this.toolCallTimeoutMs);
        });

        try {
            const result = await Promise.race([
                client.callTool({
                    name: toolName,
                    arguments: args,
                }),
                timeoutPromise,
            ]);

            // MCP servers may return errors inside a structured tool result
            // (e.g. { isError: true, content: [{ text: "...screen recording..." }] })
            // rather than throwing. Probe the result for screen-permission signals so
            // the Ghost OS wizard can surface a clear "stale permission" remediation
            // even when the tool call technically "succeeded" at the JSON-RPC layer.
            try {
                const resultObj = result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
                if (resultObj?.isError && Array.isArray(resultObj.content)) {
                    const text = resultObj.content.map((c) => c?.text ?? "").join("\n");
                    if (text && SCREEN_PERMISSION_ERROR_RE.test(text)) {
                        this.emitLifecycle({
                            type: "permission-error",
                            serverName,
                            error: text.trim().slice(0, 500),
                            detail: toolName,
                        });
                    }
                }
            } catch {
                // Non-fatal — permission probing must never break a successful call.
            }

            return result;
        } catch (error) {
            // Detect screen-recording errors thrown from the tool call itself.
            const message = error instanceof Error ? error.message : String(error);
            if (SCREEN_PERMISSION_ERROR_RE.test(message)) {
                this.emitLifecycle({
                    type: "permission-error",
                    serverName,
                    error: message.slice(0, 500),
                    detail: toolName,
                });
            }
            throw error;
        } finally {
            // Clear timeout to prevent timer leaks
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
        }
    }

    /**
     * Get all discovered tools from connected servers
     */
    getAllTools(): MCPDiscoveredTool[] {
        const allTools: MCPDiscoveredTool[] = [];
        for (const tools of this.tools.values()) {
            allTools.push(...tools);
        }
        return allTools;
    }

    /**
     * Get tools from a specific server
     */
    getServerTools(serverName: string): MCPDiscoveredTool[] {
        return this.tools.get(serverName) || [];
    }

    /**
     * Get status of all servers
     */
    getAllStatus(): MCPServerStatus[] {
        return Array.from(this.status.values());
    }

    /**
     * Check if a server is connected
     */
    isConnected(serverName: string): boolean {
        return this.clients.has(serverName);
    }

    /**
     * Get all connected server names
     */
    getConnectedServers(): string[] {
        return Array.from(this.clients.keys());
    }

    /**
     * Get the character ID a server was connected for
     */
    getConnectedCharacterId(serverName: string): string | undefined {
        return this.serverCharacterContext.get(serverName);
    }

    /**
     * Get current reload status for a character
     */
    getReloadStatus(characterId: string): {
        isReloading: boolean;
        progress: number; // 0-100
        estimatedTimeRemaining: number; // milliseconds
        failedServers: string[];
        totalServers: number;
        completedServers: number;
    } {
        const state = this.reloadState.get(characterId);
        if (!state || !state.isReloading) {
            return {
                isReloading: false,
                progress: 100,
                estimatedTimeRemaining: 0,
                failedServers: [],
                totalServers: 0,
                completedServers: 0,
            };
        }

        const progress = state.totalServers > 0
            ? (state.completedServers / state.totalServers) * 100
            : 0;

        const elapsed = Date.now() - (state.startedAt?.getTime() || 0);
        const avgTimePerServer = state.completedServers > 0
            ? elapsed / state.completedServers
            : 5000; // Default 5s per server

        const remaining = (state.totalServers - state.completedServers) * avgTimePerServer;

        return {
            isReloading: true,
            progress: Math.min(progress, 100),
            estimatedTimeRemaining: Math.max(remaining, 0),
            failedServers: state.failedServers,
            totalServers: state.totalServers,
            completedServers: state.completedServers,
        };
    }

    /**
     * Check if ANY character is currently reloading (for global indicator)
     */
    isAnyReloading(): boolean {
        for (const state of this.reloadState.values()) {
            if (state.isReloading) return true;
        }
        return false;
    }

    /**
     * Disconnect all MCP servers and clear all cached tools/status
     */
    async disconnectAll(): Promise<void> {
        const serverNames = this.getConnectedServers();
        console.log(`[MCP] Disconnecting all ${serverNames.length} servers`);

        for (const serverName of serverNames) {
            await this.disconnect(serverName);
        }

        // Clear any remaining state (in case disconnect didn't clean everything)
        this.clients.clear();
        this.tools.clear();
        this.status.clear();
        this.transports.clear();
        this.serverConfigs.clear();

        console.log("[MCP] All servers disconnected and state cleared");
    }

    /**
     * Sync connections with config - disconnect servers not in the provided config
     * and clear their tools
     *
     * @param configuredServers - Set of server names that should remain connected
     * @returns Names of servers that were disconnected
     */
    async syncWithConfig(configuredServers: Set<string>): Promise<string[]> {
        const disconnectedServers: string[] = [];
        const connectedServers = this.getConnectedServers();

        for (const serverName of connectedServers) {
            if (!configuredServers.has(serverName)) {
                console.log(`[MCP] Server "${serverName}" is no longer in config, disconnecting`);
                await this.disconnect(serverName);
                disconnectedServers.push(serverName);
            }
        }

        if (disconnectedServers.length > 0) {
            console.log(`[MCP] Disconnected ${disconnectedServers.length} servers no longer in config: ${disconnectedServers.join(", ")}`);
        }

        return disconnectedServers;
    }

    private hasActiveScheduledTasks(characterId?: string): boolean {
        const { tasks } = taskRegistry.list({
            type: "scheduled",
            ...(characterId ? { characterId } : {}),
        });
        return tasks.some((task) => task.status === "running");
    }

    private deferReconnect(characterId: string): void {
        if (this.pendingReconnects.has(characterId)) {
            return;
        }
        console.log(`[MCP] Deferring reconnect for character ${characterId} until scheduled tasks complete`);
        const timeoutId = setTimeout(() => {
            this.pendingReconnects.delete(characterId);
            this.reconnectForCharacter(characterId).catch((error) => {
                console.error(`[MCP] Deferred reconnect failed for ${characterId}:`, error);
            });
        }, 60_000);
        this.pendingReconnects.set(characterId, timeoutId);
    }

    private deferConfigSync(configuredServers: Set<string>): void {
        if (this.pendingConfigSync) {
            clearTimeout(this.pendingConfigSync.timeoutId);
        }

        console.log("[MCP] Deferring config sync until scheduled tasks complete");
        const timeoutId = setTimeout(() => {
            const pending = this.pendingConfigSync;
            this.pendingConfigSync = null;
            if (!pending) return;
            this.syncWithConfigSafely(pending.configuredServers).catch((error) => {
                console.error("[MCP] Deferred config sync failed:", error);
            });
        }, 60_000);

        this.pendingConfigSync = { configuredServers, timeoutId };
    }
}

export { MCPClientManager };

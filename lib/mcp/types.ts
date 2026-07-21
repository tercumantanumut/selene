/**
 * MCP (Model Context Protocol) Type Definitions
 * 
 * Defines types for MCP server configuration, tool discovery, and status tracking.
 */

/**
 * MCP Server configuration as provided by user
 * Supports HTTP/SSE URL-based transport OR stdio subprocess transport
 */
export interface MCPServerConfig {
    /** Transport type - "http" is Streamable HTTP, "sse" is legacy SSE, "stdio" is inferred if command is present */
    type?: "http" | "sse" | "stdio";

    /** Server URL (for http/sse transport, can include ${VARIABLE} placeholders) */
    url?: string;

    /** Command to run (for stdio transport) */
    command?: string;

    /** Command arguments (for stdio transport) */
    args?: string[];

    /** Environment variables for subprocess (for stdio transport) */
    env?: Record<string, string>;

    /** Optional headers (for http/sse, can include ${VARIABLE} placeholders) */
    headers?: Record<string, string>;

    /** Authentication mode for URL-based transports. OAuth uses browser sign-in and local callback handling. */
    auth?: {
        type?: "none" | "headers" | "oauth";
    };

    /** Optional timeout in milliseconds */
    timeout?: number;

    /**
     * Whether this server is enabled.
     * Disabled servers retain their configuration but are not connected.
     * @default true (undefined treated as enabled for backward compatibility)
     */
    enabled?: boolean;
}

/**
 * Full MCP configuration object (matches user's JSON format)
 */
export interface MCPConfig {
    mcpServers: Record<string, MCPServerConfig>;
}

/**
 * Resolved MCP server configuration (ready for connection)
 */
export interface ResolvedMCPServer {
    name: string;
    type: "http" | "sse" | "stdio";

    // For HTTP/SSE transport
    url?: string;
    headers?: Record<string, string>;
    auth?: MCPServerConfig["auth"];
    oauthRedirectUrl?: string;

    // For stdio transport
    command?: string;
    args?: string[];
    env?: Record<string, string>;

    timeout: number;
}

/**
 * MCP tool as discovered from server
 */
export interface MCPDiscoveredTool {
    /** Tool name from MCP server */
    name: string;

    /** Tool description from MCP server */
    description?: string;

    /** JSON Schema for input parameters */
    inputSchema: Record<string, unknown>;

    /** Which MCP server this tool belongs to */
    serverName: string;
}

/**
 * MCP server connection status
 */
export interface MCPServerStatus {
    serverName: string;
    connected: boolean;
    lastConnected?: Date;
    lastError?: string;
    /** UI-facing state that distinguishes auth-required failures from transport failures. */
    connectionState?: "unauthenticated" | "authorization_required" | "authorizing" | "connected" | "expired" | "failed" | "not_connected";
    authRequired?: boolean;
    authorizationUrl?: string;
    serverUrl?: string;
    transportType?: "http" | "sse" | "stdio";
    errorStatus?: number | string;
    details?: string;
    recovery?: string;
    toolCount: number;
    tools: string[];
}

/**
 * MCP tool for UI consumption
 */
export interface MCPTool {
    id: string;
    name: string;
    description?: string;
    serverName: string;
    inputSchema: Record<string, unknown>;
}

/**
 * Per-request MCP context store.
 *
 * AsyncLocalStorage propagates through async call trees, so setting a value
 * before the model call makes it available deep inside the tool executors
 * and the MCP server bridge without threading it through every intermediate
 * function signature.
 */

import { AsyncLocalStorage } from "async_hooks";
import type { LivePromptEntry } from "@/lib/background-tasks/live-prompt-queue-registry";

/**
 * Per-request context used to build the Selene platform MCP server that
 * exposes ToolRegistry tools and per-agent MCP tools to in-process callers.
 */
export interface SeleneMcpContext {
  /** Authenticated user ID */
  userId: string;
  /** Current chat session ID */
  sessionId: string;
  /** Current agent run ID (used for live prompt injection). */
  runId?: string;
  /** Active character / agent ID (null for the default assistant) */
  characterId: string | null;
  /**
   * Tool names that are explicitly enabled for this agent.
   * When set, only these tools (plus alwaysLoad utility tools) are exposed.
   * When undefined, all environment-enabled tools are exposed.
   */
  enabledTools?: string[];
  /** Agent working directory (primary sync folder path) */
  cwd?: string;
  /** Filesystem paths to cached Selene plugins (for in-process plugin loading) */
  pluginPaths?: string[];
  /** Hook execution context for routing plugin hooks during tool calls */
  hookContext?: {
    allowedPluginNames: Set<string>;
    pluginRoots: Map<string, string>;
  };

  // ── Tool loading and isolation ─────────────────────────────────────────────

  /**
   * Tool loading mode — mirrors the app-level setting.
   * When "deferred", non-alwaysLoad tools require searchTools discovery first.
   * When "always", all enabled tools are active immediately.
   */
  toolLoadingMode?: "deferred" | "always";

  /**
   * Tool names previously discovered via searchTools in earlier turns.
   * Seeds the activated-tools set so discoveries from prior requests persist.
   */
  previouslyDiscoveredTools?: string[];

  /**
   * MCP server names enabled for this agent (from character metadata).
   * Scopes MCPClientManager tool exposure to only this agent's servers.
   * When undefined + no enabledMcpTools, all connected servers are accessible.
   */
  enabledMcpServers?: string[];

  /**
   * Specific MCP tool IDs (format: "serverName:toolName") enabled for this agent.
   * Takes precedence over enabledMcpServers when set.
   */
  enabledMcpTools?: string[];

  /**
   * MCP tool IDs (in getMCPToolId format, e.g. "mcp_server_tool") that are
   * alwaysLoad (active immediately without searchTools). Populated from
   * mcpToolPreferences in character metadata.
   */
  alwaysLoadMcpToolIds?: string[];

  /**
   * Callback fired when an MCP tool produces rich output (image URL, video URL, etc.).
   * Route.ts wires this into the Selene streaming state so image/video chips
   * appear in the UI.
   */
  onRichOutput?: (toolCallId: string, toolName: string, output: unknown) => void;

  /**
   * Callback fired when executeCommand emits incremental stdout/stderr while running.
   */
  onExecuteCommandProgress?: (update: import("@/lib/command-execution/types").ExecuteCommandProgressUpdate) => void;

  /**
   * Callback fired before queued live-prompt entries are injected into an
   * active run so the chat route can split/persist messages.
   */
  onQueueMessages?: (entries: LivePromptEntry[]) => Promise<void>;
}

export const mcpContextStore = new AsyncLocalStorage<SeleneMcpContext>();

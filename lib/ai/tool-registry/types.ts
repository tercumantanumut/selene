/**
 * Tool Registry Type Definitions
 *
 * Based on Anthropic's Advanced Tool Use patterns (Nov 2025):
 * - Tool Search Tool: On-demand tool discovery with deferred loading
 * - Tool categorization for better searchability
 * - Metadata for tool management
 */

import type { Tool } from "ai";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool category for grouping and search
 */
export type ToolCategory =
  | "image-generation"
  | "image-editing"
  | "video-generation"
  | "analysis"
  | "knowledge"
  | "utility"
  | "search"
  | "scheduling"
  | "mcp"
  | "custom-comfyui"
  | "browser"
  | "computer-use";

/**
 * Configuration for when a tool should be loaded
 */
export type ToolDefaultLoadingPolicy = "required" | "always" | "deferred";
export type ToolLoadingPreference = "always" | "deferred";
export type EffectiveToolLoadingPolicy = "required" | "always" | "deferred" | "disabled";

export type ResolvedToolLoadingPolicy = {
  policy: EffectiveToolLoadingPolicy;
  initiallyActive: boolean;
  discoverable: boolean;
  authorized: boolean;
  reason:
    | "required"
    | "agent-override"
    | "legacy-mcp-preference"
    | "system-default"
    | "tool-default"
    | "runtime-include"
    | "not-enabled"
    | "unavailable";
};

export type ToolLoadPlan = {
  allAuthorizedTools: Record<string, Tool>;
  initialActiveToolIds: Set<string>;
  deferredToolIds: Set<string>;
  disabledToolIds: Set<string>;
  resolutions: Map<string, ResolvedToolLoadingPolicy>;
};

export interface ToolLoadingConfig {
  /**
   * Legacy flag: if true, this tool is excluded from the initial context and only
   * loaded when discovered via the tool search tool.
   * Default: false (always loaded)
   */
  deferLoading?: boolean;

  /**
   * Legacy flag: if true, this tool is included in the initial context.
   * Required/bootstrap behavior is now represented by defaultPolicy="required"
   * and/or mandatory=true.
   * Default: false
   */
  alwaysLoad?: boolean;

  /** Canonical default loading behavior when an agent has no override. */
  defaultPolicy?: ToolDefaultLoadingPolicy;

  /** Required/bootstrap tools cannot be deferred or disabled by agent settings. */
  mandatory?: boolean;

  /** Tools that must be activated with this tool for protocol/recovery safety. */
  companions?: string[];
}

/**
 * Metadata for a registered tool
 */
export interface ToolMetadata {
  /** Human-readable display name */
  displayName: string;

  /** Tool category for grouping */
  category: ToolCategory;

  /** Keywords for search matching */
  keywords: string[];

  /** Brief description for search results (max 100 chars) */
  shortDescription: string;

  /**
   * High-signal capability phrase used by searchTools ranking.
   * Example: "search the web" or "edit files in the codebase".
   */
  searchHint?: string;

  /**
   * Full usage instructions returned by searchTools.
   * Contains detailed parameter docs, usage examples, and guidelines.
   * This replaces verbose tool descriptions and system prompt instructions.
   */
  fullInstructions?: string;

  /** Loading configuration */
  loading: ToolLoadingConfig;

  /** Whether this tool requires a session ID */
  requiresSession: boolean;

  /** Environment variable that enables/disables this tool */
  enableEnvVar?: string;

  /**
   * If true, tool results are shown in UI but excluded from AI conversation history.
   * Used to save tokens for large outputs like browser snapshots that the AI has
   * already processed in the current turn.
   */
  ephemeralResults?: boolean;

  /**
   * Optional MCP annotations forwarded when this tool is exposed through the
   * Claude Agent SDK bridge.
   */
  mcpAnnotations?: ToolAnnotations;
}

/**
 * Options passed to tool factory functions
 */
interface ToolFactoryOptions {
  /** Session ID for database tracking */
  sessionId?: string;

  /** User ID for authorization and ownership */
  userId?: string;

  /** Character ID for agent-specific context */
  characterId?: string;

  /** Character avatar URL for character-aware tools */
  characterAvatarUrl?: string;

  /** Character appearance description */
  characterAppearanceDescription?: string;

  /** Live executeCommand progress hook forwarded by request-scoped runtimes. */
  onExecuteCommandProgress?: import("@/lib/command-execution/types").ExecuteCommandProgressUpdate extends infer T
    ? (update: T) => void
    : never;

  /** LLM provider name — forwarded to tools that need execution-strategy awareness. */
  provider?: string;
}

/**
 * Factory function type for creating tools
 */
export type ToolFactory = (options: ToolFactoryOptions) => Tool;

/**
 * A registered tool definition
 */
export interface RegisteredTool {
  /** Unique tool name/identifier */
  name: string;

  /** Tool metadata for search and management */
  metadata: ToolMetadata;

  /** Factory function to create the tool instance */
  factory: ToolFactory;
}

/**
 * Context for tool instantiation
 */
export interface ToolContext {
  /** Current session ID */
  sessionId: string;

  /** User ID for authorization */
  userId?: string;

  /** Character ID for agent-specific context */
  characterId?: string;

  /** Character context (optional) */
  characterAvatarUrl?: string;
  characterAppearanceDescription?: string;

  /** Live executeCommand progress hook forwarded by request-scoped runtimes. */
  onExecuteCommandProgress?: (update: import("@/lib/command-execution/types").ExecuteCommandProgressUpdate) => void;

  /** Which tools to include (overrides deferred loading) */
  includeTools?: string[];

  /** Whether to include deferred tools */
  includeDeferredTools?: boolean;

  /**
   * Agent-specific enabled tools filter.
   * If provided, ONLY tools in this set (plus required/bootstrap tools and
   * safety companions) are authorized. Loading policy controls only whether
   * authorized tools are initially active or deferred.
   */
  agentEnabledTools?: Set<string>;

  /** Per-agent initial-loading preferences for authorized tools. */
  toolLoadingPreferences?: Record<string, ToolLoadingPreference>;

  /** System-level default loading mode for tools without an agent override. */
  toolLoadingMode?: "deferred" | "always";

  /** LLM provider name — used by delegation tools to decide execution strategy. */
  provider?: string;
}

/**
 * Search result from the tool search tool
 */
export interface ToolSearchResult {
  /** Tool name */
  name: string;

  /** Display name */
  displayName: string;

  /** Category */
  category: ToolCategory;

  /** Short description */
  description: string;

  /** Match score (0-1) */
  relevance: number;

  /** Full usage instructions (detailed parameters, examples, guidelines) */
  fullInstructions?: string;
}

// ToolSearchContext is now defined in search-tool.ts and re-exported from index.ts


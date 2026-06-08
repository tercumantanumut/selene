/**
 * Settings-Aware Tool Resolver for Agent Templates
 *
 * Dynamically resolves which tools should be enabled for an agent template
 * based on user settings, API keys, and feature flags. This replaces the
 * static hardcoded tool lists that would include tools users can't use.
 *
 * @module resolve-tools
 */

import type { AppSettings } from "@/lib/settings/settings-manager";

/** Result of tool resolution — includes enabled tools and any warnings */
export interface ToolResolutionResult {
  /** Tool IDs that should be enabled */
  enabledTools: string[];
  /** Warnings about tools that were excluded due to missing prerequisites */
  warnings: ToolWarning[];
}

export interface ToolWarning {
  toolId: string;
  toolName: string;
  reason: string;
  /** Settings key(s) that need to be configured */
  settingsKeys: string[];
  /** Human-readable action to fix */
  action: string;
}

// ============================================================================
// TOOL CATEGORIES
// ============================================================================

/** Core tools that are ALWAYS enabled — no prerequisites */
export const ALWAYS_ENABLED_TOOLS = [
  "localGrep",
  "readFile",
  "editFile",
  "writeFile",
  "executeCommand",
] as const;

/** Utility tools that are ALWAYS enabled — no external dependencies */
export const UTILITY_TOOLS = [
  "compactSession",
  "memorize",
  "skill",
  "updatePlan",
  "delegateToSubagent",
] as const;

/**
 * Static default tools for new agents.
 *
 * Includes always-on core + utility tools plus unified webSearch.
 */
export const DEFAULT_ENABLED_TOOLS: string[] = [
  ...ALWAYS_ENABLED_TOOLS,
  ...UTILITY_TOOLS,
  "webSearch",
  "chromiumWorkspace",
];

/** Tools that are EXCLUDED from the Selene template by design */
const EXCLUDED_TOOLS = [
  "describeImage", // Not essential for default template; can be added manually
  "patchFile",     // Redundant with editFile for most use cases
] as const;

// ============================================================================
// RESOLVER
// ============================================================================

/**
 * Resolve which tools should be enabled for the Selene default template
 * based on the current user settings.
 *
 * This function is called at agent creation time (not at template definition time)
 * so it can check the actual state of API keys, feature flags, etc.
 *
 * @param settings - Current application settings
 * @returns Resolved tool list and any warnings about excluded tools
 */
export function resolveSeleneTemplateTools(settings: AppSettings): ToolResolutionResult {
  const enabledTools: string[] = [];
  const warnings: ToolWarning[] = [];

  // 1. Always-enabled core tools
  enabledTools.push(...ALWAYS_ENABLED_TOOLS);

  // 2. Always-enabled utility tools
  enabledTools.push(...UTILITY_TOOLS);

  // 3. Conditional: Vector Search
  if (settings.vectorDBEnabled === true) {
    enabledTools.push("vectorSearch");
    console.log("[SeleneTemplate] Vector Search enabled: vectorDBEnabled=true");
  } else {
    warnings.push({
      toolId: "vectorSearch",
      toolName: "Vector Search",
      reason: "Vector Database is disabled in settings",
      settingsKeys: ["vectorDBEnabled"],
      action: "Enable Vector Database in Settings → Vector Search to use semantic code search",
    });
    console.log("[SeleneTemplate] Vector Search disabled: vectorDBEnabled is not true");
  }

  // 4. Unified Web tool (always enabled)
  enabledTools.push("webSearch");
  const hasTavilyKey = typeof settings.tavilyApiKey === "string" && settings.tavilyApiKey.trim().length > 0;
  const webSearchProvider = settings.webSearchProvider || "auto";
  if (hasTavilyKey) {
    console.log("[SeleneTemplate] Web enabled: Tavily configured (provider: " + webSearchProvider + ")");
  } else {
    console.log("[SeleneTemplate] Web enabled: DuckDuckGo/local fallback active (provider: " + webSearchProvider + ")");
  }

  // 5. Chromium Workspace (always enabled — embedded browser, no external deps)
  enabledTools.push("chromiumWorkspace");
  console.log("[SeleneTemplate] Chromium Workspace enabled: embedded browser automation");

  // 5b. Ghost OS (macOS only — desktop automation via accessibility tree)
  // Only pre-enable on macOS where Ghost OS can actually run.
  // Binary detection is async but template resolution is sync, so we check platform
  // as a sync gate. The actual MCP connection happens at chat time via config resolution
  // which will validate the binary exists.
  if (process.platform === "darwin") {
    enabledTools.push("ghostOs");
    console.log("[SeleneTemplate] Ghost OS pre-enabled: macOS desktop automation (MCP auto-detected at chat time)");
  } else {
    console.log("[SeleneTemplate] Ghost OS skipped: not on macOS");
  }

  // 6. Conditional: Workspace (only when dev mode is enabled)
  if (settings.devWorkspaceEnabled === true) {
    enabledTools.push("workspace");
    console.log("[SeleneTemplate] Workspace enabled: devWorkspaceEnabled=true");
  } else {
    warnings.push({
      toolId: "workspace",
      toolName: "Workspace",
      reason: "Dev Workspace is disabled in settings",
      settingsKeys: ["devWorkspaceEnabled"],
      action: "Enable Dev Workspace in Settings to use git worktree integration",
    });
    console.log("[SeleneTemplate] Workspace disabled: devWorkspaceEnabled is not true");
  }

  // 7. Log excluded tools
  for (const toolId of EXCLUDED_TOOLS) {
    console.log(`[SeleneTemplate] ${toolId} excluded by design (not in Selene default template)`);
  }

  return { enabledTools, warnings };
}

/**
 * Get the list of tools that are always excluded from the Selene template.
 * Useful for UI to show which tools were intentionally removed.
 */
export function getExcludedSeleneTools(): readonly string[] {
  return EXCLUDED_TOOLS;
}

/**
 * Check if a specific tool would be enabled given the current settings.
 * Useful for UI to show tool availability before agent creation.
 */
export function isToolAvailableForSelene(toolId: string, settings: AppSettings): boolean {
  const result = resolveSeleneTemplateTools(settings);
  return result.enabledTools.includes(toolId);
}

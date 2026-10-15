/**
 * Tool Search Tool
 *
 * Keeps the deferred-loading flow simple:
 * - exact selection via `select:ToolA,ToolB`
 * - required terms via `+term`
 * - plain keyword matching backed by ToolRegistry scoring
 */

import { tool, jsonSchema } from "ai";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { ToolRegistry } from "./registry";
import type { ResolvedToolLoadingPolicy, ToolSearchResult, ToolCategory } from "./types";
import { isPolicyDeferred, isRequiredTool } from "./loading-policy";
import {
  parseSubagentDirectory,
  searchSubagents,
  type SubagentSearchResult,
} from "./search-tool-subagent-types";

const TOOL_SEARCH_LOGGING_ENABLED =
  process.env.TOOL_SEARCH_LOGGING === "true" || process.env.TOOL_SEARCH_LOGGING === "1";

function logSearchTools(message: string): void {
  if (!TOOL_SEARCH_LOGGING_ENABLED) return;
  console.log(message);
}

/**
 * Context for search/list tools to know which tools are actually available
 * in the current session (not just registered in the global registry).
 */
export interface ToolSearchContext {
  /** Set of tool names that are initially active (non-deferred tools). */
  initialActiveTools?: Set<string>;

  /** Mutable set of tool names discovered during this request/session. */
  discoveredTools?: Set<string>;

  /** Enables Anthropic tool-reference output bridging for deferred tools. */
  enableAnthropicToolReferences?: boolean;

  /** Optional per-agent tool allowlist. */
  enabledTools?: Set<string>;

  /** Tools resolved as unauthorized/unavailable for this request. */
  disabledTools?: Set<string>;

  /** Request-scoped resolved loading policies. */
  resolvedPolicies?: Map<string, ResolvedToolLoadingPolicy>;

  /** @deprecated Use initialActiveTools instead. */
  loadedTools?: Set<string>;

  /** Workflow subagent directory for subagent discovery. */
  subagentDirectory?: string[];
}

export function authorizeRuntimeLoadedTools(
  context: Pick<ToolSearchContext, "enabledTools" | "disabledTools" | "resolvedPolicies">,
  toolIds: Iterable<string>
): void {
  for (const toolId of toolIds) {
    // Dynamic tool namespaces (MCP/custom ComfyUI) are resolved after the base
    // registry plan. If a stale registry entry was seen before that point, it
    // may have been marked disabled/not-enabled under the built-in
    // agent.enabledTools authorization model. Loading the tool for this request
    // is the authoritative authorization signal for these dynamic namespaces.
    context.enabledTools?.add(toolId);
    context.disabledTools?.delete(toolId);
    context.resolvedPolicies?.delete(toolId);
  }
}

type ToolSearchInput = {
  query: string;
  category?: ToolCategory;
  limit?: number;
};

const toolSearchSchema = jsonSchema<ToolSearchInput>({
  type: "object",
  title: "searchToolsInput",
  description: "Input schema for searching available tools",
  properties: {
    query: {
      type: "string",
      description:
        "Search query to find relevant tools. Use descriptive terms like 'generate image', 'edit photo', 'create video', or 'select:readFile,editFile'. Prefix required terms with '+'.",
    },
    category: {
      type: "string",
      enum: [
        "image-generation",
        "image-editing",
        "video-generation",
        "analysis",
        "knowledge",
        "utility",
        "search",
        "mcp",
        "browser",
        "computer-use",
      ],
      description:
        "Optional soft category filter. Search text matters more than category when they conflict.",
    },
    limit: {
      type: "number",
      minimum: 1,
      maximum: 50,
      default: 20,
      description: "Maximum number of tools to return (default: 20)",
    },
  },
  required: ["query"],
  additionalProperties: false,
});

interface SearchResultWithAvailability extends ToolSearchResult {
  isAvailable: boolean;
  fullInstructions?: string;
  resultType: "tool";
}

interface SubagentResultWithAvailability extends SubagentSearchResult {
  isAvailable: true;
  resultType: "subagent";
}

type UnifiedResultWithAvailability =
  | SearchResultWithAvailability
  | SubagentResultWithAvailability;

interface SearchToolResult {
  status: "success" | "no_results";
  query: string;
  results: UnifiedResultWithAvailability[];
  message: string;
  summary?: string;
}

interface ParsedToolQuery {
  selectNames: string[];
  searchText: string;
  optionalTerms: string[];
  requiredTerms: string[];
}

function asJsonToolOutput(value: unknown): ToolResultOutput {
  return {
    type: "json",
    value: value as any,
  };
}

function normalizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
}

function addSelectAlias(
  aliases: Map<string, string>,
  ambiguousAliases: Set<string>,
  alias: string | undefined,
  toolName: string
): void {
  if (!alias) return;
  const normalized = normalizeToolName(alias);
  if (!normalized || ambiguousAliases.has(normalized)) return;

  const existing = aliases.get(normalized);
  if (existing && existing !== toolName) {
    aliases.delete(normalized);
    ambiguousAliases.add(normalized);
    return;
  }

  aliases.set(normalized, toolName);
}

function buildSelectAliasMap(registry: ToolRegistry): Map<string, string> {
  const aliases = new Map<string, string>();
  const ambiguousAliases = new Set<string>();

  for (const name of registry.getToolNames()) {
    const registered = registry.get(name);
    if (!registered) continue;

    const { metadata } = registered;
    addSelectAlias(aliases, ambiguousAliases, name, name);
    addSelectAlias(aliases, ambiguousAliases, metadata.displayName, name);

    if (metadata.category === "mcp") {
      // MCP tools are displayed to users by native server/tool names like
      // `supabase:execute_sql` and `execute_sql`, while the callable tool ID is
      // namespaced/sanitized (`mcp_supabase_execute_sql`).  Preserve exact
      // select: lookup for both forms so connected MCP tools are discoverable
      // without users needing to guess Selene's internal ID format.
      const nativeToolName = metadata.keywords[0];
      const serverName = metadata.keywords[1];

      addSelectAlias(aliases, ambiguousAliases, nativeToolName, name);
      if (serverName && nativeToolName) {
        addSelectAlias(aliases, ambiguousAliases, `${serverName}:${nativeToolName}`, name);
        addSelectAlias(aliases, ambiguousAliases, `${serverName}.${nativeToolName}`, name);
        addSelectAlias(aliases, ambiguousAliases, `${serverName}/${nativeToolName}`, name);
      }
    }
  }

  return aliases;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function tokenizeTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseToolQuery(query: string): ParsedToolQuery {
  const trimmed = query.trim();
  const selectPrefix = /^select\s*:/i;

  if (selectPrefix.test(trimmed)) {
    const selectBody = trimmed.replace(selectPrefix, "");
    const selectNames = uniqueStrings(
      selectBody
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    );
    return {
      selectNames,
      searchText: selectNames.join(" "),
      optionalTerms: [],
      requiredTerms: [],
    };
  }

  const requiredTerms: string[] = [];
  const optionalTerms: string[] = [];

  for (const term of query.split(/\s+/)) {
    const normalized = term.trim();
    if (!normalized) continue;
    if (normalized.startsWith("+")) {
      const value = normalized.replace(/^\++/, "").trim().toLowerCase();
      if (value) requiredTerms.push(value);
      continue;
    }
    optionalTerms.push(normalized.toLowerCase());
  }

  const searchText = uniqueStrings([...optionalTerms, ...requiredTerms]).join(" ").trim() || trimmed;

  return {
    selectNames: [],
    searchText,
    optionalTerms: uniqueStrings(tokenizeTerms(optionalTerms.join(" "))),
    requiredTerms: uniqueStrings(tokenizeTerms(requiredTerms.join(" "))),
  };
}

function dedupeResultsByName(results: ToolSearchResult[]): ToolSearchResult[] {
  const seen = new Set<string>();
  const deduped: ToolSearchResult[] = [];

  for (const result of results) {
    if (seen.has(result.name)) continue;
    seen.add(result.name);
    deduped.push(result);
  }

  return deduped;
}

function buildToolHaystack(toolName: string, registry: ToolRegistry): string {
  const registered = registry.get(toolName);
  if (!registered) return toolName.toLowerCase();

  const { metadata } = registered;
  return [
    toolName,
    metadata.displayName,
    metadata.shortDescription,
    metadata.searchHint ?? "",
    metadata.category,
    ...metadata.keywords,
  ]
    .join(" ")
    .toLowerCase();
}

function matchesRequiredTerms(
  result: ToolSearchResult,
  requiredTerms: string[],
  registry: ToolRegistry
): boolean {
  if (requiredTerms.length === 0) return true;
  const haystack = buildToolHaystack(result.name, registry);
  return requiredTerms.every((term) => haystack.includes(term));
}

function resolveSelectedToolNames(
  requestedNames: string[],
  registry: ToolRegistry
): ToolSearchResult[] {
  const normalizedMap = buildSelectAliasMap(registry);

  const results: ToolSearchResult[] = [];
  for (const requestedName of requestedNames) {
    const direct = registry.getToolDetails(requestedName);
    const resolvedName = direct
      ? requestedName
      : normalizedMap.get(normalizeToolName(requestedName));
    const details = resolvedName ? registry.getToolDetails(resolvedName) : null;
    if (!details) continue;
    results.push({
      name: details.name,
      displayName: details.displayName,
      category: details.category,
      description: details.description,
      relevance: 1,
      fullInstructions: details.fullInstructions,
    });
  }

  return dedupeResultsByName(results);
}

function collectSearchMatches(
  parsedQuery: ParsedToolQuery,
  registry: ToolRegistry,
  limit: number
): ToolSearchResult[] {
  const rawQueries = uniqueStrings([
    parsedQuery.searchText,
    ...parsedQuery.optionalTerms,
    ...parsedQuery.requiredTerms,
  ]).filter(Boolean);

  let results: ToolSearchResult[] = [];
  for (const rawQuery of rawQueries) {
    results = dedupeResultsByName([...results, ...registry.search(rawQuery, Math.max(limit, 20))]);
  }

  if (results.length === 0 && parsedQuery.searchText) {
    results = registry.search(parsedQuery.searchText, Math.max(limit, 20));
  }

  return results;
}

function applySoftCategoryFilter(
  results: ToolSearchResult[],
  category: ToolCategory | undefined
): ToolSearchResult[] {
  if (!category || results.length === 0) {
    return results;
  }

  const categoryMatches = results.filter((result) => result.category === category);
  if (categoryMatches.length === 0) {
    return results;
  }

  const strongNonCategoryMatches = results.filter(
    (result) => result.category !== category && result.relevance >= 0.75
  );
  return [...categoryMatches, ...strongNonCategoryMatches];
}

function filterEnabledResults(
  results: ToolSearchResult[],
  enabledTools: Set<string> | undefined,
  disabledTools: Set<string> | undefined,
  registry: ToolRegistry
): ToolSearchResult[] {
  return results.filter((result) => {
    if (disabledTools?.has(result.name)) return false;
    if (!enabledTools) return true;

    const registered = registry.get(result.name);
    if (!registered) return false;
    if (isRequiredTool(result.name, registered.metadata)) return true;
    return enabledTools.has(result.name);
  });
}

function filterRequiredTerms(
  results: ToolSearchResult[],
  parsedQuery: ParsedToolQuery,
  registry: ToolRegistry
): ToolSearchResult[] {
  if (parsedQuery.requiredTerms.length === 0) {
    return results;
  }

  return results.filter((result) =>
    matchesRequiredTerms(result, parsedQuery.requiredTerms, registry)
  );
}

function buildNoResultsMessage(
  query: string,
  registry: ToolRegistry,
  enabledTools?: Set<string>,
  disabledTools?: Set<string>
): SearchToolResult {
  let availableTools = registry.getAvailableToolsList();
  availableTools = availableTools.filter((toolSummary) => {
    if (disabledTools?.has(toolSummary.name)) return false;
    if (!enabledTools) return true;
    const registered = registry.get(toolSummary.name);
    return Boolean(registered && (isRequiredTool(toolSummary.name, registered.metadata) || enabledTools.has(toolSummary.name)));
  });

  const categoryList = [...new Set(availableTools.map((toolSummary) => toolSummary.category))];
  return {
    status: "no_results",
    query,
    results: [],
    message: `No tools found matching "${query}". Available categories: ${categoryList.join(", ")}. Try a broader capability phrase or use select:ToolName for an exact fetch.`,
  };
}

function markDiscoveredTools(
  results: ToolSearchResult[],
  discoveredTools: Set<string> | undefined,
  registry: ToolRegistry,
  resolvedPolicies?: Map<string, ResolvedToolLoadingPolicy>
): void {
  if (!discoveredTools) {
    return;
  }

  for (const result of results) {
    const registered = registry.get(result.name);
    if (registered && isPolicyDeferred(result.name, registered.metadata, resolvedPolicies)) {
      discoveredTools.add(result.name);
      logSearchTools(`[searchTools] Discovered deferred tool: ${result.name}`);
    }
  }
}

export function createToolSearchTool(context?: ToolSearchContext) {
  const registry = ToolRegistry.getInstance();
  const initialActiveTools = context?.initialActiveTools ?? context?.loadedTools;
  const discoveredTools = context?.discoveredTools;
  const enabledTools = context?.enabledTools;
  const disabledTools = context?.disabledTools;
  const resolvedPolicies = context?.resolvedPolicies;
  const subagentDirectory = context?.subagentDirectory;
  const enableAnthropicToolReferences =
    context?.enableAnthropicToolReferences === true;

  return tool({
    description: `Search for available AI tools by functionality.

**⚠️ CRITICAL: This is NOT for searching the codebase!**
- To search CODE/FILES, use: \`localGrep\` (exact text) or \`vectorSearch\` (semantic)
- This tool discovers YOUR AI CAPABILITIES (image generation, web search, etc)

**DEFERRED LOADING:**
- You only see a fraction of your tools initially (to save tokens)
- If a user says "use grep", "search the web", "edit an image", search here first
- **NEVER deny having a capability without searching first**

**Search queries (describe the CAPABILITY, not content):**
- "grep", "regex", "pattern search" → finds localGrep
- "semantic search", "vector search" → finds vectorSearch
- "generate image", "create image" → finds image generation tools
- "web search", "search internet" → finds web search tools
- "delegate", "subagent", "agent" → finds delegation tools AND available subagents
- "select:Read,Edit,Grep" → fetch exact tools directly
- "+slack send" → require "slack", rank by "send"

**❌ WRONG:** searchTools({ query: "tutorial tooltip positioning" })
**✅ RIGHT:** localGrep({ pattern: "tooltip", fileTypes: ["ts"] })

**After finding a tool:** Use it immediately. Do NOT call searchTools again for the same task.`,
    inputSchema: toolSearchSchema,
    execute: async ({ query, category, limit = 20 }: ToolSearchInput): Promise<SearchToolResult> => {
      const effectiveLimit = Math.min(Math.max(limit, 1), 50);
      const parsedQuery = parseToolQuery(query);

      let toolResults = parsedQuery.selectNames.length > 0
        ? resolveSelectedToolNames(parsedQuery.selectNames, registry)
        : collectSearchMatches(parsedQuery, registry, effectiveLimit * 4);

      toolResults = filterRequiredTerms(toolResults, parsedQuery, registry);
      toolResults = applySoftCategoryFilter(toolResults, category);
      toolResults = filterEnabledResults(toolResults, enabledTools, disabledTools, registry);
      toolResults = dedupeResultsByName(toolResults).slice(0, effectiveLimit);

      const subagentResults: SubagentSearchResult[] = subagentDirectory
        ? searchSubagents(query, parseSubagentDirectory(subagentDirectory))
        : [];

      if (toolResults.length === 0 && subagentResults.length === 0) {
        return buildNoResultsMessage(query, registry, enabledTools, disabledTools);
      }

      markDiscoveredTools(toolResults, discoveredTools, registry, resolvedPolicies);

      const toolResultsWithAvailability: UnifiedResultWithAvailability[] = toolResults.map((result) => {
        const registered = registry.get(result.name);
        const isDeferred = registered
          ? isPolicyDeferred(result.name, registered.metadata, resolvedPolicies)
          : false;
        const isInitiallyActive = initialActiveTools?.has(result.name) ?? !isDeferred;
        const wasDiscovered = discoveredTools?.has(result.name) ?? false;

        return {
          ...result,
          resultType: "tool" as const,
          isAvailable: isInitiallyActive || wasDiscovered,
          fullInstructions: result.fullInstructions,
        };
      });

      const subagentResultsWithAvailability: UnifiedResultWithAvailability[] = subagentResults.map((result) => ({
        ...result,
        resultType: "subagent" as const,
        isAvailable: true,
      }));

      const allResults = [...toolResultsWithAvailability, ...subagentResultsWithAvailability]
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, effectiveLimit);

      const toolCount = allResults.filter((result) => result.resultType === "tool").length;
      const subagentCount = allResults.filter((result) => result.resultType === "subagent").length;
      const availableCount = allResults.filter((result) => result.isAvailable).length;

      let message = `Found ${allResults.length} result(s) matching "${query}".`;
      if (toolCount > 0 && subagentCount > 0) {
        message += ` ${toolCount} tool(s) and ${subagentCount} subagent(s).`;
      } else if (toolCount > 0) {
        message += ` ${toolCount} tool(s).`;
      } else if (subagentCount > 0) {
        message += ` ${subagentCount} subagent(s).`;
      }
      if (availableCount > 0) {
        message += ` ${availableCount} are now available for use.`;
      }

      const summary = subagentCount > 0
        ? "To delegate to a subagent, use: delegateToSubagent({ action: 'start', agentId: '<id>', task: '<description>' })"
        : "";

      return {
        status: "success",
        query,
        results: allResults,
        message,
        summary,
      };
    },
    ...(enableAnthropicToolReferences
      ? {
          toModelOutput: async ({ output }) => {
            const result = output as SearchToolResult;
            if (!result || result.status !== "success" || !Array.isArray(result.results)) {
              return asJsonToolOutput(output);
            }

            const hasSubagentResults = result.results.some(
              (entry) => entry.resultType === "subagent"
            );
            if (hasSubagentResults) {
              return asJsonToolOutput(output);
            }

            const referencedToolNames = Array.from(
              new Set(
                result.results
                  .filter(
                    (entry): entry is SearchResultWithAvailability =>
                      entry.resultType === "tool"
                  )
                  .map((entry) => entry.name)
                  .filter((toolName) => {
                    const registered = registry.get(toolName);
                    return registered
                      ? isPolicyDeferred(toolName, registered.metadata, resolvedPolicies)
                      : false;
                  })
              )
            );

            if (referencedToolNames.length === 0) {
              return asJsonToolOutput(output);
            }

            return {
              type: "content",
              value: [
                {
                  type: "text",
                  text: result.message,
                },
                ...referencedToolNames.map((toolName) => ({
                  type: "custom" as const,
                  providerOptions: {
                    anthropic: {
                      type: "tool-reference",
                      toolName,
                    },
                  },
                })),
              ],
            };
          },
        }
      : {}),
  });
}


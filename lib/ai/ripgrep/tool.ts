/**
 * Local Grep Tool
 * 
 * AI tool for fast pattern searching using ripgrep.
 * Complements vector search with exact/regex pattern matching.
 */

import { tool, jsonSchema } from "ai";
import { searchWithRipgrep, isRipgrepAvailable, type RipgrepMatch, type RipgrepSearchResult } from "./ripgrep";
import { resolveSessionWorkspaceInfo } from "@/lib/workspace/metadata";
import { getAccessibleSyncFolders } from "@/lib/vectordb/accessible-sync-folders";
import { validateSyncFolderPath } from "@/lib/vectordb/path-validation";
import { loadSettings } from "@/lib/settings/settings-manager";
import { logToolEvent } from "@/lib/ai/tool-registry/logging";
import { isOtherWorktreePath } from "@/lib/ai/filesystem/path-utils";

interface LocalGrepToolOptions {
    sessionId: string;
    characterId?: string | null;
}

/**
 * Input schema for the localGrep tool
 */
interface LocalGrepInput {
    pattern: string;
    paths?: string[];
    regex?: boolean;
    caseInsensitive?: boolean;
    maxResults?: number;
    fileTypes?: string[];
    contextLines?: number;
}

/**
 * Result type for the localGrep tool
 */
interface LocalGrepResult {
    status: "success" | "error" | "disabled" | "no_paths";
    matchCount?: number;
    /** Total matches found before limiting (may be higher than matchCount) */
    totalMatchCount?: number;
    /** Whether results were truncated due to maxResults limit */
    wasTruncated?: boolean;
    pattern?: string;
    regex?: boolean;
    searchedPaths?: string[];
    /** Where default search paths came from when caller omitted explicit paths */
    pathSource?: "explicit" | "workspace" | "synced_folders" | "workspace_then_synced";
    /** Ordered implicit scopes attempted by the tool for no-path requests */
    attemptedScopes?: string[];
    /** Whether the tool ran a same-call fallback scope after zero matches */
    fallbackUsed?: boolean;
    results?: string;
    matches?: Array<{ file: string; line: number; text: string }>;
    message?: string;
    error?: string;
}

type SyncedPathResolution =
    | { status: "ok"; paths: string[]; skippedCount: number }
    | { status: "no_paths"; message: string }
    | { status: "error"; error: string };

async function resolveSyncedSearchPaths(characterId?: string | null): Promise<SyncedPathResolution> {
    if (!characterId) {
        return {
            status: "no_paths",
            message: "No paths specified. Please provide paths to search.",
        };
    }

    try {
        const folders = await getAccessibleSyncFolders(characterId);
        const validatedFolders = await Promise.all(
            folders.map(async (folder) => {
                const { normalizedPath, error } = await validateSyncFolderPath(folder.folderPath, {
                    requireReadable: false,
                });

                return {
                    path: normalizedPath,
                    error,
                };
            })
        );

        const skippedCount = validatedFolders.filter((folder) => folder.error).length;
        const paths = validatedFolders
            .filter((folder) => !folder.error)
            .map((folder) => folder.path);

        if (paths.length === 0) {
            return {
                status: "no_paths",
                message:
                    skippedCount > 0
                        ? "No valid synced folders are currently available for this agent. Synced folder entries may point to deleted or inaccessible paths. Remove stale folders in agent settings or pass explicit paths."
                        : "No paths specified and no synced folders found for this agent. Please specify paths to search or add synced folders in the agent settings.",
            };
        }

        return {
            status: "ok",
            paths,
            skippedCount,
        };
    } catch {
        return {
            status: "error",
            error: "Failed to retrieve synced folders. Please specify paths to search explicitly.",
        };
    }
}

async function resolveWorkspaceSearchPath(sessionId: string): Promise<string | null> {
    if (!sessionId || sessionId === "UNSCOPED") {
        return null;
    }

    try {
        const workspaceInfo = await resolveSessionWorkspaceInfo(sessionId);
        const worktreePath = workspaceInfo?.worktreePath;

        if (!worktreePath || typeof worktreePath !== "string") {
            return null;
        }

        const { normalizedPath, error } = await validateSyncFolderPath(worktreePath, {
            requireReadable: false,
        });

        return error ? null : normalizedPath;
    } catch {
        return null;
    }
}

function buildRegexErrorHint(pattern: string, errorMessage: string): string {
    const normalizedError = errorMessage.toLowerCase();
    const isRegexParseError =
        normalizedError.includes("regex parse") ||
        normalizedError.includes("error parsing regex") ||
        normalizedError.includes("unclosed group") ||
        normalizedError.includes("unclosed character class") ||
        normalizedError.includes("unmatched") ||
        normalizedError.includes("repetition");

    if (!isRegexParseError) {
        return errorMessage;
    }

    return `${errorMessage}\nHint: Your pattern was interpreted as regex and could not be parsed. ` +
        `If you intended a literal search, set regex: false. ` +
        `If you need regex mode, escape metacharacters (e.g., \"${pattern}\" -> \"${pattern.replace(/([()\[\]{}\\])/g, "\\$1")}\").`;
}

/**
 * Format ripgrep matches for AI consumption
 */
function formatResults(searchResult: RipgrepSearchResult, query: string): string {
    const { matches, totalMatches, wasTruncated } = searchResult;

    if (matches.length === 0) {
        return `No matches found for pattern: "${query}"`;
    }

    const groupedByFile = new Map<string, RipgrepMatch[]>();
    for (const match of matches) {
        const existing = groupedByFile.get(match.file) || [];
        existing.push(match);
        groupedByFile.set(match.file, existing);
    }

    // Show total vs displayed count when truncated
    let output: string;
    if (wasTruncated) {
        output = `Found ${totalMatches} total matches, showing ${matches.length} in ${groupedByFile.size} files for: "${query}"\n`;
        output += `⚠️ Results were truncated. Increase maxResults or refine your search pattern to see more.\n\n`;
    } else {
        output = `Found ${matches.length} matches in ${groupedByFile.size} files for: "${query}"\n\n`;
    }

    for (const [file, fileMatches] of groupedByFile) {
        output += `📄 ${file}\n`;
        output += "─".repeat(Math.min(file.length + 3, 60)) + "\n";

        for (const match of fileMatches) {
            // Show context before
            if (match.beforeContext && match.beforeContext.length > 0) {
                for (const ctx of match.beforeContext) {
                    output += `   ${ctx}\n`;
                }
            }

            // Show match with line number
            output += `${match.line}│ ${match.text}\n`;

            // Show context after
            if (match.afterContext && match.afterContext.length > 0) {
                for (const ctx of match.afterContext) {
                    output += `   ${ctx}\n`;
                }
            }

            output += "\n";
        }
        output += "\n";
    }

    return output.trim();
}

/**
 * JSON Schema definition for the localGrep tool
 */
const localGrepSchema = jsonSchema<LocalGrepInput>({
    type: "object",
    properties: {
        pattern: {
            type: "string",
            description: "Search pattern (exact text or regex). Examples: 'getUserById', 'async.*await', 'TODO:'",
        },
        paths: {
            type: "array",
            items: { type: "string" },
            description: "Paths to search. If omitted, searches agent's synced folders. Can be files or directories.",
        },
        regex: {
            type: "boolean",
            default: false,
            description: "Treat pattern as regex (default: false = literal text search)",
        },
        caseInsensitive: {
            type: "boolean",
            default: true,
            description: "Ignore case (default: true)",
        },
        maxResults: {
            type: "number",
            default: 20,
            description: "Maximum results to return (default: 20)",
        },
        fileTypes: {
            type: "array",
            items: { type: "string" },
            description: "File extensions to include, e.g., ['ts', 'js', 'py']. Omit for all files.",
        },
        contextLines: {
            type: "number",
            default: 2,
            description: "Lines of context before/after each match (default: 2)",
        },
    },
    required: ["pattern"],
    additionalProperties: false,
});

/**
 * Create the localGrep AI tool
 */
export function createLocalGrepTool(options: LocalGrepToolOptions) {
    const { sessionId, characterId } = options;

    return tool({
        description: `Search for exact text or regex patterns in files using ripgrep.
Use tight queries first to avoid noisy output: specific pattern, narrow paths/fileTypes,
and small maxResults/contextLines before expanding.

Unlike vectorSearch (semantic/conceptual), localGrep finds EXACT matches with line numbers.
If no paths specified, searches the agent's synced folders.
Respects .gitignore and skips binary files by default.`,

        inputSchema: localGrepSchema,

        execute: async (input): Promise<LocalGrepResult> => {
            // Handle common AI parameter mistakes:
            // - query → pattern (AI often uses "query" instead of "pattern")
            // - type → fileTypes (AI may pass single type instead of array)
            // - fileTypes as JSON string instead of array (e.g., "[\"ts\", \"tsx\"]")
            const rawInput = input as unknown as Record<string, unknown>;
            const pattern = input.pattern || (rawInput.query as string | undefined);

            // Parse fileTypes - ALWAYS validate type (AI might pass string instead of array)
            let fileTypes: string[] | undefined;
            const rawFileTypes = input.fileTypes ?? rawInput.fileTypes ?? rawInput.type;

            if (rawFileTypes) {
                if (Array.isArray(rawFileTypes)) {
                    // Already an array, ensure all elements are strings
                    fileTypes = rawFileTypes.map(String);
                } else if (typeof rawFileTypes === "string") {
                    // Try to parse as JSON array first (e.g., "[\"ts\", \"tsx\"]")
                    if (rawFileTypes.startsWith("[")) {
                        try {
                            const parsed = JSON.parse(rawFileTypes);
                            if (Array.isArray(parsed)) {
                                fileTypes = parsed.map(String);
                            }
                        } catch {
                            // Not valid JSON, treat as single type
                            fileTypes = [rawFileTypes];
                        }
                    } else {
                        // Single type string (e.g., "ts")
                        fileTypes = [rawFileTypes];
                    }
                }
            }

            // Parse paths - ALWAYS validate type (AI might pass string instead of array)
            let paths: string[] | undefined;
            const rawPaths = input.paths ?? (rawInput.paths as unknown);

            if (rawPaths) {
                if (Array.isArray(rawPaths)) {
                    paths = rawPaths.map(String);
                } else if (typeof rawPaths === "string") {
                    // Try to parse as JSON array first (e.g., "[\"path1\", \"path2\"]")
                    if (rawPaths.startsWith("[")) {
                        try {
                            const parsed = JSON.parse(rawPaths);
                            if (Array.isArray(parsed)) {
                                paths = parsed.map(String);
                            }
                        } catch {
                            // Not valid JSON, treat as single path
                            paths = [rawPaths];
                        }
                    } else {
                        // Single path string
                        paths = [rawPaths];
                    }
                }
            }

            const {
                regex = false,
                caseInsensitive = true,
                maxResults = 20,
                contextLines = 2,
            } = input;

            // Validate pattern is provided
            if (!pattern || typeof pattern !== "string" || pattern.trim() === "") {
                const errorMessage = "Missing or invalid pattern. Use: localGrep({ pattern: \"your-search-term\" })";
                logToolEvent({
                    level: "error",
                    toolName: "localGrep",
                    event: "error",
                    error: errorMessage,
                    metadata: { searchPath: "native_localgrep" },
                });

                return {
                    status: "error",
                    error: errorMessage,
                };
            }

            // Honor explicit/implicit literal default contract:
            // regex=true -> regex mode, otherwise literal mode.
            const isRegex = regex === true;

            // Check if ripgrep is available
            if (!isRipgrepAvailable()) {
                const errorMessage = "ripgrep is not available. The vscode-ripgrep package may not be installed correctly.";
                logToolEvent({
                    level: "error",
                    toolName: "localGrep",
                    event: "error",
                    error: errorMessage,
                    metadata: { searchPath: "native_localgrep" },
                });

                return {
                    status: "error",
                    error: errorMessage,
                };
            }

            // Load settings
            const settings = loadSettings();
            const enabled = settings.localGrepEnabled ?? true;
            if (!enabled) {
                logToolEvent({
                    level: "warn",
                    toolName: "localGrep",
                    event: "error",
                    error: "Local Grep is disabled in settings.",
                    metadata: { searchPath: "native_localgrep" },
                });

                return {
                    status: "disabled",
                    message: "Local Grep is disabled in settings.",
                };
            }

            const executeSearch = async (candidatePaths: string[]) => {
                return searchWithRipgrep({
                    pattern,
                    paths: candidatePaths,
                    regex: isRegex,
                    caseInsensitive,
                    maxResults: maxResults ?? settings.localGrepMaxResults ?? 20,
                    fileTypes,
                    contextLines: contextLines ?? settings.localGrepContextLines ?? 2,
                    respectGitignore: settings.localGrepRespectGitignore ?? true,
                });
            };

            // Determine search paths
            const hasExplicitPaths = Array.isArray(paths) && paths.length > 0;
            let searchPaths = paths || [];
            let skippedSyncedFolderCount = 0;
            let pathSource: LocalGrepResult["pathSource"] = hasExplicitPaths ? "explicit" : undefined;
            const attemptedScopes: string[] = [];
            let fallbackUsed = false;

            if (!hasExplicitPaths) {
                const workspacePath = await resolveWorkspaceSearchPath(sessionId);
                if (workspacePath) {
                    searchPaths = [workspacePath];
                    pathSource = "workspace";
                    attemptedScopes.push("workspace");
                } else {
                    attemptedScopes.push("synced_folders");
                    const syncedResolution = await resolveSyncedSearchPaths(characterId);

                    if (syncedResolution.status === "error") {
                        logToolEvent({
                            level: "error",
                            toolName: "localGrep",
                            event: "error",
                            error: syncedResolution.error,
                            metadata: { searchPath: "native_localgrep" },
                        });

                        return {
                            status: "error",
                            error: syncedResolution.error,
                        };
                    }

                    if (syncedResolution.status === "no_paths") {
                        logToolEvent({
                            level: "warn",
                            toolName: "localGrep",
                            event: "error",
                            error: syncedResolution.message,
                            metadata: { searchPath: "native_localgrep" },
                        });

                        return {
                            status: "no_paths",
                            message: syncedResolution.message,
                        };
                    }

                    searchPaths = syncedResolution.paths;
                    skippedSyncedFolderCount = syncedResolution.skippedCount;
                    pathSource = "synced_folders";
                }
            }

            try {
                let searchResult = await executeSearch(searchPaths);
                let finalSearchPaths = searchPaths;
                const infoMessages: string[] = [];
                let finalPathSource: LocalGrepResult["pathSource"] =
                    pathSource === "workspace"
                        ? "workspace"
                        : pathSource === "synced_folders"
                            ? "synced_folders"
                            : pathSource === "explicit"
                                ? "explicit"
                                : undefined;

                if (!hasExplicitPaths && pathSource === "workspace" && searchResult.matches.length === 0) {
                    attemptedScopes.push("synced_folders");
                    const syncedResolution = await resolveSyncedSearchPaths(characterId);

                    if (syncedResolution.status === "ok") {
                        // Exclude other worktree paths to prevent cross-workspace contamination
                        const workspacePath = searchPaths[0] ?? null;
                        const filteredPaths = syncedResolution.paths.filter(
                            (p) => !isOtherWorktreePath(p, workspacePath)
                        );
                        const excludedCount = syncedResolution.paths.length - filteredPaths.length;

                        skippedSyncedFolderCount += syncedResolution.skippedCount;
                        fallbackUsed = true;
                        finalPathSource = "workspace_then_synced";
                        finalSearchPaths = filteredPaths;
                        searchResult = await executeSearch(finalSearchPaths);

                        if (excludedCount > 0) {
                            infoMessages.push(
                                `Excluded ${excludedCount} other workspace path(s) from fallback search.`
                            );
                        }
                    } else if (syncedResolution.status === "error") {
                        infoMessages.push(
                            "Workspace search returned 0 matches; synced folder fallback failed to load."
                        );
                    } else {
                        infoMessages.push(
                            "Workspace search returned 0 matches; no synced folders were available for fallback."
                        );
                    }
                }

                if (skippedSyncedFolderCount > 0) {
                    infoMessages.push(
                        `Skipped ${skippedSyncedFolderCount} unavailable synced folder path(s) before searching.`
                    );
                }

                if (fallbackUsed) {
                    infoMessages.push(
                        "Workspace search returned 0 matches; retried with synced folders in the same tool call."
                    );
                }

                const formattedOutput = formatResults(searchResult, pattern);

                logToolEvent({
                    level: "info",
                    toolName: "localGrep",
                    event: "success",
                    metadata: {
                        searchPath: "native_localgrep",
                        pattern,
                        regex: isRegex,
                        matchCount: searchResult.matches.length,
                        skippedSyncedFolderCount,
                        pathSource: finalPathSource,
                        attemptedScopes: attemptedScopes.join(","),
                        fallbackUsed,
                    },
                });

                return {
                    status: "success",
                    matchCount: searchResult.matches.length,
                    totalMatchCount: searchResult.totalMatches,
                    wasTruncated: searchResult.wasTruncated,
                    pattern,
                    regex: isRegex,
                    searchedPaths: finalSearchPaths,
                    pathSource: finalPathSource,
                    attemptedScopes: attemptedScopes.length > 0 ? attemptedScopes : undefined,
                    fallbackUsed,
                    results: formattedOutput,
                    message: infoMessages.length > 0 ? infoMessages.join(" ") : undefined,
                    // Also include structured data for potential further processing
                    matches: searchResult.matches.slice(0, 20).map((m: RipgrepMatch) => ({
                        file: m.file,
                        line: m.line,
                        text: m.text.slice(0, 200), // Truncate long lines
                    })),
                };
            } catch (error) {
                const rawError = error instanceof Error ? error.message : "Search failed";
                const enrichedError = isRegex ? buildRegexErrorHint(pattern, rawError) : rawError;

                logToolEvent({
                    level: "error",
                    toolName: "localGrep",
                    event: "error",
                    error: enrichedError,
                    metadata: {
                        searchPath: "native_localgrep",
                        pattern,
                        regex: isRegex,
                    },
                });

                return {
                    status: "error",
                    error: enrichedError,
                };
            }
        },
    });
}

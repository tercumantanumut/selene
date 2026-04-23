/**
 * Search Backend Abstraction
 *
 * Generic types shared by every search backend (ripgrep, fff, ...).
 * Tool code depends only on these types; concrete backends live in ./backends.
 *
 * Design notes:
 *   - Existing RipgrepMatch / RipgrepSearchResult / RipgrepOptions are aliased to
 *     SearchMatch / SearchResult / SearchOptions so historical imports keep compiling.
 *   - Optional fields (column, gitStatus, frecencyScore, isDefinition) are surfaced
 *     by richer backends and ignored by simpler ones.
 */

/** Identifier for a registered search backend. Extend as new backends are added. */
export type SearchBackendId = "ripgrep" | "fff";

/** Capability flags a backend can declare supporting. */
export type SearchFeature =
    | "regex"
    | "context-lines"
    | "column"
    | "file-type-filter"
    | "glob-filter"
    | "gitignore"
    | "hidden-files"
    | "git-filter"
    | "frecency"
    | "definition-priority";

/** A single search hit. Superset of ripgrep's historical shape. */
export interface SearchMatch {
    /** Absolute or repo-relative file path (backend-dependent; tool layer is tolerant). */
    file: string;
    /** 1-based line number. */
    line: number;
    /** 0-based column of the first submatch. Optional — fff does not produce this. */
    column?: number;
    /** The matched line text, trimmed of trailing whitespace. */
    text: string;
    /** Lines immediately preceding `line` (newest last). */
    beforeContext?: string[];
    /** Lines immediately following `line`. */
    afterContext?: string[];
    // --- Optional capability-backed fields ---
    gitStatus?: "modified" | "staged" | "untracked" | "ignored" | "deleted" | "renamed";
    frecencyScore?: number;
    isDefinition?: boolean;
}

export interface SearchResult {
    /** Matches, limited to maxResults. */
    matches: SearchMatch[];
    /** Total matches observed before limiting (>= matches.length). */
    totalMatches: number;
    /** True if matches was capped at maxResults. */
    wasTruncated: boolean;
    /** Which backend produced these results. Useful for telemetry + UI badges. */
    backend: SearchBackendId;
}

export interface SearchOptions {
    pattern: string;
    paths: string[];
    regex?: boolean;
    caseInsensitive?: boolean;
    maxResults?: number;
    fileTypes?: string[];
    globs?: string[];
    contextLines?: number;
    respectGitignore?: boolean;
    includeHidden?: boolean;
    /** Hints richer backends use. Ignored by backends that don't support them. */
    gitFilter?: Array<"modified" | "staged" | "untracked" | "deleted" | "renamed">;
    rankByFrecency?: boolean;
}

/**
 * The core interface. Every concrete backend implements this.
 *
 * Lifecycle (optional):
 *   - prepare(paths) — warm an in-process index, if any. Idempotent per path.
 *   - dispose() — release held resources (only called on app shutdown).
 *
 * Errors:
 *   - Throw SearchBackendUnavailableError for "I am not usable right now"
 *     (missing binary, missing index, package not installed). These trigger fallback.
 *   - Throw SearchBackendTransientError for recoverable failures (spawn EBADF, etc.).
 *     These also trigger fallback, but are logged differently.
 *   - Throw any other Error (e.g. user regex syntax error) to surface directly to
 *     the caller WITHOUT fallback. The registry treats these as permanent.
 */
export interface SearchBackend {
    readonly id: SearchBackendId;
    readonly displayName: string;
    isAvailable(): Promise<boolean>;
    supports(feature: SearchFeature): boolean;
    search(options: SearchOptions): Promise<SearchResult>;
    /** Optional: warm an index or preflight paths. */
    prepare?(workspacePaths: string[]): Promise<void>;
    /** Optional: release resources on shutdown. */
    dispose?(): Promise<void>;
}

/**
 * Fallback-eligible error: backend is known-unusable (e.g. binary missing,
 * index not ready, optional dependency not installed).
 */
export class SearchBackendUnavailableError extends Error {
    readonly backendId: SearchBackendId;
    constructor(backendId: SearchBackendId, message: string) {
        super(`[${backendId}] ${message}`);
        this.name = "SearchBackendUnavailableError";
        this.backendId = backendId;
    }
}

/**
 * Fallback-eligible error: recoverable runtime failure (spawn error, timeout,
 * transient IO issue). Distinct from Unavailable so telemetry can tell them apart.
 */
export class SearchBackendTransientError extends Error {
    readonly backendId: SearchBackendId;
    constructor(backendId: SearchBackendId, message: string, options?: { cause?: unknown }) {
        super(`[${backendId}] ${message}`, options);
        this.name = "SearchBackendTransientError";
        this.backendId = backendId;
    }
}

/** How the tool layer picks a backend. Backed by a settings field. */
export type SearchBackendSelection = "auto" | SearchBackendId;

// --- Back-compat aliases used by existing callers ---

/** @deprecated Prefer `SearchMatch`. */
export type RipgrepMatch = SearchMatch;
/** @deprecated Prefer `SearchResult` (note: `backend` field added). */
export type RipgrepSearchResult = Omit<SearchResult, "backend"> & { backend?: SearchBackendId };
/** @deprecated Prefer `SearchOptions`. */
export type RipgrepOptions = SearchOptions;

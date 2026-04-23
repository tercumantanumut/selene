/**
 * Ripgrep Search Backend
 *
 * Thin adapter that implements the SearchBackend interface on top of the
 * existing `lib/ai/ripgrep/ripgrep.ts` binary wrapper. This file intentionally
 * contains no new search logic — it only wires the existing driver into the
 * pluggable backend registry.
 */

import {
    isRipgrepAvailable,
    searchWithRipgrep,
    type RipgrepOptions,
} from "@/lib/ai/ripgrep/ripgrep";
import {
    SearchBackendTransientError,
    SearchBackendUnavailableError,
    type SearchBackend,
    type SearchFeature,
    type SearchOptions,
    type SearchResult,
} from "@/lib/ai/search/types";

const SUPPORTED_FEATURES: ReadonlySet<SearchFeature> = new Set<SearchFeature>([
    "regex",
    "context-lines",
    "column",
    "file-type-filter",
    "glob-filter",
    "gitignore",
    "hidden-files",
]);

/**
 * Classify an error thrown by `searchWithRipgrep`:
 *   - regex parse errors / other stderr-2 failures propagate unchanged so the
 *     tool layer can show a hint and NOT fall back to another backend.
 *   - spawn / IO failures are wrapped in SearchBackendTransientError so the
 *     registry can try the next backend.
 */
function classifyRipgrepError(err: unknown): Error {
    const raw = err instanceof Error ? err : new Error(String(err));
    const msg = raw.message.toLowerCase();

    // User-facing syntax errors bubble up directly — no fallback.
    if (msg.includes("regex parse") || msg.includes("error parsing regex")) {
        return raw;
    }

    // Spawn / IO problems → transient, eligible for fallback.
    if (
        msg.includes("ebadf") ||
        msg.includes("enoent") ||
        msg.includes("spawn") ||
        msg.includes("eacces") ||
        msg.includes("etimedout")
    ) {
        return new SearchBackendTransientError("ripgrep", raw.message, { cause: raw });
    }

    // Unknown errors → surface as-is (caller decides).
    return raw;
}

export class RipgrepBackend implements SearchBackend {
    readonly id = "ripgrep" as const;
    readonly displayName = "Local Grep (ripgrep)";

    async isAvailable(): Promise<boolean> {
        return isRipgrepAvailable();
    }

    supports(feature: SearchFeature): boolean {
        return SUPPORTED_FEATURES.has(feature);
    }

    async search(options: SearchOptions): Promise<SearchResult> {
        if (!isRipgrepAvailable()) {
            throw new SearchBackendUnavailableError(
                "ripgrep",
                "ripgrep binary not found (@vscode/ripgrep not installed correctly).",
            );
        }

        // SearchOptions is a superset of RipgrepOptions; the extra optional
        // fields (gitFilter, rankByFrecency) are intentionally dropped here.
        const rgOptions: RipgrepOptions = {
            pattern: options.pattern,
            paths: options.paths,
            regex: options.regex,
            caseInsensitive: options.caseInsensitive,
            maxResults: options.maxResults,
            fileTypes: options.fileTypes,
            globs: options.globs,
            contextLines: options.contextLines,
            respectGitignore: options.respectGitignore,
            includeHidden: options.includeHidden,
        };

        try {
            const rg = await searchWithRipgrep(rgOptions);
            return {
                matches: rg.matches,
                totalMatches: rg.totalMatches,
                wasTruncated: rg.wasTruncated,
                backend: this.id,
            };
        } catch (err) {
            throw classifyRipgrepError(err);
        }
    }
}

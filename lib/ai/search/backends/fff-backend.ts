/**
 * fff.nvim Search Backend (via @ff-labs/fff-node)
 *
 * Implements SearchBackend using fff's Node SDK. fff maintains a persistent
 * in-process index per workspace root, which sidesteps ripgrep's per-call
 * spawn cost on large repositories.
 *
 * Compatibility rules:
 *   - The package is optional. If it is not installed we report unavailable
 *     and let the caller fall back to ripgrep.
 *   - Explicit file paths are mapped to their parent directory and filtered
 *     back down to the requested file so the public localGrep contract remains
 *     file-or-directory compatible.
 *   - fff always respects .gitignore. When callers explicitly disable that
 *     behavior we surface a backend-unavailable error so localGrep can fall
 *     back to ripgrep without changing semantics.
 *   - Context lines are synthesized from disk and cached per search so we do
 *     not reread the same file for every hit.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
    SearchBackendTransientError,
    SearchBackendUnavailableError,
    type SearchBackend,
    type SearchFeature,
    type SearchMatch,
    type SearchOptions,
    type SearchResult,
} from "@/lib/ai/search/types";

interface FffHit {
    relativePath: string;
    lineNumber: number;
    lineContent: string;
    gitStatus?: string;
    totalFrecencyScore?: number;
    isDefinition?: boolean;
}

interface FffGrepOptions {
    mode?: "plain" | "regex" | "fuzzy";
    caseInsensitive?: boolean;
    pageSize?: number;
    extensions?: string[];
}

interface FffFinderResult<T> {
    value: T;
}

interface FffFinder {
    grep(pattern: string, options?: FffGrepOptions): FffHit[] | Promise<FffHit[]>;
    dispose?(): void | Promise<void>;
    close?(): void | Promise<void>;
    shutdown?(): void | Promise<void>;
}

interface FffModule {
    FileFinder: {
        create(opts: { basePath: string }): FffFinderResult<FffFinder>;
    };
}

interface SearchTarget {
    rootPath: string;
    onlyFilePath?: string;
}

type ContextCache = Map<string, string[] | null>;

const SUPPORTED_FEATURES: ReadonlySet<SearchFeature> = new Set<SearchFeature>([
    "regex",
    "context-lines",
    "file-type-filter",
    "gitignore",
    "git-filter",
    "frecency",
    "definition-priority",
]);

const finderCache = new Map<string, FffFinder>();
let cachedModule: FffModule | null | undefined;

async function loadFff(): Promise<FffModule | null> {
    if (cachedModule !== undefined) return cachedModule;
    try {
        // Optional dependency: resolved dynamically at runtime.
        // @ts-expect-error -- optional dependency may not be installed
        const mod = (await import(/* webpackIgnore: true */ "@ff-labs/fff-node")) as unknown as FffModule;
        cachedModule = mod;
        return mod;
    } catch {
        cachedModule = null;
        return null;
    }
}

function normalize(searchPath: string): string {
    return path.resolve(searchPath);
}

function isRegexSyntaxError(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes("regex parse")
        || normalized.includes("error parsing regex")
        || normalized.includes("invalid regular expression")
        || normalized.includes("unclosed group")
        || normalized.includes("unclosed character class")
        || normalized.includes("unmatched")
        || normalized.includes("repetition")
        || normalized.includes("syntax error in regex");
}

function isTransientFailure(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes("timeout")
        || normalized.includes("timed out")
        || normalized.includes("temporarily unavailable")
        || normalized.includes("eagain")
        || normalized.includes("emfile")
        || normalized.includes("ebusy")
        || normalized.includes("ebadf")
        || normalized.includes("broken pipe");
}

async function resolveSearchTargets(paths: string[]): Promise<SearchTarget[]> {
    const targets: SearchTarget[] = [];

    for (const candidatePath of paths) {
        const absoluteCandidate = normalize(candidatePath);
        let stat;
        try {
            stat = await fs.stat(absoluteCandidate);
        } catch (err) {
            throw new Error(
                `Search path is not accessible: ${absoluteCandidate}. ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        if (stat.isDirectory()) {
            targets.push({ rootPath: absoluteCandidate });
            continue;
        }

        if (stat.isFile()) {
            targets.push({
                rootPath: path.dirname(absoluteCandidate),
                onlyFilePath: absoluteCandidate,
            });
            continue;
        }

        throw new Error(`Search path must be a file or directory: ${absoluteCandidate}`);
    }

    return targets;
}

async function getFinder(rootPath: string): Promise<FffFinder> {
    const key = normalize(rootPath);
    const cached = finderCache.get(key);
    if (cached) return cached;

    const mod = await loadFff();
    if (!mod) {
        throw new SearchBackendUnavailableError(
            "fff",
            "@ff-labs/fff-node is not installed; fff backend is unavailable.",
        );
    }

    const handle = mod.FileFinder.create({ basePath: key });
    const finder = handle.value;
    finderCache.set(key, finder);
    return finder;
}

async function getFileLines(
    absolutePath: string,
    cache: ContextCache,
): Promise<string[] | null> {
    const key = normalize(absolutePath);
    if (cache.has(key)) {
        return cache.get(key) ?? null;
    }

    try {
        const content = await fs.readFile(key, "utf8");
        const lines = content.split(/\r?\n/);
        cache.set(key, lines);
        return lines;
    } catch {
        cache.set(key, null);
        return null;
    }
}

async function readContext(
    absolutePath: string,
    line: number,
    contextLines: number,
    cache: ContextCache,
): Promise<{ before: string[]; after: string[] }> {
    if (contextLines <= 0) return { before: [], after: [] };

    const lines = await getFileLines(absolutePath, cache);
    if (!lines) return { before: [], after: [] };

    const idx = line - 1;
    return {
        before: lines.slice(Math.max(0, idx - contextLines), idx),
        after: lines.slice(idx + 1, idx + 1 + contextLines),
    };
}

function computeColumn(lineText: string, pattern: string, isRegex: boolean, caseInsensitive: boolean): number | undefined {
    if (!lineText || !pattern) return undefined;

    try {
        if (isRegex) {
            const flags = caseInsensitive ? "i" : "";
            const match = new RegExp(pattern, flags).exec(lineText);
            return match ? match.index : undefined;
        }

        const haystack = caseInsensitive ? lineText.toLowerCase() : lineText;
        const needle = caseInsensitive ? pattern.toLowerCase() : pattern;
        const idx = haystack.indexOf(needle);
        return idx >= 0 ? idx : undefined;
    } catch {
        return undefined;
    }
}

function classifyFinderError(rootPath: string, err: unknown): Error {
    if (err instanceof SearchBackendUnavailableError) {
        return err;
    }

    const raw = err instanceof Error ? err : new Error(String(err));
    if (isTransientFailure(raw.message)) {
        return new SearchBackendTransientError(
            "fff",
            `Failed to open finder for ${rootPath}: ${raw.message}`,
            { cause: raw },
        );
    }

    return raw;
}

function classifyGrepError(rootPath: string, err: unknown, regex: boolean): Error {
    const raw = err instanceof Error ? err : new Error(String(err));
    if (regex && isRegexSyntaxError(raw.message)) {
        return raw;
    }

    if (isTransientFailure(raw.message)) {
        return new SearchBackendTransientError(
            "fff",
            `grep failed in ${rootPath}: ${raw.message}`,
            { cause: raw },
        );
    }

    return raw;
}

async function disposeFinder(finder: FffFinder): Promise<void> {
    if (typeof finder.dispose === "function") {
        await finder.dispose();
        return;
    }
    if (typeof finder.close === "function") {
        await finder.close();
        return;
    }
    if (typeof finder.shutdown === "function") {
        await finder.shutdown();
    }
}

export class FffBackend implements SearchBackend {
    readonly id = "fff" as const;
    readonly displayName = "Local Search (fff)";

    async isAvailable(): Promise<boolean> {
        const mod = await loadFff();
        return mod !== null;
    }

    supports(feature: SearchFeature): boolean {
        return SUPPORTED_FEATURES.has(feature);
    }

    async prepare(workspacePaths: string[]): Promise<void> {
        const targets = await resolveSearchTargets(workspacePaths).catch(() => [] as SearchTarget[]);
        for (const target of targets) {
            try {
                await getFinder(target.rootPath);
            } catch {
                // Best-effort warmup only; search() will surface the user-facing error.
            }
        }
    }

    async dispose(): Promise<void> {
        const finders = Array.from(finderCache.values());
        finderCache.clear();
        await Promise.allSettled(finders.map((finder) => disposeFinder(finder)));
    }

    async search(options: SearchOptions): Promise<SearchResult> {
        if (!options.paths.length) {
            return { matches: [], totalMatches: 0, wasTruncated: false, backend: this.id };
        }

        if (!(await this.isAvailable())) {
            throw new SearchBackendUnavailableError(
                "fff",
                "@ff-labs/fff-node is not installed; cannot use fff backend.",
            );
        }

        if (options.respectGitignore === false) {
            throw new SearchBackendUnavailableError(
                "fff",
                "fff backend always respects .gitignore. Use ripgrep when localGrepRespectGitignore is false.",
            );
        }

        const {
            pattern,
            paths,
            regex = false,
            caseInsensitive = true,
            maxResults = 20,
            fileTypes,
            contextLines = 0,
            rankByFrecency = false,
        } = options;

        const targets = await resolveSearchTargets(paths);

        // Coalesce targets that share a rootPath so we don't grep the same
        // directory once per requested file. A root that has ANY directory-level
        // target (no onlyFilePath) is treated as dir-wide; otherwise we filter
        // hits down to the set of explicit file paths.
        const groupedByRoot = new Map<string, { rootPath: string; fileFilter: Set<string> | null }>();
        for (const target of targets) {
            const existing = groupedByRoot.get(target.rootPath);
            if (existing) {
                if (existing.fileFilter !== null) {
                    if (target.onlyFilePath) {
                        existing.fileFilter.add(target.onlyFilePath);
                    } else {
                        // Mix of file + dir target for same root → dir-wide wins.
                        existing.fileFilter = null;
                    }
                }
                continue;
            }
            groupedByRoot.set(target.rootPath, {
                rootPath: target.rootPath,
                fileFilter: target.onlyFilePath ? new Set([target.onlyFilePath]) : null,
            });
        }

        const contextCache: ContextCache = new Map();
        const allHits: Array<{ hit: FffHit; absoluteFile: string }> = [];

        for (const group of groupedByRoot.values()) {
            let finder: FffFinder;
            try {
                finder = await getFinder(group.rootPath);
            } catch (err) {
                throw classifyFinderError(group.rootPath, err);
            }

            let hits: FffHit[];
            try {
                // When ranking by frecency we need to see enough hits to rank
                // fairly across all targets; otherwise a bounded page is fine.
                const pageSize = rankByFrecency
                    ? Math.max(maxResults * 4, 64)
                    : Math.max(1, maxResults * 2);
                const rawHits = await finder.grep(pattern, {
                    mode: regex ? "regex" : "plain",
                    caseInsensitive,
                    pageSize,
                    extensions: fileTypes && fileTypes.length > 0 ? fileTypes : undefined,
                });
                hits = Array.isArray(rawHits) ? rawHits : [];
            } catch (err) {
                throw classifyGrepError(group.rootPath, err, regex);
            }

            for (const hit of hits) {
                const absoluteFile = path.isAbsolute(hit.relativePath)
                    ? normalize(hit.relativePath)
                    : normalize(path.join(group.rootPath, hit.relativePath));

                if (group.fileFilter && !group.fileFilter.has(absoluteFile)) {
                    continue;
                }

                allHits.push({ hit, absoluteFile });
            }
        }

        const totalMatches = allHits.length;

        // Truncation order matters: when ranking by frecency we must sort the
        // FULL hit set before slicing, otherwise higher-scoring hits that
        // happened to come later can never surface.
        let selected: Array<{ hit: FffHit; absoluteFile: string }>;
        if (rankByFrecency) {
            const sorted = allHits.slice().sort((a, b) => {
                return (b.hit.totalFrecencyScore ?? 0) - (a.hit.totalFrecencyScore ?? 0);
            });
            selected = sorted.slice(0, maxResults);
        } else {
            selected = allHits.slice(0, maxResults);
        }

        const matches: SearchMatch[] = [];
        for (const { hit, absoluteFile } of selected) {
            const text = (hit.lineContent ?? "").replace(/\s+$/, "");
            const context = await readContext(absoluteFile, hit.lineNumber, contextLines, contextCache);

            matches.push({
                file: absoluteFile,
                line: hit.lineNumber,
                column: computeColumn(text, pattern, regex, caseInsensitive),
                text,
                beforeContext: context.before,
                afterContext: context.after,
                gitStatus: normalizeGitStatus(hit.gitStatus),
                frecencyScore: hit.totalFrecencyScore,
                isDefinition: hit.isDefinition,
            });
        }

        return {
            matches,
            totalMatches,
            wasTruncated: totalMatches > matches.length,
            backend: this.id,
        };
    }
}

function normalizeGitStatus(raw?: string): SearchMatch["gitStatus"] {
    if (!raw) return undefined;
    const value = raw.toLowerCase();
    if (
        value === "modified"
        || value === "staged"
        || value === "untracked"
        || value === "ignored"
        || value === "deleted"
        || value === "renamed"
    ) {
        return value;
    }
    return undefined;
}

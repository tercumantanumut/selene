/**
 * Resolve TypeScript path aliases from a synced folder's `tsconfig.json`
 * for use as an esbuild plugin during design-workspace component imports.
 *
 * Why this exists: when a user imports a real `.tsx` file from their
 * codebase via the design-workspace `import` action, the file may
 * reference path aliases like `import { cn } from "@/lib/utils"`.
 * esbuild's default resolver does not know about these aliases unless we
 * wire them in. This module reads the source file's owning synced
 * folder's `tsconfig.json`, extracts `compilerOptions.paths` and
 * `baseUrl`, and exposes an esbuild plugin that intercepts matching
 * import specifiers and rewrites them to absolute filesystem paths.
 *
 * Scope:
 *   - Only the `import` action threads `tsconfigPaths` through to the
 *     compiler. `generate` / `edit` / `patch` keep the historical
 *     resolver behavior because their source comes from the LLM, which
 *     is steered to use bare-package imports rather than host aliases.
 *   - We use the TypeScript compiler API (`ts.readConfigFile` +
 *     `ts.parseJsonConfigFileContent`) rather than a hand-rolled JSON
 *     parser so `extends` chains and JSON-with-comments are handled
 *     identically to how the host project itself reads them.
 */

import { existsSync, statSync } from "fs";
import { dirname, isAbsolute, normalize, resolve, sep } from "path";
import * as esbuild from "esbuild";
import ts from "typescript";

export interface TsconfigPathsConfig {
  /** Absolute filesystem path the `paths` targets are resolved against. */
  baseUrl: string;
  /** TS-style path alias map, e.g. `{ "@/*": ["./*"] }`. */
  paths: Record<string, string[]>;
}

// File extension probe order. Mirrors the TS bundler-resolution heuristic:
// try the literal target first, then explicit extensions, then directory
// `index.*` candidates. Kept narrow to the file types we actually expect
// inside a synced folder — node_modules-style probing is delegated to
// esbuild's own resolver via the `nodePaths` build option.
const FILE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
] as const;
const INDEX_CANDIDATES = [
  "/index.ts",
  "/index.tsx",
  "/index.mts",
  "/index.cts",
  "/index.js",
  "/index.jsx",
] as const;

/**
 * Find the synced folder that contains `resolvedFilePath`, returning the
 * longest matching prefix from `syncedFolders`. Returns `null` when the
 * file lives outside every candidate folder. Used by the import handler
 * to decide which folder's `tsconfig.json` to load.
 *
 * Longest-prefix match is required because synced folders can nest
 * (`/repo` and `/repo/sub`); the closer parent owns the file's alias
 * configuration.
 */
export function findOwningSyncedFolder(
  resolvedFilePath: string,
  syncedFolders: readonly string[],
): string | null {
  const normalizedFile = normalize(resolvedFilePath);
  let best: string | null = null;
  for (const folder of syncedFolders) {
    const normalizedFolder = normalize(folder);
    const withSep = normalizedFolder.endsWith(sep)
      ? normalizedFolder
      : `${normalizedFolder}${sep}`;
    if (
      normalizedFile === normalizedFolder ||
      normalizedFile.startsWith(withSep)
    ) {
      if (best === null || normalizedFolder.length > best.length) {
        best = normalizedFolder;
      }
    }
  }
  return best;
}

/**
 * Read `<folderRoot>/tsconfig.json` (and its `extends` chain) using the
 * TypeScript compiler API, returning the merged `paths` map and an
 * absolute `baseUrl`. Returns `null` when the tsconfig is missing,
 * malformed, or carries no `paths` config — a `null` result tells the
 * caller to skip installing the esbuild plugin entirely (no tsconfig
 * means no aliases means nothing to resolve).
 *
 * `baseUrl` falls back to the tsconfig directory when the file omits
 * `baseUrl` explicitly. That matches the implicit behavior under
 * `moduleResolution: "bundler"` (the resolution used by Next.js et al.,
 * where `baseUrl` is the implicit `./` next to the tsconfig).
 */
export function loadTsconfigPaths(
  folderRoot: string,
): TsconfigPathsConfig | null {
  const configPath = resolve(folderRoot, "tsconfig.json");
  if (!existsSync(configPath)) {
    return null;
  }
  const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
  if (readResult.error) {
    return null;
  }
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    folderRoot,
    {},
    configPath,
  );
  const paths = parsed.options.paths;
  if (!paths || Object.keys(paths).length === 0) {
    return null;
  }
  const baseUrl = parsed.options.baseUrl
    ? parsed.options.baseUrl
    : dirname(configPath);
  return { baseUrl, paths };
}

interface CompiledRule {
  /**
   * RegExp matching a full import specifier, anchored. When `hasWildcard`
   * is true, capture group 1 contains the wildcard tail.
   */
  match: RegExp;
  /** Concrete path templates with optional `*` placeholder. */
  targets: string[];
  /** Whether the rule contains a single `*` wildcard. */
  hasWildcard: boolean;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileRules(paths: Record<string, string[]>): CompiledRule[] {
  const rules: CompiledRule[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const star = pattern.indexOf("*");
    if (star === -1) {
      rules.push({
        match: new RegExp(`^${escapeRegExp(pattern)}$`),
        targets,
        hasWildcard: false,
      });
      continue;
    }
    if (pattern.indexOf("*", star + 1) !== -1) {
      // TS spec: only one wildcard per pattern. Skip malformed entries
      // rather than throwing — a bad tsconfig should not block the
      // whole import action; the unmatched specifier will surface as a
      // normal "Could not resolve" error from esbuild's default
      // resolver, which is the expected fall-through.
      continue;
    }
    const head = escapeRegExp(pattern.slice(0, star));
    const tail = escapeRegExp(pattern.slice(star + 1));
    rules.push({
      match: new RegExp(`^${head}(.*)${tail}$`),
      targets,
      hasWildcard: true,
    });
  }
  // Longest pattern first — more specific aliases win over generic ones
  // (TS spec: e.g. `@/foo/*` beats `@/*` for `@/foo/bar`).
  rules.sort((a, b) => b.match.source.length - a.match.source.length);
  return rules;
}

function tryResolveCandidate(candidate: string): string | null {
  for (const ext of FILE_EXTENSIONS) {
    const withExt = candidate + ext;
    try {
      if (existsSync(withExt) && statSync(withExt).isFile()) {
        return withExt;
      }
    } catch {
      // statSync can throw on permission errors / dangling symlinks; treat
      // those as "not a candidate" rather than aborting resolution.
    }
  }
  for (const idx of INDEX_CANDIDATES) {
    const withIdx = candidate + idx;
    try {
      if (existsSync(withIdx) && statSync(withIdx).isFile()) {
        return withIdx;
      }
    } catch {
      // see above
    }
  }
  return null;
}

/**
 * Build an esbuild plugin that resolves TypeScript path-alias imports
 * against the supplied `baseUrl` and `paths` map. The plugin only fires
 * for specifiers that match a configured pattern, so unrelated bare
 * package imports (`react`, `framer-motion`) fall through to esbuild's
 * default resolver.
 *
 * When a pattern matches but no candidate file exists on disk, the
 * plugin returns `null` so esbuild emits its usual "Could not resolve"
 * error. Silently swallowing the failure would mask typos in the user's
 * source (e.g. `@/lib/utlis` instead of `@/lib/utils`).
 */
export function createTsconfigPathsPlugin(
  config: TsconfigPathsConfig,
): esbuild.Plugin {
  const rules = compileRules(config.paths);
  if (rules.length === 0) {
    return { name: "selene-tsconfig-paths-noop", setup() {} };
  }
  // Build a single combined filter so esbuild only invokes our hook on
  // specifiers that have at least one matching alias. Each rule's
  // anchored pattern is wrapped in a non-capturing group, then re-anchored
  // around the union — keeps the per-call cost roughly constant in the
  // number of aliases.
  const innerSources = rules
    .map((r) => `(?:${r.match.source.replace(/^\^/, "").replace(/\$$/, "")})`)
    .join("|");
  const combined = new RegExp(`^(?:${innerSources})$`);
  return {
    name: "selene-tsconfig-paths",
    setup(build) {
      build.onResolve({ filter: combined }, (args) => {
        for (const rule of rules) {
          const m = rule.match.exec(args.path);
          if (!m) continue;
          const wildcardTail = rule.hasWildcard ? m[1] : "";
          for (const target of rule.targets) {
            const concrete = rule.hasWildcard
              ? target.replace("*", wildcardTail)
              : target;
            const absolute = isAbsolute(concrete)
              ? concrete
              : resolve(config.baseUrl, concrete);
            const found = tryResolveCandidate(absolute);
            if (found) return { path: found };
          }
          // Pattern matched but no candidate file existed — let esbuild
          // surface its own "Could not resolve" error for visibility.
          return null;
        }
        return null;
      });
    },
  };
}

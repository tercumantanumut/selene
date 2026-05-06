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

import { existsSync, readFileSync, statSync } from "fs";
import { dirname, extname, isAbsolute, normalize, resolve, sep } from "path";
import * as esbuild from "esbuild";
import ts from "typescript";
import {
  assertContained,
  type ContainmentConfig,
} from "./containment";

export interface TsconfigPathsConfig {
  /** Absolute filesystem path the `paths` targets are resolved against. */
  baseUrl: string;
  /** TS-style path alias map, e.g. `{ "@/*": ["./*"] }`. */
  paths: Record<string, string[]>;
}

/**
 * Lightweight pattern test for "does this import specifier match a tsconfig
 * paths rule?". Used by `dependencies.ts` to skip alias-matching specifiers
 * during the missing-package check (esbuild's tsconfig-paths plugin will
 * resolve them at bundle time, so we don't want them flagged as missing
 * npm packages) and by the compiler's resolution-error classifier to give
 * the agent an alias-aware suggestion when an alias target is missing.
 *
 * Mirrors the matching rules `compileRules` uses, but only returns a
 * boolean — no compiled regex / file probe — because callers either
 * already know they will rely on the plugin or are reporting an error.
 */
export function tsconfigAliasMatches(
  target: string,
  tsconfigPaths: TsconfigPathsConfig,
): boolean {
  for (const pattern of Object.keys(tsconfigPaths.paths)) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (target === pattern) return true;
      continue;
    }
    if (pattern.indexOf("*", star + 1) !== -1) continue; // malformed
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    if (
      target.startsWith(head) &&
      target.endsWith(tail) &&
      target.length >= head.length + tail.length
    ) {
      return true;
    }
  }
  return false;
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
 * Matched aliases are loaded through a plugin namespace so relative imports
 * inside aliased project files keep resolving from the original synced project
 * location rather than the preview virtual-module directory.
 *
 * When a pattern matches but no candidate file exists on disk, the
 * plugin returns `null` so esbuild emits its usual "Could not resolve"
 * error. Silently swallowing the failure would mask typos in the user's
 * source (e.g. `@/lib/utlis` instead of `@/lib/utils`).
 *
 * Round-2 containment guard: when `containment` is supplied, every
 * resolved alias target is validated against the allowed-roots snapshot
 * BEFORE the file is loaded. A `tsconfig.paths` rule with an absolute
 * target (`["/etc/passwd/*"]`) or a parent-walking target
 * (`["../../outside/*"]`) that escapes the synced folder is refused with
 * a `ContainmentViolationError` instead of silently leaking out. Same
 * guard runs in the namespace onLoad as defense-in-depth in case the
 * plugin is ever extended to accept paths from another source.
 */
export function createTsconfigPathsPlugin(
  config: TsconfigPathsConfig,
  containment?: ContainmentConfig,
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
            if (found) {
              // Containment check: refuse to load the alias target if it
              // resolves outside the synced-folder containment roots. We
              // throw rather than fall through so the agent sees a
              // structured `CONTAINMENT_VIOLATION` instead of a generic
              // "could not resolve" — the misconfigured paths rule is
              // the actionable cause.
              if (containment) {
                assertContained(found, containment, args.path);
              }
              return { path: found, namespace: "selene-tsconfig-paths" };
            }
          }
          // Pattern matched but no candidate file existed — let esbuild
          // surface its own "Could not resolve" error for visibility.
          return null;
        }
        return null;
      });

      build.onLoad({ filter: /.*/, namespace: "selene-tsconfig-paths" }, (args) => {
        // Defense-in-depth: re-assert containment at load time. The
        // onResolve hook already validates, but plugins may be extended
        // later to accept paths from elsewhere; keeping the guard here
        // means no future change can sneak past containment without
        // explicitly disabling this check.
        if (containment) {
          assertContained(args.path, containment);
        }
        const extension = extname(args.path).toLowerCase();
        const loader: esbuild.Loader =
          extension === ".tsx" ? "tsx" :
          extension === ".jsx" ? "jsx" :
          extension === ".json" ? "json" :
          extension === ".js" || extension === ".mjs" || extension === ".cjs" ? "js" :
          "ts";
        return {
          contents: readFileSync(args.path, "utf8"),
          loader,
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}

/**
 * Sandbox containment guard for the design-workspace `import` pipeline.
 *
 * Why this exists: the `import` action threads `componentResolveDir` through
 * to esbuild so the user's TSX can import sibling files (`./coach.css`),
 * tsconfig-aliased modules (`@/lib/utils`), and synced-repo `node_modules`.
 * Without an explicit containment guard, those resolutions can escape the
 * synced folder via:
 *   - A relative import that walks above the source file (`../../outside`).
 *   - A tsconfig.paths target that's absolute (`/etc/passwd/*`) or walks
 *     past the tsconfig directory (`["../../outside/*"]`).
 *   - A CSS `@import` or `url(...)` whose path resolves outside the source
 *     CSS file's directory.
 *
 * The guard answers the single question "is this absolute path inside any
 * of the allowed roots?" — if no, the load is refused with a structured
 * `ContainmentViolationError`. The error is unwrapped from esbuild's error
 * envelope by the compile catch block (same pattern as
 * DesignWorkspaceImportError) and surfaced as a classified compile-report
 * issue (kind=`containment`) so the agent gets an actionable hint instead
 * of a raw resolution failure.
 *
 * Allowed roots for an `import` compile:
 *   - The owning synced folder — every transitive source / CSS read.
 *   - The host project's `node_modules` — react/react-dom shims.
 *   - The sandbox `node_modules` — curated workspace deps.
 *   - The synced repo's own `node_modules` — pragmatic fallback the
 *     `import` action enables via `extraNodePaths`.
 *
 * For `generate` / `edit` / `patch` the import action threads `undefined`
 * (no containment config) because those flows don't read any synced file —
 * the source is LLM-emitted and lives only in memory, so there's nothing
 * to escape from. The guard is then a no-op.
 */

import { isAbsolute, normalize, resolve, sep } from "path";

/**
 * Plugin error code thrown when a file load lands outside every allowed
 * containment root. Mirrors the shape of DesignWorkspaceImportError so the
 * compile catch block can unwrap it from esbuild's error envelope and
 * forward it as a structured compile-report issue.
 */
export class ContainmentViolationError extends Error {
  readonly code = "CONTAINMENT_VIOLATION" as const;
  constructor(
    /** Absolute path that violated containment. */
    public readonly absPath: string,
    /** Snapshot of the allowed roots at the time of the violation. */
    public readonly allowedRoots: readonly string[],
    /** Specifier as written in the source (when known). */
    public readonly specifier?: string,
  ) {
    super(
      `Path "${absPath}" is outside the design-import containment roots ` +
        `(${allowedRoots.join(", ")}). The design-workspace import pipeline ` +
        `restricts reads to the owning synced folder and curated node_modules ` +
        `roots; relative or aliased paths that escape those roots are refused.`,
    );
    this.name = "ContainmentViolationError";
  }
}

/**
 * Containment configuration handed to esbuild plugins. `allowedRoots` is a
 * snapshot of absolute, normalized paths — callers are responsible for
 * normalization at the boundary so plugins do not silently accept
 * `..`-walking entries from internal callers.
 */
export interface ContainmentConfig {
  /** Absolute, normalized paths that are allowed read targets. */
  readonly allowedRoots: readonly string[];
}

function ensureNormalizedAbsolute(p: string): string {
  if (!isAbsolute(p)) {
    // The caller passed a relative path. Resolve against cwd as a defense
    // against silent containment bypass — a relative root would otherwise
    // turn into an unbounded prefix match against `args.path`.
    return normalize(resolve(p));
  }
  return normalize(p);
}

/**
 * Build a containment config from a list of candidate roots. Filters out
 * empty / duplicate values, normalizes each entry, and returns a frozen
 * snapshot. Pass through `null` / `undefined` entries (callers may have
 * conditional roots like the synced repo's `node_modules`).
 */
export function buildContainmentConfig(
  candidateRoots: readonly (string | null | undefined)[],
): ContainmentConfig {
  const allowedRoots = Array.from(
    new Set(
      candidateRoots
        .filter((root): root is string => typeof root === "string" && root.length > 0)
        .map(ensureNormalizedAbsolute),
    ),
  );
  return { allowedRoots: Object.freeze(allowedRoots) };
}

function isUnderRoot(absPath: string, root: string): boolean {
  // Both inputs are already normalized — `normalize()` is idempotent so an
  // extra call is cheap defensive insurance against unnormalized roots
  // sneaking in through future callers.
  const normPath = normalize(absPath);
  const normRoot = normalize(root);
  if (normPath === normRoot) return true;
  const withSep = normRoot.endsWith(sep) ? normRoot : `${normRoot}${sep}`;
  return normPath.startsWith(withSep);
}

/** Pure predicate — useful for plugins that prefer to fall through (return
 *  `undefined` from onResolve) rather than throw on a containment miss. */
export function isContained(
  absPath: string,
  config: ContainmentConfig,
): boolean {
  return config.allowedRoots.some((root) => isUnderRoot(absPath, root));
}

/**
 * Throws `ContainmentViolationError` when `absPath` is outside every
 * allowed root. Plugins should call this immediately before reading the
 * file from disk so violations surface BEFORE any side-effect.
 */
export function assertContained(
  absPath: string,
  config: ContainmentConfig,
  specifier?: string,
): void {
  if (!isContained(absPath, config)) {
    throw new ContainmentViolationError(absPath, config.allowedRoots, specifier);
  }
}

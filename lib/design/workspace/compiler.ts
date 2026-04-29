/**
 * Server-side React/TSX component compiler.
 *
 * Uses esbuild to bundle a preview entry plus the user component into a single
 * self-executing browser script. The component module is compiled as-is and
 * imported through an esbuild virtual module, so the preview pipeline does not
 * rewrite or regex-transform the model output.
 */

import * as esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import type { Config } from "tailwindcss";
import { basename, extname, resolve } from "path";
import { createHash } from "crypto";
import { SANDBOX_DIR, SANDBOX_NODE_MODULES } from "../libraries";
// Synced-folder reads go through `readSyncedFile()` — never raw
// `fs.readFile` — per the BA-4 constraint. The helper bundles the
// containment check + stable error codes.
import {
  readSyncedFile,
  isReadSyncedFileError,
} from "../../ai/filesystem/read-utils";
// Source-level import (no barrel) per Sprint 4 hard constraint — the
// resolver pulls the helper directly from `queries.ts`.
import { findWorkspaceDesignByIdOrTag } from "../gallery/queries";

// Derive the workspace folder name from the canonical SANDBOX_DIR constant
// rather than re-typing the literal "selene-workspace" inside suggestion
// strings. This keeps diagnostic suggestions in sync if the sandbox name is
// ever changed in `lib/design/libraries.ts` and removes the duplicated literal
// flagged in commit 0aff3a43 review.
const SANDBOX_DIR_NAME = basename(SANDBOX_DIR);
import { getProjectRoot } from "../../utils/project-root";
import {
  installSandboxPackages,
  validateWorkspaceDependencies,
  type DependencyValidationResult,
  type DependencyInstallResult,
} from "./dependencies";
import {
  createTsconfigPathsPlugin,
  type TsconfigPathsConfig,
} from "./tsconfig-paths";
import {
  type DesignWorkspaceAutoInstallSummary,
  type DesignWorkspaceCompilationIssue,
  type DesignWorkspaceCompileReport,
  type DesignWorkspaceDependencySummary,
  type DesignWorkspaceDiagnostic,
} from "./config";
import type { DesignPreviewTheme } from "./types";
import { logToolEvent } from "@/lib/ai/tool-registry/logging";
import { escapeHtml } from "./preview";
// Turbopack needs a static import it can trace in server bundles.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- CJS config is loaded as the module default at runtime
import previewTailwindConfig from "../../../tailwind.preview.config.cjs";

const VIRTUAL_COMPONENT_PATH = "__selene_preview_component__";
const VIRTUAL_COMPONENT_NAMESPACE = "selene-preview-component";
const COMPILE_TIMEOUT_MS = 15_000;
const TAILWIND_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Sprint 4 W4.2 — cross-component composition virtual-module resolver.
//
// The compiler recognises `design:<ref>` import specifiers and resolves them
// to other workspace components owned by the current (userId, sessionId).
// The namespace below is used by the esbuild plugin's onResolve / onLoad
// hooks so nested bundles do not collide with the top-level virtual
// component or the external-URL plugin.
// ---------------------------------------------------------------------------
const DESIGN_IMPORT_PREFIX = "design:";
const DESIGN_IMPORT_NAMESPACE = "design-workspace";

/** Stable error codes surfaced on the tool envelope when a `design:<ref>`
 *  import cannot be resolved, belongs to another scope, or participates in
 *  an import cycle. Exported so the tool handler + bridge + tool-UI can
 *  reuse the string union instead of duplicating literals. */
export type DesignImportErrorCode =
  | "IMPORT_NOT_FOUND"
  | "IMPORT_SCOPE_VIOLATION"
  | "IMPORT_CYCLE_DETECTED";

/** Thrown when a `design:<ref>` specifier cannot be resolved within the
 *  current (userId, sessionId) scope, belongs to another scope, or closes
 *  an import cycle. The error bubbles out of the onLoad callback and is
 *  caught by the tool handler, which maps `code` into a structured
 *  envelope field so the agent can act on the failure. */
export class DesignWorkspaceImportError extends Error {
  readonly code: DesignImportErrorCode;
  /** The raw `<ref>` portion of the `design:<ref>` specifier as it appeared
   *  in the source — echoed back verbatim for agent-readable diagnostics. */
  readonly ref: string;
  /** The chain of (resolved) component ids traversed before the failure,
   *  ordered from the top-level compile target down to the offending
   *  import. Included on cycles so the agent can see exactly which rows
   *  participated. Empty on the top-level compile's first resolve. */
  readonly chain: string[];
  /** Rev-J1 (Sprint 4 W4.2 revision) — resolved component id at the point
   *  of failure, when known. Populated on IMPORT_CYCLE_DETECTED (always the
   *  head-of-cycle id, i.e. the last entry of `chain`) and left undefined
   *  on IMPORT_NOT_FOUND (no resolution happened) and IMPORT_SCOPE_VIOLATION
   *  (the loader rejected the ref before the compiler saw a row). The
   *  Backend Architect's H2 review called for a distinct `resolvedId`
   *  field alongside the `attemptedRef` so the agent can tell which
   *  concrete component row closed the loop, independent of how it was
   *  referenced (id vs name alias). */
  readonly resolvedId?: string;

  constructor(
    code: DesignImportErrorCode,
    ref: string,
    message: string,
    chain: string[] = [],
    resolvedId?: string,
  ) {
    super(message);
    this.name = "DesignWorkspaceImportError";
    this.code = code;
    this.ref = ref;
    this.chain = chain;
    this.resolvedId = resolvedId;
  }
}

export function isDesignWorkspaceImportError(
  error: unknown,
): error is DesignWorkspaceImportError {
  return error instanceof DesignWorkspaceImportError;
}

/** Minimal loader contract used by the `design:<ref>` resolver. Kept tiny
 *  (single method, no row shape surfaced) so the compiler doesn't reach
 *  into the gallery module directly — tests can swap in an in-memory stub
 *  without touching the sqlite client. Rows are identified by their `id`
 *  so cycle detection is stable regardless of how the caller referenced
 *  the component (by id or by name alias). */
export interface DesignImportLoader {
  /** Resolve a `design:<ref>` specifier to `{ id, sourceCode }` for the
   *  given (userId, sessionId). Returns `null` when no row in scope
   *  matches — the compiler treats null as `IMPORT_NOT_FOUND` and
   *  intentionally does NOT distinguish cross-scope hits from true
   *  misses (the backing query already collapses both cases to null so
   *  existence never leaks). */
  findByRef(input: {
    userId: string;
    sessionId: string;
    ref: string;
  }): Promise<{ id: string; sourceCode: string } | null>;
}

/**
 * W3.4 — maximum `renderMany` cells accepted at the tool boundary.
 *
 * Exceeding this limit surfaces `errorCode: "RENDER_MANY_TOO_MANY"` at the
 * tool handler before the compiler is invoked, so the compiler itself
 * never sees oversized input. Lives here (not in the tool file) so the
 * compiler + tool share one source of truth and the test suite can
 * import it without pulling the whole tool module.
 */
export const RENDER_MANY_MAX_CELLS = 24;

/**
 * W3.4 — one cell in a `renderMany` grid, post-validation.
 *
 * `props` is an opaque JSON-serializable bag forwarded to the component
 * as its full prop set for the cell. `label` renders above the cell and
 * `className` attaches to the cell wrapper (for per-cell backgrounds,
 * borders, etc).
 *
 * Deliberately NOT a "variants DSL": the agent supplies the full array
 * of render specs — the compiler does NOT infer permutations from the
 * component's prop types. Keeping the primitive low-level is the whole
 * point (see W3.4 anti-scope).
 */
export interface RenderManyCell {
  props: Record<string, unknown>;
  label?: string;
  className?: string;
}

/**
 * Maximum accepted size (in bytes) for a user-provided globals.css. Anything
 * larger is rejected with `GLOBALS_CSS_TOO_LARGE` rather than inlined — the
 * preview document already carries compiled Tailwind output plus the sandboxed
 * component bundle, so a runaway globals.css would blow past the AI SDK tool
 * result token cap (see `SLIM_RESULT_SAFETY_CAP` in the tool file).
 *
 * Kept as an exported constant (no indirection through a settings key) because
 * W2.4 explicitly calls for a "config constant" — one source of truth for the
 * limit, easy to grep for, bumpable via a single edit if a real app's
 * globals.css genuinely needs more headroom.
 */
export const GLOBALS_CSS_MAX_BYTES = 256 * 1024;

/** Stable error codes surfaced on the tool envelope when globals.css
 * resolution / validation fails. See `GlobalsCssResolutionError.code`. */
export type GlobalsCssErrorCode =
  | "GLOBALS_CSS_NOT_FOUND"
  | "GLOBALS_CSS_EMPTY"
  | "GLOBALS_CSS_NOT_CSS"
  | "GLOBALS_CSS_TOO_LARGE";

/**
 * Thrown by `resolveAndReadGlobalsCss` when a caller-provided
 * `globalsCssPath` cannot be turned into an injectable CSS payload. The
 * tool handler catches this and maps it to a structured
 * `data.globalsCssError` field so the agent can act on the failure without
 * parsing the human-readable `error` string.
 *
 * The error carries the original `path` (as-provided by the agent, not the
 * resolved absolute path) so logs / envelopes stay agent-relative and do
 * not leak host filesystem layout.
 */
export class DesignWorkspaceGlobalsCssError extends Error {
  readonly code: GlobalsCssErrorCode;
  readonly path: string;
  readonly bytes?: number;
  readonly limit?: number;

  constructor(
    code: GlobalsCssErrorCode,
    path: string,
    message: string,
    extras: { bytes?: number; limit?: number } = {},
  ) {
    super(message);
    this.name = "DesignWorkspaceGlobalsCssError";
    this.code = code;
    this.path = path;
    this.bytes = extras.bytes;
    this.limit = extras.limit;
  }
}

export interface ResolvedGlobalsCss {
  /** Agent-provided synced-folder-relative path (echoed, not the absolute path). */
  path: string;
  /** Raw CSS contents read from disk. */
  contents: string;
  /** Size in bytes (pre-injection). Kept for logging / cache diagnostics. */
  bytes: number;
  /** Short SHA-256 hex digest of `contents`, stamped on the preview document
   *  via `data-globals-css-hash` so screenshot tooling can detect changes
   *  across compiles without re-reading the file. */
  hash: string;
}

/**
 * Resolve a synced-folder-relative path, read the CSS file, and validate it
 * for inline injection into the preview document. Does NOT cache across calls
 * in v1 — each compile re-reads the file so mutating the real app's
 * globals.css produces an up-to-date preview on the next tool invocation.
 * TODO(perf): memoize by `(validPath, mtime)` if globals.css reads become a
 * hot path. A per-request cache is safe because the hash stamp will always
 * surface staleness to screenshot consumers.
 */
export async function resolveAndReadGlobalsCss(args: {
  globalsCssPath: string;
  characterId: string;
  sessionId: string;
}): Promise<ResolvedGlobalsCss> {
  const { globalsCssPath, characterId, sessionId } = args;

  // Reject non-.css early so we give a clearer error than the filesystem
  // would and so we don't read a huge binary that happens to live inside a
  // synced folder. Matches the spec's "not a .css file" rule.
  if (extname(globalsCssPath).toLowerCase() !== ".css") {
    throw new DesignWorkspaceGlobalsCssError(
      "GLOBALS_CSS_NOT_CSS",
      globalsCssPath,
      `globalsCssPath "${globalsCssPath}" does not have a .css extension.`,
    );
  }

  // Resolve + read through `readSyncedFile` (BA-4). Any PATH_NOT_ALLOWED /
  // FILE_NOT_FOUND / READ_FAILED surfaces as GLOBALS_CSS_NOT_FOUND; the
  // 5 MiB read-utils cap never trips here because the compiler's own
  // stricter GLOBALS_CSS_MAX_BYTES (256 KiB) is enforced below.
  let contents: string;
  let bytes: number;
  try {
    const readResult = await readSyncedFile({
      characterId,
      sessionId,
      sourcePath: globalsCssPath,
    });
    contents = readResult.content;
    bytes = readResult.bytes;
  } catch (error) {
    if (isReadSyncedFileError(error)) {
      if (error.code === "FILE_TOO_LARGE") {
        // Distinct from the GlobalsCssPath-specific limit, but still
        // surfaces as TOO_LARGE so the agent gets an actionable envelope.
        throw new DesignWorkspaceGlobalsCssError(
          "GLOBALS_CSS_TOO_LARGE",
          globalsCssPath,
          `globalsCssPath "${globalsCssPath}" is ${error.bytes ?? "?"} bytes — exceeds the read-utils cap.`,
          { bytes: error.bytes, limit: error.limit },
        );
      }
      throw new DesignWorkspaceGlobalsCssError(
        "GLOBALS_CSS_NOT_FOUND",
        globalsCssPath,
        `globalsCssPath "${globalsCssPath}" could not be read: ${error.message}`,
      );
    }
    throw new DesignWorkspaceGlobalsCssError(
      "GLOBALS_CSS_NOT_FOUND",
      globalsCssPath,
      `Failed to read globalsCssPath "${globalsCssPath}": ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }

  if (bytes > GLOBALS_CSS_MAX_BYTES) {
    throw new DesignWorkspaceGlobalsCssError(
      "GLOBALS_CSS_TOO_LARGE",
      globalsCssPath,
      `globalsCssPath "${globalsCssPath}" is ${bytes} bytes — exceeds the ${GLOBALS_CSS_MAX_BYTES}-byte limit.`,
      { bytes, limit: GLOBALS_CSS_MAX_BYTES },
    );
  }

  if (contents.trim().length === 0) {
    throw new DesignWorkspaceGlobalsCssError(
      "GLOBALS_CSS_EMPTY",
      globalsCssPath,
      `globalsCssPath "${globalsCssPath}" is empty — nothing to inject.`,
      { bytes },
    );
  }

  const hash = createHash("sha256").update(contents).digest("hex").slice(0, 16);
  return { path: globalsCssPath, contents, bytes, hash };
}
const PREVIEW_THEME_CSS = [
  ":root {",
  "  color-scheme: light;",
  // Sentinel custom property — present iff this stylesheet is parsed and
  // applied. The screenshot pipeline polls
  // `getComputedStyle(document.documentElement).getPropertyValue('--selene-styles-applied')`
  // before running computed-style probes, so probes can never read the
  // pre-CSS DOM. See `waitForProbeStylesReady` in screenshot.ts.
  "  --selene-styles-applied: 1;",
  // Tailwind preflight (v3) sets `html { font-family: var(--font-inter), ... }`
  // because `tailwind.preview.config.cjs` has `fontFamily.sans` keyed on
  // `var(--font-inter)`. The standalone preview HTML doesn't include
  // `next/font` injection, so without these defaults the var() reference is
  // invalid (no inner fallback) and the browser falls back to the UA-default
  // serif font (Times) — which is what surfaced as the bogus
  // `font: \"16px Times\"` probe reading. Defining the vars keeps the cascade
  // valid; the fallback list (`ui-sans-serif, system-ui, sans-serif`) does
  // the actual resolution since neither family is bundled.
  "  --font-inter: \"Inter\";",
  "  --font-jetbrains-mono: \"JetBrains Mono\";",
  "  --terminal-cream: 34 63% 89%;",
  "  --terminal-cream-dark: 37 52% 81%;",
  "  --terminal-dark: 0 0% 10%;",
  "  --terminal-bg: 0 0% 4%;",
  "  --terminal-green: 18 49% 54%;",
  "  --terminal-amber: 41 100% 50%;",
  "  --terminal-text: 0 0% 88%;",
  "  --terminal-muted: 0 0% 53%;",
  "  --terminal-border: 0 0% 20%;",
  "  --background: 32 55% 89%;",
  "  --foreground: 0 0% 10%;",
  "  --card: 32 55% 89%;",
  "  --card-foreground: 0 0% 10%;",
  "  --popover: 32 55% 89%;",
  "  --popover-foreground: 0 0% 10%;",
  "  --primary: 0 0% 10%;",
  "  --primary-foreground: 32 55% 89%;",
  "  --secondary: 32 40% 85%;",
  "  --secondary-foreground: 0 0% 10%;",
  "  --muted: 32 30% 82%;",
  "  --muted-foreground: 0 0% 53%;",
  "  --accent: 18 49% 54%;",
  "  --accent-foreground: 0 0% 100%;",
  "  --destructive: 0 84% 60%;",
  "  --destructive-foreground: 32 55% 89%;",
  "  --border: 0 0% 75%;",
  "  --input: 0 0% 75%;",
  "  --ring: 18 49% 54%;",
  "  --radius: 0.5rem;",
  "  --chart-1: 18 49% 54%;",
  "  --chart-2: 41 100% 50%;",
  "  --chart-3: 0 0% 53%;",
  "  --chart-4: 32 55% 70%;",
  "  --chart-5: 0 0% 30%;",
  "}",
  ".dark {",
  "  color-scheme: dark;",
  "  --terminal-cream: 0 0% 14%;",
  "  --terminal-cream-dark: 0 0% 18%;",
  "  --terminal-dark: 34 63% 90%;",
  "  --terminal-bg: 0 0% 8%;",
  "  --terminal-green: 18 49% 54%;",
  "  --terminal-amber: 41 100% 50%;",
  "  --terminal-text: 0 0% 92%;",
  "  --terminal-muted: 0 0% 70%;",
  "  --terminal-border: 0 0% 28%;",
  "  --background: 0 0% 14%;",
  "  --foreground: 34 63% 90%;",
  "  --card: 0 0% 17%;",
  "  --card-foreground: 34 63% 90%;",
  "  --popover: 0 0% 16%;",
  "  --popover-foreground: 34 63% 90%;",
  "  --primary: 34 63% 90%;",
  "  --primary-foreground: 0 0% 10%;",
  "  --secondary: 0 0% 20%;",
  "  --secondary-foreground: 34 63% 90%;",
  "  --muted: 0 0% 20%;",
  "  --muted-foreground: 0 0% 65%;",
  "  --accent: 18 49% 54%;",
  "  --accent-foreground: 0 0% 100%;",
  "  --destructive: 0 62.8% 30.6%;",
  "  --destructive-foreground: 34 63% 90%;",
  "  --border: 0 0% 24%;",
  "  --input: 0 0% 24%;",
  "  --ring: 18 49% 54%;",
  "  --chart-1: 18 49% 54%;",
  "  --chart-2: 41 100% 50%;",
  "  --chart-3: 0 0% 65%;",
  "  --chart-4: 34 63% 70%;",
  "  --chart-5: 0 0% 50%;",
  "}",
].join("\n");

const PROJECT_ROOT = getProjectRoot();
const TAILWIND_INPUT_PATH = resolve(PROJECT_ROOT, "lib/design/workspace/preview.tailwind.css");
const PREVIEW_TAILWIND_SOURCE = [
  "@tailwind base;",
  "@tailwind components;",
  "@tailwind utilities;",
  "",
].join("\n");

/**
 * Per-compile alias map for the W2.3 asset-ref rewrite step.
 *
 * Entries of the form `{ alias: "hero", url: "/api/media/..." }` cause the
 * compiler to rewrite every occurrence of `@asset/hero` in the user's TSX
 * source to the real URL BEFORE handing the source to esbuild and tailwind.
 *
 * The map is NEVER persisted alongside the component row — it's a per-call
 * input the LLM provides each turn, matching the Sprint 2 spec (W2.3).
 */
export interface DesignAssetAlias {
  alias: string;
  url: string;
}

/** Pre-esbuild error code: a `@asset/<alias>` reference has no matching
 * declaration in the per-call `assetAliases` map. Emitted in the compile
 * report's error structure so the agent can react programmatically. */
export const ASSET_ALIAS_NOT_FOUND = "ASSET_ALIAS_NOT_FOUND";

/**
 * Thrown by `rewriteAssetAliases` when the source references an alias that
 * isn't in the per-call alias map. Surfaced via the normal compile-report
 * path so the tool envelope can shape it into
 * `{ code: "ASSET_ALIAS_NOT_FOUND", alias, declaredAliases }`.
 */
export class AssetAliasNotFoundError extends Error {
  alias: string;
  declaredAliases: string[];

  constructor(alias: string, declaredAliases: string[]) {
    super(
      `@asset/${alias} was referenced by the component source but not declared in this call's assetAliases map. Declared aliases: [${declaredAliases.join(", ")}].`,
    );
    this.name = "AssetAliasNotFoundError";
    this.alias = alias;
    this.declaredAliases = declaredAliases;
  }
}

/**
 * Match `@asset/<alias>` anywhere in the source — including inside quoted
 * strings (e.g. `src="@asset/hero"`, `url("@asset/bg")`). Alias format is
 * constrained to `[A-Za-z0-9_-]+` per the W2.3 spec; anything else is not
 * considered a reference and is left untouched.
 *
 * The regex has no anchors — it matches substrings — so substrings that
 * happen to look like the pattern (e.g. inside a comment) WILL be rewritten.
 * This is intentional: the compiler treats `@asset/<alias>` as a dedicated
 * prefix the model is told to use only as an asset reference. Rewriting all
 * occurrences is the simplest safe semantics.
 */
const ASSET_ALIAS_REF_PATTERN = /@asset\/([a-zA-Z0-9_-]+)/g;

/**
 * Rewrite every `@asset/<alias>` reference in `componentCode` to the URL
 * declared for that alias in `aliases`. Throws `AssetAliasNotFoundError` if
 * any reference is missing from the map.
 *
 * Placed BEFORE esbuild + tailwind so the downstream pipeline sees the real
 * URL strings — screenshot + HTML emission flow through unchanged (the
 * rewritten URLs travel via the normal component source, per W2.3 spec).
 */
export function rewriteAssetAliases(
  componentCode: string,
  aliases: DesignAssetAlias[] | undefined,
): string {
  if (!aliases || aliases.length === 0) {
    // Fast path: no rewrite requested. Any `@asset/*` refs in the source
    // still become compile errors below — we only skip the rewrite work.
    if (!ASSET_ALIAS_REF_PATTERN.test(componentCode)) {
      ASSET_ALIAS_REF_PATTERN.lastIndex = 0;
      return componentCode;
    }
    ASSET_ALIAS_REF_PATTERN.lastIndex = 0;
  }

  const map = new Map<string, string>();
  for (const entry of aliases ?? []) {
    map.set(entry.alias, entry.url);
  }
  const declaredAliases = Array.from(map.keys());

  return componentCode.replace(ASSET_ALIAS_REF_PATTERN, (_match, alias: string) => {
    const url = map.get(alias);
    if (url === undefined) {
      throw new AssetAliasNotFoundError(alias, declaredAliases);
    }
    return url;
  });
}

interface BuildTailwindPreviewOptions {
  autoInstallMissingDependencies?: boolean;
  source?: string;
  tsconfigPaths?: TsconfigPathsConfig;
  /**
   * Per-call `@asset/<alias>` map for the W2.3 rewrite step. See
   * `rewriteAssetAliases` above. Applied before dependency validation,
   * esbuild bundling, and tailwind content scanning so the downstream
   * pipeline sees the substituted URLs.
   */
  assetAliases?: DesignAssetAlias[];
  /**
   * Preview theme honored by the compiled `<html>` emission.
   *
   * - "dark"   → `<html lang="en" class="dark">` (historical default).
   * - "light"  → `<html lang="en">` (no `.dark` class).
   * - "system" → `<html lang="en">` plus an inline `<head>` script that
   *   toggles the `.dark` class on `document.documentElement` based on
   *   `prefers-color-scheme`. A script is used (rather than a pure
   *   `@media (prefers-color-scheme: dark)` CSS block) because Tailwind's
   *   `darkMode: "class"` config in `tailwind.preview.config.cjs` keys its
   *   `dark:` variants off the class, not a media query, so a CSS-only
   *   media block would leave dark utilities inert.
   *
   * When omitted, defaults to "dark" to preserve the previous hardcoded
   * `<html class="dark">` behavior for callers that haven't been updated.
   */
  previewTheme?: DesignPreviewTheme;
  /**
   * Optional synced-folder-relative path to the real app's globals.css
   * (e.g. "sanity-seline/app/globals.css"). When set, the compiler resolves
   * it via `resolveSyncedPath`, reads the file, and injects it as an inline
   * `<style data-source="globals">` block at the TOP of `<head>` — BEFORE
   * the preview theme / Tailwind utility CSS — so the real app's design
   * tokens, theme variables, and base styles are the foundation the
   * generated component renders against (and Tailwind utilities can still
   * win on specificity ties, matching real Next.js app behavior). See the
   * injection-order comment in `buildCompiledPreviewHtml`.
   *
   * Requires `characterId` + `sessionId` to be set so the path can be
   * validated against the character's synced folders. When either is
   * missing, `resolveAndReadGlobalsCss` throws a
   * `DesignWorkspaceGlobalsCssError` with code `GLOBALS_CSS_NOT_FOUND`.
   *
   * Resolution failures (missing file, non-.css, empty, or
   * > GLOBALS_CSS_MAX_BYTES) propagate as `DesignWorkspaceGlobalsCssError`
   * so the tool handler can map them to structured envelope codes. The
   * compiler never silently falls back to a preview without the real app's
   * tokens — that would hide a user-actionable failure behind a
   * differently-styled preview.
   */
  globalsCssPath?: string;
  /**
   * Character scope for `resolveSyncedPath` — required when
   * `globalsCssPath` is set.
   */
  characterId?: string;
  /**
   * Session scope for `resolveSyncedPath` — required when
   * `globalsCssPath` is set.
   */
  sessionId?: string;
  /**
   * W3.3 — optional URL of a reference image to render as a fixed-position
   * overlay on top of the compiled preview. The overlay ships with a small
   * vanilla-JS control panel (opacity slider, show/hide toggle,
   * normal/difference blend-mode select) so the user can diff the generated
   * component against a Figma frame / screenshot without leaving the
   * preview iframe. `pointer-events: none` on the overlay root keeps it
   * from intercepting clicks on the actual component.
   *
   * Accepts:
   *   - `http(s)://...` absolute URLs (external images)
   *   - `/api/media/...` synced media URLs (server-scoped)
   *   - `data:image/...;base64,...` data URIs
   *
   * The compiler does NOT reuse the W2.3 `@asset/<alias>` pipeline here —
   * the reference image is cosmetic preview chrome and lives outside the
   * user's component source, so it never needs to become a stable token
   * that survives persistence. Direct URL passthrough is simpler and
   * avoids allocating an alias for a one-shot debug overlay.
   */
  referenceImageUrl?: string;
  /**
   * W3.4 — auto-grid rendering of arbitrary prop permutations.
   *
   * When supplied (and non-empty), REPLACES the default single-render
   * `<Component />` with a CSS grid that renders one cell per entry.
   * Each cell receives its `props` bag as the component's full prop set,
   * optionally labeled / classed via `label` and `className`. Each cell
   * carries `data-design-cell-index="N"` so probe selectors / screenshot
   * tooling can target individual cells.
   *
   * Low-level primitive on purpose: the caller supplies the full array
   * of render specs. There is NO inference of variants from prop types,
   * no `{ propName: [values] }` auto-cartesian — W3.4 anti-scope.
   *
   * Cap enforced at the tool boundary (`RENDER_MANY_MAX_CELLS`), not
   * here — the compiler trusts its caller to have validated. Cells with
   * malformed `props` are expected to be caught by the tool's Zod
   * schema, NOT the compiler.
   */
  renderMany?: readonly RenderManyCell[];

  /**
   * Sprint 4 W4.2 — user scope for the `design:<ref>` virtual-module
   * resolver. When set alongside `sessionId` the compiler installs an
   * additional esbuild plugin that resolves `import X from "design:<ref>"`
   * specifiers against rows in `design_components` owned by
   * (userId, sessionId). When either field is missing the plugin is NOT
   * installed — any `design:` import in the source then fails at the
   * esbuild "could not resolve" step, which is the right default for
   * callers that haven't wired the resolver (e.g. legacy "import"
   * action paths).
   *
   * The distinction between "missing scope" (plugin off) and "scope
   * mismatch" (plugin on, ref not in scope → IMPORT_NOT_FOUND) matches
   * the existence-leak rules in `findWorkspaceDesignByIdOrTag` — a
   * caller without a user scope MUST NOT get structured import
   * diagnostics that could reveal whether a ref exists in some other
   * scope.
   */
  userId?: string;
  /**
   * Sprint 4 W4.2 — session scope for the `design:<ref>` virtual-module
   * resolver. Note: this is also used by the W2.4 globals.css flow above,
   * so the single field carries both semantics. The two flows never
   * conflict (globals.css treats `sessionId` as an input to
   * `resolveSyncedPath`; the import resolver uses the same string to
   * scope the DB query).
   */
  /**
   * Sprint 4 W4.2 — optional loader override for the `design:<ref>`
   * resolver. Defaults to the real `findWorkspaceDesignByIdOrTag` query
   * when omitted. Tests pass an in-memory stub so they can drive the
   * cycle / scope-violation / not-found branches without touching the
   * sqlite client, AND so they can assert the compiler propagates an
   * IMPORT_SCOPE_VIOLATION thrown by a loader that happens to know about
   * cross-scope existence.
   */
  designImportLoader?: DesignImportLoader;
  /**
   * Sprint 4 W4.2 — optional pre-seeded cycle-detection chain. Callers
   * that already know the top-level component's id (e.g. the tool
   * handler, which loaded the row before compile) pass it in so a
   * `design:<rootId>` import inside the root's own source is correctly
   * diagnosed as a self-cycle. When omitted the chain starts empty —
   * cycles two hops deep (A → B → A) are still caught because the
   * plugin seeds the resolved id on first load of A.
   */
  designImportChainSeed?: readonly string[];
}

interface BuildTailwindPreviewResult {
  html: string;
  report: DesignWorkspaceCompileReport;
}

interface CompileResult {
  code: string;
  warnings: string[];
  diagnostics?: DesignWorkspaceDiagnostic[];
}

class DesignWorkspaceCompileError extends Error {
  report: DesignWorkspaceCompileReport;

  constructor(message: string, report: DesignWorkspaceCompileReport) {
    super(message);
    this.name = "DesignWorkspaceCompileError";
    this.report = report;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function normalizeDependencySummary(
  value: DependencyValidationResult,
): DesignWorkspaceDependencySummary {
  return {
    manifestPackages: value.manifestPackages,
    importedPackages: value.importedPackages,
    checkedPackages: value.checkedPackages,
    missingManifestPackages: value.missingManifestPackages,
    missingImportedPackages: value.missingImportedPackages,
    missingPackages: value.missingPackages,
  };
}

function normalizeAutoInstallSummary(
  value?: DependencyInstallResult,
): DesignWorkspaceAutoInstallSummary | undefined {
  if (!value) {
    return undefined;
  }

  return {
    attempted: value.attempted,
    success: value.success,
    packages: value.packages,
    packageNames: value.packageNames,
    error: value.error,
  };
}

function toDiagnosticLocation(location?: esbuild.Location): DesignWorkspaceDiagnostic["location"] {
  if (!location?.file) {
    return undefined;
  }

  return {
    file: location.file,
    line: location.line,
    column: location.column,
  };
}

function inferIssueType(message: string): DesignWorkspaceCompilationIssue["type"] {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("could not resolve") ||
    normalized.includes("cannot find module") ||
    normalized.includes("failed to resolve")
  ) {
    return "dependency";
  }
  if (
    normalized.includes("expected") ||
    normalized.includes("unexpected") ||
    normalized.includes("syntax") ||
    normalized.includes("unterminated")
  ) {
    return "syntax";
  }
  if (normalized.includes("type") || normalized.includes("jsx")) {
    return "type";
  }
  if (normalized.includes("runtime") || normalized.includes("render")) {
    return "runtime";
  }
  return "unknown";
}

function buildIssueSuggestion(
  issueType: DesignWorkspaceCompilationIssue["type"],
  message: string,
  dependencyCheck: DependencyValidationResult,
): string | undefined {
  if (issueType === "dependency") {
    const missingPackages = dependencyCheck.missingPackages;
    if (missingPackages.length > 0) {
      return `Install missing workspace packages: ${missingPackages.join(", ")}`;
    }

    const couldResolveMatch = message.match(/["'`](.+?)["'`]/);
    if (couldResolveMatch?.[1]) {
      return `Verify that ${couldResolveMatch[1]} is installed in ${SANDBOX_DIR_NAME}/package.json.`;
    }
  }

  if (issueType === "syntax") {
    return "Fix the TSX syntax near the reported location and ensure the file exports a default React component.";
  }

  if (issueType === "type") {
    return "Check JSX usage, component props, and imported symbols for mismatches.";
  }

  return undefined;
}

function toCompilationIssue(
  text: string,
  location: DesignWorkspaceDiagnostic["location"],
  dependencyCheck: DependencyValidationResult,
): DesignWorkspaceCompilationIssue {
  const type = inferIssueType(text);
  return {
    type,
    message: text,
    location,
    suggestion: buildIssueSuggestion(type, text, dependencyCheck),
  };
}

/**
 * W3.4 — escape a JSON string so it is safe to embed verbatim inside a
 * JavaScript double-quoted string literal. The embedded JSON is then
 * `JSON.parse()`d at runtime inside the preview bundle.
 *
 * Why this indirection? The renderMany cell props are arbitrary,
 * untrusted JSON from the agent/caller. Embedding those values as raw
 * JSX attributes (or even as a bare object literal in the generated
 * entry source) opens up two concrete hazards:
 *
 *   1. JSX attribute injection — a string containing `"` / `>` / `<`
 *      would escape the attribute context and inject arbitrary JSX.
 *   2. Script-context escape — a string containing `</script>` would
 *      terminate the inline `<script>` tag inside the preview HTML.
 *
 * The `JSON.parse("…")` pattern sidesteps both: the runtime parse
 * restores the original structural/string values without any JSX
 * serialization step, and the escape sequences below neutralize the
 * specific characters that differ between JSON and JS source:
 *
 *   - `\u2028` / `\u2029`: valid in JSON strings but terminate a JS
 *     source line — would otherwise break the embedded literal.
 *   - `</` sequences: neutralized so `</script>` cannot close the
 *     host `<script>` tag in the preview HTML.
 *   - Backslash / quote: escaped because we embed inside a double-
 *     quoted JS string.
 *
 * The output is a valid JS string literal (without surrounding
 * quotes) that round-trips through `JSON.parse` to the original
 * structured value.
 *
 * @internal Exported for unit tests.
 */
export function encodeJsonForJsStringLiteral(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    // JSON.stringify returns undefined for unserializable roots (e.g. a
    // bare function). renderMany validation at the tool boundary rejects
    // non-plain-object props before this ever runs, but we defend in
    // depth — emit a harmless empty-object literal so the parse below
    // still succeeds.
    return "{}";
  }
  return json
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    // Prevent `</script>` inside a string value from prematurely closing
    // the inline <script> tag that hosts the compiled bundle.
    .replace(/<\//g, "<\\/");
}

/**
 * @internal Exported for unit tests — verifies the emitted entry source
 * for both the single-render path and the renderMany grid path without
 * running the full esbuild pipeline.
 */
export function createPreviewEntrySource(renderMany?: readonly RenderManyCell[]): string {
  // Single-render path (unchanged from before W3.4).
  if (!renderMany || renderMany.length === 0) {
    return [
      "import React from 'react';",
      "import { createRoot } from 'react-dom/client';",
      `import Component from '${VIRTUAL_COMPONENT_PATH}';`,
      "",
      "class __SeleneErrorBoundary__ extends React.Component {",
      "  constructor(props) {",
      "    super(props);",
      "    this.state = { error: null };",
      "  }",
      "",
      "  static getDerivedStateFromError(error) {",
      "    return { error };",
      "  }",
      "",
      "  render() {",
      "    if (this.state.error) {",
      "      var msg = 'Render Error:\\n' + (this.state.error.stack || this.state.error.message);",
      "      return React.createElement('pre', { style: { padding: '16px', fontFamily: 'ui-monospace, monospace', background: '#111827', color: '#ef4444', whiteSpace: 'pre-wrap', fontSize: '13px', margin: 0 } }, msg);",
      "    }",
      "    return this.props.children;",
      "  }",
      "}",
      "",
      "var __root__ = document.getElementById('selene-design-preview-root');",
      "if (!__root__) {",
      "  throw new Error('Preview root not found');",
      "}",
      "",
      "if (typeof Component !== 'function') {",
      "  throw new Error('Default export must be a React component function.');",
      "}",
      "",
      "try {",
      "  createRoot(__root__).render(",
      "    React.createElement(__SeleneErrorBoundary__, null, React.createElement(Component))",
      "  );",
      "  requestAnimationFrame(function() {",
      "    __root__.setAttribute('data-preview-ready', 'true');",
      "  });",
      "} catch (e) {",
      "  var div = document.createElement('div');",
      "  div.style.cssText = 'padding:16px;font-family:ui-monospace,monospace;background:#111827;color:#ef4444;white-space:pre-wrap;font-size:13px;';",
      "  div.textContent = 'Mount Error:\\n' + (e.stack || e.message);",
      "  __root__.replaceChildren(div);",
      "}",
    ].join("\n");
  }

  // ------------------------------------------------------------------------
  // W3.4 — renderMany grid path.
  //
  // Each cell's `props` is emitted as JSON (parsed at runtime) so there is
  // NO JSX-attribute serialization step on the untrusted data — see the
  // `encodeJsonForJsStringLiteral` doc comment. The rendered grid uses
  // `React.createElement` exclusively (no JSX) so the generated entry is
  // plain JS that the esbuild tsx loader compiles trivially.
  //
  // CSS grid is inline on the container so it works even when Tailwind
  // hasn't scanned the entry source (the entry is virtual and not fed to
  // the tailwind content pipeline).
  // ------------------------------------------------------------------------

  const cellsJson = renderMany.map((cell, index) => ({
    index,
    props: cell.props,
    label: cell.label ?? null,
    className: cell.className ?? null,
  }));

  const encoded = encodeJsonForJsStringLiteral(cellsJson);

  return [
    "import React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    `import Component from '${VIRTUAL_COMPONENT_PATH}';`,
    "",
    "class __SeleneErrorBoundary__ extends React.Component {",
    "  constructor(props) {",
    "    super(props);",
    "    this.state = { error: null };",
    "  }",
    "",
    "  static getDerivedStateFromError(error) {",
    "    return { error };",
    "  }",
    "",
    "  render() {",
    "    if (this.state.error) {",
    "      var msg = 'Render Error:\\n' + (this.state.error.stack || this.state.error.message);",
    "      return React.createElement('pre', { style: { padding: '16px', fontFamily: 'ui-monospace, monospace', background: '#111827', color: '#ef4444', whiteSpace: 'pre-wrap', fontSize: '13px', margin: 0 } }, msg);",
    "    }",
    "    return this.props.children;",
    "  }",
    "}",
    "",
    "class __SeleneCellBoundary__ extends React.Component {",
    "  constructor(props) { super(props); this.state = { error: null }; }",
    "  static getDerivedStateFromError(error) { return { error }; }",
    "  render() {",
    "    if (this.state.error) {",
    "      var msg = 'Cell Error:\\n' + (this.state.error.stack || this.state.error.message);",
    "      return React.createElement('pre', { style: { padding: '8px', fontFamily: 'ui-monospace, monospace', background: '#111827', color: '#ef4444', whiteSpace: 'pre-wrap', fontSize: '12px', margin: 0 } }, msg);",
    "    }",
    "    return this.props.children;",
    "  }",
    "}",
    "",
    `var __renderManySpecs__ = JSON.parse("${encoded}");`,
    "",
    "var __root__ = document.getElementById('selene-design-preview-root');",
    "if (!__root__) {",
    "  throw new Error('Preview root not found');",
    "}",
    "",
    "if (typeof Component !== 'function') {",
    "  throw new Error('Default export must be a React component function.');",
    "}",
    "",
    "function __renderManyCell__(spec) {",
    "  var children = [];",
    "  if (spec.label != null) {",
    "    children.push(React.createElement('div', {",
    "      key: 'label',",
    "      className: 'cell-label',",
    "      style: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', opacity: 0.7, marginBottom: '8px' }",
    "    }, String(spec.label)));",
    "  }",
    "  children.push(React.createElement('div', {",
    "    key: 'content',",
    "    className: 'cell-content',",
    "    'data-design-cell-index': spec.index",
    "  }, React.createElement(__SeleneCellBoundary__, null, React.createElement(Component, spec.props || {}))));",
    "  return React.createElement('div', {",
    "    key: spec.index,",
    "    className: spec.className || undefined,",
    "    'data-design-cell-wrapper': spec.index",
    "  }, children);",
    "}",
    "",
    "try {",
    "  var __cells__ = __renderManySpecs__.map(function(spec) { return __renderManyCell__(spec); });",
    "  var __grid__ = React.createElement('div', {",
    "    'data-design-render-many': 'true',",
    "    style: { display: 'grid', gap: '24px', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', padding: '16px' }",
    "  }, __cells__);",
    "  createRoot(__root__).render(",
    "    React.createElement(__SeleneErrorBoundary__, null, __grid__)",
    "  );",
    "  requestAnimationFrame(function() {",
    "    __root__.setAttribute('data-preview-ready', 'true');",
    "  });",
    "} catch (e) {",
    "  var div = document.createElement('div');",
    "  div.style.cssText = 'padding:16px;font-family:ui-monospace,monospace;background:#111827;color:#ef4444;white-space:pre-wrap;font-size:13px;';",
    "  div.textContent = 'Mount Error:\\n' + (e.stack || e.message);",
    "  __root__.replaceChildren(div);",
    "}",
  ].join("\n");
}

function createComponentPlugin(componentCode: string): esbuild.Plugin {
  return {
    name: "selene-preview-component",
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${VIRTUAL_COMPONENT_PATH}$`) }, () => ({
        path: VIRTUAL_COMPONENT_PATH,
        namespace: VIRTUAL_COMPONENT_NAMESPACE,
      }));

      build.onLoad({ filter: /.*/, namespace: VIRTUAL_COMPONENT_NAMESPACE }, () => ({
        contents: componentCode,
        loader: "tsx",
        resolveDir: PROJECT_ROOT,
      }));
    },
  };
}

/**
 * Sprint 4 W4.2 — esbuild plugin for the `design:<ref>` virtual-module
 * resolver.
 *
 * Wiring:
 *   1. `onResolve({filter: /^design:/})` captures every `import X from
 *      "design:<ref>"` specifier emitted in the user's TSX source, no
 *      matter which namespace the importer lived in (top-level virtual
 *      component OR a nested `design:<ref>` module).
 *   2. `onLoad({namespace: DESIGN_IMPORT_NAMESPACE})` parses the `<ref>`
 *      portion, calls the loader's scope-enforced `findByRef`, and returns
 *      the target component's `sourceCode` with `loader: "tsx"` so esbuild
 *      keeps walking (including further `design:*` imports).
 *
 * Cycle detection (Rev-J1, Sprint 4 W4.2 revision):
 *   Earlier revisions used a compile-wide `Set<string>` of resolved ids
 *   that grew monotonically across the entire build. That surfaced false
 *   cycles in two realistic cases — (a) a shared-dependency diamond
 *   (A -> B -> D and A -> C -> D), once D was loaded for the first branch
 *   any later reach through the other branch tripped `importChain.has(id)`
 *   and (b) mixed id/name refs to the same component from different
 *   branches, which esbuild treats as two distinct specifier paths so
 *   onLoad fires twice but the Set already remembers the resolved id from
 *   the first load. Neither is actually a cycle, but both were being
 *   reported as IMPORT_CYCLE_DETECTED (Backend Architect H2 finding).
 *
 *   The revised tracker is path-sensitive. Two maps, both keyed by the
 *   esbuild virtual-module path (i.e. the raw `design:<ref>` specifier):
 *     - `pendingParentChains` — set in onResolve, stores the chain of
 *       resolved ids from the root DOWN TO (but not including) this
 *       node. Reflects the *importer's* full chain at the moment of
 *       the resolve call. Path-sensitive because different importers
 *       writing the same specifier overwrite with their own chain; the
 *       cycle check only cares that resolved.id does not appear in
 *       whichever chain reaches the onLoad — any true cycle has
 *       resolved.id in every parent chain that leads there, so the
 *       last-writer-wins race is safe.
 *     - `fullChains` — set in onLoad AFTER a successful resolution.
 *       Stores the chain INCLUDING the just-loaded node's resolved id,
 *       so this node's children can look their parent's full chain up
 *       by the importer specifier path alone.
 *
 *   The root component's id is seeded from `designImportChainSeed` so a
 *   `design:<rootId>` self-import (or any back-edge to the compile
 *   target) is diagnosed as a cycle on first resolve, even though the
 *   root itself is served by `createComponentPlugin` (which never calls
 *   through this plugin's onLoad).
 *
 *   Importantly, chains are NEVER shared across unrelated resolution
 *   branches: each onResolve computes its own parent chain from the
 *   importer's recorded fullChain (falling back to the seed for the
 *   root-level specifier). That restores the "stack pushed on descent,
 *   popped on ascent" semantics of a recursive DFS without needing an
 *   explicit post-subtree callback from esbuild (which has no such hook).
 *
 * Errors:
 *   Any failure (missing ref, cycle, empty ref) is thrown synchronously
 *   inside the onLoad callback as a `DesignWorkspaceImportError`. esbuild
 *   surfaces the thrown error to the outer `esbuild.build()` call, which
 *   `compileReactComponent` re-throws unchanged so the top-level handler
 *   can map the `.code` into an envelope field. We deliberately do NOT
 *   convert the error into an esbuild-style `errors[]` entry — the compile
 *   report loses the structured `code` in that path, and the spec says
 *   every scope violation / cycle / not-found MUST surface a structured
 *   error code.
 */
function createDesignImportPlugin(
  userId: string,
  sessionId: string,
  seedChain: readonly string[],
  loader: DesignImportLoader,
): esbuild.Plugin {
  // Path-sensitive cycle-tracking maps. Keys are the raw `design:<ref>`
  // specifier paths esbuild surfaces in onResolve/onLoad args; values are
  // the ordered list of resolved component ids from the compile root down
  // to (exclusive / inclusive) that node. Scoped to a single plugin
  // instance — every `compileReactComponent` call constructs a fresh
  // plugin so concurrent tool invocations can never share chain state.
  const pendingParentChains = new Map<string, readonly string[]>();
  const fullChains = new Map<string, readonly string[]>();
  return {
    name: "selene-design-import",
    setup(build) {
      build.onResolve({ filter: /^design:/ }, (args) => {
        // Derive the parent chain from the importer. When the importer is
        // itself a `design:<ref>` node, its fullChain (populated by the
        // onLoad below) already represents the path from root down to and
        // including the importer. For importers outside this plugin's
        // namespace — the top-level virtual preview component, the stdin
        // entry, or an external URL — we fall back to the caller-provided
        // seed, which carries the root component's id.
        const parentChain =
          fullChains.get(args.importer) ?? seedChain;
        pendingParentChains.set(args.path, parentChain);
        return {
          // Keep the original specifier as the path so the onLoad ref
          // parser sees the raw string the user authored and the map
          // keys line up across onResolve -> onLoad.
          path: args.path,
          namespace: DESIGN_IMPORT_NAMESPACE,
        };
      });

      build.onLoad(
        { filter: /.*/, namespace: DESIGN_IMPORT_NAMESPACE },
        async (args) => {
          const parentChain =
            pendingParentChains.get(args.path) ?? seedChain;

          const rawRef = args.path.slice(DESIGN_IMPORT_PREFIX.length).trim();
          if (rawRef.length === 0) {
            throw new DesignWorkspaceImportError(
              "IMPORT_NOT_FOUND",
              "",
              'Empty ref in `design:` import — expected `design:<id-or-name>`.',
              [...parentChain],
            );
          }

          // `findByRef` returns null for BOTH "row does not exist" and
          // "row exists but belongs to another user/session" — see
          // `findWorkspaceDesignByIdOrTag` for the existence-leak
          // reasoning. We classify nulls as IMPORT_NOT_FOUND from the
          // compiler's perspective; IMPORT_SCOPE_VIOLATION is reserved for
          // callers that hand the loader a ref they resolved elsewhere and
          // know belongs to another scope (tests can drive this branch
          // directly by throwing IMPORT_SCOPE_VIOLATION from a custom
          // loader).
          const resolved = await loader.findByRef({
            userId,
            sessionId,
            ref: rawRef,
          });

          if (!resolved) {
            throw new DesignWorkspaceImportError(
              "IMPORT_NOT_FOUND",
              rawRef,
              `No workspace component matches "design:${rawRef}" in this session. ` +
                "The ref must be either the component id or a unique component name within the current (userId, sessionId).",
              [...parentChain],
            );
          }

          if (parentChain.includes(resolved.id)) {
            // Build a human-readable chain so the agent can see the cycle
            // at a glance. Format: "A -> B -> A" (ids). Using ids (not
            // refs) so a name-alias import path and an id import path to
            // the same row produce the same cycle diagnostic. The head of
            // cycle is the resolved id we refused to load twice — echoed
            // as `resolvedId` so the agent can point at the concrete row
            // that closed the loop without having to re-scan the chain.
            const chainArr = [...parentChain, resolved.id];
            throw new DesignWorkspaceImportError(
              "IMPORT_CYCLE_DETECTED",
              rawRef,
              `Import cycle detected for "design:${rawRef}". Chain: ${chainArr.join(" -> ")}.`,
              chainArr,
              resolved.id,
            );
          }

          // Record the full chain (parent + this node's resolved id)
          // under this specifier path so any child `design:<nested>`
          // imports inside `resolved.sourceCode` can look it up as their
          // parent chain in the onResolve hook above.
          fullChains.set(args.path, [...parentChain, resolved.id]);
          return {
            contents: resolved.sourceCode,
            loader: "tsx",
            resolveDir: PROJECT_ROOT,
          };
        },
      );
    },
  };
}

/**
 * esbuild plugin that handles external HTTP/HTTPS imports (e.g. Google Fonts CDN URLs).
 *
 * When user code does `import 'https://fonts.googleapis.com/css2?family=...'`,
 * esbuild cannot resolve HTTP URLs as local modules. This plugin intercepts such
 * imports and converts them to a tiny runtime DOM injection:
 *   document.head.appendChild(<link rel="stylesheet" href="...">)
 *
 * This allows Google Fonts and other CDN stylesheet imports to work inside the
 * sandboxed preview iframe without any network requests being blocked by esbuild.
 */
function createExternalUrlPlugin(): esbuild.Plugin {
  return {
    name: "selene-external-url",
    setup(build) {
      // Mark all https:// and http:// imports as handled by this plugin
      build.onResolve({ filter: /^https?:\/\// }, (args) => ({
        path: args.path,
        namespace: "selene-external-url",
      }));

      // For stylesheet URLs (Google Fonts etc.), inject a <link> at runtime
      build.onLoad({ filter: /.*/, namespace: "selene-external-url" }, (args) => {
        const url = args.path;
        const isStylesheet =
          url.includes("fonts.googleapis.com") ||
          url.endsWith(".css") ||
          url.includes("stylesheet");

        if (isStylesheet) {
          // Inject a <link rel="stylesheet"> into the document head at runtime
          return {
            contents: `
              (function() {
                var link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = ${JSON.stringify(url)};
                document.head.appendChild(link);
              })();
            `,
            loader: "js",
          };
        }

        // For non-stylesheet external URLs, produce an empty module
        return { contents: "", loader: "js" };
      });
    },
  };
}

async function compileReactComponent(
  componentCode: string,
  dependencyCheck: DependencyValidationResult,
  renderMany?: readonly RenderManyCell[],
  tsconfigPaths?: TsconfigPathsConfig,
  designImport?: {
    userId: string;
    sessionId: string;
    /**
     * Rev-J1 (Sprint 4 W4.2 revision) — the root's import chain is now a
     * readonly seed (ordered array) rather than a compile-wide Set. The
     * plugin derives every downstream chain from per-specifier parent
     * chains internally, so callers only hand over the root seed.
     */
    seedChain: readonly string[];
    loader: DesignImportLoader;
  },
): Promise<CompileResult> {
  try {
    const plugins: esbuild.Plugin[] = [
      createExternalUrlPlugin(),
      createComponentPlugin(componentCode),
    ];
    if (tsconfigPaths) {
      plugins.push(createTsconfigPathsPlugin(tsconfigPaths));
    }
    if (designImport) {
      plugins.push(
        createDesignImportPlugin(
          designImport.userId,
          designImport.sessionId,
          designImport.seedChain,
          designImport.loader,
        ),
      );
    }

    const result = await withTimeout(
      esbuild.build({
        stdin: {
          contents: createPreviewEntrySource(renderMany),
          resolveDir: PROJECT_ROOT,
          loader: "tsx",
        },
        absWorkingDir: PROJECT_ROOT,
        bundle: true,
        format: "iife",
        write: false,
        minify: false,
        target: ["es2020"],
        jsx: "automatic",
        jsxImportSource: "react",
        logLevel: "silent",
        treeShaking: false,
        sourcemap: false,
        platform: "browser",
        define: {
          "process.env.NODE_ENV": '"development"',
        },
        alias: {
          "react": resolve(PROJECT_ROOT, "node_modules/react"),
          "react-dom": resolve(PROJECT_ROOT, "node_modules/react-dom"),
          "react/jsx-runtime": resolve(PROJECT_ROOT, "node_modules/react/jsx-runtime"),
          "react/jsx-dev-runtime": resolve(PROJECT_ROOT, "node_modules/react/jsx-dev-runtime"),
        },
        loader: {
          ".woff2": "dataurl",
          ".woff": "dataurl",
          ".ttf": "dataurl",
          ".otf": "dataurl",
          ".eot": "dataurl",
        },
        nodePaths: [SANDBOX_NODE_MODULES],
        plugins,
      }),
      COMPILE_TIMEOUT_MS,
      "Design preview compilation",
    );

    const warnings = result.warnings.map((warning) => warning.text);
    const diagnostics = result.warnings.map((warning) => ({
      text: warning.text,
      location: toDiagnosticLocation(warning.location ?? undefined),
    }));

    if (result.outputFiles.length === 0) {
      throw new Error("esbuild produced no output files");
    }

    return {
      code: result.outputFiles[0].text,
      warnings,
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
    };
  } catch (error) {
    if (error instanceof DesignWorkspaceCompileError) {
      throw error;
    }

    // Sprint 4 W4.2 — surface DesignWorkspaceImportError thrown from the
    // `design:<ref>` onLoad hook with its structured code intact. esbuild
    // catches plugin-thrown errors and packs the original error onto
    // `errors[i].detail`; we unwrap the first detail that looks like one
    // of our import errors and re-throw it so the handler maps it into a
    // structured envelope field (IMPORT_NOT_FOUND / IMPORT_SCOPE_VIOLATION
    // / IMPORT_CYCLE_DETECTED). If we fell through into the generic
    // DesignWorkspaceCompileError path, the report would carry only the
    // freeform text and the agent would lose the `.code` branch signal.
    const rawEsbuildErrors =
      typeof error === "object" && error !== null && "errors" in error && Array.isArray((error as { errors?: unknown[] }).errors)
        ? ((error as { errors: esbuild.Message[] }).errors ?? [])
        : [];

    for (const e of rawEsbuildErrors) {
      const detail = (e as esbuild.Message & { detail?: unknown }).detail;
      if (detail instanceof DesignWorkspaceImportError) {
        throw detail;
      }
    }
    if (error instanceof DesignWorkspaceImportError) {
      throw error;
    }

    const errors = rawEsbuildErrors;

    const warnings =
      typeof error === "object" && error !== null && "warnings" in error && Array.isArray((error as { warnings?: unknown[] }).warnings)
        ? ((error as { warnings: esbuild.Message[] }).warnings ?? []).map((warning) => warning.text)
        : [];

    const diagnostics =
      typeof error === "object" && error !== null && "warnings" in error && Array.isArray((error as { warnings?: unknown[] }).warnings)
        ? ((error as { warnings: esbuild.Message[] }).warnings ?? []).map((warning) => ({
            text: warning.text,
            location: toDiagnosticLocation(warning.location ?? undefined),
          }))
        : undefined;

    const issueList = errors.length > 0
      ? errors.map((issue) =>
          toCompilationIssue(
            issue.text,
            toDiagnosticLocation(issue.location ?? undefined),
            dependencyCheck,
          ),
        )
      : [
          toCompilationIssue(
            error instanceof Error ? error.message : "Compilation failed.",
            undefined,
            dependencyCheck,
          ),
        ];

    throw new DesignWorkspaceCompileError(
      issueList[0]?.message ?? "Compilation failed.",
      {
        warnings,
        diagnostics,
        errors: issueList,
        dependencyCheck: normalizeDependencySummary(dependencyCheck),
        recovered: false,
        durationMs: 0,
      },
    );
  }
}

function escapeInlineScript(js: string): string {
  return js.replace(/<\/(script)/gi, "<\\/$1");
}

async function buildPreviewTailwindCss(componentCode: string): Promise<string> {
  try {
    const baseConfig = previewTailwindConfig as unknown as Omit<Config, "content">;
    const config = {
      ...baseConfig,
      content: [
        {
          raw: componentCode,
          extension: "tsx",
        },
      ],
    } satisfies Config;

    const result = await withTimeout(
      postcss([tailwindcss(config)]).process(PREVIEW_TAILWIND_SOURCE, {
        from: TAILWIND_INPUT_PATH,
      }),
      TAILWIND_TIMEOUT_MS,
      "Tailwind preview build",
    );

    return result.css;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Tailwind preview build failed.");
  }
}

function escapeInlineStyle(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

// Inline script used when `previewTheme === "system"`. Mirrors the
// client-side patching convention in `components/design/design-preview-frame.tsx`
// so that `prefers-color-scheme: dark` toggles the `.dark` class that
// Tailwind's `darkMode: "class"` config reacts to. Kept as a compact IIFE
// on a single line to keep the HTML inspector output readable.
const SYSTEM_THEME_SCRIPT =
  "<script>(function(){var h=document.documentElement;function u(){h.classList.toggle('dark',window.matchMedia('(prefers-color-scheme:dark)').matches)}u();window.matchMedia('(prefers-color-scheme:dark)').addEventListener('change',u)})()</script>";

function buildHtmlOpenTag(theme: DesignPreviewTheme): string {
  if (theme === "dark") {
    return '<html lang="en" class="dark">';
  }
  // "light" and "system" both emit no static class. For "system" the
  // injected script toggles `.dark` at runtime based on media query.
  return '<html lang="en">';
}

/**
 * W3.3 — Reference-image overlay markup.
 *
 * Exported (via `buildCompiledPreviewHtml`) so unit tests can probe the
 * emitted HTML for:
 *   - `data-design-reference-overlay` root attribute (testability).
 *   - Default opacity 0.4 on initial render.
 *   - Presence of the opacity slider, show/hide toggle, and blend-mode select.
 *
 * The overlay root + control panel are rendered as the FIRST children of
 * `<body>` (before `#selene-design-preview-root`) so z-index stacking is
 * simpler — the overlay covers the entire viewport with `position: fixed`,
 * `inset: 0`, and `z-index: 2147483646`, which sits above ordinary content
 * but below the DevTools / React Error Overlay.
 *
 * `pointer-events: none` on the root keeps the overlay from intercepting
 * clicks on the real component; the control panel re-enables pointer events
 * (`pointer-events: auto`) for its own buttons + inputs.
 *
 * The wired JS is intentionally vanilla — no React, no framework — to keep
 * the preview runtime minimal. On image load failure, the JS stamps
 * `data-design-reference-error="true"` on the overlay root so tests (and the
 * agent) can probe for the failure without relying on freeform error text.
 */
function buildReferenceOverlayHtml(referenceImageUrl: string): string[] {
  // Inline-escape the URL for both the <img src> and the JS string literal.
  // We put it into the HTML via `escapeHtml` (double-quoted attribute) and
  // into the script via `JSON.stringify` so quotes / backticks are safe.
  const safeHtmlUrl = escapeHtml(referenceImageUrl);
  const safeJsUrl = JSON.stringify(referenceImageUrl);

  // Tag name is a data-attribute anchor; tests probe by
  // `document.querySelector('[data-design-reference-overlay]')`.
  return [
    `  <div data-design-reference-overlay id="selene-design-reference-overlay" style="position:fixed;inset:0;pointer-events:none;z-index:2147483646;display:block;">`,
    `    <img data-design-reference-image src="${safeHtmlUrl}" alt="Design reference overlay" style="width:100%;height:100%;object-fit:contain;object-position:center;opacity:0.4;mix-blend-mode:normal;display:block;" />`,
    `  </div>`,
    `  <div data-design-reference-controls id="selene-design-reference-controls" style="position:fixed;top:8px;right:8px;pointer-events:auto;z-index:2147483647;background:rgba(17,24,39,0.85);color:#f9fafb;font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;padding:8px 10px;border-radius:8px;display:flex;flex-direction:column;gap:6px;box-shadow:0 4px 12px rgba(0,0,0,0.35);min-width:180px;">`,
    `    <label style="display:flex;align-items:center;gap:6px;">`,
    `      <span style="flex:0 0 auto;">Opacity</span>`,
    `      <input data-design-reference-opacity type="range" min="0" max="100" value="40" style="flex:1 1 auto;" />`,
    `      <span data-design-reference-opacity-value style="flex:0 0 auto;width:28px;text-align:right;font-variant-numeric:tabular-nums;">40</span>`,
    `    </label>`,
    `    <label style="display:flex;align-items:center;gap:6px;">`,
    `      <span style="flex:0 0 auto;">Blend</span>`,
    `      <select data-design-reference-blend style="flex:1 1 auto;background:rgba(255,255,255,0.08);color:inherit;border:1px solid rgba(255,255,255,0.2);border-radius:4px;padding:2px 4px;">`,
    `        <option value="normal">normal</option>`,
    `        <option value="difference">difference</option>`,
    `      </select>`,
    `    </label>`,
    `    <button data-design-reference-toggle type="button" style="cursor:pointer;background:rgba(255,255,255,0.12);color:inherit;border:1px solid rgba(255,255,255,0.2);border-radius:4px;padding:4px 6px;font:inherit;">Hide reference</button>`,
    `  </div>`,
    `  <script>`,
    `    (function(){`,
    `      var overlay = document.getElementById('selene-design-reference-overlay');`,
    `      var img = overlay ? overlay.querySelector('[data-design-reference-image]') : null;`,
    `      var controls = document.getElementById('selene-design-reference-controls');`,
    `      if (!overlay || !img || !controls) { return; }`,
    `      var slider = controls.querySelector('[data-design-reference-opacity]');`,
    `      var sliderValue = controls.querySelector('[data-design-reference-opacity-value]');`,
    `      var blendSel = controls.querySelector('[data-design-reference-blend]');`,
    `      var toggleBtn = controls.querySelector('[data-design-reference-toggle]');`,
    `      if (slider) {`,
    `        slider.addEventListener('input', function(){`,
    `          var v = Number(slider.value);`,
    `          if (!isFinite(v)) v = 40;`,
    `          img.style.opacity = String(v / 100);`,
    `          if (sliderValue) sliderValue.textContent = String(v);`,
    `        });`,
    `      }`,
    `      if (blendSel) {`,
    `        blendSel.addEventListener('change', function(){`,
    `          img.style.mixBlendMode = blendSel.value === 'difference' ? 'difference' : 'normal';`,
    `        });`,
    `      }`,
    `      if (toggleBtn) {`,
    `        var hidden = false;`,
    `        toggleBtn.addEventListener('click', function(){`,
    `          hidden = !hidden;`,
    `          overlay.style.display = hidden ? 'none' : 'block';`,
    `          toggleBtn.textContent = hidden ? 'Show reference' : 'Hide reference';`,
    `          overlay.setAttribute('data-design-reference-hidden', hidden ? 'true' : 'false');`,
    `        });`,
    `      }`,
    `      img.addEventListener('error', function(){`,
    `        overlay.setAttribute('data-design-reference-error', 'true');`,
    `      });`,
    `      img.addEventListener('load', function(){`,
    `        overlay.setAttribute('data-design-reference-loaded', 'true');`,
    `      });`,
    `      // Also preload via Image() so a 404 is detected even if the <img>`,
    `      // was cached before our listeners attached.`,
    `      try {`,
    `        var probe = new Image();`,
    `        probe.onerror = function(){ overlay.setAttribute('data-design-reference-error', 'true'); };`,
    `        probe.src = ${safeJsUrl};`,
    `      } catch (_e) { /* noop */ }`,
    `    })();`,
    `  </script>`,
  ];
}

export function buildCompiledPreviewHtml(
  compiledJs: string,
  tailwindCss: string,
  title: string,
  previewTheme: DesignPreviewTheme,
  globalsCss?: ResolvedGlobalsCss,
  referenceImageUrl?: string,
): string {
  const safeJs = escapeInlineScript(compiledJs);
  const safeCss = escapeInlineStyle(tailwindCss);
  const safeThemeCss = escapeInlineStyle(PREVIEW_THEME_CSS);
  const systemThemeScriptLine =
    previewTheme === "system" ? `  ${SYSTEM_THEME_SCRIPT}` : null;

  // Injection-order decision (Option A — matches real Next.js app behavior):
  //   globals.css → preview-theme vars → compiled Tailwind utilities → layout reset
  //
  // globals.css is written FIRST so it forms the base layer (design tokens,
  // @layer base declarations, CSS custom properties). Tailwind utility
  // classes emitted later can then override specific values at the point
  // of use — exactly how `app/layout.tsx` + `globals.css` work in a real
  // Next.js app: utility classes defeat base styles on specificity ties.
  // The alternative (Option B, globals after Tailwind) would let a stray
  // selector in globals.css silently shadow Tailwind utilities, which is
  // atypical and hard to debug.
  const globalsStyleLines = globalsCss
    ? [
        `  <style data-source="globals" data-globals-path="${escapeHtml(
          globalsCss.path,
        )}" data-globals-css-hash="${globalsCss.hash}">`,
        escapeInlineStyle(globalsCss.contents),
        "  </style>",
      ]
    : [];

  // Root-level hash attribute so screenshot tooling / cache keys can detect
  // globals.css content changes without re-reading the file. Omitted when
  // no globals.css was injected so the attribute's presence alone signals
  // "this preview was compiled with a globals.css".
  const htmlOpenTag = globalsCss
    ? buildHtmlOpenTag(previewTheme).replace(
        ">",
        ` data-globals-css-hash="${globalsCss.hash}">`,
      )
    : buildHtmlOpenTag(previewTheme);

  return [
    "<!DOCTYPE html>",
    htmlOpenTag,
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    // Signal to the UA that this preview supports both light and dark. Keeps
    // form controls, scrollbars, and other UA widgets in sync with the
    // currently-applied theme (`darkMode: "class"` on <html>), and avoids
    // flash-of-white when the system script toggles `.dark` at runtime.
    '  <meta name="color-scheme" content="light dark" />',
    `  <title>${escapeHtml(title)}</title>`,
    "  <!-- Allow Google Fonts and other external font CDNs -->",
    '  <link rel="preconnect" href="https://fonts.googleapis.com" />',
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />',
    // globals.css first (Option A) — see injection-order comment above.
    ...globalsStyleLines,
    "  <style>",
    safeThemeCss,
    "  </style>",
    "  <style>",
    safeCss,
    "  </style>",
    "  <style>",
    "    html, body, #selene-design-preview-root { margin: 0; width: 100%; height: 100%; }",
    "  </style>",
    ...(systemThemeScriptLine ? [systemThemeScriptLine] : []),
    "</head>",
    "<body>",
    // W3.3 — reference-image overlay is injected as the FIRST child of body
    // so it paints above the `#selene-design-preview-root` content via the
    // explicit z-index on the overlay root. The overlay itself has
    // `pointer-events: none`, so it never intercepts clicks on the actual
    // component — the opacity slider / blend-mode select / toggle button
    // live in a separate control panel that re-enables pointer events for
    // its own inputs. See `buildReferenceOverlayHtml` for the template.
    ...(referenceImageUrl ? buildReferenceOverlayHtml(referenceImageUrl) : []),
    '  <div id="selene-design-preview-root"></div>',
    "  <script>",
    "    function __showError__(label, msg) {",
    "      var root = document.getElementById('selene-design-preview-root');",
    "      if (!root) return;",
    "      var div = document.createElement('div');",
    "      div.style.cssText = 'padding:16px;font-family:ui-monospace,monospace;background:#111827;color:#ef4444;white-space:pre-wrap;font-size:13px;';",
    "      div.textContent = label + ':\\n' + msg;",
    "      root.replaceChildren(div);",
    "    }",
    "    window.onerror = function(msg, src, line, col, err) {",
    "      __showError__('Runtime Error', err ? (err.stack || err.message) : String(msg));",
    "      return true;",
    "    };",
    "    window.onunhandledrejection = function(event) {",
    "      var reason = event.reason;",
    "      __showError__('Unhandled Promise Rejection', reason ? (reason.stack || reason.message || String(reason)) : 'Unknown');",
    "    };",
    "  </script>",
    `  <script>${safeJs}<\/script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function createMissingDependencyIssues(
  dependencyCheck: DependencyValidationResult,
): DesignWorkspaceCompilationIssue[] {
  return dependencyCheck.missingPackages.map((packageName) => ({
    type: "dependency",
    message: `Cannot resolve workspace package \"${packageName}\".`,
    suggestion: `Install ${packageName} in ${SANDBOX_DIR_NAME}/package.json or allow automatic recovery to install it.`,
  }));
}

function buildReportMessage(report: DesignWorkspaceCompileReport): string {
  const primary = report.errors[0]?.message;
  if (primary) {
    return primary;
  }

  if (report.dependencyCheck.missingPackages.length > 0) {
    return `Missing dependencies: ${report.dependencyCheck.missingPackages.join(", ")}`;
  }

  return "Design preview compilation failed.";
}

function logCompilerFailure(
  source: string,
  report: DesignWorkspaceCompileReport,
  message: string,
): void {
  logToolEvent({
    level: "error",
    toolName: "designWorkspaceCompiler",
    event: "error",
    error: message,
    metadata: {
      source,
      recovered: report.recovered,
      missingPackages: report.dependencyCheck.missingPackages,
      autoInstall: report.autoInstall,
      errors: report.errors,
    },
  });
}

export function isDesignWorkspaceCompileError(
  error: unknown,
): error is DesignWorkspaceCompileError {
  return error instanceof DesignWorkspaceCompileError;
}

export function isDesignWorkspaceGlobalsCssError(
  error: unknown,
): error is DesignWorkspaceGlobalsCssError {
  return error instanceof DesignWorkspaceGlobalsCssError;
}

export async function buildTailwindPreviewWithMetadata(
  componentCode: string,
  title: string,
  options: BuildTailwindPreviewOptions = {},
): Promise<BuildTailwindPreviewResult> {
  const startedAt = Date.now();
  const source = options.source ?? "design-workspace";
  // Default to "dark" to preserve the historical hardcoded
  // `<html class="dark">` output when callers haven't opted in yet.
  const previewTheme: DesignPreviewTheme = options.previewTheme ?? "dark";

  // --- W2.4 globals.css resolution (PRE-esbuild) --------------------------
  // Resolve + read the real app's globals.css BEFORE the expensive compile
  // pipeline so a bad path / oversized file fails fast. The resolved payload
  // is passed through to `buildCompiledPreviewHtml` and injected as the first
  // <style> block in <head> (Option A, see injection-order comment there).
  //
  // v1: NO caching across requests — each compile re-reads the file so
  // mutating the real app's globals.css always surfaces on the next preview.
  // TODO(perf): memoize by `(validPath, mtime)` if this becomes a hot path;
  // the data-globals-css-hash attribute on the preview document already lets
  // screenshot tooling detect staleness.
  let globalsCss: ResolvedGlobalsCss | undefined;
  if (options.globalsCssPath) {
    if (!options.characterId || !options.sessionId) {
      throw new DesignWorkspaceGlobalsCssError(
        "GLOBALS_CSS_NOT_FOUND",
        options.globalsCssPath,
        `globalsCssPath requires characterId and sessionId so the synced folder can be resolved.`,
      );
    }
    // Intentionally unawaited in a dedicated try block: `DesignWorkspaceGlobalsCssError`
    // is surfaced to the caller unchanged so the tool handler can map
    // `error.code` into a structured envelope field. We do NOT wrap it in a
    // `DesignWorkspaceCompileError` because the error is about the preview
    // environment, not the component source.
    globalsCss = await resolveAndReadGlobalsCss({
      globalsCssPath: options.globalsCssPath,
      characterId: options.characterId,
      sessionId: options.sessionId,
    });
  }

  // --- W2.3 alias rewrite (PRE-esbuild / PRE-tailwind) -------------------
  // Resolve `@asset/<alias>` references to their declared URLs BEFORE we
  // hand the source to dependency validation, esbuild, or the tailwind
  // content scanner. A missing alias becomes a compile-report error (not
  // a throw) so the caller's normal error-envelope path lights up with
  // the `ASSET_ALIAS_NOT_FOUND` code + declared aliases list.
  let rewrittenCode: string;
  try {
    rewrittenCode = rewriteAssetAliases(componentCode, options.assetAliases);
  } catch (error) {
    if (error instanceof AssetAliasNotFoundError) {
      const dependencyCheck = await validateWorkspaceDependencies(componentCode);
      const report: DesignWorkspaceCompileReport = {
        warnings: [],
        errors: [
          {
            type: "unknown",
            message: error.message,
            suggestion: `Declare "${error.alias}" in the tool call's "assetAliases" array (or remove the @asset/${error.alias} reference from the component source).`,
          },
        ],
        dependencyCheck: normalizeDependencySummary(dependencyCheck),
        recovered: false,
        durationMs: Date.now() - startedAt,
      };
      logCompilerFailure(source, report, error.message);
      throw new DesignWorkspaceCompileError(error.message, report);
    }
    throw error;
  }

  let dependencyCheck = await validateWorkspaceDependencies(rewrittenCode);
  let autoInstall: DesignWorkspaceAutoInstallSummary | undefined;
  let recovered = false;

  if (
    dependencyCheck.missingPackages.length > 0 &&
    options.autoInstallMissingDependencies !== false
  ) {
    logToolEvent({
      level: "warn",
      toolName: "designWorkspaceCompiler",
      event: "retry",
      error: `Missing dependencies detected: ${dependencyCheck.missingPackages.join(", ")}`,
      metadata: {
        source,
        missingPackages: dependencyCheck.missingPackages,
      },
    });

    autoInstall = normalizeAutoInstallSummary(
      await installSandboxPackages(dependencyCheck.missingPackages),
    );

    if (autoInstall?.success) {
      recovered = true;
      dependencyCheck = await validateWorkspaceDependencies(rewrittenCode);
    }
  }

  if (dependencyCheck.missingPackages.length > 0) {
    const report: DesignWorkspaceCompileReport = {
      warnings: [],
      errors: createMissingDependencyIssues(dependencyCheck),
      dependencyCheck: normalizeDependencySummary(dependencyCheck),
      autoInstall,
      recovered,
      durationMs: Date.now() - startedAt,
    };
    const message = buildReportMessage(report);
    logCompilerFailure(source, report, message);
    throw new DesignWorkspaceCompileError(message, report);
  }

  // Sprint 4 W4.2 — wire the `design:<ref>` resolver if the caller
  // supplied BOTH userId AND sessionId. We also require the loader
  // (defaulting to the real gallery query) so tests can swap in an
  // in-memory stub without touching sqlite.
  //
  // Rev-J1: the caller now supplies a `seedChain` (the root component's
  // id, ordered). The plugin itself maintains path-sensitive chain Maps
  // internally, so concurrent tool invocations can never poison each
  // other — every `compileReactComponent` call constructs a fresh plugin
  // instance with its own closures.
  let designImport: {
    userId: string;
    sessionId: string;
    seedChain: readonly string[];
    loader: DesignImportLoader;
  } | undefined;
  if (options.userId && options.sessionId) {
    const loader = options.designImportLoader ?? {
      async findByRef(input) {
        const row = await findWorkspaceDesignByIdOrTag(
          input.userId,
          input.sessionId,
          input.ref,
        );
        return row ? { id: row.id, sourceCode: row.code } : null;
      },
    };
    designImport = {
      userId: options.userId,
      sessionId: options.sessionId,
      seedChain: [...(options.designImportChainSeed ?? [])],
      loader,
    };
  }

  try {
    const compileResult = await compileReactComponent(
      rewrittenCode,
      dependencyCheck,
      options.renderMany,
      options.tsconfigPaths,
      designImport,
    );
    const tailwindCss = await buildPreviewTailwindCss(rewrittenCode);
    const report: DesignWorkspaceCompileReport = {
      warnings: compileResult.warnings,
      diagnostics: compileResult.diagnostics,
      errors: [],
      dependencyCheck: normalizeDependencySummary(dependencyCheck),
      autoInstall,
      recovered,
      durationMs: Date.now() - startedAt,
    };

    if (recovered) {
      logToolEvent({
        level: "info",
        toolName: "designWorkspaceCompiler",
        event: "success",
        durationMs: report.durationMs,
        metadata: {
          source,
          recovered,
          autoInstall,
        },
      });
    }

    return {
      html: buildCompiledPreviewHtml(
        compileResult.code,
        tailwindCss,
        title,
        previewTheme,
        globalsCss,
        options.referenceImageUrl,
      ),
      report,
    };
  } catch (error) {
    // Sprint 4 W4.2 — propagate the structured import error unchanged so
    // the tool handler can map `error.code` into an envelope field.
    // Wrapping in a DesignWorkspaceCompileError would strip `code` / `ref`
    // / `chain`, and the spec says we NEVER drop a field without an
    // agent-actionable substitute.
    if (error instanceof DesignWorkspaceImportError) {
      logCompilerFailure(
        source,
        {
          warnings: [],
          errors: [
            {
              type: "dependency",
              message: error.message,
              suggestion:
                error.code === "IMPORT_CYCLE_DETECTED"
                  ? `Break the cycle (chain: ${error.chain.join(" -> ")}).`
                  : error.code === "IMPORT_SCOPE_VIOLATION"
                    ? "Only import design: refs that belong to the current session."
                    : `No workspace component matches "design:${error.ref}" in this session.`,
            },
          ],
          dependencyCheck: normalizeDependencySummary(dependencyCheck),
          autoInstall,
          recovered,
          durationMs: Date.now() - startedAt,
        },
        error.message,
      );
      throw error;
    }

    const baseReport =
      error instanceof DesignWorkspaceCompileError
        ? error.report
        : {
            warnings: [],
            errors: [
              toCompilationIssue(
                error instanceof Error ? error.message : "Compilation failed.",
                undefined,
                dependencyCheck,
              ),
            ],
            dependencyCheck: normalizeDependencySummary(dependencyCheck),
            recovered: false,
            durationMs: 0,
          } satisfies DesignWorkspaceCompileReport;

    const report: DesignWorkspaceCompileReport = {
      ...baseReport,
      dependencyCheck: baseReport.dependencyCheck ?? normalizeDependencySummary(dependencyCheck),
      autoInstall: baseReport.autoInstall ?? autoInstall,
      recovered,
      durationMs: Date.now() - startedAt,
    };

    const message = buildReportMessage(report);
    logCompilerFailure(source, report, message);
    throw new DesignWorkspaceCompileError(message, report);
  }
}

export async function buildTailwindPreviewAsync(
  componentCode: string,
  title: string,
  options: Pick<BuildTailwindPreviewOptions, "assetAliases"> = {},
): Promise<string> {
  const { html } = await buildTailwindPreviewWithMetadata(componentCode, title, {
    autoInstallMissingDependencies: true,
    source: "design-workspace-preview",
    assetAliases: options.assetAliases,
  });
  return html;
}

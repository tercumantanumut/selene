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
// Namespace import used by the source-CSS preprocessor (`preprocessSourceCss`)
// for `path.resolve` against a per-file base directory and `path.dirname` /
// `path.normalize` while walking @import + url() references. The named import
// above is preserved so existing call sites (e.g. `extname(...)` lookups
// throughout the file) keep their unqualified spelling.
import * as path from "path";
import { createHash } from "crypto";
// Used by the source-CSS plugin (`createSourceCssPlugin`) to read `.css` /
// `.module.css` files imported by user components and inline them as runtime
// `<style>` injections. Synced-folder containment was already enforced when
// the importing TSX file was loaded, so esbuild's resolver landing on these
// paths is safe to read directly.
import { promises as fsPromises, existsSync } from "fs";
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
  tsconfigAliasMatches,
  type TsconfigPathsConfig,
} from "./tsconfig-paths";
import {
  ContainmentViolationError,
  assertContained,
  buildContainmentConfig,
  isContained,
  type ContainmentConfig,
} from "./containment";
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
const NEXT_PREVIEW_NAMESPACE = "selene-next-preview-stub";
const PREVIEW_TAILWIND_SOURCE = [
  "@tailwind base;",
  "@tailwind components;",
  "@tailwind utilities;",
  "",
].join("\n");

const NEXT_NAVIGATION_STUB_SOURCE = `
import React from "react";

const readPathname = () => {
  if (typeof window === "undefined") return "/";
  return window.location?.pathname || "/";
};

const readSearchParams = () => {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location?.search || "");
};

export function useRouter() {
  return {
    back() { window.history.back(); },
    forward() { window.history.forward(); },
    refresh() {},
    push(href) { window.history.pushState(null, "", href); window.dispatchEvent(new Event("popstate")); },
    replace(href) { window.history.replaceState(null, "", href); window.dispatchEvent(new Event("popstate")); },
    prefetch() {},
  };
}

export function usePathname() {
  return readPathname();
}

export function useSearchParams() {
  return readSearchParams();
}

export function useParams() {
  return {};
}

export function useSelectedLayoutSegment() {
  return null;
}

export function useSelectedLayoutSegments() {
  return [];
}

export function redirect(url) {
  if (typeof window !== "undefined") window.location.assign(url);
}

export function permanentRedirect(url) {
  redirect(url);
}

export function notFound() {
  throw new Error("next/navigation notFound() is not available in the design preview.");
}

export const RedirectType = { push: "push", replace: "replace" };
export const ReadonlyURLSearchParams = URLSearchParams;
export default { useRouter, usePathname, useSearchParams, useParams };
`;

const NEXT_LINK_STUB_SOURCE = `
import React from "react";

export default React.forwardRef(function Link(props, ref) {
  const { href, as, replace, scroll, shallow, prefetch, locale, legacyBehavior, passHref, children, ...rest } = props;
  const resolvedHref = typeof href === "string" ? href : (href && href.pathname) || "#";
  return React.createElement("a", { ...rest, ref, href: resolvedHref }, children);
});
`;

const NEXT_HEAD_STUB_SOURCE = `
import React from "react";

export default function Head(props) {
  return React.createElement(React.Fragment, null, props.children || null);
}
`;

const NEXT_IMAGE_STUB_SOURCE = `
import React from "react";

export default React.forwardRef(function Image(props, ref) {
  const { src, alt, width, height, fill, loader, quality, priority, placeholder, blurDataURL, unoptimized, sizes, ...rest } = props;
  const resolvedSrc = typeof src === "string" ? src : (src && src.src) || "";
  return React.createElement("img", { ...rest, ref, src: resolvedSrc, alt: alt || "", width: fill ? undefined : width, height: fill ? undefined : height, sizes });
});
`;

const NEXT_FONT_STUB_SOURCE = `
const createFont = () => ({ className: "", style: {}, variable: "" });
const fontProxy = new Proxy(createFont, {
  get(target, prop) {
    if (prop === "default") return target;
    if (prop === "__esModule") return true;
    return target;
  },
});
module.exports = fontProxy;
`;

const NEXT_DYNAMIC_STUB_SOURCE = `
import React from "react";

export default function dynamic(loaderOrComponent) {
  if (typeof loaderOrComponent === "function") {
    return function DynamicPreviewStub(props) {
      return React.createElement(React.Fragment, null);
    };
  }
  return function DynamicPreviewStub() {
    return React.createElement(React.Fragment, null);
  };
}
`;

const NEXT_SCRIPT_STUB_SOURCE = `
import React from "react";

export default function Script(props) {
  const { strategy, onLoad, onReady, onError, children, ...rest } = props;
  return React.createElement("script", rest, children || null);
}
`;

const NEXT_ROUTER_STUB_SOURCE = `
function noop() {}

export function useRouter() {
  const pathname = typeof window === "undefined" ? "/" : window.location?.pathname || "/";
  return {
    pathname,
    route: pathname,
    query: {},
    asPath: pathname,
    basePath: "",
    locale: undefined,
    locales: undefined,
    defaultLocale: undefined,
    isReady: true,
    isFallback: false,
    isPreview: false,
    back() { window.history.back(); },
    forward() { window.history.forward(); },
    reload() { window.location.reload(); },
    push(href) { window.history.pushState(null, "", href); return Promise.resolve(true); },
    replace(href) { window.history.replaceState(null, "", href); return Promise.resolve(true); },
    prefetch() { return Promise.resolve(); },
    beforePopState: noop,
    events: { on: noop, off: noop, emit: noop },
  };
}

export default { router: null, ready(callback) { if (typeof callback === "function") callback(); }, events: { on: noop, off: noop, emit: noop } };
`;

const NEXT_GENERIC_STUB_SOURCE = `
const noop = () => undefined;
const passthrough = (value) => value;
// Round-2 M4: \`headers()\` and \`cookies()\` need mutator methods. Server
// Actions and route handlers in App Router routinely call \`cookies().set()\`
// and \`headers().set()\` — without explicit \`set\` / \`delete\` shims those
// crash the preview at runtime with "set is not a function". The shims are
// intentionally noops (the iframe preview has no real request/response
// lifecycle) so the call site does not throw and the rendered output
// matches what a server-rendered page would look like before the mutation.
const headers = () => {
  const m = new Map();
  return {
    get: (name) => m.has(String(name).toLowerCase()) ? m.get(String(name).toLowerCase()) : null,
    has: (name) => m.has(String(name).toLowerCase()),
    set: (name, value) => { m.set(String(name).toLowerCase(), String(value)); },
    append: (name, value) => { m.set(String(name).toLowerCase(), String(value)); },
    delete: (name) => { m.delete(String(name).toLowerCase()); },
    forEach: (cb) => { m.forEach((v, k) => cb(v, k)); },
    entries: () => m.entries(),
    keys: () => m.keys(),
    values: () => m.values(),
    [Symbol.iterator]: () => m.entries(),
  };
};
const cookies = () => {
  const m = new Map();
  return {
    get: (name) => m.has(name) ? { name, value: m.get(name) } : undefined,
    getAll: () => Array.from(m.entries()).map(([name, value]) => ({ name, value })),
    has: (name) => m.has(name),
    set: (name, value) => {
      // Next.js \`cookies().set\` is overloaded: \`set(name, value, options?)\` OR
      // \`set({ name, value, ...options })\`. Both forms collapse to a noop
      // mutation on the in-memory Map for preview purposes.
      if (typeof name === "object" && name !== null) {
        m.set(name.name, name.value);
      } else {
        m.set(name, value);
      }
    },
    delete: (name) => {
      if (typeof name === "object" && name !== null) {
        m.delete(name.name ?? name);
      } else {
        m.delete(name);
      }
    },
    [Symbol.iterator]: () => m.entries(),
  };
};
const draftMode = () => ({ isEnabled: false, enable: noop, disable: noop });
const userAgent = () => ({});
const NextResponse = { next: () => ({}), json: (body) => body, redirect: (url) => url };

const generic = new Proxy(noop, {
  get(_target, prop) {
    if (prop === "default") return generic;
    if (prop === "__esModule") return true;
    if (prop === "headers") return headers;
    if (prop === "cookies") return cookies;
    if (prop === "draftMode") return draftMode;
    if (prop === "userAgent") return userAgent;
    if (prop === "NextResponse") return NextResponse;
    if (prop === "ImageResponse") return function ImageResponse() {};
    if (prop === "NextRequest") return function NextRequest() {};
    if (prop === "NextFetchEvent") return function NextFetchEvent() {};
    return noop;
  },
  apply(_target, _thisArg, args) {
    return args.length === 1 ? passthrough(args[0]) : undefined;
  },
});

module.exports = generic;
`;

/**
 * Rev-J3 audit — Next.js stub coverage matrix.
 *
 * Explicit per-module stubs (richer surface than the generic Proxy):
 *   - `next/navigation` → useRouter, usePathname, useSearchParams, useParams,
 *     useSelectedLayoutSegment(s), redirect, permanentRedirect, notFound,
 *     RedirectType, ReadonlyURLSearchParams.
 *   - `next/router` → pages-router useRouter shape.
 *   - `next/link` → renders an `<a>`.
 *   - `next/head` → renders children (no real <head> hoist; preview is iframe).
 *   - `next/image` → renders an `<img>` with the same src/sizes/etc.
 *   - `next/dynamic` → returns an empty Fragment stub.
 *   - `next/script` → renders a <script> element.
 *   - `next/font`, `next/font/*` → callable Proxy returning
 *     `{ className, style, variable }`.
 *
 * Generic Proxy fallback (covers everything else under `next/...`):
 *   - Default import + namespace import work via Proxy `default`/`__esModule`.
 *   - Named imports become noops, with explicit higher-fidelity hits for
 *     `headers`, `cookies`, `draftMode`, `userAgent`, `NextResponse`,
 *     `ImageResponse`, `NextRequest`, `NextFetchEvent` so the common
 *     server primitives in `next/server`, `next/headers`, `next/og`, and
 *     `next/cache` import without runtime crashes.
 *
 * Anything not on this list (e.g. esoteric `revalidatePath`, `unstable_*`)
 * resolves to a `noop` thanks to the Proxy `get` trap. For preview, that's
 * the right answer: SSR-only side effects are a no-op in an IIFE bundle.
 */
function getNextPreviewStub(specifier: string): { source: string; loader: esbuild.Loader } {
  if (specifier === "next/navigation") {
    return { source: NEXT_NAVIGATION_STUB_SOURCE, loader: "tsx" };
  }
  if (specifier === "next/router") {
    return { source: NEXT_ROUTER_STUB_SOURCE, loader: "tsx" };
  }
  if (specifier === "next/link") {
    return { source: NEXT_LINK_STUB_SOURCE, loader: "tsx" };
  }
  if (specifier === "next/head") {
    return { source: NEXT_HEAD_STUB_SOURCE, loader: "tsx" };
  }
  if (specifier === "next/image") {
    return { source: NEXT_IMAGE_STUB_SOURCE, loader: "tsx" };
  }
  if (specifier === "next/dynamic") {
    return { source: NEXT_DYNAMIC_STUB_SOURCE, loader: "tsx" };
  }
  if (specifier === "next/script") {
    return { source: NEXT_SCRIPT_STUB_SOURCE, loader: "tsx" };
  }
  if (specifier === "next/font" || specifier.startsWith("next/font/")) {
    return { source: NEXT_FONT_STUB_SOURCE, loader: "js" };
  }
  return { source: NEXT_GENERIC_STUB_SOURCE, loader: "js" };
}

function createNextPreviewStubsPlugin(): esbuild.Plugin {
  return {
    name: "selene-next-preview-stubs",
    setup(build) {
      build.onResolve({ filter: /^next(?:\/.*)?$/ }, (args) => ({
        path: args.path,
        namespace: NEXT_PREVIEW_NAMESPACE,
      }));

      build.onLoad({ filter: /.*/, namespace: NEXT_PREVIEW_NAMESPACE }, (args) => {
        const stub = getNextPreviewStub(args.path);
        return {
          contents: stub.source,
          loader: stub.loader,
          resolveDir: PROJECT_ROOT,
        };
      });
    },
  };
}

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
  /**
   * Working directory esbuild uses to resolve unqualified imports emitted
   * by the user's TSX (relative paths, sibling modules, parent-walking
   * `node_modules` lookups). The `import` action MUST set this to
   * `dirname(resolvedSourcePath)` from the synced folder so `./coach.css`
   * and similar specifiers resolve against the file's actual location
   * instead of `PROJECT_ROOT`.
   *
   * `generate` / `edit` / `patch` leave this undefined; the LLM-emitted
   * source has no on-disk home, so `PROJECT_ROOT` is the correct default.
   */
  componentResolveDir?: string;
  /**
   * Extra `node_modules` directories to add to esbuild's `nodePaths`
   * after the sandbox's `node_modules`. The `import` action passes the
   * synced repo's `node_modules` so the preview re-uses whatever the
   * user has installed in their target codebase, eliminating most
   * sandbox-install churn for production-grade Next.js apps.
   *
   * Sandbox order is preserved: the curated `selene-workspace`
   * `node_modules` wins on package collisions.
   */
  extraNodePaths?: readonly string[];
  /**
   * Round-2 (B1+M5): synced-folder containment config for the `import`
   * action. When supplied, the compile pipeline enforces an allowlist
   * of root directories at every onLoad — relative imports (`./foo`),
   * tsconfig-paths aliases (`@/lib/x`), and bare specifiers that
   * resolve to a file outside the allowlist are rejected with
   * `ContainmentViolationError` (mapped to a `containment` issue).
   *
   * Pipelines that pre-date the import action (`generate` / `edit` /
   * `patch`) leave this undefined and operate in the historical
   * no-containment mode — synced-folder reads in those flows already
   * funnel through `readSyncedFile()` which has its own check.
   */
  containment?: ContainmentConfig;
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
  // Round-2 M1 — defensive fallback. The source-CSS plugin throws
  // PreprocessorNotSupportedError up front for `.scss/.sass/.less/.styl`,
  // so this branch is only reached if a future loader change lets the
  // raw esbuild "no loader is configured" message slip through. Keep
  // the dependency classification (suggestion strings stay actionable)
  // until/unless we add a dedicated `preprocessor` issue type to
  // DesignWorkspaceCompilationIssue.
  if (normalized.includes("no loader is configured")) {
    return "dependency";
  }
  // Round-2 (B1+M5) — same defensive fallback for raw containment text
  // that bypasses the typed-error unwrap path. The actionable
  // suggestion is built downstream by `buildIssueSuggestion`.
  if (normalized.includes("outside the synced-folder allowlist")) {
    return "dependency";
  }
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

/**
 * Resolution-error sub-classification. esbuild's "Could not resolve X" is one
 * of four very different problems, and pre-Rev-J2 the suggestion always told
 * the user to install X into `selene-workspace/package.json` — even when X was
 * `./coach.css` (a sibling file, not an npm package). Each kind has a
 * distinct recovery path that the agent can act on without reading the raw
 * error text:
 *
 *   - "relative":   `./foo`, `../foo`, `/abs` — sibling/parent file the
 *                   resolver couldn't locate. Recovery: verify the file
 *                   exists at the expected path inside the synced folder.
 *   - "alias":      matches a tsconfig.paths rule but the alias target file
 *                   is missing. Recovery: check the corresponding paths
 *                   entry; the alias config is right but the on-disk target
 *                   doesn't exist.
 *   - "framework":  Next.js / framework primitive that needs a preview
 *                   shim. Recovery: out of the agent's hands — the shim is
 *                   either provided by `createNextPreviewStubsPlugin` or it
 *                   isn't, and unsupported primitives should be ported via
 *                   `action: "port"`.
 *   - "npm":        bare specifier (no leading dot/slash, no alias hit, no
 *                   framework prefix). Recovery: install into the sandbox
 *                   manifest, or — for the `import` action — verify the
 *                   synced repo's `node_modules` actually has the package.
 */
type ResolutionErrorKind = "relative" | "alias" | "framework" | "npm";

// Rev-J3 — `tsconfigAliasMatches` was lifted into ./tsconfig-paths so
// dependencies.ts can use the same pattern test to skip alias-matching
// specifiers during the missing-package check. The compiler keeps the
// import + uses the same shared helper.

function classifyResolutionTarget(
  target: string,
  tsconfigPaths?: TsconfigPathsConfig,
): ResolutionErrorKind {
  if (target.startsWith(".") || target.startsWith("/")) return "relative";
  // `next` is the bare-package form; `next/...` is a subpath. Both are routed
  // to `createNextPreviewStubsPlugin`, so reaching the resolution-error path
  // for them means either the plugin's stub list missed a primitive or the
  // resolve filter regressed — either way the recovery is "shim or port",
  // not "install".
  if (target === "next" || target.startsWith("next/")) return "framework";
  if (tsconfigPaths && tsconfigAliasMatches(target, tsconfigPaths)) return "alias";
  return "npm";
}

function buildIssueSuggestion(
  issueType: DesignWorkspaceCompilationIssue["type"],
  message: string,
  dependencyCheck: DependencyValidationResult,
  tsconfigPaths?: TsconfigPathsConfig,
): string | undefined {
  if (issueType === "dependency") {
    const missingPackages = dependencyCheck.missingPackages;
    if (missingPackages.length > 0) {
      return `Install missing workspace packages: ${missingPackages.join(", ")}`;
    }

    const couldResolveMatch = message.match(/["'`](.+?)["'`]/);
    if (couldResolveMatch?.[1]) {
      const target = couldResolveMatch[1];
      const kind = classifyResolutionTarget(target, tsconfigPaths);
      switch (kind) {
        case "relative":
          return (
            `Unresolved relative import "${target}". The pipeline reads sibling ` +
            `files from the importing source's directory inside the synced ` +
            `folder. Verify the file exists at the expected path and that the ` +
            `path is contained in a synced folder.`
          );
        case "alias":
          return (
            `Path alias "${target}" matched a tsconfig.json paths rule but the ` +
            `target file was not found on disk. Check the corresponding ` +
            `compilerOptions.paths entry in the synced folder's tsconfig.json ` +
            `and verify the file exists.`
          );
        case "framework":
          return (
            `Framework primitive "${target}" is not currently shimmed for the ` +
            `design preview. Supported: next/navigation, next/router, next/link, ` +
            `next/head, next/image, next/dynamic, next/script, next/font/*. ` +
            `Other next/* paths fall back to a generic noop stub. If the ` +
            `imported component depends on the real runtime, port it via ` +
            `action: "port" instead of import.`
          );
        case "npm":
        default:
          return (
            `Could not resolve npm package "${target}". For "import": verify ` +
            `the synced repo's node_modules has it installed (run npm/pnpm/yarn ` +
            `install in the source repo). For other actions: add it to ` +
            `${SANDBOX_DIR_NAME}/package.json.`
          );
      }
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

/**
 * Round-3 M5 — stable code derivation for compile-report issues.
 *
 * Codes are inferred from the same classification we already do for the
 * suggestion string. This means: if `buildIssueSuggestion` could pick a
 * specific recovery path (relative / alias / framework / npm), we record
 * the matching code. If the message text didn't yield a structured
 * unresolved specifier, `undefined` is returned and the consumer falls
 * back to `type`. Containment / preprocessor failures ARE NOT routed
 * through this helper — they go through dedicated typed-error catch
 * paths in `buildTailwindPreviewWithMetadata`, which build the issue
 * with `code: "CONTAINMENT_VIOLATION" | "PREPROCESSOR_NOT_SUPPORTED"`
 * directly.
 */
function deriveIssueCode(
  type: DesignWorkspaceCompilationIssue["type"],
  message: string,
  tsconfigPaths?: TsconfigPathsConfig,
): DesignWorkspaceCompilationIssue["code"] {
  if (type !== "dependency") return undefined;
  const normalized = message.toLowerCase();
  if (normalized.includes("outside the synced-folder allowlist")) {
    return "CONTAINMENT_VIOLATION";
  }
  if (
    normalized.includes("preprocessed stylesheet") ||
    (normalized.includes("no loader is configured") &&
      /\.(scss|sass|less|styl|stylus)\b/.test(normalized))
  ) {
    return "PREPROCESSOR_NOT_SUPPORTED";
  }
  const couldResolveMatch = message.match(/["'`](.+?)["'`]/);
  if (!couldResolveMatch?.[1]) return undefined;
  const target = couldResolveMatch[1];
  switch (classifyResolutionTarget(target, tsconfigPaths)) {
    case "relative":
      return "UNRESOLVED_RELATIVE_IMPORT";
    case "alias":
      return "UNRESOLVED_PATH_ALIAS";
    case "framework":
      return "UNSHIMMED_FRAMEWORK_PRIMITIVE";
    case "npm":
      return "MISSING_NPM_PACKAGE";
  }
}

function toCompilationIssue(
  text: string,
  location: DesignWorkspaceDiagnostic["location"],
  dependencyCheck: DependencyValidationResult,
  tsconfigPaths?: TsconfigPathsConfig,
): DesignWorkspaceCompilationIssue {
  const type = inferIssueType(text);
  return {
    type,
    code: deriveIssueCode(type, text, tsconfigPaths),
    message: text,
    location,
    suggestion: buildIssueSuggestion(type, text, dependencyCheck, tsconfigPaths),
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

/**
 * Loads the user's TSX as a virtual module. The `resolveDir` we hand back to
 * esbuild is the working directory from which esbuild will follow any
 * unqualified imports the source file emits — relative paths (`./coach.css`),
 * sibling modules, and the synced-repo's `node_modules` if the importer lives
 * inside a synced folder.
 *
 * For `generate` / `edit` / `patch`, the source has no on-disk home, so the
 * default `PROJECT_ROOT` is correct (it lets the LLM-emitted code use
 * bare-package imports that resolve through `nodePaths`).
 *
 * For `import`, callers MUST pass the directory of the imported source file —
 * `dirname(resolvedSourcePath)` from the synced folder — so relative imports
 * resolve against the file's actual location instead of failing with a
 * misleading "could not resolve" error pointing at PROJECT_ROOT.
 */
function createComponentPlugin(
  componentCode: string,
  resolveDir: string = PROJECT_ROOT,
): esbuild.Plugin {
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
        resolveDir,
      }));
    },
  };
}

/**
 * Round-2 B1: containment-guard plugin. Registered after plugin-owned
 * namespace loaders so CSS / tsconfig / design-import handlers can claim
 * their files first, while default file-namespace loads still pass through
 * this guard before esbuild's built-in loader reads from disk. The hook
 * sees relative imports the user's TSX makes against `componentResolveDir`,
 * sibling component files, and transitive imports of imported modules.
 *
 * Behaviour:
 *   - If the absolute load path is inside ANY allowed root, return
 *     `undefined` so the next plugin (or esbuild's default loader) takes
 *     over normally.
 *   - If outside every allowed root, throw `ContainmentViolationError`.
 *     esbuild wraps the throw into its `errors[*].detail` field; the
 *     compile catch-block unwraps it and surfaces a classified
 *     compile-report issue with code `CONTAINMENT_VIOLATION`.
 *
 * Why onLoad instead of onResolve: esbuild's resolver walks the parent
 * directory chain for bare specifiers and falls back to nodePaths after
 * — capturing the FINAL resolved absolute path requires hooking after
 * resolution. onLoad on the file namespace runs once per resolved file,
 * which is the right place to gate disk reads.
 *
 * Plugins that load through their own namespace (`selene-tsconfig-paths`,
 * `selene-source-css`, `selene-next-preview-stubs`, the design-import
 * resolver, and the external-url plugin) are NOT covered by this file-
 * namespace filter — those plugins enforce containment internally where
 * applicable.
 */
function createContainmentGuardPlugin(
  containment: ContainmentConfig,
): esbuild.Plugin {
  return {
    name: "selene-containment-guard",
    setup(build) {
      build.onLoad({ filter: /.*/, namespace: "file" }, (args) => {
        if (!isContained(args.path, containment)) {
          throw new ContainmentViolationError(
            args.path,
            containment.allowedRoots,
          );
        }
        // Pass-through: returning undefined lets the next plugin or
        // esbuild's default loader handle the actual content.
        return undefined;
      });
    },
  };
}

/**
 * Round-2 M3: explicit sandbox-wins resolver for bare package specifiers.
 *
 * Why this exists: the import action sets `componentResolveDir` to the
 * source file's actual directory inside the synced folder. esbuild's
 * default resolver walks parent directories from `resolveDir` looking
 * for `node_modules` BEFORE consulting the build-level `nodePaths`
 * fallback. So with a Next.js page at `/synced/repo/app/coach/page.tsx`,
 * the synced repo's `node_modules` (e.g. `/synced/repo/node_modules`)
 * wins even when the curated sandbox `selene-workspace/node_modules`
 * has the same package. That breaks the "sandbox always wins on
 * collision" guarantee — and worse, it lets a synced repo override
 * curated package versions silently.
 *
 * The plugin runs FIRST in the resolver chain. For each bare
 * specifier (no leading `.` / `/`, no `next/...`, no `design:...`):
 *   1. If the package directory exists under `SANDBOX_NODE_MODULES`,
 *      we delegate back to esbuild via `build.resolve()` with
 *      `resolveDir: SANDBOX_DIR`. esbuild then walks from SANDBOX_DIR
 *      and finds the package in its node_modules first. We tag with
 *      `pluginData` to short-circuit recursion.
 *   2. Otherwise we return `undefined` so esbuild's default resolver
 *      runs (which walks from the importer's resolveDir and falls back
 *      to nodePaths — exactly what we want when the sandbox lacks the
 *      package).
 *
 * Edge cases handled by early-out:
 *   - The virtual component path (intercepted by createComponentPlugin).
 *   - `next/...` and bare `next` (handled by next-preview-stubs).
 *   - `design:<ref>` (handled by the design-import plugin).
 *   - URLs (`http:`, `https:`, `data:`) and node builtins (`node:fs`).
 *   - The recursive call's own `pluginData.__sandboxFirst` marker.
 *   - Round-3 M3 — tsconfig-alias-matching specifiers. A specifier that
 *     matches a `paths` rule in the synced folder's `tsconfig.json` MUST
 *     be handled by the tsconfig-paths plugin, not by this sandbox-first
 *     hijack. Without this guard, monorepo-style aliases like `@repo/ui`
 *     could be silently captured by the sandbox if a same-named package
 *     happened to exist there, breaking the user's alias intent.
 */
function createSandboxFirstPackagePlugin(
  tsconfigPaths?: TsconfigPathsConfig,
): esbuild.Plugin {
  return {
    name: "selene-sandbox-first-package",
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        // Recursion guard — when WE call build.resolve below, esbuild
        // re-enters the resolver chain. The pluginData marker tells us
        // we're inside that re-entry and should let esbuild handle it.
        if (
          (args.pluginData as { __sandboxFirst?: boolean } | undefined)
            ?.__sandboxFirst
        ) {
          return undefined;
        }
        const spec = args.path;
        // Don't intercept paths owned by other plugins. The list mirrors
        // every other plugin's `filter` so we don't double-resolve.
        if (
          spec === VIRTUAL_COMPONENT_PATH ||
          spec === "next" ||
          spec.startsWith("next/") ||
          spec.startsWith("design:") ||
          spec.startsWith("http:") ||
          spec.startsWith("https:") ||
          spec.startsWith("data:") ||
          spec.startsWith("node:")
        ) {
          return undefined;
        }
        // Round-3 M3 — alias awareness. If the specifier matches a
        // tsconfig.json `paths` rule, defer to the tsconfig-paths plugin
        // (registered later in the chain). This matters for monorepo
        // aliases that look like packages — e.g. `@repo/ui` resolves via
        // `paths` to a synced-folder file, NOT to a sandbox package of
        // the same name. Without this guard the sandbox-first existence
        // probe could spuriously match an unrelated package and override
        // the alias intent.
        if (tsconfigPaths && tsconfigAliasMatches(spec, tsconfigPaths)) {
          return undefined;
        }
        // Extract the package root for the existence probe — `lodash/get`
        // → `lodash`, `@scope/name/sub` → `@scope/name`. This mirrors
        // `normalizePackageName` in dependencies.ts but inlined to avoid
        // pulling that module's filter list (which excludes specifiers
        // we DO want to handle here).
        let packageRoot: string;
        if (spec.startsWith("@")) {
          const slash = spec.indexOf("/");
          if (slash === -1) return undefined; // malformed scope-only
          const second = spec.indexOf("/", slash + 1);
          packageRoot = second === -1 ? spec : spec.slice(0, second);
        } else {
          const slash = spec.indexOf("/");
          packageRoot = slash === -1 ? spec : spec.slice(0, slash);
        }
        // Existence probe: only force sandbox-first when the sandbox
        // actually has the package. If it doesn't, we fall through to
        // esbuild's default resolution (which finds it in the synced
        // repo or via `nodePaths`).
        if (
          !existsSync(resolve(SANDBOX_NODE_MODULES, packageRoot, "package.json")) &&
          !existsSync(resolve(SANDBOX_NODE_MODULES, packageRoot))
        ) {
          return undefined;
        }
        const result = await build.resolve(spec, {
          kind: args.kind,
          // Forcing the resolveDir to SANDBOX_DIR makes esbuild's
          // parent-walk start at the sandbox, so SANDBOX_NODE_MODULES is
          // the first node_modules directory it finds.
          resolveDir: SANDBOX_DIR,
          pluginData: { __sandboxFirst: true },
        });
        if (result.errors.length > 0 || !result.path) {
          return undefined;
        }
        return {
          path: result.path,
          namespace: result.namespace,
          external: result.external,
          sideEffects: result.sideEffects,
        };
      });
    },
  };
}

/**
 * Plugin error: the source TSX (or a transitive dependency) imports a
 * preprocessed-CSS file (`.scss`, `.sass`, `.less`, `.styl`) that the
 * design preview cannot bundle without an external compiler. Surfaced as
 * a structured compile-report issue (kind=`preprocessor`) so the agent
 * can recommend porting via `action: "port"` or pre-compiling to plain
 * CSS, instead of getting esbuild's generic "no loader configured" error.
 */
class PreprocessorNotSupportedError extends Error {
  readonly code = "PREPROCESSOR_NOT_SUPPORTED" as const;
  constructor(
    public readonly absPath: string,
    public readonly extension: string,
  ) {
    super(
      `Preprocessed stylesheet "${absPath}" (${extension}) is not supported ` +
        `by the design-workspace import preview. The pipeline only handles ` +
        `plain ".css" and ".module.css" files. Pre-compile to CSS or use ` +
        `action: "port" to render with the LLM.`,
    );
    this.name = "PreprocessorNotSupportedError";
  }
}

// Common image / font / asset MIME types used by the CSS preprocessor when
// inlining `url("./bg.png")` / `url("../fonts/Inter.woff2")` references as
// `data:` URIs. Anything outside this map falls back to
// `application/octet-stream` — still valid as a data URI, but with a less
// helpful Content-Type for the browser. Keeping the table narrow because
// the alternative (a full mime-types dependency) would pull in ~3 MB.
const CSS_ASSET_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
};

const PREPROCESSOR_EXTENSIONS = new Set([".scss", ".sass", ".less", ".styl", ".stylus"]);

function isExternalUrl(target: string): boolean {
  return (
    target.startsWith("http:") ||
    target.startsWith("https:") ||
    target.startsWith("data:") ||
    target.startsWith("//")
  );
}

function isUrlTokenInImport(cssContent: string, urlIndex: number): boolean {
  const previousBoundary = Math.max(
    cssContent.lastIndexOf(";", urlIndex),
    cssContent.lastIndexOf("{", urlIndex),
    cssContent.lastIndexOf("}", urlIndex),
  );
  return /@import\b/i.test(cssContent.slice(previousBoundary + 1, urlIndex));
}

/**
 * Recursive CSS preprocessor — walks `@import` directives and `url(...)`
 * references in plain CSS so the inlined `<style>` text in the iframe
 * preview behaves like the original file would in a browser.
 *
 *   - `@import "./tokens.css"` → file is read, preprocessed itself, and
 *     concatenated into the parent.
 *   - `url("./hero.png")` / `url(./bg.svg)` → file is read and emitted as
 *     a `data:<mime>;base64,...` URI so the asset works without a server.
 *   - External URLs (`http://`, `https://`, `data:`, `//`) and absolute
 *     URLs (`/foo.png`) are left untouched.
 *
 * Containment is enforced on every read — anything that resolves outside
 * the synced folder is refused with `ContainmentViolationError`. Read
 * failures (missing files, permission errors) fall through to leaving
 * the original `@import` / `url()` text in place; the rendered preview
 * will produce a 404 in the iframe console, which is the correct signal.
 *
 * Cycle protection: `visited` tracks absolute paths already preprocessed
 * on this branch. A `@import` that re-enters a file already on the stack
 * is replaced with a comment and skipped, mirroring the way real CSS
 * loaders break cycles.
 */
async function preprocessSourceCss(
  cssContent: string,
  cssFilePath: string,
  containment: ContainmentConfig | undefined,
  visited: Set<string> = new Set(),
): Promise<string> {
  const baseDir = path.dirname(cssFilePath);
  const normalizedSelf = path.normalize(cssFilePath);
  if (visited.has(normalizedSelf)) {
    return `/* @import cycle skipped: ${cssFilePath} */`;
  }
  const nextVisited = new Set(visited);
  nextVisited.add(normalizedSelf);

  // Round-3 M2 — scan the ORIGINAL `cssContent` (not the post-expansion
  // `processed` text) for both passes. The previous order built `processed`
  // by expanding @import directives first, then walked `processed` for
  // url() references — which meant url()s inside imported CSS that we'd
  // already recursively expanded got re-walked in the parent's pass and
  // re-resolved against the parent's `baseDir`. For most cases the
  // recursive call had already converted the url() to a `data:` URI (which
  // the parent skips via isExternalUrl), so the bug was latent. But when
  // the inner url() was skipped — missing file, containment violation, or
  // any read error — the literal `url("./bg.png")` survived into the
  // expanded text and was then re-resolved against the parent's
  // directory. That could inline the wrong asset (or worse, hit a
  // same-named file under the parent) silently.
  //
  // The fix is the natural order: process the parent's own url()s
  // first against `baseDir`, THEN expand @imports (whose recursion has
  // already used each imported file's own directory). The result is a
  // single-pass concatenation where every url() was resolved against the
  // correct base, and stale literals inside expanded imports stay
  // exactly as the recursion left them.
  const importRegex = /@import\s+(?:url\(\s*)?["']([^"')]+)["']\s*\)?\s*;?/g;
  const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

  // ----- Pass 1: parent's own url() references (scanned in cssContent) ---
  const urlReplacements: Array<{ match: string; replacement: string }> = [];
  for (const match of cssContent.matchAll(urlRegex)) {
    const [literal, , target] = match;
    if (
      match.index !== undefined &&
      isUrlTokenInImport(cssContent, match.index)
    ) {
      continue;
    }
    if (isExternalUrl(target) || target.startsWith("/") || target.startsWith("#")) {
      continue;
    }
    const resolved = path.resolve(baseDir, target);
    try {
      if (containment) {
        if (!isContained(resolved, containment)) {
          // url() containment violations are non-fatal: leaving the raw
          // path in place produces a 404 instead of leaking out, which
          // is the safe default. We DO leave the urlRegex match untouched
          // so the failure remains visible.
          continue;
        }
      }
      const data = await fsPromises.readFile(resolved);
      const ext = path.extname(resolved).slice(1).toLowerCase();
      const mime = CSS_ASSET_MIME_TYPES[ext] || "application/octet-stream";
      const base64 = data.toString("base64");
      urlReplacements.push({
        match: literal,
        replacement: `url("data:${mime};base64,${base64}")`,
      });
    } catch {
      // Missing asset — leave url() as-is so the iframe console reports
      // the 404. Hiding it would mask layout issues during preview.
    }
  }
  // Build the `processed` text by applying url() replacements directly to
  // the original cssContent. After this point any url() that survived (skip
  // / containment / read-error) remains in its ORIGINAL form, anchored to
  // this file's directory — never re-resolved against a parent's baseDir.
  let processed = cssContent;
  for (const replacement of urlReplacements) {
    processed = processed.replace(replacement.match, replacement.replacement);
  }

  // ----- Pass 2: @import directives (scanned in cssContent) ---------------
  // Recursive expansion. Each imported file is preprocessed in its OWN
  // baseDir, so url() references inside the imported file resolve against
  // the imported file's directory. We collect replacements first, then
  // apply them — this matches our `cssContent`-anchored scan while still
  // mutating `processed` (which already has parent url()s rewritten).
  const importTasks: Array<{ match: string; replacement: string }> = [];
  for (const match of cssContent.matchAll(importRegex)) {
    const [literal, target] = match;
    if (isExternalUrl(target)) {
      // Keep external imports as-is — the preview iframe will fetch
      // them directly via the runtime <link> injection.
      continue;
    }
    if (target.startsWith("/")) {
      // Absolute paths point at a webserver root we don't have. Leave
      // alone; browser will 404, which the iframe console reports.
      continue;
    }
    const resolved = path.resolve(baseDir, target);
    try {
      if (containment) {
        if (!isContained(resolved, containment)) {
          throw new ContainmentViolationError(resolved, containment.allowedRoots, target);
        }
      }
      const importedSource = await fsPromises.readFile(resolved, "utf8");
      const expanded = await preprocessSourceCss(
        importedSource,
        resolved,
        containment,
        nextVisited,
      );
      importTasks.push({
        match: literal,
        replacement: `/* @import ${JSON.stringify(target)} */\n${expanded}\n/* @end-import */`,
      });
    } catch (error) {
      // Containment violations propagate — they are sandbox-correctness
      // failures the agent must see. Other read errors leave the
      // original @import text in place so the iframe's network layer
      // surfaces them as a normal 404.
      if (error instanceof ContainmentViolationError) {
        throw error;
      }
    }
  }
  for (const task of importTasks) {
    processed = processed.replace(task.match, task.replacement);
  }

  return processed;
}

/**
 * Loads `.css` and `.module.css` files from the synced repo and converts each
 * import into a small JS shim that injects a `<style>` block at runtime. This
 * lets imported components keep their plain-CSS sibling files (`./coach.css`)
 * and CSS-Modules class declarations, even though the preview ships as an
 * IIFE bundle (which esbuild's native CSS pipeline cannot inline).
 *
 * Round-2 M2: each loaded CSS file is recursively preprocessed via
 * `preprocessSourceCss` so `@import "./tokens.css"` and `url("./hero.png")`
 * references resolve against the source CSS file's actual directory and the
 * resulting `<style>` text is self-contained (assets emitted as data URIs).
 * Without this, a typical Next.js `globals.css` chain that uses `@import` or
 * `background-image: url(...)` would 404 in the iframe.
 *
 * Round-2 M1: imports of preprocessed stylesheets (`.scss`, `.sass`, `.less`,
 * `.styl`) throw `PreprocessorNotSupportedError`. esbuild has no built-in
 * Sass loader, so without this hook the user gets the unhelpful "no loader
 * configured" error; with the hook, the agent gets a structured signal that
 * it should pre-compile the file or port via `action: "port"`.
 *
 * Round-2 B1: every disk read is gated by the containment guard. CSS files,
 * `@import` targets, and `url()` assets are all validated against the
 * synced-folder allowed-roots before being read.
 *
 * For CSS Modules the class-name map is implemented as an identity Proxy:
 * `styles.button` returns the literal string `"button"`. This is intentionally
 * lossy — it preserves the layout and class hooks the component relies on
 * without requiring a full CSS Modules compiler. Style scoping is therefore
 * NOT preserved; the previewed component sees the raw class names. We accept
 * this trade-off because preview fidelity for class-name layout is more
 * important than perfect scoping inside an isolated iframe.
 *
 * Files we cannot read (permission errors, dangling symlinks) fall through to
 * esbuild's default resolver, which will surface a "could not resolve" error
 * with the resolution-error classifier downstream.
 */
function createSourceCssPlugin(
  containment?: ContainmentConfig,
): esbuild.Plugin {
  return {
    name: "selene-source-css",
    setup(build) {
      // Round-2 M1: reject preprocessed stylesheets up front. The filter
      // runs on `args.path` regardless of how the file was resolved, so
      // we catch both relative imports (`./styles.scss`) and aliased
      // ones (`@/styles/coach.module.scss`).
      build.onLoad({ filter: /\.(scss|sass|less|styl|stylus)$/ }, (args) => {
        throw new PreprocessorNotSupportedError(
          args.path,
          path.extname(args.path),
        );
      });

      // CSS Modules registered before the generic `.css$` filter — the
      // more specific filter wins for `*.module.css` because esbuild
      // dispatches in registration order and stops at the first non-null
      // result.
      build.onLoad({ filter: /\.module\.css$/ }, async (args) => {
        if (containment) {
          assertContained(args.path, containment);
        }
        let css: string;
        try {
          css = await fsPromises.readFile(args.path, "utf8");
        } catch {
          return null;
        }
        const processed = await preprocessSourceCss(css, args.path, containment);
        return {
          contents: [
            "(function () {",
            '  if (typeof document === "undefined") return;',
            '  var s = document.createElement("style");',
            `  s.setAttribute("data-source", ${JSON.stringify(args.path)});`,
            `  s.textContent = ${JSON.stringify(processed)};`,
            "  document.head.appendChild(s);",
            "})();",
            // Identity proxy — `styles.foo` evaluates to "foo". Preserves the
            // call-site shape so render code that does `<div className={styles.x}>`
            // stays valid; class-name *scoping* is not preserved by design.
            'export default new Proxy({}, { get: function (_t, p) { return typeof p === "string" ? p : undefined; } });',
          ].join("\n"),
          loader: "js",
        };
      });

      build.onLoad({ filter: /\.css$/ }, async (args) => {
        if (containment) {
          assertContained(args.path, containment);
        }
        let css: string;
        try {
          css = await fsPromises.readFile(args.path, "utf8");
        } catch {
          return null;
        }
        const processed = await preprocessSourceCss(css, args.path, containment);
        return {
          contents: [
            "(function () {",
            '  if (typeof document === "undefined") return;',
            '  var s = document.createElement("style");',
            `  s.setAttribute("data-source", ${JSON.stringify(args.path)});`,
            `  s.textContent = ${JSON.stringify(processed)};`,
            "  document.head.appendChild(s);",
            "})();",
          ].join("\n"),
          loader: "js",
        };
      });
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
  /**
   * Working directory esbuild uses to resolve unqualified imports emitted by
   * the user's TSX (e.g. `./coach.css`, sibling component files, `node_modules`
   * lookups that walk parent directories). Defaults to `PROJECT_ROOT` so the
   * historical behavior for `generate` / `edit` / `patch` (LLM-emitted source
   * with no on-disk home) is preserved.
   *
   * The `import` action MUST pass `dirname(resolvedSourcePath)` from the
   * synced folder so relative imports resolve against the file's actual
   * location instead of `PROJECT_ROOT`. Without this, `import "./foo.css"`
   * from `/repo/app/coach/page.tsx` resolves to `<project>/foo.css` and
   * fails with a misleading "Could not resolve" error.
   */
  componentResolveDir?: string,
  /**
   * Additional `node_modules` directories esbuild searches when a bare
   * specifier (e.g. `framer-motion`, `@radix-ui/react-slot`) cannot be
   * resolved through the sandbox. The `import` action passes the synced
   * repo's `node_modules` so the preview piggy-backs on whatever the user
   * already has installed in their target codebase, eliminating most
   * install churn for typical Next.js apps.
   *
   * Order matters: esbuild walks `nodePaths` left-to-right after exhausting
   * the per-importer resolution chain, so the sandbox wins on collisions
   * (preserving the curated dependency set from `selene-workspace/package.json`).
   */
  extraNodePaths?: readonly string[],
  /**
   * Round-2 (B1+M5): synced-folder containment config for the `import`
   * action. When present, every `onLoad` on the default file namespace
   * runs the path through {@link isContained}; tsconfig-paths and
   * source-CSS plugins run defense-in-depth `assertContained` after
   * their own resolves. Pipelines that pre-date the import action
   * (`generate` / `edit` / `patch`) pass `undefined` and operate in
   * the historical no-containment mode.
   */
  containment?: ContainmentConfig,
): Promise<CompileResult> {
  try {
    const plugins: esbuild.Plugin[] = [
      // Round-2 M3: sandbox-first must run BEFORE any other onResolve so
      // bare specifiers that exist in the curated sandbox cannot be
      // shadowed by an arbitrary `node_modules` walk from the synced
      // repo's resolveDir. The plugin is a no-op for specifiers the
      // sandbox does not contain (returns undefined), so unrelated bare
      // imports fall through to esbuild's default resolution.
      //
      // Round-3 M3: the plugin now also takes `tsconfigPaths` and skips
      // any specifier that matches a `paths` rule in the synced folder's
      // `tsconfig.json`. Without this, a monorepo-style alias like
      // `@repo/ui` could be incorrectly claimed by the sandbox if a
      // same-named package exists there, instead of being routed through
      // the tsconfig-paths plugin to the actual aliased file.
      createSandboxFirstPackagePlugin(tsconfigPaths),
      createExternalUrlPlugin(),
      createComponentPlugin(componentCode, componentResolveDir),
      createNextPreviewStubsPlugin(),
      // Source-CSS plugin must run BEFORE the tsconfig-paths plugin, otherwise
      // an aliased CSS file (e.g. `@/styles/globals.css`) would be claimed by
      // the alias plugin and loaded with the default `ts` loader. Registration
      // order = onLoad dispatch order, so the CSS plugin gets the first look at
      // any `.css` / `.module.css` path regardless of how it was resolved.
      createSourceCssPlugin(containment),
    ];
    if (tsconfigPaths) {
      plugins.push(createTsconfigPathsPlugin(tsconfigPaths, containment));
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
    if (containment) {
      // Containment guard registered LAST and scoped to esbuild's default
      // `file` namespace. Plugin-owned namespaces (selene-source-css,
      // selene-tsconfig-paths, selene-next-preview-stubs, design-workspace,
      // external-url, virtual-component) handle their own reads first, while
      // disk-backed files that fall through to esbuild's built-in loader pass
      // through this guard before any filesystem read.
      plugins.push(createContainmentGuardPlugin(containment));
    }

    const nodePaths = [SANDBOX_NODE_MODULES, ...(extraNodePaths ?? [])];

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
          // Inline asset imports — covers `import logo from "./logo.svg"`,
          // raster image imports, and any other binary the imported component
          // happens to reference. `dataurl` keeps the IIFE bundle self-contained
          // (no separate output files) at the cost of larger bundle size; for
          // preview workloads this trade-off is correct because the component
          // never ships to production.
          ".svg": "dataurl",
          ".png": "dataurl",
          ".jpg": "dataurl",
          ".jpeg": "dataurl",
          ".gif": "dataurl",
          ".webp": "dataurl",
          ".avif": "dataurl",
          ".ico": "dataurl",
        },
        nodePaths,
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
      // Round-2 (B1+M5): containment guard rejected an onLoad path that
      // walked outside the synced-folder allowlist. Surface the typed
      // error so the handler maps it to a `containment` issue with the
      // offending path + allowedRoots intact.
      if (detail instanceof ContainmentViolationError) {
        throw detail;
      }
      // Round-2 M1: source-CSS plugin rejected a preprocessed stylesheet
      // (.scss / .sass / .less / .styl). Surface the typed error so the
      // handler maps it to a `preprocessor` issue with a port-or-precompile
      // suggestion instead of esbuild's generic "no loader configured".
      if (detail instanceof PreprocessorNotSupportedError) {
        throw detail;
      }
    }
    if (error instanceof DesignWorkspaceImportError) {
      throw error;
    }
    if (error instanceof ContainmentViolationError) {
      throw error;
    }
    if (error instanceof PreprocessorNotSupportedError) {
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
            tsconfigPaths,
          ),
        )
      : [
          toCompilationIssue(
            error instanceof Error ? error.message : "Compilation failed.",
            undefined,
            dependencyCheck,
            tsconfigPaths,
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
  // Rev-J3 — single shared options object so all three callsites stay in
  // lock-step. The dependency check now mirrors esbuild's `nodePaths` so a
  // synced-repo `framer-motion` (only installed under the user's repo) is
  // not falsely flagged as missing, and tsconfig-aliased specifiers are
  // skipped because the tsconfig-paths plugin will resolve them.
  const dependencyValidationOptions = {
    tsconfigPaths: options.tsconfigPaths,
    extraNodePaths: options.extraNodePaths,
  };
  try {
    rewrittenCode = rewriteAssetAliases(componentCode, options.assetAliases);
  } catch (error) {
    if (error instanceof AssetAliasNotFoundError) {
      const dependencyCheck = await validateWorkspaceDependencies(
        componentCode,
        dependencyValidationOptions,
      );
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

  let dependencyCheck = await validateWorkspaceDependencies(
    rewrittenCode,
    dependencyValidationOptions,
  );
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
      dependencyCheck = await validateWorkspaceDependencies(
        rewrittenCode,
        dependencyValidationOptions,
      );
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
      options.componentResolveDir,
      options.extraNodePaths,
      options.containment,
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

    // Round-2 (B1+M5) — wrap a containment violation into a structured
    // DesignWorkspaceCompileError so the handler surfaces the offending
    // path + allowedRoots in the report, with an actionable suggestion
    // explaining how to widen the allowlist or move the file inside it.
    if (error instanceof ContainmentViolationError) {
      const report: DesignWorkspaceCompileReport = {
        warnings: [],
        errors: [
          {
            type: "dependency",
            // Round-3 M5 — stable code so consumers can branch on the
            // specific failure class without parsing message text.
            code: "CONTAINMENT_VIOLATION",
            message: error.message,
            suggestion:
              `Path "${error.absPath}" is outside the synced-folder allowlist. ` +
              `Allowed roots: ${error.allowedRoots.join(", ")}. ` +
              `Move the file inside one of those roots, or ensure the ` +
              `import action's source file lives inside a synced folder.`,
          },
        ],
        dependencyCheck: normalizeDependencySummary(dependencyCheck),
        autoInstall,
        recovered,
        durationMs: Date.now() - startedAt,
      };
      const message = buildReportMessage(report);
      logCompilerFailure(source, report, message);
      throw new DesignWorkspaceCompileError(message, report);
    }

    // Round-2 M1 — preprocessed stylesheet rejection. The compiler
    // doesn't bundle Sass/Less/Stylus; the suggestion points the agent
    // at the two recoverable paths (pre-compile to plain CSS, or use
    // `action: "port"` to render via the LLM instead).
    if (error instanceof PreprocessorNotSupportedError) {
      const report: DesignWorkspaceCompileReport = {
        warnings: [],
        errors: [
          {
            type: "dependency",
            // Round-3 M5 — stable code lets the agent route preprocessed
            // stylesheet failures to the port-or-precompile recovery
            // without inspecting the message text.
            code: "PREPROCESSOR_NOT_SUPPORTED",
            message: error.message,
            suggestion:
              `Preprocessed stylesheets (${error.extension}) are not bundled ` +
              `by the design preview. Pre-compile "${error.absPath}" to plain ` +
              `CSS (or .module.css) before importing, or render the component ` +
              `via action: "port" instead of import.`,
          },
        ],
        dependencyCheck: normalizeDependencySummary(dependencyCheck),
        autoInstall,
        recovered,
        durationMs: Date.now() - startedAt,
      };
      const message = buildReportMessage(report);
      logCompilerFailure(source, report, message);
      throw new DesignWorkspaceCompileError(message, report);
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
                options.tsconfigPaths,
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

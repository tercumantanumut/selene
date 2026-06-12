/**
 * Puppeteer-based screenshot capture for Design Workspace components.
 *
 * This module reuses the PNG export infrastructure in `./export.ts` —
 * same Chromium launch args, same preview-ready wait condition, same
 * CSP + sanitize pipeline, same media persistence via `saveFile`.
 *
 * It differs from `renderPngExport` in two ways:
 *
 *   1. Inputs are `{ componentId, userId, sessionId }` (the caller does not
 *      pass raw code) — the component is hydrated from the gallery via
 *      `findWorkspaceDesign`.
 *   2. An optional `probeSelectors` list triggers a second `page.evaluate`
 *      pass that returns a curated subset of `getComputedStyle(...)` for
 *      each selector, useful for downstream visual / a11y analysis.
 *
 * DesignSnapshot + undo/restore semantics are unaffected: this module only
 * reads the currently-persisted component code; it never mutates gallery
 * rows or workspace store state.
 */

import { sanitizeHTML } from "@/lib/design/utils/sanitize";
import { saveFile } from "@/lib/storage/local-storage";
import { findWorkspaceDesign } from "@/lib/design/gallery/service";
import { buildTailwindPreviewWithMetadata } from "./compiler";
import type { RenderManyCell } from "./compiler";
import type { DesignPreviewTheme } from "./types";
import {
  PUPPETEER_TIMEOUT_MS,
  buildExportPreviewHtml,
  injectCspMeta,
  sanitizeComponentName,
  waitForPageReady,
} from "./export";
import { acquirePage } from "./browser";

type PreviewDiagnosticPage = {
  on?: (event: string, handler: (...args: any[]) => void) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
};

function previewConsoleText(message: unknown): string {
  if (
    message &&
    typeof message === "object" &&
    "text" in message &&
    typeof message.text === "function"
  ) {
    try {
      return message.text();
    } catch {
      return String(message);
    }
  }
  return String(message);
}

function previewConsoleType(message: unknown): string {
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    typeof message.type === "function"
  ) {
    try {
      return message.type();
    } catch {
      return "log";
    }
  }
  return "log";
}

function requestFailureText(request: unknown): string {
  if (!request || typeof request !== "object") {
    return String(request);
  }
  const req = request as {
    url?: () => string;
    failure?: () => { errorText?: string } | null;
  };
  const url = typeof req.url === "function" ? req.url() : "unknown-url";
  const failure = typeof req.failure === "function" ? req.failure() : null;
  return `${url}${failure?.errorText ? ` (${failure.errorText})` : ""}`;
}

/**
 * Forward page-side failures into Node logs before the preview-ready wait.
 * Without these hooks a missing bundle, CSP block, or render exception only
 * appears as a generic Puppeteer timeout.
 */
function attachPreviewDiagnostics(page: PreviewDiagnosticPage): void {
  if (typeof page.on !== "function") {
    return;
  }

  page.on("console", (message: unknown) => {
    console.error(`[preview-console:${previewConsoleType(message)}] ${previewConsoleText(message)}`);
  });
  page.on("pageerror", (error: unknown) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[preview-pageerror] ${message}`);
  });
  page.on("requestfailed", (request: unknown) => {
    console.error(`[preview-requestfailed] ${requestFailureText(request)}`);
  });
}

export async function pauseAnimations(page: {
  evaluate: (...args: any[]) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  addStyleTag: (input: { content: string }) => Promise<unknown>;
}): Promise<void> {
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      try {
        animation.currentTime = 0;
        animation.pause();
      } catch {
        // Ignore animations the browser refuses to control.
      }
    }
  });
  await page.addStyleTag({
    content: "*,*::before,*::after{animation-play-state:paused!important;transition:none!important;}",
  });
}

export function extractRuntimeReferenceError(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.stack || error.message : String(error);
  const match = raw.match(/(?:ReferenceError:\s*)?([^\n]+? is not defined)/);
  return match?.[1]?.trim();
}

export interface ScreenshotViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

/**
 * Sprint 4 W4.1 — CDP state harness.
 *
 * Each entry asks the screenshot service to capture ONE additional PNG with a
 * CSS pseudo-class force-applied to `selector` via Chrome DevTools Protocol
 * `Emulation.setEmulatedPseudoState`. Captures run on a FRESH page per entry
 * so leaked pseudo state cannot bleed into the base screenshot or adjacent
 * state captures. Unsupported pseudo names / unresolvable selectors surface
 * as structured per-entry errors on the returned `stateScreenshots[N]` —
 * they never crash the base capture.
 */
export type ScreenshotStatePseudo =
  | "hover"
  | "focus-visible"
  | "active"
  | "disabled";

export interface ScreenshotStateRequest {
  selector: string;
  pseudo: ScreenshotStatePseudo;
  label?: string;
}

export interface ScreenshotOptions {
  componentId: string;
  sessionId: string;
  userId: string;
  viewport?: ScreenshotViewport; // default { width: 1440, height: 900, deviceScaleFactor: 2 }
  probeSelectors?: string[];     // optional computed-style probe
  /**
   * Sprint 4 W4.1 — state harness. When provided, the service captures ONE
   * screenshot per entry with the corresponding pseudo-class force-applied
   * to the specified selector via CDP `Emulation.setEmulatedPseudoState`.
   * Each state capture runs on a fresh page so pseudo state cannot leak
   * into the base capture or adjacent state captures. Probes (when
   * requested) are re-run under the forced pseudo state so the caller can
   * see how computed styles change.
   *
   * Per-entry failures (unknown pseudo alias, unresolvable selector, CDP
   * error) are surfaced as structured errors on the matching
   * `stateScreenshots[N].error` — the base capture is unaffected.
   */
  states?: readonly ScreenshotStateRequest[];
  /**
   * Forwarded to `buildTailwindPreviewWithMetadata` so the Puppeteer-rendered
   * HTML matches the workspace's active theme. Accepts the full
   * `DesignPreviewTheme` — `"system"` is handled by the compiled preview via
   * the inline `matchMedia` IIFE in `<head>` (see compiler.ts
   * `SYSTEM_THEME_SCRIPT`), so this module only needs to forward the value.
   * When omitted, the compiler's own default applies.
   */
  theme?: DesignPreviewTheme;
  /**
   * Sprint 3 Rev-F1 — W3.4 renderMany grids routinely exceed the 900px
   * default viewport height. With 24 cells and `minmax(240px, 1fr)` the grid
   * lays out as 6 columns × 4 rows at 1440 viewport width, which at 240px
   * minimum cell height totals 960px + gap + padding. Forwarding the
   * validated cells here serves two purposes:
   *
   *   1. The compiled preview HTML emits the CSS grid (via the compiler's
   *      renderMany entry source); otherwise the screenshot renders a
   *      single `<Component />` and the caller sees a mismatched capture.
   *   2. `resolveScreenshotCaptureOptions` auto-enables `fullPage` when
   *      this field is present, so Puppeteer captures the entire scrollable
   *      grid instead of clipping at viewport height.
   *
   * Cell validation (24-cell cap, plain-object props) is enforced at the
   * tool boundary BEFORE this call — screenshot.ts does not re-validate.
   */
  renderMany?: readonly RenderManyCell[];
  /**
   * Sprint 3 Rev-F1 — when `true`, Puppeteer's `page.screenshot` is invoked
   * with `fullPage: true` + `captureBeyondViewport: true` so the capture
   * extends past the viewport height to the scrollHeight of the document.
   * Defaults to `false` to preserve the historical non-renderMany capture
   * semantics (viewport-bound PNG). Auto-enabled by
   * `resolveScreenshotCaptureOptions` when `renderMany` is provided; an
   * explicit `false` takes precedence over the auto-enable behavior so
   * callers that know their grid fits can still opt out.
   */
  fullPage?: boolean;
}

export interface ScreenshotProbeResult {
  [cssSelector: string]: Record<string, string>; // resolved styles
}

export interface ScreenshotStateCapture {
  label: string;
  pseudo: string;
  selector: string;
  screenshot: {
    url: string;
    width: number;
    height: number;
    dpr: number;
  };
  probes?: ScreenshotProbeResult;
}

/**
 * Sprint 4 W4.1 — per-entry error surface for the state harness. Emitted in
 * place of `screenshot` / `probes` when the entry's selector or pseudo
 * rejected BEFORE a PNG could be written. `label` / `pseudo` / `selector`
 * are always present so the caller can correlate the error back to the
 * input entry without relying on array order.
 */
export interface ScreenshotStateCaptureError {
  label: string;
  pseudo: string;
  selector: string;
  error: {
    code:
      | "STATE_INVALID_PSEUDO"
      | "STATE_SELECTOR_NOT_FOUND"
      | "STATE_SELECTOR_INVALID"
      | "STATE_CAPTURE_FAILED";
    message: string;
  };
}

export type ScreenshotStateEntry =
  | ScreenshotStateCapture
  | ScreenshotStateCaptureError;

export interface ScreenshotResult {
  screenshot: {
    url: string;              // /api/media/...
    width: number;            // CSS pixels
    height: number;
    dpr: number;
  };
  probes?: ScreenshotProbeResult;
  /**
   * Sprint 4 W4.1 — per-state captures (present only when `options.states`
   * is a non-empty array). Each entry either contains a persisted
   * screenshot URL under the forced pseudo-class OR a structured error
   * describing why that entry failed. The base `screenshot` is always
   * populated regardless of per-entry failures.
   */
  stateScreenshots?: ScreenshotStateEntry[];
}

const SUPPORTED_STATE_PSEUDOS: readonly ScreenshotStatePseudo[] = [
  "hover",
  "focus-visible",
  "active",
  "disabled",
];

function isSupportedStatePseudo(value: unknown): value is ScreenshotStatePseudo {
  return (
    typeof value === "string" &&
    (SUPPORTED_STATE_PSEUDOS as readonly string[]).includes(value)
  );
}

/**
 * Default label generator for a state capture when the caller did not
 * provide `label`. Intentionally mirrors `${pseudo}:${selector}` so the
 * label is self-describing in logs + downstream UIs.
 */
function defaultStateLabel(pseudo: string, selector: string): string {
  return `${pseudo}:${selector}`;
}

function resolveStateLabel(
  entry: { label?: string; pseudo: string; selector: string },
): string {
  if (typeof entry.label === "string" && entry.label.trim().length > 0) {
    return entry.label.trim();
  }
  return defaultStateLabel(entry.pseudo, entry.selector);
}

const DEFAULT_VIEWPORT: ScreenshotViewport = {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
};

/**
 * Sprint 3 Rev-F1 — derive the Puppeteer `page.screenshot` call options
 * from a subset of `ScreenshotOptions`.
 *
 * Contract:
 *   - `fullPage` defaults to `false` so non-renderMany captures preserve
 *     the viewport-bound PNG semantics the export / screenshot pipeline
 *     has always emitted.
 *   - When a non-empty `renderMany` is present AND the caller did not
 *     explicitly set `fullPage: false`, `fullPage` auto-enables. This
 *     covers the 24-cell × 4-row grid case where the default 900px
 *     viewport clips the bottom row.
 *   - When `fullPage` is true, `captureBeyondViewport` is also enabled so
 *     Puppeteer extends past the viewport height to document scrollHeight.
 *     (Puppeteer already implies this when `fullPage: true` — the explicit
 *     field documents the intent and keeps older Puppeteer versions in
 *     line with the behavior the spec requires.)
 *   - An explicit `fullPage: false` takes precedence over the auto-enable
 *     so callers that pre-measured their grid height can opt out.
 *
 * Exported for unit tests; also used internally by `captureScreenshot`.
 */
export function resolveScreenshotCaptureOptions(input: {
  renderMany?: readonly RenderManyCell[] | undefined;
  fullPage?: boolean | undefined;
}): { fullPage: boolean; captureBeyondViewport: boolean } {
  const hasRenderMany = Array.isArray(input.renderMany) && input.renderMany.length > 0;
  // Explicit caller preference wins in both directions. `undefined` is the
  // only state where we apply the auto-enable policy.
  const fullPage =
    input.fullPage === undefined ? hasRenderMany : input.fullPage === true;
  return {
    fullPage,
    captureBeyondViewport: fullPage,
  };
}

/**
 * Curated subset of CSSStyleDeclaration keys returned per probed selector.
 * Flattened to `Record<string, string>` — callers receive the *resolved*
 * computed-style value for each of these properties. Intentionally not the
 * whole declaration: full CSSStyleDeclaration flattening is noisy and
 * inflates payload size; this covers the typical visual-fidelity surface
 * (color, layout box, typography, effects) used by design QA tooling.
 *
 * Sprint 1 Group B broadened this list after repeated "probe returned empty
 * for <property>" agent reports traced to missing entries here — the
 * envelope was preserving the probe map intact; the requested property
 * simply wasn't in the curated set. Additions:
 *   - `colorScheme`     — resolved `color-scheme` on the target (theme QA)
 *   - `cursor`           — interactive-surface affordance
 *   - `transition`       — animated-state diffing (T1.x / T4.x)
 *   - `textShadow`       — depth / layering QA
 *   - `overflow`         — clipping / scroll boundary checks
 *   - `gap`, `flexDirection`, `justifyContent`, `alignItems`,
 *     `gridTemplateColumns`, `gridTemplateRows` — layout-structural probes
 *     for dashboard / grid components (T1.6).
 *
 * Payload impact: 20 → 30 properties. At the 16-selector cap, worst-case
 * payload is ~30 × 16 × ~60 chars = ~29 KB, well under the 40 KB
 * `SLIM_RESULT_SAFETY_CAP` and under the 10 K token inline passthrough
 * budget once other envelope fields are accounted for.
 */
/** @internal Exported for unit testing only — asserts the curated probe list. */
export const PROBE_CSS_PROPERTIES = [
  // Color / fill
  "color",
  "backgroundColor",
  "colorScheme",
  // Effects / filters
  "backdropFilter",
  "boxShadow",
  "textShadow",
  "filter",
  "opacity",
  // Borders / geometry
  "border",
  "borderRadius",
  "transform",
  // Box model
  "width",
  "height",
  "padding",
  "margin",
  "overflow",
  // Typography
  "font",
  "letterSpacing",
  "lineHeight",
  // Layout / stacking
  "display",
  "position",
  "zIndex",
  // Flex / grid (dashboard probes — T1.6)
  "flexDirection",
  "justifyContent",
  "alignItems",
  "gap",
  "gridTemplateColumns",
  "gridTemplateRows",
  // Interaction / animation
  "cursor",
  "transition",
] as const;

/**
 * Capture a PNG screenshot of a design-workspace component by id, persist
 * it to the local media store, and optionally probe computed styles for a
 * list of CSS selectors.
 *
 * @example
 * ```ts
 * const result = await captureScreenshot({
 *   componentId: "cmp_abc123",
 *   sessionId: "sess_42",
 *   userId: "user_7",
 *   viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
 *   probeSelectors: ["button.primary", ".hero-title"],
 *   theme: "dark",
 * });
 *
 * // result.screenshot.url === "/api/media/…/design-component.png"
 * // result.probes?.["button.primary"]?.backgroundColor === "rgb(59, 130, 246)"
 * ```
 */
/**
 * Puppeteer `page.evaluate` body factored out so it can be re-run under a
 * forced CDP pseudo-state. Type is `any` for the `page` parameter because the
 * `puppeteer` export type does not narrow across the mock used in tests — the
 * function only reads `page.evaluate`, which every Puppeteer Page + our
 * FakePage mock implement.
 */
type ProbePage = {
  evaluate: (...args: any[]) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

/**
 * Sentinel CSS custom property emitted by `PREVIEW_THEME_CSS` (compiler.ts).
 * `waitForProbeStylesReady` polls `getComputedStyle(<html>).getPropertyValue`
 * for this name and only resolves once the value is `"1"`, proving the
 * `<style>` block has been parsed and applied. Without this gate, probes
 * could capture the pre-CSS DOM (browser-default `font: 16px Times`,
 * `body { margin: 8px }`, `colorScheme: "normal"`) on the first turn after
 * `setContent({waitUntil: "domcontentloaded"})`.
 *
 * Exported so the regression test in
 * `lib/design/workspace/__tests__/probe-styles-ready.test.ts` can assert the
 * sentinel is the same string the compiler emits — a future rename on either
 * side would otherwise re-introduce the silent race.
 */
export const PROBE_STYLES_APPLIED_SENTINEL = "--selene-styles-applied";
const PROBE_STYLES_READY_TIMEOUT_MS = 5_000;
const PROBE_STYLES_READY_POLL_MS = 50;

/** @internal Exported for unit testing — settles style/font state before computed-style probes. */
export async function waitForProbeStylesReady(page: ProbePage): Promise<void> {
  await page.evaluate(
    async (sentinelName: string, timeoutMs: number, pollMs: number) => {
      // 1. Wait for any web fonts the page declared. Tailwind preview itself
      //    doesn't load fonts, but a globals.css injection or an `@import` in
      //    a user-emitted style block can pull one in — `document.fonts.ready`
      //    is the standard one-shot signal that all in-flight font loads have
      //    settled.
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }

      // 2. Poll for the sentinel CSS custom property. The poll is bounded by
      //    `timeoutMs` so a missing sentinel surfaces as a fast diagnostic
      //    instead of blocking until the outer screenshot timeout. We don't
      //    throw on miss because the OUTER capture flow has already run
      //    `waitForPageReady` (which gates on `data-preview-ready` + a real
      //    style flush via the React mount); falling through here only means
      //    the sentinel happens to be missing for a non-default preview
      //    pipeline (a regression test, not a real-user breakage).
      const root = document.documentElement;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const value = window
          .getComputedStyle(root)
          .getPropertyValue(sentinelName)
          .trim();
        if (value === "1") {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
      }

      // 3. Two RAFs after the sentinel poll so any layout/paint scheduled by
      //    the React mount (which flips data-preview-ready in its OWN RAF) is
      //    flushed before getComputedStyle reads on the main probe pass.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    },
    PROBE_STYLES_APPLIED_SENTINEL,
    PROBE_STYLES_READY_TIMEOUT_MS,
    PROBE_STYLES_READY_POLL_MS,
  );
}

async function collectProbes(
  page: ProbePage,
  selectors: string[],
): Promise<ScreenshotProbeResult> {
  await waitForProbeStylesReady(page);
  return page.evaluate(
    (sel: string[], properties: string[]) => {
      const out: Record<string, Record<string, string>> = {};
      for (const selector of sel) {
        let element: Element | null = null;
        try {
          element = document.querySelector(selector);
        } catch {
          element = null;
        }
        if (!element) {
          out[selector] = { _error: "selector not found" };
          continue;
        }
        const style = window.getComputedStyle(element);
        const collected: Record<string, string> = {};
        for (const prop of properties) {
          // getPropertyValue expects kebab-case; indexing on the
          // CSSStyleDeclaration with camelCase works for the subset
          // we request here and avoids the manual case conversion.
          const value = (style as unknown as Record<string, string>)[prop];
          if (typeof value === "string") {
            collected[prop] = value;
          }
        }
        out[selector] = collected;
      }
      return out;
    },
    selectors,
    PROBE_CSS_PROPERTIES as unknown as string[],
  );
}

/**
 * Sprint 4 W4.1 — Capture ONE PNG + optional probes with a CSS pseudo-class
 * force-applied to `selector` via Chrome DevTools Protocol. The page passed
 * in MUST already have the preview HTML loaded + viewport set. Per-entry
 * failures (unsupported pseudo, unresolvable selector, CDP error) are
 * returned as structured `{ error }` envelopes so the outer caller can
 * surface them without masking the base screenshot.
 *
 * Exported for unit tests; the production path is `captureScreenshot`.
 */
export async function captureScreenshotUnderPseudoState(args: {
  page: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  entry: ScreenshotStateRequest;
  viewport: ScreenshotViewport;
  probeSelectors?: string[];
  fileNameBase: string;
  sessionId: string;
  fullPage: boolean;
  captureBeyondViewport: boolean;
}): Promise<ScreenshotStateEntry> {
  const label = resolveStateLabel(args.entry);
  const pseudo = args.entry.pseudo;
  const selector = args.entry.selector;

  if (!isSupportedStatePseudo(pseudo)) {
    return {
      label,
      pseudo: String(pseudo),
      selector,
      error: {
        code: "STATE_INVALID_PSEUDO",
        message: `Unsupported pseudo-class "${String(
          pseudo,
        )}". Supported: ${SUPPORTED_STATE_PSEUDOS.join(", ")}.`,
      },
    };
  }
  if (typeof selector !== "string" || selector.trim().length === 0) {
    return {
      label,
      pseudo,
      selector: String(selector),
      error: {
        code: "STATE_SELECTOR_INVALID",
        message: "Selector must be a non-empty string.",
      },
    };
  }

  let cdp: {
    send: (method: string, params?: Record<string, unknown>) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    detach?: () => Promise<void>;
  } | null = null;

  try {
    cdp = await args.page.target().createCDPSession();
    if (!cdp) {
      throw new Error("CDP session not available on this page");
    }
    // Both DOM and CSS agents must be enabled before we can resolve a
    // nodeId and force pseudo-classes on it. `CSS.forcePseudoState` is a
    // CSS-domain command (there is no `Emulation.setEmulatedPseudoState` on
    // the pinned Chromium runtime — verified by the live test in
    // `tests/lib/design/workspace/state-harness.live.test.ts`).
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const doc = (await cdp.send("DOM.getDocument", { depth: 0 })) as {
      root: { nodeId: number };
    };
    const rootNodeId = doc?.root?.nodeId;
    if (typeof rootNodeId !== "number") {
      throw new Error("DOM.getDocument returned no root node");
    }
    const queryResult = (await cdp.send("DOM.querySelector", {
      nodeId: rootNodeId,
      selector,
    })) as { nodeId?: number };
    const nodeId = queryResult?.nodeId;
    if (!nodeId || nodeId === 0) {
      return {
        label,
        pseudo,
        selector,
        error: {
          code: "STATE_SELECTOR_NOT_FOUND",
          message: `Selector "${selector}" did not match any element in the preview.`,
        },
      };
    }

    // Force the pseudo-class via the CSS agent. The parameter name is
    // `forcedPseudoClasses` (NOT `pseudoClass`) per the CDP spec —
    // `browser_protocol.json` CSS.forcePseudoState. Passing an empty array
    // clears any previously-forced pseudo-classes on `nodeId`.
    await cdp.send("CSS.forcePseudoState", {
      nodeId,
      forcedPseudoClasses: [pseudo],
    });

    const screenshot = await args.page.screenshot({
      type: "png",
      fullPage: args.fullPage,
      captureBeyondViewport: args.captureBeyondViewport,
    });
    const buffer = Buffer.isBuffer(screenshot) ? screenshot : Buffer.from(screenshot);
    const safePseudo = pseudo.replace(/[^a-z0-9-]/gi, "_");
    const safeLabel = label.replace(/[^a-z0-9-]/gi, "_").slice(0, 48);
    const stored = await saveFile(
      buffer,
      args.sessionId,
      `${args.fileNameBase}.state-${safePseudo}-${safeLabel}.png`,
      "generated",
    );
    const actualDpr = await args.page.evaluate(() => window.devicePixelRatio);

    let probes: ScreenshotProbeResult | undefined;
    if (args.probeSelectors && args.probeSelectors.length > 0) {
      probes = await collectProbes(args.page, args.probeSelectors);
    }

    // Clear the forced pseudo-state before the page is closed so no state
    // bleed reaches a (hypothetical) caller reusing the same page. We
    // isolate per-page above, but clearing is still the correct hygiene.
    // An empty `forcedPseudoClasses` array is the documented "clear" form
    // for `CSS.forcePseudoState`.
    try {
      await cdp.send("CSS.forcePseudoState", {
        nodeId,
        forcedPseudoClasses: [],
      });
    } catch {
      // Best-effort reset — ignore.
    }

    const capture: ScreenshotStateCapture = {
      label,
      pseudo,
      selector,
      screenshot: {
        url: stored.url,
        width: args.viewport.width,
        height: args.viewport.height,
        dpr: actualDpr,
      },
    };
    if (probes) {
      capture.probes = probes;
    }
    return capture;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "State capture failed.";
    return {
      label,
      pseudo,
      selector,
      error: {
        code: "STATE_CAPTURE_FAILED",
        message,
      },
    };
  } finally {
    if (cdp?.detach) {
      await cdp.detach().catch(() => {
        // Swallow — CDP detach failures must not mask the real error.
      });
    }
  }
}

export async function captureScreenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;

  // 1. Hydrate component code from the gallery. `findWorkspaceDesign`
  //    enforces user/session scoping at the query layer.
  const component = await findWorkspaceDesign({
    id: options.componentId,
    userId: options.userId,
    sessionId: options.sessionId,
  });
  if (!component) {
    throw new Error(`Design component not found: ${options.componentId}`);
  }

  const code = component.code?.trim();
  if (!code) {
    throw new Error(`Design component ${options.componentId} has no code to render.`);
  }

  const componentName = component.name || "Design Component";
  const fileName = `${sanitizeComponentName(componentName)}.png`;
  const fileNameBase = sanitizeComponentName(componentName);

  // 2. Build preview HTML through the same pipeline as renderPngExport.
  //    When `theme` OR `renderMany` is provided, go directly through the
  //    metadata-aware compiler entry so the theme reaches `<html class="…">`
  //    and the renderMany CSS grid replaces the single `<Component />`
  //    mount. Otherwise defer to the shared `buildExportPreviewHtml` helper
  //    (which uses the compiler's own default) so the PNG path stays
  //    identical to renderPngExport's for the unchanged pre-W3.4 callers.
  //
  //    Sprint 3 Rev-F1: `renderMany` joins `theme` as a trigger for the
  //    metadata path because `buildExportPreviewHtml` does not thread the
  //    renderMany primitive. Without this, a screenshot with renderMany
  //    cells would capture the single-render fallback instead of the grid.
  const hasRenderMany =
    Array.isArray(options.renderMany) && options.renderMany.length > 0;
  const useMetadataPath = Boolean(options.theme) || hasRenderMany;
  const renderedHtml = useMetadataPath
    ? (
        await buildTailwindPreviewWithMetadata(code, componentName, {
          autoInstallMissingDependencies: true,
          source: "design-workspace-screenshot",
          previewTheme: options.theme,
          renderMany: hasRenderMany ? options.renderMany : undefined,
        })
      ).html
    : await buildExportPreviewHtml({
        code,
        mode: "tailwind",
        componentName,
        animated: true,
      });

  // 3. Sanitize + CSP-wrap — identical to renderPngExport.
  // `allowInlineScripts` is required here: the esbuild-bundled preview JS
  // (wrapped in our own <script> block) is what fires `data-preview-ready`,
  // and unconditional <script> stripping caused Puppeteer to time out with
  // `Waiting failed`. This HTML is first-party trusted (our builder output)
  // and is rendered inside a sandboxed Puppeteer page with CSP.
  const sanitizedHtml = injectCspMeta(
    sanitizeHTML(renderedHtml, {
      allowStyles: true,
      allowDataUrls: true,
      allowInlineScripts: true,
    }),
  );

  const page = await acquirePage();

  // Timeout handle retained so the success path can clear the timer. The
  // prior `Promise.race(..., setTimeout)` left a live 10-minute timer
  // per successful capture; this pairs every `setTimeout` with a
  // `clearTimeout` in `finally`.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  attachPreviewDiagnostics(page);

  try {
    const captureTask = async (): Promise<ScreenshotResult> => {
      await page.setViewport({
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
      });
      await page.setContent(sanitizedHtml, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await waitForPageReady(page);

      // Sprint 3 Rev-F1: derive `fullPage` + `captureBeyondViewport` from
      // the presence of `renderMany` (auto-enable) and any explicit
      // `fullPage` flag. The helper is pure + exported so unit tests can
      // lock in the auto-enable contract without spinning up Puppeteer.
      const captureOpts = resolveScreenshotCaptureOptions({
        renderMany: options.renderMany,
        fullPage: options.fullPage,
      });
      const screenshot = await page.screenshot({
        type: "png",
        fullPage: captureOpts.fullPage,
        captureBeyondViewport: captureOpts.captureBeyondViewport,
      });
      const buffer = Buffer.isBuffer(screenshot) ? screenshot : Buffer.from(screenshot);
      const stored = await saveFile(buffer, options.sessionId, fileName, "generated");

      // 4. Read back the *actual* DPR the page is using (Puppeteer may
      //    clamp/override the requested value on certain platforms).
      const actualDpr = await page.evaluate(() => window.devicePixelRatio);

      // 5. Probe computed styles only when the caller asked for it.
      let probes: ScreenshotProbeResult | undefined;
      if (options.probeSelectors && options.probeSelectors.length > 0) {
        probes = await collectProbes(page, options.probeSelectors);
      }

      // 6. Sprint 4 W4.1 — state harness. Per-entry captures run on fresh
      //    pages so leaked pseudo-state cannot bleed between captures.
      //    Each entry either produces a screenshot or a structured error;
      //    neither outcome fails the base capture.
      let stateScreenshots: ScreenshotStateEntry[] | undefined;
      if (options.states && options.states.length > 0) {
        stateScreenshots = [];
        for (const entry of options.states) {
          const statePage = await acquirePage();
          attachPreviewDiagnostics(statePage);
          try {
            await statePage.setViewport({
              width: viewport.width,
              height: viewport.height,
              deviceScaleFactor: viewport.deviceScaleFactor,
            });
            await statePage.setContent(sanitizedHtml, {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            });
            await waitForPageReady(statePage);
            const captured = await captureScreenshotUnderPseudoState({
              page: statePage,
              entry,
              viewport,
              probeSelectors: options.probeSelectors,
              fileNameBase,
              sessionId: options.sessionId,
              fullPage: captureOpts.fullPage,
              captureBeyondViewport: captureOpts.captureBeyondViewport,
            });
            stateScreenshots.push(captured);
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "State capture page setup failed.";
            stateScreenshots.push({
              label: resolveStateLabel(entry),
              pseudo: String(entry?.pseudo ?? ""),
              selector: String(entry?.selector ?? ""),
              error: {
                code: "STATE_CAPTURE_FAILED",
                message,
              },
            });
          } finally {
            await statePage.close().catch(() => {
              // Swallow — shared-browser page-close failures must not mask
              // the real outcome.
            });
          }
        }
      }

      const result: ScreenshotResult = {
        screenshot: {
          url: stored.url,
          width: viewport.width,
          height: viewport.height,
          dpr: actualDpr,
        },
      };
      if (probes) {
        result.probes = probes;
      }
      if (stateScreenshots && stateScreenshots.length > 0) {
        result.stateScreenshots = stateScreenshots;
      }
      return result;
    };

    const timeoutTask = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error("Screenshot capture timed out")),
        PUPPETEER_TIMEOUT_MS,
      );
    });

    return await Promise.race([captureTask(), timeoutTask]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    await page.close().catch(() => {
      // Swallow: shared-browser page-close failures must not mask the
      // real error from the try block.
    });
  }
}

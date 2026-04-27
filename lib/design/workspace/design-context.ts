/**
 * Unified design-workspace context attached to user messages.
 *
 * Mirrors `inspect-context.ts` for the Inspect tool, but consolidates Inspect
 * + Measurements + Picked colours into a single `designContext` payload
 * carried on `metadata.custom`. The server-side prompt extractor then turns
 * this into a stable markdown-style block prepended to the user's message.
 *
 * Sanitisation rules:
 *   - All free-form strings are clamped to bounded lengths.
 *   - Per-section caps prevent prompt-size blowup if the user has dozens of
 *     measurements / colours hanging around.
 *   - Numeric fields are coerced to finite numbers (NaN/Infinity → 0).
 */
import type { DesignComponent, Measurement, PickedColor } from "./types";
import type { InspectMessageContext, InspectSelection } from "./inspect-context";
import {
  MAX_INSPECT_SELECTIONS,
  buildInspectMessageContext,
  buildInspectPromptText,
  sanitizeInspectMessageContext,
} from "./inspect-context";

const DESIGN_CONTEXT_VERSION = 1 as const;
const MAX_SELECTOR_LEN = 320;
const MAX_HEX_LEN = 16;
const MAX_TAGNAME_LEN = 40;
export const MAX_DESIGN_CONTEXT_MEASUREMENTS = 8;
export const MAX_DESIGN_CONTEXT_COLORS = 8;

/**
 * Validates a CSS hex color string. Accepts `#rgb`, `#rrggbb`, and `#rrggbbaa`
 * (case-insensitive). Used by the colour sanitiser to drop free-form strings
 * (e.g. `"banana"`, `"red"`, `"#xyz"`) before they reach the LLM prompt.
 */
export function isValidHex(hex: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex);
}

export interface DesignContextMeasurement {
  id: string;
  fromSelector: string;
  toSelector: string;
  dx: number;
  dy: number;
  horizontal: number;
  vertical: number;
  euclidean: number;
}

export interface DesignContextColor {
  id: string;
  hex: string;
  source: PickedColor["source"];
  selector: string;
  tagName: string;
  rgb: { r: number; g: number; b: number; a: number };
}

export interface DesignMessageContext {
  version: typeof DESIGN_CONTEXT_VERSION;
  source: "design-workspace";
  sessionId?: string;
  componentId?: string;
  componentName?: string;
  capturedAt: string;
  inspect?: InspectMessageContext;
  measurements?: DesignContextMeasurement[];
  pickedColors?: DesignContextColor[];
}

function clampStr(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toRgbChannel(value: unknown, min: number, max: number): number {
  const n = toFiniteNumber(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function buildMeasurementContext(m: Measurement): DesignContextMeasurement | null {
  const fromSelector = clampStr(m.from?.selector, MAX_SELECTOR_LEN);
  const toSelector = clampStr(m.to?.selector, MAX_SELECTOR_LEN);
  if (!fromSelector || !toSelector) return null;
  return {
    id: clampStr(m.id, 64) || `m-${fromSelector}-${toSelector}`,
    fromSelector,
    toSelector,
    dx: toFiniteNumber(m.distances?.dx),
    dy: toFiniteNumber(m.distances?.dy),
    horizontal: toFiniteNumber(m.distances?.horizontal),
    vertical: toFiniteNumber(m.distances?.vertical),
    euclidean: toFiniteNumber(m.distances?.euclidean),
  };
}

function buildColorContext(c: PickedColor): DesignContextColor | null {
  const hex = clampStr(c.hex, MAX_HEX_LEN);
  const selector = clampStr(c.element?.selector, MAX_SELECTOR_LEN);
  const tagName = clampStr(c.element?.tagName, MAX_TAGNAME_LEN);
  if (!hex || !selector) return null;
  // Mirror the sanitiser: drop colours whose hex doesn't match the regex.
  // Anything reaching this function should already be well-formed (it comes
  // from the in-app colour-pick flow), but the guard prevents stale store
  // entries from leaking into the LLM prompt.
  if (!isValidHex(hex)) return null;
  return {
    id: clampStr(c.id, 64) || `c-${hex}-${selector}`,
    hex,
    source: c.source,
    selector,
    tagName,
    rgb: {
      r: Math.round(toRgbChannel(c.rgb?.r, 0, 255)),
      g: Math.round(toRgbChannel(c.rgb?.g, 0, 255)),
      b: Math.round(toRgbChannel(c.rgb?.b, 0, 255)),
      a: toRgbChannel(c.rgb?.a, 0, 1),
    },
  };
}

export interface BuildDesignContextArgs {
  inspect?: InspectMessageContext | null;
  measurements?: Measurement[];
  pickedColors?: PickedColor[];
  component?: Pick<DesignComponent, "id" | "name"> | null;
  sessionId?: string | null;
}

/**
 * Compose a `DesignMessageContext` from the live design-workspace state.
 * Returns `null` when none of the three sections has any content — callers
 * use that to drop the metadata field entirely (no empty payloads on the
 * wire).
 */
export function buildDesignContext(args: BuildDesignContextArgs): DesignMessageContext | null {
  const measurements = (args.measurements ?? [])
    .slice(-MAX_DESIGN_CONTEXT_MEASUREMENTS)
    .map(buildMeasurementContext)
    .filter((entry): entry is DesignContextMeasurement => entry !== null);

  const pickedColors = (args.pickedColors ?? [])
    .slice(-MAX_DESIGN_CONTEXT_COLORS)
    .map(buildColorContext)
    .filter((entry): entry is DesignContextColor => entry !== null);

  const hasInspect = !!args.inspect && args.inspect.elements.length > 0;
  const hasMeasurements = measurements.length > 0;
  const hasColors = pickedColors.length > 0;

  if (!hasInspect && !hasMeasurements && !hasColors) return null;

  return {
    version: DESIGN_CONTEXT_VERSION,
    source: "design-workspace",
    sessionId: args.sessionId ?? args.inspect?.sessionId ?? undefined,
    componentId: args.component?.id ?? args.inspect?.componentId ?? undefined,
    componentName: clampStr(args.component?.name ?? args.inspect?.componentName, 120) || undefined,
    capturedAt: new Date().toISOString(),
    inspect: hasInspect ? args.inspect ?? undefined : undefined,
    measurements: hasMeasurements ? measurements : undefined,
    pickedColors: hasColors ? pickedColors : undefined,
  };
}

/**
 * Server-side sanitiser: re-validates a payload that came back over the
 * wire, dropping malformed entries and clamping all string fields. Returns
 * `null` if no usable section survives.
 */
export function sanitizeDesignContext(value: unknown): DesignMessageContext | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<DesignMessageContext> & {
    inspect?: unknown;
    measurements?: unknown;
    pickedColors?: unknown;
  };

  const inspect = sanitizeInspectMessageContext(raw.inspect);

  const measurements = Array.isArray(raw.measurements)
    ? raw.measurements
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const candidate = entry as Partial<DesignContextMeasurement>;
          const fromSelector = clampStr(candidate.fromSelector, MAX_SELECTOR_LEN);
          const toSelector = clampStr(candidate.toSelector, MAX_SELECTOR_LEN);
          if (!fromSelector || !toSelector) return null;
          return {
            id: clampStr(candidate.id, 64) || `m-${fromSelector}-${toSelector}`,
            fromSelector,
            toSelector,
            dx: toFiniteNumber(candidate.dx),
            dy: toFiniteNumber(candidate.dy),
            horizontal: toFiniteNumber(candidate.horizontal),
            vertical: toFiniteNumber(candidate.vertical),
            euclidean: toFiniteNumber(candidate.euclidean),
          } satisfies DesignContextMeasurement;
        })
        .filter((entry): entry is DesignContextMeasurement => entry !== null)
        .slice(0, MAX_DESIGN_CONTEXT_MEASUREMENTS)
    : [];

  const pickedColors = Array.isArray(raw.pickedColors)
    ? raw.pickedColors
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const candidate = entry as Partial<DesignContextColor> & {
            rgb?: Partial<{ r: number; g: number; b: number; a: number }>;
          };
          const hex = clampStr(candidate.hex, MAX_HEX_LEN);
          const selector = clampStr(candidate.selector, MAX_SELECTOR_LEN);
          if (!hex || !selector) return null;
          // Drop free-form strings (e.g. "banana", "red", "#xyz") before they
          // can reach `formatDesignContextPrompt`. We never coerce to a
          // fallback colour — silently swapping bad input for `#000000`
          // would hide the upstream bug.
          if (!isValidHex(hex)) return null;
          const allowedSources: ReadonlyArray<PickedColor["source"]> = [
            "background",
            "foreground",
            "border",
            "gradient",
            "svg-fill",
            "svg-stroke",
            "pseudo-before",
            "pseudo-after",
          ];
          const source: PickedColor["source"] = allowedSources.includes(
            candidate.source as PickedColor["source"],
          )
            ? (candidate.source as PickedColor["source"])
            : "background";
          return {
            id: clampStr(candidate.id, 64) || `c-${hex}-${selector}`,
            hex,
            source,
            selector,
            tagName: clampStr(candidate.tagName, MAX_TAGNAME_LEN),
            rgb: {
              r: Math.round(toRgbChannel(candidate.rgb?.r, 0, 255)),
              g: Math.round(toRgbChannel(candidate.rgb?.g, 0, 255)),
              b: Math.round(toRgbChannel(candidate.rgb?.b, 0, 255)),
              a: toRgbChannel(candidate.rgb?.a, 0, 1),
            },
          } satisfies DesignContextColor;
        })
        .filter((entry): entry is DesignContextColor => entry !== null)
        .slice(0, MAX_DESIGN_CONTEXT_COLORS)
    : [];

  if (!inspect && measurements.length === 0 && pickedColors.length === 0) return null;

  const capturedAt = clampStr(raw.capturedAt, 80) || new Date().toISOString();

  return {
    version: DESIGN_CONTEXT_VERSION,
    source: "design-workspace",
    sessionId: clampStr(raw.sessionId, 120) || undefined,
    componentId: clampStr(raw.componentId, 120) || undefined,
    componentName: clampStr(raw.componentName, 120) || undefined,
    capturedAt,
    inspect: inspect ?? undefined,
    measurements: measurements.length > 0 ? measurements : undefined,
    pickedColors: pickedColors.length > 0 ? pickedColors : undefined,
  };
}

/**
 * Merge a unified `DesignMessageContext` with a legacy standalone
 * `InspectMessageContext`.
 *
 * Older clients posted `metadata.custom.inspectContext` only; current clients
 * post `metadata.custom.designContext` (which carries inspect + measurements +
 * colours together). During the transition both fields can co-exist, and a
 * naive "designContext wins, ignore legacy" branch silently dropped the
 * legacy inspect data when the new payload happened to omit its inspect
 * section (e.g. a measurements-only `designContext`). This helper preserves
 * the legacy inspect data in that case so no context is lost.
 *
 * Rules:
 *   - both null → null
 *   - primary null, legacy non-empty → wrap legacy.inspect in a fresh design
 *     context (same shape callers further down the pipe expect)
 *   - primary has inspect → primary unchanged (designContext wins)
 *   - primary missing/empty inspect, legacy has inspect → primary with
 *     legacy.inspect spliced in
 *   - otherwise → primary unchanged
 *
 * Inspect selections are capped at `MAX_INSPECT_SELECTIONS` to mirror the
 * cap applied at build time.
 */
export function mergeDesignContext(
  primary: DesignMessageContext | null,
  legacy: { inspect?: InspectMessageContext | null } | null,
): DesignMessageContext | null {
  const legacyInspect = legacy?.inspect ?? null;
  const legacyHasElements = !!legacyInspect && legacyInspect.elements.length > 0;

  if (!primary) {
    if (!legacyHasElements) return null;
    const elements: InspectSelection[] = legacyInspect!.elements.slice(0, MAX_INSPECT_SELECTIONS);
    return {
      version: DESIGN_CONTEXT_VERSION,
      source: "design-workspace",
      sessionId: legacyInspect!.sessionId,
      componentId: legacyInspect!.componentId,
      componentName: legacyInspect!.componentName,
      capturedAt: legacyInspect!.selectedAt,
      inspect: { ...legacyInspect!, elements },
    };
  }

  const primaryInspectEmpty = !primary.inspect || primary.inspect.elements.length === 0;
  if (primaryInspectEmpty && legacyHasElements) {
    const elements: InspectSelection[] = legacyInspect!.elements.slice(0, MAX_INSPECT_SELECTIONS);
    return {
      ...primary,
      inspect: { ...legacyInspect!, elements },
    };
  }

  return primary;
}

/**
 * Format a `DesignMessageContext` as the markdown-style block we prepend to
 * the user's message before sending it to the model. Safe to call with
 * `null` (returns null) so callers can chain without a guard.
 */
export function formatDesignContextPrompt(ctx: DesignMessageContext | null): string | null {
  if (!ctx) return null;
  const sections: string[] = [];

  const inspectText = buildInspectPromptText(ctx.inspect ?? null);
  if (inspectText) sections.push(inspectText);

  if (ctx.measurements && ctx.measurements.length > 0) {
    const lines: string[] = ["[Measurements]"];
    ctx.measurements.forEach((m, idx) => {
      lines.push(
        `${idx + 1}. ${m.fromSelector} → ${m.toSelector}: ${Math.round(m.euclidean)}px (dx ${Math.round(m.dx)}, dy ${Math.round(m.dy)})`,
      );
    });
    sections.push(lines.join("\n"));
  }

  if (ctx.pickedColors && ctx.pickedColors.length > 0) {
    const lines: string[] = ["[Colors]"];
    ctx.pickedColors.forEach((c, idx) => {
      const tag = c.tagName ? `<${c.tagName}> ` : "";
      lines.push(`${idx + 1}. ${c.hex} (${c.source}) — ${tag}${c.selector}`);
    });
    sections.push(lines.join("\n"));
  }

  return sections.length === 0 ? null : sections.join("\n\n");
}

// Re-export the inspect builder so callers don't need two imports.
export { buildInspectMessageContext };

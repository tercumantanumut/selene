/**
 * Pure helpers for the eyedropper's tiered paint-detection pipeline.
 *
 * The actual detection runs inside the design preview iframe (see
 * `tools-script.ts`), where these functions are duplicated verbatim as a
 * string template — the iframe script can't `import` from this module at
 * runtime because it's injected as a single self-contained `<script>` tag.
 *
 * Keep this module a *spec* for the iframe duplication: any change here MUST
 * be mirrored in `tools-script.ts`. The duplication is intentional and
 * flagged with a `// SHARED WITH paint-detection.ts` comment over there so
 * reviewers don't try to deduplicate.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse `rgb(...)` / `rgba(...)` strings produced by `getComputedStyle`. */
export function parseRgbaString(input: string | null | undefined): Rgba | null {
  if (!input) return null;
  const match = input.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)/,
  );
  if (!match) return null;
  const r = Number(match[1]);
  const g = Number(match[2]);
  const b = Number(match[3]);
  const aRaw = match[4] !== undefined ? Number.parseFloat(match[4]) : 1;
  const a = Number.isFinite(aRaw) ? aRaw : 1;
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return { r, g, b, a };
}

/**
 * Extract every `rgb(...)` / `rgba(...)` color stop from a `linear-gradient`
 * or `radial-gradient` `background-image` value. Browsers normalise hex /
 * named-color stops to `rgb()` form in the computed-style output, so a
 * regex over `rgb(...)` is sufficient — we don't have to plug in a
 * temporary element to resolve `red` / `#abc`.
 *
 * Returns the parsed stops in source order; callers pick the representative
 * stop (typically the middle one).
 */
export function parseGradientStops(backgroundImage: string | null | undefined): Rgba[] {
  if (!backgroundImage) return [];
  const stops: Rgba[] = [];
  const rgbRe = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[0-9.]+)?\s*\)/g;
  const matches = backgroundImage.match(rgbRe);
  if (!matches) return [];
  for (const m of matches) {
    const parsed = parseRgbaString(m);
    if (parsed) stops.push(parsed);
  }
  return stops;
}

/**
 * Pick the representative color from a gradient. With 1 stop we return it
 * directly. With 2 stops we average them (the visual centre). With 3+ we
 * return the middle stop verbatim.
 */
export function pickGradientRepresentative(stops: Rgba[]): Rgba | null {
  if (stops.length === 0) return null;
  if (stops.length === 1) return stops[0];
  if (stops.length === 2) {
    return {
      r: Math.round((stops[0].r + stops[1].r) / 2),
      g: Math.round((stops[0].g + stops[1].g) / 2),
      b: Math.round((stops[0].b + stops[1].b) / 2),
      a: (stops[0].a + stops[1].a) / 2,
    };
  }
  const mid = Math.floor(stops.length / 2);
  return stops[mid];
}

/**
 * Tier ordering for the eyedropper (mirrored verbatim in `tools-script.ts`'s
 * `getEffectivePaint`):
 *
 *   Tier 1 walks the click target AND ALL ANCESTORS looking for the first
 *   non-transparent solid background-color. This matches what the user
 *   visually sees — an opaque parent painting over a child gradient is the
 *   pixel they clicked, so we report the parent's solid first instead of
 *   the child's gradient.
 *
 *   Tier 2 then considers the click target's (and ancestors') gradient(s).
 *
 * If the user wants the click target's own gradient (or any non-background
 * paint) to override an ancestor solid, they can hold Shift while clicking
 * to read the foreground color instead.
 */

/** Detect whether a `background-image` value is a CSS gradient. */
export function isGradientBackgroundImage(value: string | null | undefined): boolean {
  if (!value) return false;
  return /\b(?:linear|radial|conic)-gradient\s*\(/i.test(value);
}

/** Convert an Rgba to a `#rrggbb` hex string (alpha is dropped — the panel
 * tracks the channel separately). */
export function rgbaToHex(rgba: Rgba): string {
  const to2 = (n: number): string => {
    const clamped = Math.max(0, Math.min(255, Math.round(n)));
    return clamped.toString(16).padStart(2, "0");
  };
  return `#${to2(rgba.r)}${to2(rgba.g)}${to2(rgba.b)}`;
}

/** Convert an Rgba to its HSL representation. */
export function rgbaToHsl(rgba: Rgba): { h: number; s: number; l: number; a: number } {
  const r = rgba.r / 255;
  const g = rgba.g / 255;
  const b = rgba.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
    a: rgba.a,
  };
}

/**
 * Display helpers for `PickedColor.source`.
 *
 * The eyedropper enum has 8 cases (background, foreground, border, gradient,
 * svg-fill, svg-stroke, pseudo-before, pseudo-after). Both the composer chip
 * (`thread-composer.tsx`) and the panel chip (`design-properties-panel.tsx`)
 * render a short human-friendly label next to the swatch — they used to ship
 * near-identical local helpers which drifted out of sync (the panel was
 * missing a `default:` branch, so a future enum value would crash the badge
 * text).
 *
 * Two variants live here:
 *   - `pickedColorSourceLabel`      — full, readable text ("background",
 *                                     "SVG fill", "::before"). Used in the
 *                                     side panel where there's room.
 *   - `pickedColorSourceShortLabel` — terse pill text ("bg", "grad", "svg")
 *                                     for the composer chips where space is
 *                                     tight.
 *
 * Both helpers include a `default: return source` fallback so a future enum
 * extension never crashes the UI — the raw enum value falls through as
 * label text until display logic catches up.
 */
import type { PickedColor } from "./types";

/** Full, panel-friendly label for a picked-colour paint source. */
export function pickedColorSourceLabel(source: PickedColor["source"]): string {
  switch (source) {
    case "background":
      return "background";
    case "foreground":
      return "foreground";
    case "border":
      return "border";
    case "gradient":
      return "gradient";
    case "svg-fill":
      return "SVG fill";
    case "svg-stroke":
      return "SVG stroke";
    case "pseudo-before":
      return "::before";
    case "pseudo-after":
      return "::after";
    default:
      return source;
  }
}

/** Short pill label for a picked-colour paint source (composer chip). */
export function pickedColorSourceShortLabel(source: PickedColor["source"]): string {
  switch (source) {
    case "background":
      return "bg";
    case "foreground":
      return "fg";
    case "border":
      return "border";
    case "gradient":
      return "grad";
    case "svg-fill":
      return "svg-fill";
    case "svg-stroke":
      return "svg-stroke";
    case "pseudo-before":
      return "::before";
    case "pseudo-after":
      return "::after";
    default:
      return source;
  }
}

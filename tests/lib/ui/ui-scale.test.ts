import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_SCALE,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  normalizeUiScale,
  uiScaleToZoomFactor,
} from "@/lib/ui/ui-scale";

describe("UI scale", () => {
  it("uses a 50–120 percent range with a 100 percent default", () => {
    expect(MIN_UI_SCALE).toBe(50);
    expect(MAX_UI_SCALE).toBe(120);
    expect(DEFAULT_UI_SCALE).toBe(100);
  });

  it("preserves valid percentages and clamps values outside the supported range", () => {
    expect(normalizeUiScale(50)).toBe(50);
    expect(normalizeUiScale(83)).toBe(83);
    expect(normalizeUiScale(120)).toBe(120);
    expect(normalizeUiScale(25)).toBe(50);
    expect(normalizeUiScale(140)).toBe(120);
  });

  it("falls back safely for malformed values and converts percentages to Electron zoom factors", () => {
    expect(normalizeUiScale(undefined)).toBe(100);
    expect(normalizeUiScale("not-a-number")).toBe(100);
    expect(normalizeUiScale(74.6)).toBe(75);
    expect(uiScaleToZoomFactor(75)).toBe(0.75);
    expect(uiScaleToZoomFactor(120)).toBe(1.2);
  });
});

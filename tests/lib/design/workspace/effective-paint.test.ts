/**
 * Tests for the eyedropper's tiered paint-detection helpers.
 *
 * The actual `getEffectivePaint` runs inside the design-preview iframe (see
 * `tools-script.ts`), so the helpers are duplicated there as a string. This
 * suite exercises the pure helpers exported from `lib/design/workspace/
 * paint-detection.ts` — the spec the iframe duplicate must mirror.
 */
import { describe, expect, it } from "vitest";
import {
  isGradientBackgroundImage,
  parseGradientStops,
  parseRgbaString,
  pickGradientRepresentative,
  rgbaToHex,
  rgbaToHsl,
} from "@/lib/design/workspace/paint-detection";

describe("parseRgbaString", () => {
  it("parses rgb(...) without alpha", () => {
    expect(parseRgbaString("rgb(255, 128, 0)")).toEqual({ r: 255, g: 128, b: 0, a: 1 });
  });

  it("parses rgba(...) with alpha", () => {
    expect(parseRgbaString("rgba(0, 0, 0, 0.5)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
  });

  it("returns null for unparseable input", () => {
    expect(parseRgbaString(null)).toBeNull();
    expect(parseRgbaString("")).toBeNull();
    expect(parseRgbaString("not-a-color")).toBeNull();
  });
});

describe("isGradientBackgroundImage", () => {
  it("detects linear / radial / conic gradients", () => {
    expect(isGradientBackgroundImage("linear-gradient(to right, red, blue)")).toBe(true);
    expect(isGradientBackgroundImage("radial-gradient(circle, red, blue)")).toBe(true);
    expect(isGradientBackgroundImage("conic-gradient(red, blue)")).toBe(true);
  });

  it("rejects non-gradient values", () => {
    expect(isGradientBackgroundImage("none")).toBe(false);
    expect(isGradientBackgroundImage('url("foo.png")')).toBe(false);
    expect(isGradientBackgroundImage(null)).toBe(false);
    expect(isGradientBackgroundImage("")).toBe(false);
  });
});

describe("parseGradientStops", () => {
  it("returns every rgb stop in source order", () => {
    const stops = parseGradientStops(
      "linear-gradient(rgb(255, 0, 0), rgb(0, 255, 0), rgb(0, 0, 255))",
    );
    expect(stops.length).toBe(3);
    expect(stops[0]).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(stops[2]).toEqual({ r: 0, g: 0, b: 255, a: 1 });
  });

  it("returns an empty array when no stops parse", () => {
    expect(parseGradientStops("linear-gradient(red, blue)")).toEqual([]);
    expect(parseGradientStops(null)).toEqual([]);
  });
});

describe("pickGradientRepresentative", () => {
  it("returns the single stop for 1-stop gradients", () => {
    const stop = { r: 255, g: 0, b: 0, a: 1 };
    expect(pickGradientRepresentative([stop])).toEqual(stop);
  });

  it("averages 2-stop gradients to the visual midpoint", () => {
    const a = { r: 0, g: 0, b: 0, a: 1 };
    const b = { r: 255, g: 255, b: 255, a: 0.5 };
    expect(pickGradientRepresentative([a, b])).toEqual({
      r: 128,
      g: 128,
      b: 128,
      a: 0.75,
    });
  });

  it("returns the middle stop for 3+ stops", () => {
    const stops = [
      { r: 255, g: 0, b: 0, a: 1 },
      { r: 0, g: 255, b: 0, a: 1 },
      { r: 0, g: 0, b: 255, a: 1 },
    ];
    expect(pickGradientRepresentative(stops)).toEqual(stops[1]);
  });

  it("returns null for an empty stop list", () => {
    expect(pickGradientRepresentative([])).toBeNull();
  });
});

describe("rgbaToHex", () => {
  it("clamps and zero-pads channels", () => {
    expect(rgbaToHex({ r: 0, g: 0, b: 0, a: 1 })).toBe("#000000");
    expect(rgbaToHex({ r: 255, g: 255, b: 255, a: 1 })).toBe("#ffffff");
    expect(rgbaToHex({ r: 999, g: -10, b: 16, a: 1 })).toBe("#ff0010");
  });
});

describe("rgbaToHsl", () => {
  it("converts pure red", () => {
    const hsl = rgbaToHsl({ r: 255, g: 0, b: 0, a: 1 });
    expect(hsl.h).toBe(0);
    expect(hsl.s).toBe(100);
    expect(hsl.l).toBe(50);
    expect(hsl.a).toBe(1);
  });

  it("converts grey to s=0", () => {
    const hsl = rgbaToHsl({ r: 128, g: 128, b: 128, a: 1 });
    expect(hsl.s).toBe(0);
    expect(hsl.l).toBeGreaterThan(40);
    expect(hsl.l).toBeLessThan(60);
  });
});

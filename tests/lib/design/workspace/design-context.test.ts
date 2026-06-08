/**
 * Tests for the unified design-workspace message-context module.
 *
 * Covers:
 *   - `buildDesignContext` returns null when every section is empty
 *   - composition: inspect + measurements + colours all surface
 *   - sanitisation: malformed entries dropped, caps enforced
 *   - prompt formatter renders all three sections in order
 */
import { describe, expect, it } from "vitest";
import {
  MAX_DESIGN_CONTEXT_COLORS,
  MAX_DESIGN_CONTEXT_MEASUREMENTS,
  buildDesignContext,
  formatDesignContextPrompt,
  isValidHex,
  mergeDesignContext,
  sanitizeDesignContext,
} from "@/lib/design/workspace/design-context";
import type { Measurement, PickedColor } from "@/lib/design/workspace/types";
import { buildInspectMessageContext } from "@/lib/design/workspace/inspect-context";

function makeMeasurement(id: string, dx = 30, dy = 40): Measurement {
  return {
    id,
    from: { selector: `#a-${id}`, rect: { x: 0, y: 0, width: 10, height: 10 } },
    to: { selector: `#b-${id}`, rect: { x: dx, y: dy, width: 10, height: 10 } },
    distances: { dx, dy, horizontal: dx - 10, vertical: dy - 10, euclidean: Math.hypot(dx, dy) },
    createdAt: 1_700_000_000_000,
  };
}

function makePickedColor(id: string, source: PickedColor["source"] = "background"): PickedColor {
  return {
    id,
    hex: "#ff8800",
    rgb: { r: 255, g: 136, b: 0, a: 1 },
    hsl: { h: 32, s: 100, l: 50, a: 1 },
    source,
    element: { selector: `#el-${id}`, tagName: "div" },
    createdAt: 1_700_000_000_000,
  };
}

describe("buildDesignContext", () => {
  it("returns null when nothing is selected", () => {
    expect(
      buildDesignContext({
        inspect: null,
        measurements: [],
        pickedColors: [],
        component: null,
        sessionId: "s1",
      }),
    ).toBeNull();
  });

  it("composes inspect + measurements + colours into one payload", () => {
    const inspect = buildInspectMessageContext({
      selectedElements: [
        {
          id: "hero",
          selector: "#hero",
          tagName: "section",
          className: "hero",
          textContent: "Welcome",
          boundingRect: { x: 0, y: 0, width: 100, height: 50 },
          computedStyles: {
            width: "100px",
            height: "50px",
            padding: "0",
            margin: "0",
            display: "block",
            position: "static",
            color: "rgb(0, 0, 0)",
            backgroundColor: "rgb(255, 255, 255)",
            fontSize: "16px",
            fontFamily: "sans-serif",
          },
        },
      ],
      component: { id: "comp-1", name: "Hero" },
      sessionId: "s1",
    });

    const ctx = buildDesignContext({
      inspect,
      measurements: [makeMeasurement("m1")],
      pickedColors: [makePickedColor("c1", "gradient")],
      component: { id: "comp-1", name: "Hero" },
      sessionId: "s1",
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.inspect?.elements?.length).toBe(1);
    expect(ctx?.measurements?.length).toBe(1);
    expect(ctx?.pickedColors?.length).toBe(1);
    expect(ctx?.componentId).toBe("comp-1");
    expect(ctx?.componentName).toBe("Hero");
  });

  it("caps measurements + colours to the configured maxima", () => {
    const measurements = Array.from({ length: MAX_DESIGN_CONTEXT_MEASUREMENTS + 5 }, (_, i) =>
      makeMeasurement(`m${i}`, i + 1, i + 1),
    );
    const pickedColors = Array.from({ length: MAX_DESIGN_CONTEXT_COLORS + 5 }, (_, i) =>
      makePickedColor(`c${i}`),
    );
    const ctx = buildDesignContext({
      inspect: null,
      measurements,
      pickedColors,
      component: null,
      sessionId: "s1",
    });
    expect(ctx?.measurements?.length).toBe(MAX_DESIGN_CONTEXT_MEASUREMENTS);
    expect(ctx?.pickedColors?.length).toBe(MAX_DESIGN_CONTEXT_COLORS);
  });
});

describe("sanitizeDesignContext", () => {
  it("drops measurements missing selectors", () => {
    const sanitized = sanitizeDesignContext({
      version: 1,
      source: "design-workspace",
      capturedAt: new Date().toISOString(),
      measurements: [
        { id: "ok", fromSelector: "#a", toSelector: "#b", dx: 10, dy: 10, horizontal: 0, vertical: 0, euclidean: 14 },
        { id: "bad", fromSelector: "", toSelector: "#b", dx: 0, dy: 0, horizontal: 0, vertical: 0, euclidean: 0 },
      ],
    });
    expect(sanitized?.measurements?.length).toBe(1);
    expect(sanitized?.measurements?.[0]?.id).toBe("ok");
  });

  it("drops colours with invalid hex/selector and clamps RGB channels", () => {
    const sanitized = sanitizeDesignContext({
      version: 1,
      source: "design-workspace",
      capturedAt: new Date().toISOString(),
      pickedColors: [
        { id: "ok", hex: "#fff", source: "background", selector: "#x", tagName: "div", rgb: { r: 999, g: -10, b: 50, a: 5 } },
        { id: "bad-hex", hex: "", source: "background", selector: "#y", tagName: "span", rgb: { r: 0, g: 0, b: 0, a: 1 } },
        { id: "bad-source", hex: "#aaa", source: "not-a-real-source", selector: "#z", tagName: "div", rgb: { r: 1, g: 1, b: 1, a: 1 } },
      ],
    });
    expect(sanitized?.pickedColors?.length).toBe(2);
    const ok = sanitized?.pickedColors?.find((c) => c.id === "ok");
    expect(ok?.rgb.r).toBe(255);
    expect(ok?.rgb.g).toBe(0);
    expect(ok?.rgb.a).toBe(1);
    const fallback = sanitized?.pickedColors?.find((c) => c.id === "bad-source");
    expect(fallback?.source).toBe("background"); // unknown source falls back
  });

  it("returns null when nothing valid survives", () => {
    expect(
      sanitizeDesignContext({
        version: 1,
        source: "design-workspace",
        capturedAt: new Date().toISOString(),
        measurements: [{ id: "x", fromSelector: "", toSelector: "", dx: 0, dy: 0, horizontal: 0, vertical: 0, euclidean: 0 }],
        pickedColors: [{ id: "y", hex: "", source: "background", selector: "", tagName: "div", rgb: { r: 0, g: 0, b: 0, a: 1 } }],
      }),
    ).toBeNull();
  });
});

describe("formatDesignContextPrompt", () => {
  it("renders inspect, measurement and colour sections in order", () => {
    const inspect = buildInspectMessageContext({
      selectedElements: [
        {
          id: "hero",
          selector: "#hero",
          tagName: "section",
          className: "hero",
          textContent: "Welcome",
          boundingRect: { x: 0, y: 0, width: 100, height: 50 },
          computedStyles: {
            width: "100px",
            height: "50px",
            padding: "0",
            margin: "0",
            display: "block",
            position: "static",
            color: "rgb(0, 0, 0)",
            backgroundColor: "rgb(255, 255, 255)",
            fontSize: "16px",
            fontFamily: "sans-serif",
          },
        },
      ],
      component: null,
      sessionId: undefined,
    });
    const ctx = buildDesignContext({
      inspect,
      measurements: [makeMeasurement("m1", 30, 40)],
      pickedColors: [makePickedColor("c1", "gradient")],
      component: null,
      sessionId: undefined,
    });
    const text = formatDesignContextPrompt(ctx);
    expect(text).not.toBeNull();
    if (!text) throw new Error("expected text");
    // Inspect section first, then measurements, then colours.
    const inspectIdx = text.indexOf("[Inspect");
    const measIdx = text.indexOf("[Measurements]");
    const colIdx = text.indexOf("[Colors]");
    expect(inspectIdx).toBeGreaterThanOrEqual(0);
    expect(measIdx).toBeGreaterThan(inspectIdx);
    expect(colIdx).toBeGreaterThan(measIdx);
    expect(text).toContain("(gradient)");
  });

  it("returns null for null input", () => {
    expect(formatDesignContextPrompt(null)).toBeNull();
  });
});

describe("isValidHex", () => {
  it("accepts #rgb / #rrggbb / #rrggbbaa in any case", () => {
    expect(isValidHex("#fff")).toBe(true);
    expect(isValidHex("#FFFFFF")).toBe(true);
    expect(isValidHex("#ffffffff")).toBe(true);
    expect(isValidHex("#AaBbCc")).toBe(true);
    expect(isValidHex("#1234abcd")).toBe(true);
  });

  it("rejects free-form / malformed strings", () => {
    expect(isValidHex("banana")).toBe(false);
    expect(isValidHex("red")).toBe(false);
    expect(isValidHex("#xyz")).toBe(false);
    expect(isValidHex("#1234")).toBe(false); // 4 chars, not allowed
    expect(isValidHex("#12345")).toBe(false); // 5 chars
    expect(isValidHex("#1234567")).toBe(false); // 7 chars
    expect(isValidHex("")).toBe(false);
    expect(isValidHex("ffffff")).toBe(false); // missing #
    expect(isValidHex("#")).toBe(false);
  });
});

describe("sanitizeDesignContext color hex regex", () => {
  function colorEntry(id: string, hex: string) {
    return {
      id,
      hex,
      source: "background" as const,
      selector: `#el-${id}`,
      tagName: "div",
      rgb: { r: 0, g: 0, b: 0, a: 1 },
    };
  }

  it("accepts every valid hex variant", () => {
    const sanitized = sanitizeDesignContext({
      version: 1,
      source: "design-workspace",
      capturedAt: new Date().toISOString(),
      pickedColors: [
        colorEntry("short", "#fff"),
        colorEntry("upper", "#FFFFFF"),
        colorEntry("alpha", "#ffffffff"),
        colorEntry("mixed", "#AaBbCc"),
      ],
    });
    expect(sanitized?.pickedColors?.length).toBe(4);
  });

  it("drops invalid hex values", () => {
    const sanitized = sanitizeDesignContext({
      version: 1,
      source: "design-workspace",
      capturedAt: new Date().toISOString(),
      pickedColors: [
        colorEntry("ok", "#fff"),
        colorEntry("banana", "banana"),
        colorEntry("xyz", "#xyz"),
        colorEntry("four-hex", "#1234"),
        colorEntry("empty", ""),
        colorEntry("named", "red"),
      ],
    });
    // Only the "ok" entry survives.
    expect(sanitized?.pickedColors?.length).toBe(1);
    expect(sanitized?.pickedColors?.[0]?.id).toBe("ok");
  });

  it("omits the colours section entirely when every hex is invalid", () => {
    const sanitized = sanitizeDesignContext({
      version: 1,
      source: "design-workspace",
      capturedAt: new Date().toISOString(),
      pickedColors: [
        colorEntry("a", "banana"),
        colorEntry("b", "#xyz"),
        colorEntry("c", "#1234"),
      ],
    });
    expect(sanitized).toBeNull();
  });

  it("omits colours section but keeps measurements when only colours are invalid", () => {
    const sanitized = sanitizeDesignContext({
      version: 1,
      source: "design-workspace",
      capturedAt: new Date().toISOString(),
      measurements: [
        { id: "m1", fromSelector: "#a", toSelector: "#b", dx: 10, dy: 10, horizontal: 0, vertical: 0, euclidean: 14 },
      ],
      pickedColors: [colorEntry("bad", "banana")],
    });
    expect(sanitized).not.toBeNull();
    expect(sanitized?.measurements?.length).toBe(1);
    expect(sanitized?.pickedColors).toBeUndefined();
  });
});

describe("mergeDesignContext", () => {
  function makeInspect(elementCount = 1): NonNullable<ReturnType<typeof buildInspectMessageContext>> {
    const ctx = buildInspectMessageContext({
      selectedElements: Array.from({ length: elementCount }, (_, i) => ({
        id: `el-${i}`,
        selector: `#el-${i}`,
        tagName: "div",
        className: "",
        textContent: "",
        boundingRect: { x: 0, y: 0, width: 10, height: 10 },
        computedStyles: {
          width: "10px",
          height: "10px",
          padding: "0",
          margin: "0",
          display: "block",
          position: "static",
          color: "rgb(0,0,0)",
          backgroundColor: "rgb(255,255,255)",
          fontSize: "16px",
          fontFamily: "sans-serif",
        },
      })),
      component: { id: "comp-1", name: "C" },
      sessionId: "s1",
    });
    if (!ctx) throw new Error("expected inspect ctx");
    return ctx;
  }

  it("returns null when both inputs are null/empty", () => {
    expect(mergeDesignContext(null, null)).toBeNull();
    expect(mergeDesignContext(null, { inspect: null })).toBeNull();
  });

  it("returns primary unchanged when legacy is null", () => {
    const primary = buildDesignContext({
      inspect: makeInspect(),
      measurements: [],
      pickedColors: [],
      component: null,
      sessionId: "s1",
    });
    const merged = mergeDesignContext(primary, { inspect: null });
    expect(merged).toBe(primary);
  });

  it("builds a design context from legacy.inspect when primary is null", () => {
    const legacyInspect = makeInspect(2);
    const merged = mergeDesignContext(null, { inspect: legacyInspect });
    expect(merged).not.toBeNull();
    expect(merged?.source).toBe("design-workspace");
    expect(merged?.inspect?.elements.length).toBe(2);
    expect(merged?.measurements).toBeUndefined();
    expect(merged?.pickedColors).toBeUndefined();
  });

  it("primary wins when both have populated inspect", () => {
    const primaryInspect = makeInspect(1);
    const legacyInspect = makeInspect(3);
    const primary = buildDesignContext({
      inspect: primaryInspect,
      measurements: [],
      pickedColors: [],
      component: null,
      sessionId: "s1",
    });
    const merged = mergeDesignContext(primary, { inspect: legacyInspect });
    expect(merged?.inspect?.elements.length).toBe(1);
  });

  it("merges legacy.inspect into primary when primary lacks inspect", () => {
    const legacyInspect = makeInspect(2);
    const measurement: Measurement = {
      id: "m1",
      from: { selector: "#a", rect: { x: 0, y: 0, width: 10, height: 10 } },
      to: { selector: "#b", rect: { x: 30, y: 30, width: 10, height: 10 } },
      distances: { dx: 30, dy: 30, horizontal: 20, vertical: 20, euclidean: 42 },
      createdAt: 1,
    };
    const primary = buildDesignContext({
      inspect: null,
      measurements: [measurement],
      pickedColors: [],
      component: null,
      sessionId: "s1",
    });
    expect(primary?.inspect).toBeUndefined();
    const merged = mergeDesignContext(primary, { inspect: legacyInspect });
    expect(merged?.inspect?.elements.length).toBe(2);
    expect(merged?.measurements?.length).toBe(1);
  });

  it("merges into primary that has measurements + colors but no inspect", () => {
    const legacyInspect = makeInspect(1);
    const measurement: Measurement = {
      id: "m1",
      from: { selector: "#a", rect: { x: 0, y: 0, width: 10, height: 10 } },
      to: { selector: "#b", rect: { x: 30, y: 30, width: 10, height: 10 } },
      distances: { dx: 30, dy: 30, horizontal: 20, vertical: 20, euclidean: 42 },
      createdAt: 1,
    };
    const color: PickedColor = {
      id: "c1",
      hex: "#abcdef",
      rgb: { r: 0, g: 0, b: 0, a: 1 },
      hsl: { h: 0, s: 0, l: 0, a: 1 },
      source: "background",
      element: { selector: "#x", tagName: "div" },
      createdAt: 1,
    };
    const primary = buildDesignContext({
      inspect: null,
      measurements: [measurement],
      pickedColors: [color],
      component: null,
      sessionId: "s1",
    });
    expect(primary?.inspect).toBeUndefined();
    expect(primary?.measurements?.length).toBe(1);
    expect(primary?.pickedColors?.length).toBe(1);
    const merged = mergeDesignContext(primary, { inspect: legacyInspect });
    expect(merged?.inspect?.elements.length).toBe(1);
    expect(merged?.measurements?.length).toBe(1);
    expect(merged?.pickedColors?.length).toBe(1);
  });

  it("caps merged inspect selections at MAX_INSPECT_SELECTIONS", () => {
    // Build a legacy context with more elements than the cap by hand-crafting
    // the structure (buildInspectMessageContext also caps, but we want to
    // verify mergeDesignContext re-applies the cap defensively).
    const oversized: ReturnType<typeof buildInspectMessageContext> = {
      version: 1,
      source: "design-workspace-inspector",
      sessionId: "s1",
      selectedAt: new Date().toISOString(),
      elements: Array.from({ length: 20 }, (_, i) => ({
        tagName: "div",
        id: `el-${i}`,
        selector: `#el-${i}`,
        textContent: "",
        className: "",
        classes: [],
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        hierarchy: [`#el-${i}`],
      })),
    };
    const merged = mergeDesignContext(null, { inspect: oversized });
    expect(merged?.inspect?.elements.length).toBeLessThanOrEqual(8);
  });
});

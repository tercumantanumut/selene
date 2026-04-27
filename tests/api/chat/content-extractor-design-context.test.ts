/**
 * End-to-end tests for the design-workspace context prepended to chat
 * messages by the server-side `extractContent` consumer.
 *
 * The build/sanitize/format pure helpers live under
 * `tests/lib/design/workspace/design-context.test.ts`. THIS file exercises
 * the integration between that module and `app/api/chat/content-extractor.ts`
 * — i.e. given a chat message with `metadata.custom.designContext`, the
 * formatted block is prepended to the prompt; given only the legacy
 * `metadata.custom.inspectContext`, the legacy fallback still surfaces.
 */
import { describe, expect, it } from "vitest";

import { extractContent } from "@/app/api/chat/content-extractor";
import { buildDesignContext } from "@/lib/design/workspace/design-context";
import { buildInspectMessageContext } from "@/lib/design/workspace/inspect-context";
import type { Measurement, PickedColor } from "@/lib/design/workspace/types";

function makeInspect() {
  return buildInspectMessageContext({
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
}

function makeMeasurement(): Measurement {
  return {
    id: "m1",
    from: { selector: "#a", rect: { x: 0, y: 0, width: 10, height: 10 } },
    to: { selector: "#b", rect: { x: 30, y: 40, width: 10, height: 10 } },
    distances: { dx: 30, dy: 40, horizontal: 20, vertical: 30, euclidean: 50 },
    createdAt: 1_700_000_000_000,
  };
}

function makePickedColor(): PickedColor {
  return {
    id: "c1",
    hex: "#ff8800",
    rgb: { r: 255, g: 136, b: 0, a: 1 },
    hsl: { h: 32, s: 100, l: 50, a: 1 },
    source: "gradient",
    element: { selector: "#hero", tagName: "div" },
    createdAt: 1_700_000_000_000,
  };
}

describe("extractContent — designContext integration", () => {
  it("designContext only — prompt prepends [Inspect]/[Measurements]/[Colors] in expected order", async () => {
    const designContext = buildDesignContext({
      inspect: makeInspect(),
      measurements: [makeMeasurement()],
      pickedColors: [makePickedColor()],
      component: { id: "comp-1", name: "Hero" },
      sessionId: "s1",
    });
    expect(designContext).not.toBeNull();

    const result = await extractContent({
      role: "user",
      content: "Refactor the hero",
      metadata: { custom: { designContext } },
    });

    // No structured parts, no attachments → returns a plain string.
    expect(typeof result).toBe("string");
    const text = result as string;

    const inspectIdx = text.indexOf("[Inspect");
    const measIdx = text.indexOf("[Measurements]");
    const colIdx = text.indexOf("[Colors]");
    const userIdx = text.indexOf("Refactor the hero");

    expect(inspectIdx).toBeGreaterThanOrEqual(0);
    expect(measIdx).toBeGreaterThan(inspectIdx);
    expect(colIdx).toBeGreaterThan(measIdx);
    // The user's actual prompt comes AFTER the design block.
    expect(userIdx).toBeGreaterThan(colIdx);
  });

  it("inspectContext only (legacy) — falls back to the legacy inspect block", async () => {
    const inspect = makeInspect();

    const result = await extractContent({
      role: "user",
      content: "Tweak the hero",
      metadata: { custom: { inspectContext: inspect } },
    });

    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text).toContain("[Inspect");
    expect(text).toContain("Tweak the hero");
    // No measurements or colours in a legacy payload.
    expect(text).not.toContain("[Measurements]");
    expect(text).not.toContain("[Colors]");
  });

  it("designContext wins when both designContext and inspectContext are present", async () => {
    // Build a design context that ONLY carries a measurement (no inspect),
    // alongside a legacy inspectContext. The unified payload should take
    // priority and the legacy one should be ignored — preventing two
    // overlapping inspect blocks in the prompt.
    const designContext = buildDesignContext({
      inspect: null,
      measurements: [makeMeasurement()],
      pickedColors: [],
      component: { id: "comp-1", name: "Hero" },
      sessionId: "s1",
    });
    expect(designContext).not.toBeNull();

    const result = await extractContent({
      role: "user",
      content: "What is the offset?",
      metadata: {
        custom: {
          designContext,
          inspectContext: makeInspect(),
        },
      },
    });

    expect(typeof result).toBe("string");
    const text = result as string;
    // The designContext branch wins → measurements present, inspect absent.
    expect(text).toContain("[Measurements]");
    expect(text).not.toContain("[Inspect");
  });

  it("snapshot of the full formatted prompt block locks in size/shape", async () => {
    const designContext = buildDesignContext({
      inspect: makeInspect(),
      measurements: [makeMeasurement()],
      pickedColors: [makePickedColor()],
      component: { id: "comp-1", name: "Hero" },
      sessionId: "s1",
    });

    const result = await extractContent({
      role: "user",
      content: "go",
      metadata: { custom: { designContext } },
    });

    expect(typeof result).toBe("string");
    const text = result as string;
    // Inline snapshot locks in the section ordering, label syntax, and the
    // separator between the design block and the user's prompt. The
    // formatter is deterministic given the inputs above, so this catches
    // accidental format drift (e.g. the day someone reorders the sections
    // or renames `[Measurements]` to `[Distances]`).
    expect(text).toMatchInlineSnapshot(`
      "[Inspect Focus]
      Component: Hero (comp-1)
      Selected elements: 1
      1. <section> .hero "Welcome"
         selector: #hero
         bounds: 100x50 at (0, 0)
         hierarchy: #hero

      [Measurements]
      1. #a → #b: 50px (dx 30, dy 40)

      [Colors]
      1. #ff8800 (gradient) — <div> #hero

      go"
    `);
  });
});

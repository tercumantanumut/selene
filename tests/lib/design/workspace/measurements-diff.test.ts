/**
 * Tests for the parent-side measurement diff used to drive the iframe sync.
 * Mirrors the existing `diffComments` test pattern. Imported directly from
 * `design-preview-frame` (named export) — same path the runtime uses, so we
 * are exercising the production diff function.
 */
import { describe, expect, it } from "vitest";
import { diffMeasurements } from "@/components/design/design-preview-frame";
import type { Measurement } from "@/lib/design/workspace/types";

function makeMeasurement(
  id: string,
  overrides: Partial<Measurement> = {},
): Measurement {
  return {
    id,
    from: { selector: `#a-${id}`, rect: { x: 0, y: 0, width: 10, height: 10 } },
    to: { selector: `#b-${id}`, rect: { x: 30, y: 30, width: 10, height: 10 } },
    distances: { dx: 30, dy: 30, horizontal: 20, vertical: 20, euclidean: 42.42 },
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("diffMeasurements", () => {
  it("classifies brand-new measurements as added", () => {
    const result = diffMeasurements(
      [makeMeasurement("m1"), makeMeasurement("m2")],
      new Map(),
    );
    expect(result.added.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(result.removed).toEqual([]);
    expect(result.updated).toEqual([]);
  });

  it("classifies missing measurements as removed", () => {
    const previous = new Map<string, Measurement>([
      ["m1", makeMeasurement("m1")],
      ["m2", makeMeasurement("m2")],
    ]);
    const result = diffMeasurements([makeMeasurement("m1")], previous);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(["m2"]);
    expect(result.updated).toEqual([]);
  });

  it("classifies endpoint or distance changes as updated", () => {
    const previous = new Map<string, Measurement>([["m1", makeMeasurement("m1")]]);
    const next = makeMeasurement("m1", {
      distances: { dx: 31, dy: 30, horizontal: 20, vertical: 20, euclidean: 43 },
    });
    const result = diffMeasurements([next], previous);
    expect(result.updated.map((m) => m.id)).toEqual(["m1"]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("classifies orphaned-flag flips as updated", () => {
    const previous = new Map<string, Measurement>([["m1", makeMeasurement("m1")]]);
    const next = makeMeasurement("m1", { orphaned: true });
    const result = diffMeasurements([next], previous);
    expect(result.updated.map((m) => m.id)).toEqual(["m1"]);
  });

  it("returns no diff when nothing has changed", () => {
    const previous = new Map<string, Measurement>([
      ["m1", makeMeasurement("m1")],
      ["m2", makeMeasurement("m2")],
    ]);
    const result = diffMeasurements(
      [makeMeasurement("m1"), makeMeasurement("m2")],
      previous,
    );
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.updated).toEqual([]);
  });
});

/**
 * Validator coverage for the new measurement-sync postMessage envelopes.
 *
 *   - `selene-tool-measurements-resolved` — iframe -> parent ack
 *   - `selene-tool-measurements-sync`     — parent -> iframe (bootstrap or diff)
 *
 * Each test covers (a) the happy path and (b) at least one realistic bad
 * shape so we know the validator rejects malformed payloads instead of
 * coercing them silently.
 */
import { describe, expect, it } from "vitest";
import {
  validateIframeMessage,
  validateMeasurementsSync,
} from "@/lib/design/workspace/iframe-messages";

describe("validateIframeMessage / selene-tool-measurements-resolved", () => {
  it("accepts a well-formed resolved/unresolved envelope", () => {
    const result = validateIframeMessage({
      type: "selene-tool-measurements-resolved",
      resolved: ["m1", "m2"],
      unresolved: ["m3"],
    });
    expect(result?.type).toBe("selene-tool-measurements-resolved");
    if (result?.type !== "selene-tool-measurements-resolved") return;
    expect(result.resolved).toEqual(["m1", "m2"]);
    expect(result.unresolved).toEqual(["m3"]);
  });

  it("rejects when `resolved` is not a string array", () => {
    expect(
      validateIframeMessage({
        type: "selene-tool-measurements-resolved",
        resolved: [1, 2, 3],
        unresolved: [],
      }),
    ).toBeNull();
  });

  it("rejects when `unresolved` is missing", () => {
    expect(
      validateIframeMessage({
        type: "selene-tool-measurements-resolved",
        resolved: ["a"],
      }),
    ).toBeNull();
  });
});

describe("validateMeasurementsSync (parent -> iframe)", () => {
  const validEntry = {
    id: "m1",
    from: { selector: "#a", rect: { x: 0, y: 0, width: 10, height: 10 } },
    to: { selector: "#b", rect: { x: 30, y: 30, width: 10, height: 10 } },
    distances: { dx: 30, dy: 30, horizontal: 20, vertical: 20, euclidean: 42.42 },
  };

  it("accepts a bootstrap envelope with valid entries", () => {
    const result = validateMeasurementsSync({
      type: "selene-tool-measurements-sync",
      bootstrap: [validEntry],
    });
    expect(result).not.toBeNull();
    if (!result || !("bootstrap" in result)) throw new Error("expected bootstrap form");
    expect(result.bootstrap.length).toBe(1);
  });

  it("accepts a diff envelope with valid added/removed/updated", () => {
    const result = validateMeasurementsSync({
      type: "selene-tool-measurements-sync",
      diff: {
        added: [validEntry],
        removed: ["m9"],
        updated: [],
      },
    });
    expect(result).not.toBeNull();
    if (!result || !("diff" in result)) throw new Error("expected diff form");
    expect(result.diff.added.length).toBe(1);
    expect(result.diff.removed).toEqual(["m9"]);
  });

  it("rejects entries missing a selector", () => {
    expect(
      validateMeasurementsSync({
        type: "selene-tool-measurements-sync",
        bootstrap: [{ ...validEntry, from: { selector: "", rect: validEntry.from.rect } }],
      }),
    ).toBeNull();
  });

  it("rejects entries with non-finite distances", () => {
    expect(
      validateMeasurementsSync({
        type: "selene-tool-measurements-sync",
        bootstrap: [
          { ...validEntry, distances: { ...validEntry.distances, euclidean: Number.POSITIVE_INFINITY } },
        ],
      }),
    ).toBeNull();
  });

  it("rejects unknown envelopes", () => {
    expect(validateMeasurementsSync({ type: "wrong" })).toBeNull();
    expect(validateMeasurementsSync(null)).toBeNull();
    expect(validateMeasurementsSync({})).toBeNull();
  });

  it("rejects diff with non-string `removed`", () => {
    expect(
      validateMeasurementsSync({
        type: "selene-tool-measurements-sync",
        diff: { added: [], removed: [1, 2], updated: [] },
      }),
    ).toBeNull();
  });
});

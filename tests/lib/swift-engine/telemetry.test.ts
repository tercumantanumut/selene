/**
 * Sprint 7 W7.1.G — telemetry module tests.
 *
 * Covers:
 *   - record + read-back of events
 *   - ring buffer caps at RING_CAPACITY (oldest events drop)
 *   - getEngineSelectionStats totals stay accurate across drops
 *   - never throws on unusual / malformed input
 *   - errorCode is clipped + control-stripped (no PII leaks via long messages)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __ENGINE_TELEMETRY_RING_CAPACITY,
  __resetEngineTelemetryForTests,
  getEngineSelectionStats,
  getRecentEngineEvents,
  recordEngineSelection,
  type EngineSelectionEvent,
} from "@/lib/swift-engine/telemetry";

describe("swift-engine telemetry", () => {
  beforeEach(() => {
    __resetEngineTelemetryForTests();
  });

  afterEach(() => {
    __resetEngineTelemetryForTests();
  });

  it("records events and exposes them via getRecentEngineEvents", () => {
    const evt: EngineSelectionEvent = {
      engine: "swift",
      outcome: "primary",
      durationMs: 42,
    };
    recordEngineSelection(evt);

    const events = getRecentEngineEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(evt);
  });

  it("starts with zeroed stats", () => {
    const stats = getEngineSelectionStats();
    expect(stats.totals.lance).toBe(0);
    expect(stats.totals.swift).toBe(0);
    expect(stats.fallbacks).toBe(0);
    expect(stats.totalEvents).toBe(0);
    expect(stats.lastEvent).toBeUndefined();
  });

  it("updates totals + lastEvent + fallback count correctly across multiple events", () => {
    recordEngineSelection({ engine: "swift", outcome: "primary", durationMs: 11 });
    recordEngineSelection({ engine: "lance", outcome: "primary", durationMs: 13 });
    recordEngineSelection({
      engine: "lance",
      outcome: "fallback-unavailable",
      errorCode: "swift_unavailable",
    });
    recordEngineSelection({
      engine: "lance",
      outcome: "fallback-error",
      errorCode: "rpc_timeout",
    });

    const stats = getEngineSelectionStats();
    expect(stats.totals.swift).toBe(1);
    expect(stats.totals.lance).toBe(3);
    expect(stats.fallbacks).toBe(2);
    expect(stats.totalEvents).toBe(4);
    expect(stats.lastEvent).toEqual({
      engine: "lance",
      outcome: "fallback-error",
      errorCode: "rpc_timeout",
    });
  });

  it("ring buffer drops oldest events once capacity is exceeded but totals stay accurate", () => {
    const cap = __ENGINE_TELEMETRY_RING_CAPACITY;
    expect(cap).toBeGreaterThan(0);

    // Fill exactly to capacity with swift/primary, then push 50 more lance/primary
    for (let i = 0; i < cap; i++) {
      recordEngineSelection({ engine: "swift", outcome: "primary" });
    }
    for (let i = 0; i < 50; i++) {
      recordEngineSelection({ engine: "lance", outcome: "primary" });
    }

    // Ring should contain at most `cap` events.
    const events = getRecentEngineEvents();
    expect(events).toHaveLength(cap);

    // The 50 most recent should be lance; the rest should be swift.
    const lanceCount = events.filter((e) => e.engine === "lance").length;
    const swiftCount = events.filter((e) => e.engine === "swift").length;
    expect(lanceCount).toBe(50);
    expect(swiftCount).toBe(cap - 50);

    // Totals are lifetime counters, NOT bounded by ring size.
    const stats = getEngineSelectionStats();
    expect(stats.totals.swift).toBe(cap);
    expect(stats.totals.lance).toBe(50);
    expect(stats.totalEvents).toBe(cap + 50);
    expect(stats.fallbacks).toBe(0);
  });

  it("returns at most `limit` recent events in chronological order", () => {
    for (let i = 0; i < 10; i++) {
      recordEngineSelection({
        engine: i % 2 === 0 ? "swift" : "lance",
        outcome: "primary",
        durationMs: i,
      });
    }

    const last3 = getRecentEngineEvents(3);
    expect(last3).toHaveLength(3);
    expect(last3.map((e) => e.durationMs)).toEqual([7, 8, 9]);
  });

  it("returns empty array when limit is zero or negative", () => {
    recordEngineSelection({ engine: "swift", outcome: "primary" });
    expect(getRecentEngineEvents(0)).toEqual([]);
    expect(getRecentEngineEvents(-5)).toEqual([]);
  });

  it("silently drops malformed events without throwing", () => {
    expect(() => {
      // @ts-expect-error — intentional bad input
      recordEngineSelection(undefined);
      // @ts-expect-error — intentional bad input
      recordEngineSelection(null);
      // @ts-expect-error — intentional bad input
      recordEngineSelection({});
      // @ts-expect-error — intentional bad input
      recordEngineSelection({ engine: "lance" });
      // @ts-expect-error — intentional bad input
      recordEngineSelection({ engine: "lance", outcome: "wat" });
      // @ts-expect-error — intentional bad input
      recordEngineSelection({ engine: "rust", outcome: "primary" });
    }).not.toThrow();

    const stats = getEngineSelectionStats();
    expect(stats.totalEvents).toBe(0);
    expect(stats.totals.lance).toBe(0);
    expect(stats.totals.swift).toBe(0);
  });

  it("clips overlong errorCode strings and strips control characters", () => {
    const long = "x".repeat(500) + "\u0007rest";
    recordEngineSelection({
      engine: "lance",
      outcome: "fallback-error",
      errorCode: long,
    });

    const stats = getEngineSelectionStats();
    expect(stats.lastEvent?.errorCode?.length).toBeLessThanOrEqual(64);
    expect(stats.lastEvent?.errorCode).not.toContain("\u0007");
  });

  it("normalizes non-finite durationMs to undefined and clips negatives to zero", () => {
    recordEngineSelection({
      engine: "swift",
      outcome: "primary",
      durationMs: Number.NaN,
    });
    expect(getEngineSelectionStats().lastEvent?.durationMs).toBeUndefined();

    recordEngineSelection({
      engine: "swift",
      outcome: "primary",
      durationMs: Number.POSITIVE_INFINITY,
    });
    expect(getEngineSelectionStats().lastEvent?.durationMs).toBeUndefined();

    recordEngineSelection({
      engine: "swift",
      outcome: "primary",
      durationMs: -250,
    });
    expect(getEngineSelectionStats().lastEvent?.durationMs).toBe(0);
  });

  it("__resetEngineTelemetryForTests fully clears state", () => {
    recordEngineSelection({ engine: "swift", outcome: "primary" });
    recordEngineSelection({ engine: "lance", outcome: "fallback-error", errorCode: "rpc_timeout" });
    expect(getEngineSelectionStats().totalEvents).toBe(2);

    __resetEngineTelemetryForTests();

    const stats = getEngineSelectionStats();
    expect(stats.totals.swift).toBe(0);
    expect(stats.totals.lance).toBe(0);
    expect(stats.fallbacks).toBe(0);
    expect(stats.totalEvents).toBe(0);
    expect(stats.lastEvent).toBeUndefined();
    expect(getRecentEngineEvents()).toEqual([]);
  });
});

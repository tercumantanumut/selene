/**
 * Reducer-level tests for the design-workspace tool collections (measurements,
 * picked colors, comments) plus the active-tool / inspector glue and the new
 * orphan-pruning action.
 *
 * These exercise the store directly via `useDesignWorkspaceStore.getState()`
 * — no React, no DOM. We `reset()` between each case so module-level caches
 * (session cache, hydration tracker) don't bleed across tests.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_COMMENTS,
  MAX_MEASUREMENTS,
  MAX_PICKED_COLORS,
  useDesignWorkspaceStore,
} from "@/lib/design/workspace/store";
import type {
  ActiveTool,
  DesignComment,
  Measurement,
  PickedColor,
} from "@/lib/design/workspace/types";

function makeMeasurement(id: string): Measurement {
  return {
    id,
    from: { selector: `#a-${id}`, rect: { x: 0, y: 0, width: 10, height: 10 } },
    to: { selector: `#b-${id}`, rect: { x: 30, y: 30, width: 10, height: 10 } },
    distances: { dx: 30, dy: 30, horizontal: 20, vertical: 20, euclidean: 42.42 },
    createdAt: 1_700_000_000_000,
  };
}

function makePickedColor(id: string, source: PickedColor["source"] = "background"): PickedColor {
  return {
    id,
    hex: "#abcdef",
    rgb: { r: 0xab, g: 0xcd, b: 0xef, a: 1 },
    hsl: { h: 200, s: 80, l: 60, a: 1 },
    source,
    element: { selector: `#el-${id}`, tagName: "div" },
    createdAt: 1_700_000_000_000,
  };
}

function makeComment(id: string, overrides: Partial<DesignComment> = {}): DesignComment {
  return {
    id,
    elementSelector: `#el-${id}`,
    text: `text-${id}`,
    createdAt: 1_700_000_000_000,
    resolved: false,
    ...overrides,
  };
}

describe("design workspace store — tool collections", () => {
  beforeEach(() => {
    useDesignWorkspaceStore.getState().reset();
  });

  describe("measurements", () => {
    it("addMeasurement / removeMeasurement / clearMeasurements", () => {
      const store = useDesignWorkspaceStore.getState();
      store.addMeasurement(makeMeasurement("m1"));
      store.addMeasurement(makeMeasurement("m2"));
      expect(useDesignWorkspaceStore.getState().measurements.map((m) => m.id)).toEqual(["m1", "m2"]);
      useDesignWorkspaceStore.getState().removeMeasurement("m1");
      expect(useDesignWorkspaceStore.getState().measurements.map((m) => m.id)).toEqual(["m2"]);
      useDesignWorkspaceStore.getState().clearMeasurements();
      expect(useDesignWorkspaceStore.getState().measurements).toEqual([]);
    });

    it("FIFO cap drops oldest when exceeding MAX_MEASUREMENTS", () => {
      const store = useDesignWorkspaceStore.getState();
      for (let i = 0; i < MAX_MEASUREMENTS + 1; i += 1) {
        store.addMeasurement(makeMeasurement(`m${i}`));
      }
      const state = useDesignWorkspaceStore.getState();
      expect(state.measurements.length).toBe(MAX_MEASUREMENTS);
      // The oldest entry (m0) must have been dropped.
      expect(state.measurements[0]?.id).toBe("m1");
      expect(state.measurements[state.measurements.length - 1]?.id).toBe(`m${MAX_MEASUREMENTS}`);
    });
  });

  describe("picked colors", () => {
    it("addPickedColor / removePickedColor / clearPickedColors", () => {
      const store = useDesignWorkspaceStore.getState();
      store.addPickedColor(makePickedColor("p1"));
      store.addPickedColor(makePickedColor("p2", "foreground"));
      expect(useDesignWorkspaceStore.getState().pickedColors.map((c) => c.id)).toEqual(["p1", "p2"]);
      useDesignWorkspaceStore.getState().removePickedColor("p1");
      expect(useDesignWorkspaceStore.getState().pickedColors.map((c) => c.id)).toEqual(["p2"]);
      useDesignWorkspaceStore.getState().clearPickedColors();
      expect(useDesignWorkspaceStore.getState().pickedColors).toEqual([]);
    });

    it("FIFO cap drops oldest when exceeding MAX_PICKED_COLORS", () => {
      const store = useDesignWorkspaceStore.getState();
      for (let i = 0; i < MAX_PICKED_COLORS + 1; i += 1) {
        store.addPickedColor(makePickedColor(`p${i}`));
      }
      const state = useDesignWorkspaceStore.getState();
      expect(state.pickedColors.length).toBe(MAX_PICKED_COLORS);
      expect(state.pickedColors[0]?.id).toBe("p1");
    });
  });

  describe("comments", () => {
    it("addComment / updateComment / removeComment / resolveComment / clearComments", () => {
      const store = useDesignWorkspaceStore.getState();
      store.addComment(makeComment("c1"));
      store.addComment(makeComment("c2"));
      expect(useDesignWorkspaceStore.getState().comments.map((c) => c.id)).toEqual(["c1", "c2"]);

      useDesignWorkspaceStore.getState().updateComment("c1", { text: "patched" });
      expect(useDesignWorkspaceStore.getState().comments[0]?.text).toBe("patched");

      useDesignWorkspaceStore.getState().resolveComment("c1");
      expect(useDesignWorkspaceStore.getState().comments[0]?.resolved).toBe(true);
      // Resolve toggles back.
      useDesignWorkspaceStore.getState().resolveComment("c1");
      expect(useDesignWorkspaceStore.getState().comments[0]?.resolved).toBe(false);

      useDesignWorkspaceStore.getState().removeComment("c1");
      expect(useDesignWorkspaceStore.getState().comments.map((c) => c.id)).toEqual(["c2"]);

      useDesignWorkspaceStore.getState().clearComments();
      expect(useDesignWorkspaceStore.getState().comments).toEqual([]);
    });

    it("FIFO cap drops oldest when exceeding MAX_COMMENTS", () => {
      const store = useDesignWorkspaceStore.getState();
      for (let i = 0; i < MAX_COMMENTS + 1; i += 1) {
        store.addComment(makeComment(`c${i}`));
      }
      const state = useDesignWorkspaceStore.getState();
      expect(state.comments.length).toBe(MAX_COMMENTS);
      expect(state.comments[0]?.id).toBe("c1");
    });

    it("markCommentsOrphaned toggles orphaned correctly", () => {
      const store = useDesignWorkspaceStore.getState();
      store.addComment(makeComment("c1"));
      store.addComment(makeComment("c2"));
      store.addComment(makeComment("c3"));

      // Unresolved set marks as stale.
      useDesignWorkspaceStore.getState().markCommentsOrphaned(["c1", "c2"], ["c3"]);
      const after1 = useDesignWorkspaceStore.getState().comments;
      expect(after1.find((c) => c.id === "c1")?.orphaned).toBe(true);
      expect(after1.find((c) => c.id === "c2")?.orphaned).toBe(true);
      // c3 was never marked orphaned, so resolved-set leaves it alone (undefined).
      expect(after1.find((c) => c.id === "c3")?.orphaned).toBeUndefined();

      // Re-ack with c1 resolved — clears stale flag explicitly to false.
      useDesignWorkspaceStore.getState().markCommentsOrphaned(["c2"], ["c1"]);
      const after2 = useDesignWorkspaceStore.getState().comments;
      expect(after2.find((c) => c.id === "c1")?.orphaned).toBe(false);
      expect(after2.find((c) => c.id === "c2")?.orphaned).toBe(true);
    });

    it("markCommentsOrphaned with empty arrays is a no-op", () => {
      const store = useDesignWorkspaceStore.getState();
      store.addComment(makeComment("c1"));
      const before = useDesignWorkspaceStore.getState().comments;
      useDesignWorkspaceStore.getState().markCommentsOrphaned([], []);
      // Same array reference — bail-out short-circuits the set() call.
      expect(useDesignWorkspaceStore.getState().comments).toBe(before);
    });
  });

  describe("active tool / inspector glue", () => {
    const cases: Array<{ tool: ActiveTool; inspectorEnabled: boolean }> = [
      { tool: null, inspectorEnabled: false },
      { tool: "inspect", inspectorEnabled: true },
      { tool: "measure", inspectorEnabled: false },
      { tool: "eyedropper", inspectorEnabled: false },
      { tool: "comment", inspectorEnabled: false },
    ];

    it("setActiveTool toggles inspectorEnabled for all 5 values", () => {
      for (const { tool, inspectorEnabled } of cases) {
        useDesignWorkspaceStore.getState().setActiveTool(tool);
        const state = useDesignWorkspaceStore.getState();
        expect(state.activeTool).toBe(tool);
        expect(state.inspectorEnabled).toBe(inspectorEnabled);
      }
    });

    it("toggleInspector round-trips through activeTool", () => {
      const initial = useDesignWorkspaceStore.getState();
      expect(initial.activeTool).toBeNull();
      expect(initial.inspectorEnabled).toBe(false);

      useDesignWorkspaceStore.getState().toggleInspector();
      const on = useDesignWorkspaceStore.getState();
      expect(on.activeTool).toBe("inspect");
      expect(on.inspectorEnabled).toBe(true);

      useDesignWorkspaceStore.getState().toggleInspector();
      const off = useDesignWorkspaceStore.getState();
      expect(off.activeTool).toBeNull();
      expect(off.inspectorEnabled).toBe(false);
    });
  });
});

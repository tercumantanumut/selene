/**
 * Reducer-level tests for the `markMeasurementsOrphaned` action.
 *
 * Mirrors the existing `markCommentsOrphaned` tests:
 *   - flips `orphaned` true for IDs in the unresolved set
 *   - clears `orphaned` (sets false) for IDs in the resolved set ONLY when
 *     they were previously orphaned, leaving never-orphaned entries alone
 *   - is a no-op (preserves array reference) when both sets are empty OR
 *     when the resulting entries are identical, so subscriber effects don't
 *     re-trigger on a redundant ack
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useDesignWorkspaceStore } from "@/lib/design/workspace/store";
import type { Measurement } from "@/lib/design/workspace/types";

function makeMeasurement(id: string): Measurement {
  return {
    id,
    from: { selector: `#a-${id}`, rect: { x: 0, y: 0, width: 10, height: 10 } },
    to: { selector: `#b-${id}`, rect: { x: 30, y: 30, width: 10, height: 10 } },
    distances: { dx: 30, dy: 30, horizontal: 20, vertical: 20, euclidean: 42.42 },
    createdAt: 1_700_000_000_000,
  };
}

describe("markMeasurementsOrphaned", () => {
  beforeEach(() => {
    useDesignWorkspaceStore.getState().reset();
  });

  it("toggles orphaned correctly for unresolved/resolved sets", () => {
    const store = useDesignWorkspaceStore.getState();
    store.addMeasurement(makeMeasurement("m1"));
    store.addMeasurement(makeMeasurement("m2"));
    store.addMeasurement(makeMeasurement("m3"));

    useDesignWorkspaceStore.getState().markMeasurementsOrphaned(["m1", "m2"], ["m3"]);
    const after1 = useDesignWorkspaceStore.getState().measurements;
    expect(after1.find((m) => m.id === "m1")?.orphaned).toBe(true);
    expect(after1.find((m) => m.id === "m2")?.orphaned).toBe(true);
    // m3 was never orphaned, so the resolved-set leaves it alone.
    expect(after1.find((m) => m.id === "m3")?.orphaned).toBeUndefined();

    // Re-ack: m1 now resolves again — explicit transition to `false`.
    useDesignWorkspaceStore.getState().markMeasurementsOrphaned(["m2"], ["m1"]);
    const after2 = useDesignWorkspaceStore.getState().measurements;
    expect(after2.find((m) => m.id === "m1")?.orphaned).toBe(false);
    expect(after2.find((m) => m.id === "m2")?.orphaned).toBe(true);
  });

  it("is a no-op (preserves array reference) when both sets are empty", () => {
    const store = useDesignWorkspaceStore.getState();
    store.addMeasurement(makeMeasurement("m1"));
    const before = useDesignWorkspaceStore.getState().measurements;
    useDesignWorkspaceStore.getState().markMeasurementsOrphaned([], []);
    expect(useDesignWorkspaceStore.getState().measurements).toBe(before);
  });

  it("preserves array reference when ack does not change any entry", () => {
    const store = useDesignWorkspaceStore.getState();
    store.addMeasurement(makeMeasurement("m1"));
    store.addMeasurement(makeMeasurement("m2"));

    // First ack flips m1 to orphaned. Second redundant ack should not
    // produce a new array (ref-equal), since the state would be identical.
    useDesignWorkspaceStore.getState().markMeasurementsOrphaned(["m1"], []);
    const ref1 = useDesignWorkspaceStore.getState().measurements;
    useDesignWorkspaceStore.getState().markMeasurementsOrphaned(["m1"], []);
    const ref2 = useDesignWorkspaceStore.getState().measurements;
    expect(ref2).toBe(ref1);
  });

  it("applies ack correctly even when activeTool was cleared in the meantime", () => {
    // Race coverage: the iframe acks resolution AFTER the user has switched
    // away from the measure tool. The ack pipeline must still update the
    // orphaned flags — measurement persistence is independent of activeTool.
    const store = useDesignWorkspaceStore.getState();
    store.addMeasurement(makeMeasurement("m1"));
    store.addMeasurement(makeMeasurement("m2"));

    // User picks the tool, draws, then switches back to null.
    useDesignWorkspaceStore.getState().setActiveTool("measure");
    useDesignWorkspaceStore.getState().setActiveTool(null);
    expect(useDesignWorkspaceStore.getState().activeTool).toBeNull();

    // Ack arrives after the tool switch — m1 unresolved, m2 resolved.
    useDesignWorkspaceStore
      .getState()
      .markMeasurementsOrphaned(["m1"], ["m2"]);

    const after = useDesignWorkspaceStore.getState().measurements;
    expect(after.find((m) => m.id === "m1")?.orphaned).toBe(true);
    // m2 was never orphaned, so resolved-set leaves it alone (false-flip
    // only happens when previously orphaned). The reducer doesn't mutate a
    // never-orphaned entry.
    expect(after.find((m) => m.id === "m2")?.orphaned).toBeUndefined();

    // Now flip m2 to orphaned then resolve, to confirm the resolved-set
    // does correctly clear once it was previously set, even with no tool.
    useDesignWorkspaceStore.getState().markMeasurementsOrphaned(["m2"], []);
    expect(
      useDesignWorkspaceStore
        .getState()
        .measurements.find((m) => m.id === "m2")?.orphaned,
    ).toBe(true);
    useDesignWorkspaceStore.getState().markMeasurementsOrphaned([], ["m2"]);
    expect(
      useDesignWorkspaceStore
        .getState()
        .measurements.find((m) => m.id === "m2")?.orphaned,
    ).toBe(false);
  });
});

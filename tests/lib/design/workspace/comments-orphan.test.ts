/**
 * Reducer-level tests for `markCommentsOrphaned`. Mirrors
 * `measurements-orphan.test.ts` — the two reducers share identical
 * change-detection semantics, and we want the regression coverage on both
 * sides so a future tweak to one doesn't silently desync the other.
 *
 * Specifically we cover the no-op short-circuit added in this iteration:
 * a redundant ack from the iframe (same orphaned/resolved sets again) MUST
 * preserve the array reference so subscriber effects don't re-trigger and
 * loop the diff back into another sync.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useDesignWorkspaceStore } from "@/lib/design/workspace/store";
import type { DesignComment } from "@/lib/design/workspace/types";

function makeComment(id: string): DesignComment {
  return {
    id,
    elementSelector: `#el-${id}`,
    text: `comment ${id}`,
    createdAt: 1_700_000_000_000,
    resolved: false,
  };
}

describe("markCommentsOrphaned", () => {
  beforeEach(() => {
    useDesignWorkspaceStore.getState().reset();
  });

  it("toggles orphaned correctly for unresolved/resolved sets", () => {
    const store = useDesignWorkspaceStore.getState();
    store.addComment(makeComment("c1"));
    store.addComment(makeComment("c2"));
    store.addComment(makeComment("c3"));

    useDesignWorkspaceStore.getState().markCommentsOrphaned(["c1", "c2"], ["c3"]);
    const after1 = useDesignWorkspaceStore.getState().comments;
    expect(after1.find((c) => c.id === "c1")?.orphaned).toBe(true);
    expect(after1.find((c) => c.id === "c2")?.orphaned).toBe(true);
    // c3 was never orphaned, so resolved-set leaves it alone.
    expect(after1.find((c) => c.id === "c3")?.orphaned).toBeUndefined();

    // Re-ack: c1 now resolves again — explicit transition to `false`.
    useDesignWorkspaceStore.getState().markCommentsOrphaned(["c2"], ["c1"]);
    const after2 = useDesignWorkspaceStore.getState().comments;
    expect(after2.find((c) => c.id === "c1")?.orphaned).toBe(false);
    expect(after2.find((c) => c.id === "c2")?.orphaned).toBe(true);
  });

  it("is a no-op (preserves array reference) when both sets are empty", () => {
    const store = useDesignWorkspaceStore.getState();
    store.addComment(makeComment("c1"));
    const before = useDesignWorkspaceStore.getState().comments;
    useDesignWorkspaceStore.getState().markCommentsOrphaned([], []);
    expect(useDesignWorkspaceStore.getState().comments).toBe(before);
  });

  it("preserves array reference when ack does not change any entry", () => {
    const store = useDesignWorkspaceStore.getState();
    store.addComment(makeComment("c1"));
    store.addComment(makeComment("c2"));

    // First ack flips c1 to orphaned. Second redundant ack must NOT produce
    // a new array reference — without the no-op short-circuit, the
    // subscriber effect keeps re-firing on every redundant ack, looping the
    // diff back through the sync queue.
    useDesignWorkspaceStore.getState().markCommentsOrphaned(["c1"], []);
    const ref1 = useDesignWorkspaceStore.getState().comments;
    useDesignWorkspaceStore.getState().markCommentsOrphaned(["c1"], []);
    const ref2 = useDesignWorkspaceStore.getState().comments;
    expect(ref2).toBe(ref1);
  });
});

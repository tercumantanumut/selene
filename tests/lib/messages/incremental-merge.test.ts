import { describe, expect, it } from "vitest";
import {
  mergeIncrementalMessages,
  reuseUnchangedUIMessages,
} from "@/lib/messages/incremental-merge";

type Row = { id: string; role: string; v: number };
const row = (id: string, v = 1, role = "assistant"): Row => ({ id, role, v });
const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id, r]));

describe("mergeIncrementalMessages", () => {
  it("keeps cached row identity and swaps in changed rows in server order", () => {
    const a = row("a");
    const b = row("b");
    const b2 = row("b", 2);
    const c = row("c");

    const merged = mergeIncrementalMessages(byId([a, b]), ["a", "b", "c"], [b2, c]);

    expect(merged).toEqual([a, b2, c]);
    expect(merged?.[0]).toBe(a);
    expect(merged?.[1]).toBe(b2);
  });

  it("drops rows the server no longer lists", () => {
    const a = row("a");
    const b = row("b");
    expect(mergeIncrementalMessages(byId([a, b]), ["b"], [])).toEqual([b]);
  });

  it("returns null when an id is neither cached nor changed", () => {
    expect(mergeIncrementalMessages(byId([row("a")]), ["a", "x"], [])).toBeNull();
  });
});

describe("reuseUnchangedUIMessages", () => {
  const ui = (id: string, tag: string) => ({ id, tag });

  it("reuses UI objects whose rows are identical to the applied ones", () => {
    const a = row("a");
    const b = row("b");
    const b2 = row("b", 2);
    const prevA = ui("a", "prev");
    const prevB = ui("b", "prev");

    const result = reuseUnchangedUIMessages(
      [ui("a", "next"), ui("b", "next")],
      [a, b2],
      byId([a, b]),
      new Map([["a", prevA], ["b", prevB]])
    );

    expect(result[0]).toBe(prevA);
    expect(result[1]).toEqual(ui("b", "next"));
  });

  it("reuses nothing when a tool row changed", () => {
    const a = row("a");
    const tool = row("t", 1, "tool");
    const tool2 = row("t", 2, "tool");
    const prevA = ui("a", "prev");
    const nextA = ui("a", "next");

    const result = reuseUnchangedUIMessages(
      [nextA],
      [a, tool2],
      byId([a, tool]),
      new Map([["a", prevA]])
    );

    expect(result[0]).toBe(nextA);
  });

  it("reuses nothing when a tool row was removed", () => {
    const a = row("a");
    const nextA = ui("a", "next");

    const result = reuseUnchangedUIMessages(
      [nextA],
      [a],
      byId([a, row("t", 1, "tool")]),
      new Map([["a", ui("a", "prev")]])
    );

    expect(result[0]).toBe(nextA);
  });
});

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";

import {
  InMemoryContentStore,
  setContentStoreForTesting,
  storeFullContent,
} from "@/lib/ai/truncated-content-store";
import { executeRetrieveFullContent } from "@/lib/ai/tools/retrieve-full-content-tool";

describe("retrieveFullContent tool — range-first retrieval", () => {
  let inMemory: InMemoryContentStore;

  beforeEach(() => {
    inMemory = new InMemoryContentStore();
    setContentStoreForTesting(inMemory);
  });

  afterEach(() => {
    setContentStoreForTesting(null);
  });

  afterAll(() => {
    setContentStoreForTesting(null);
  });

  it("uses range when legacy slice fields are also present", async () => {
    const id = storeFullContent("sess-conflict", "test", "line1\nline2\nline3", 10);
    expect(id).not.toBeNull();

    const result = await executeRetrieveFullContent(
      { sessionId: "sess-conflict" },
      { contentId: id!, head: 2, range: [1, 3] }
    );

    expect(result).toMatchObject({ status: "success", mode: "range" });
    expect((result as Record<string, unknown>).content).toBe("line1\nline2\nline3");
  });

  it("lets valid range win over all legacy slice fields", async () => {
    const id = storeFullContent("sess-all", "test", "alpha\nbeta\ngamma", 10);
    expect(id).not.toBeNull();

    const result = await executeRetrieveFullContent(
      { sessionId: "sess-all" },
      { contentId: id!, head: 1, tail: 1, range: [1, 2], grep: "alpha" }
    );

    expect(result).toMatchObject({ status: "success", mode: "range" });
    expect((result as Record<string, unknown>).content).toBe("alpha\nbeta");
  });

  it("allows a single slice parameter (head)", async () => {
    const id = storeFullContent("sess-ok", "test", "a\nb\nc\nd\ne", 10);
    expect(id).not.toBeNull();

    const result = await executeRetrieveFullContent(
      { sessionId: "sess-ok" },
      { contentId: id!, head: 2 }
    );

    expect(result).toMatchObject({ status: "success" });
    expect((result as Record<string, unknown>).content).toBe("a\nb");
  });

  it("allows no slice parameters (defaults to head preview)", async () => {
    const id = storeFullContent("sess-default", "test", "x\ny\nz", 10);
    expect(id).not.toBeNull();

    const result = await executeRetrieveFullContent(
      { sessionId: "sess-default" },
      { contentId: id! }
    );

    expect(result).toMatchObject({ status: "success" });
  });

  it("ignores empty grep string when checking conflicts", async () => {
    const id = storeFullContent("sess-empty-grep", "test", "foo\nbar", 10);
    expect(id).not.toBeNull();

    const result = await executeRetrieveFullContent(
      { sessionId: "sess-empty-grep" },
      { contentId: id!, head: 1, grep: "" }
    );

    // Empty grep is ignored, so only head is active — no conflict.
    expect(result).toMatchObject({ status: "success" });
  });

  it("ignores UI placeholder slice values when a real slice is present", async () => {
    const id = storeFullContent("sess-ui-placeholders", "test", "one\ntwo\nthree", 10);
    expect(id).not.toBeNull();

    const result = await executeRetrieveFullContent(
      { sessionId: "sess-ui-placeholders" },
      {
        contentId: id!,
        head: 2,
        tail: 0,
        range: [0, 0],
        grep: "",
      }
    );

    expect(result).toMatchObject({ status: "success", mode: "head" });
    expect((result as Record<string, unknown>).content).toBe("one\ntwo");
  });

  it("defaults to head preview when only UI placeholder slice values are sent", async () => {
    const id = storeFullContent("sess-ui-only-placeholders", "test", "one\ntwo\nthree", 10);
    expect(id).not.toBeNull();

    const result = await executeRetrieveFullContent(
      { sessionId: "sess-ui-only-placeholders" },
      {
        contentId: id!,
        tail: 0,
        range: [0, 0],
        grep: "",
      }
    );

    expect(result).toMatchObject({ status: "success", mode: "default" });
  });
});

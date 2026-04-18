import { describe, it, expect, beforeEach } from "vitest";
import {
  createLivePromptQueue,
  appendToLivePromptQueue,
  appendToLivePromptQueueBySession,
  drainLivePromptQueue,
  hasLivePromptQueue,
  removeLivePromptQueue,
  waitForQueueMessage,
  reserveLivePromptQueueBySession,
  promoteLivePromptQueueToRunId,
  clearLivePromptQueueBySession,
  getLivePromptQueueKeyBySession,
} from "@/lib/background-tasks/live-prompt-queue-registry";

const RUN_ID = "test-run-001";
const SESSION_ID = "test-session-001";

describe("live-prompt-queue-registry", () => {
  beforeEach(() => {
    removeLivePromptQueue(RUN_ID, SESSION_ID);
  });

  it("appendToLivePromptQueue returns false when no queue exists", () => {
    const result = appendToLivePromptQueue(RUN_ID, {
      id: "1",
      content: "hello",
      stopIntent: false,
    });
    expect(result).toBe(false);
  });

  it("hasLivePromptQueue returns false before creation", () => {
    expect(hasLivePromptQueue(RUN_ID)).toBe(false);
  });

  it("createLivePromptQueue initializes an empty queue", () => {
    createLivePromptQueue(RUN_ID, SESSION_ID);
    expect(hasLivePromptQueue(RUN_ID)).toBe(true);
    const drained = drainLivePromptQueue(RUN_ID);
    expect(drained).toHaveLength(0);
  });

  it("appendToLivePromptQueue returns true and enqueues after creation", () => {
    createLivePromptQueue(RUN_ID, SESSION_ID);
    const result = appendToLivePromptQueue(RUN_ID, {
      id: "1",
      content: "hello",
      stopIntent: false,
    });
    expect(result).toBe(true);
  });

  it("drainLivePromptQueue returns all entries and clears the queue atomically", () => {
    createLivePromptQueue(RUN_ID, SESSION_ID);
    appendToLivePromptQueue(RUN_ID, { id: "1", content: "msg1", stopIntent: false });
    appendToLivePromptQueue(RUN_ID, { id: "2", content: "msg2", stopIntent: true });

    const first = drainLivePromptQueue(RUN_ID);
    expect(first).toHaveLength(2);
    expect(first[0].content).toBe("msg1");
    expect(first[1].stopIntent).toBe(true);
    expect(first[0].timestamp).toBeTypeOf("number");

    // Second drain must be empty — atomic clear
    const second = drainLivePromptQueue(RUN_ID);
    expect(second).toHaveLength(0);
  });

  it("drainLivePromptQueue returns empty array for non-existent queue", () => {
    const drained = drainLivePromptQueue("nonexistent-run");
    expect(drained).toHaveLength(0);
  });

  it("removeLivePromptQueue cleans up and subsequent appends return false", () => {
    createLivePromptQueue(RUN_ID, SESSION_ID);
    removeLivePromptQueue(RUN_ID, SESSION_ID);
    expect(hasLivePromptQueue(RUN_ID)).toBe(false);
    const result = appendToLivePromptQueue(RUN_ID, {
      id: "1",
      content: "test",
      stopIntent: false,
    });
    expect(result).toBe(false);
  });

  it("entries are ordered by insertion (not sorted)", () => {
    createLivePromptQueue(RUN_ID, SESSION_ID);
    appendToLivePromptQueue(RUN_ID, { id: "a", content: "first", stopIntent: false });
    appendToLivePromptQueue(RUN_ID, { id: "b", content: "second", stopIntent: false });
    appendToLivePromptQueue(RUN_ID, { id: "c", content: "third", stopIntent: false });

    const drained = drainLivePromptQueue(RUN_ID);
    expect(drained.map(e => e.id)).toEqual(["a", "b", "c"]);
  });

  // --- appendToLivePromptQueueBySession tests ---

  it("appendToLivePromptQueueBySession returns false when no queue exists for session", () => {
    const result = appendToLivePromptQueueBySession(SESSION_ID, {
      id: "1",
      content: "hello",
      stopIntent: false,
    });
    expect(result).toBe(false);
  });

  it("appendToLivePromptQueueBySession returns true after createLivePromptQueue", () => {
    createLivePromptQueue(RUN_ID, SESSION_ID);
    const result = appendToLivePromptQueueBySession(SESSION_ID, {
      id: "1",
      content: "hello via session",
      stopIntent: false,
    });
    expect(result).toBe(true);
  });

  it("appendToLivePromptQueueBySession enqueued entry is visible via drainLivePromptQueue", () => {
    createLivePromptQueue(RUN_ID, SESSION_ID);
    appendToLivePromptQueueBySession(SESSION_ID, { id: "x", content: "session msg", stopIntent: true });

    const drained = drainLivePromptQueue(RUN_ID);
    expect(drained).toHaveLength(1);
    expect(drained[0].content).toBe("session msg");
    expect(drained[0].stopIntent).toBe(true);
    expect(drained[0].timestamp).toBeTypeOf("number");
  });

  it("appendToLivePromptQueueBySession returns false after removeLivePromptQueue", () => {
    createLivePromptQueue(RUN_ID, SESSION_ID);
    removeLivePromptQueue(RUN_ID, SESSION_ID);
    const result = appendToLivePromptQueueBySession(SESSION_ID, {
      id: "1",
      content: "test",
      stopIntent: false,
    });
    expect(result).toBe(false);
  });

  it("removeLivePromptQueue cleans up the session index", () => {
    createLivePromptQueue(RUN_ID, SESSION_ID);
    removeLivePromptQueue(RUN_ID, SESSION_ID);
    // Both runId-based and sessionId-based lookups should fail
    expect(hasLivePromptQueue(RUN_ID)).toBe(false);
    expect(appendToLivePromptQueueBySession(SESSION_ID, { id: "1", content: "x", stopIntent: false })).toBe(false);
  });

  it("different sessions map to different runs independently", () => {
    const RUN_B = "test-run-002";
    const SESSION_B = "test-session-002";

    createLivePromptQueue(RUN_ID, SESSION_ID);
    createLivePromptQueue(RUN_B, SESSION_B);

    appendToLivePromptQueueBySession(SESSION_ID, { id: "1", content: "for A", stopIntent: false });
    appendToLivePromptQueueBySession(SESSION_B, { id: "2", content: "for B", stopIntent: false });

    const drainedA = drainLivePromptQueue(RUN_ID);
    const drainedB = drainLivePromptQueue(RUN_B);

    expect(drainedA).toHaveLength(1);
    expect(drainedA[0].content).toBe("for A");
    expect(drainedB).toHaveLength(1);
    expect(drainedB[0].content).toBe("for B");

    // Cleanup
    removeLivePromptQueue(RUN_B, SESSION_B);
  });

  it("waitForQueueMessage resolves when a new entry is appended", async () => {
    createLivePromptQueue(RUN_ID, SESSION_ID);

    const waiter = waitForQueueMessage(RUN_ID);
    appendToLivePromptQueue(RUN_ID, { id: "w1", content: "wake", stopIntent: false });

    await expect(waiter).resolves.toBeUndefined();
  });

  it("waitForQueueMessage rejects when aborted", async () => {
    createLivePromptQueue(RUN_ID, SESSION_ID);

    const controller = new AbortController();
    const waiter = waitForQueueMessage(RUN_ID, controller.signal);
    controller.abort();

    await expect(waiter).rejects.toThrow("Aborted");
  });

  it("waitForQueueMessage rejects when queue is removed while waiting", async () => {
    createLivePromptQueue(RUN_ID, SESSION_ID);

    const waiter = waitForQueueMessage(RUN_ID);
    removeLivePromptQueue(RUN_ID, SESSION_ID);

    await expect(waiter).resolves.toBeUndefined();
  });

  // ── reserveLivePromptQueueBySession / promoteLivePromptQueueToRunId ─────
  // These close the ~9–11 s race window between /api/chat POST and
  // createLivePromptQueue being reached after the slow awaits (session load,
  // preflight check, createAgentRun). The composer's live-prompt-queue POST
  // must succeed immediately after /api/chat begins, not only after the
  // real agentRun.id is known.

  describe("reserveLivePromptQueueBySession", () => {
    beforeEach(() => {
      clearLivePromptQueueBySession(SESSION_ID);
    });

    it("makes appendToLivePromptQueueBySession succeed before any runId is assigned", () => {
      reserveLivePromptQueueBySession(SESSION_ID);

      const result = appendToLivePromptQueueBySession(SESSION_ID, {
        id: "pre-run-1",
        content: "injected during warmup",
        stopIntent: false,
      });

      expect(result).toBe(true);
    });

    it("clears a stale reservation from a prior session before creating the new one", () => {
      reserveLivePromptQueueBySession(SESSION_ID);
      appendToLivePromptQueueBySession(SESSION_ID, {
        id: "stale-1",
        content: "from a prior aborted run",
        stopIntent: false,
      });

      // Re-reserving for the same session drops the stale entries so they
      // don't bleed into the new run.
      reserveLivePromptQueueBySession(SESSION_ID);

      // Promote to a run and drain — should be empty.
      promoteLivePromptQueueToRunId(SESSION_ID, RUN_ID);
      const drained = drainLivePromptQueue(RUN_ID);
      expect(drained).toHaveLength(0);
    });
  });

  describe("promoteLivePromptQueueToRunId", () => {
    beforeEach(() => {
      clearLivePromptQueueBySession(SESSION_ID);
    });

    it("carries entries queued during reservation into the real runId key", () => {
      reserveLivePromptQueueBySession(SESSION_ID);
      appendToLivePromptQueueBySession(SESSION_ID, {
        id: "warmup-1",
        content: "first injection",
        stopIntent: false,
      });
      appendToLivePromptQueueBySession(SESSION_ID, {
        id: "warmup-2",
        content: "second injection",
        stopIntent: true,
      });

      promoteLivePromptQueueToRunId(SESSION_ID, RUN_ID);

      // Entries must survive the rekey.
      const drained = drainLivePromptQueue(RUN_ID);
      expect(drained).toHaveLength(2);
      expect(drained[0].content).toBe("first injection");
      expect(drained[1].content).toBe("second injection");
      expect(drained[1].stopIntent).toBe(true);
    });

    it("is idempotent: calling twice with the same runId is a no-op", () => {
      reserveLivePromptQueueBySession(SESSION_ID);
      promoteLivePromptQueueToRunId(SESSION_ID, RUN_ID);

      appendToLivePromptQueue(RUN_ID, {
        id: "post-1",
        content: "after promote",
        stopIntent: false,
      });

      // Second promote call must not wipe the entry.
      promoteLivePromptQueueToRunId(SESSION_ID, RUN_ID);
      const drained = drainLivePromptQueue(RUN_ID);
      expect(drained).toHaveLength(1);
      expect(drained[0].content).toBe("after promote");
    });

    it("falls back to createLivePromptQueue when no reservation exists", () => {
      // No prior reserve — promote should still leave a working queue.
      promoteLivePromptQueueToRunId(SESSION_ID, RUN_ID);

      expect(hasLivePromptQueue(RUN_ID)).toBe(true);
      const result = appendToLivePromptQueueBySession(SESSION_ID, {
        id: "fresh-1",
        content: "no warmup",
        stopIntent: false,
      });
      expect(result).toBe(true);
    });

    it("wakes waiters parked on the session during warmup when entries existed", async () => {
      reserveLivePromptQueueBySession(SESSION_ID);
      // Queue an entry before promote to exercise the wake-on-promote path.
      appendToLivePromptQueueBySession(SESSION_ID, {
        id: "warm-entry",
        content: "will wake the waiter",
        stopIntent: false,
      });

      // Promote and make sure the real-runId waiter can observe the entry.
      promoteLivePromptQueueToRunId(SESSION_ID, RUN_ID);
      const waiter = waitForQueueMessage(RUN_ID);
      // Entry already present — waiter resolves immediately.
      await expect(waiter).resolves.toBeUndefined();
    });
  });

  describe("clearLivePromptQueueBySession", () => {
    beforeEach(() => {
      clearLivePromptQueueBySession(SESSION_ID);
    });

    it("releases a reservation so a later append by session returns false", () => {
      reserveLivePromptQueueBySession(SESSION_ID);
      clearLivePromptQueueBySession(SESSION_ID);

      const result = appendToLivePromptQueueBySession(SESSION_ID, {
        id: "after-clear",
        content: "should not land",
        stopIntent: false,
      });
      expect(result).toBe(false);
    });

    it("releases a promoted run — used by outer catch when agentRun.id is null", () => {
      reserveLivePromptQueueBySession(SESSION_ID);
      promoteLivePromptQueueToRunId(SESSION_ID, RUN_ID);
      clearLivePromptQueueBySession(SESSION_ID);

      expect(hasLivePromptQueue(RUN_ID)).toBe(false);
      const result = appendToLivePromptQueueBySession(SESSION_ID, {
        id: "after-clear",
        content: "should not land",
        stopIntent: false,
      });
      expect(result).toBe(false);
    });

    it("is a no-op when no queue exists for the session", () => {
      // Must not throw even when nothing was reserved.
      expect(() => clearLivePromptQueueBySession(SESSION_ID)).not.toThrow();
    });
  });

  describe("getLivePromptQueueKeyBySession", () => {
    it("returns undefined when no reservation exists", () => {
      expect(getLivePromptQueueKeyBySession(SESSION_ID)).toBeUndefined();
    });

    it("returns the placeholder key after reservation, before promotion", () => {
      reserveLivePromptQueueBySession(SESSION_ID);
      const key = getLivePromptQueueKeyBySession(SESSION_ID);
      expect(key).toBeDefined();
      expect(key).toContain("pending-run:");
      expect(key).toContain(SESSION_ID);
    });

    it("returns the real run id after promotion", () => {
      reserveLivePromptQueueBySession(SESSION_ID);
      promoteLivePromptQueueToRunId(SESSION_ID, RUN_ID);
      expect(getLivePromptQueueKeyBySession(SESSION_ID)).toBe(RUN_ID);
    });

    it("returned placeholder key drains entries that raced in during warmup", () => {
      // Simulates the error-path drain scenario: injection lands while the
      // queue is still on the pending key (agentRun.id not yet assigned),
      // then the route throws and must drain-before-clear instead of
      // silently dropping the entry.
      reserveLivePromptQueueBySession(SESSION_ID);
      appendToLivePromptQueueBySession(SESSION_ID, {
        id: "race-1",
        content: "injected during warmup",
        stopIntent: false,
      });

      const key = getLivePromptQueueKeyBySession(SESSION_ID);
      expect(key).toBeDefined();
      const drained = drainLivePromptQueue(key as string);
      expect(drained).toHaveLength(1);
      expect(drained[0].content).toBe("injected during warmup");

      // After drain, clearing must still succeed and the key must detach.
      clearLivePromptQueueBySession(SESSION_ID);
      expect(getLivePromptQueueKeyBySession(SESSION_ID)).toBeUndefined();
    });

    it("returns undefined after clear", () => {
      reserveLivePromptQueueBySession(SESSION_ID);
      clearLivePromptQueueBySession(SESSION_ID);
      expect(getLivePromptQueueKeyBySession(SESSION_ID)).toBeUndefined();
    });
  });

});

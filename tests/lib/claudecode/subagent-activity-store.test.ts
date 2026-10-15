import { beforeEach, describe, expect, it } from "vitest";
import {
  clearClaudeCodeSubagentActivityForTests,
  flushPendingSubagentWrites,
  getClaudeCodeSubagentSnapshot,
  recordClaudeCodeSubagentActivity,
  recordClaudeCodeSubagentFinished,
  recordClaudeCodeSubagentStarted,
  subscribeToClaudeCodeSubagentActivity,
} from "@/lib/claudecode/subagent-activity-store";
import { getRawSqlite } from "@/lib/db/sqlite-client";

describe("Claude Code native sub-agent activity store", () => {
  beforeEach(() => {
    clearClaudeCodeSubagentActivityForTests();
  });

  it("records start, live nested activity, and completion", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeToClaudeCodeSubagentActivity({ userId: "u1", sessionId: "s1" }, (event) => {
      seen.push(event.type);
    });

    recordClaudeCodeSubagentStarted({
      userId: "u1",
      sessionId: "s1",
      runId: "r1",
      parentToolUseId: "toolu_1",
      subagentType: "general-purpose",
      description: "probe native stream",
    });
    recordClaudeCodeSubagentActivity({
      userId: "u1",
      sessionId: "s1",
      parentToolUseId: "toolu_1",
      summary: "nested text delta",
      toolName: "Read",
      streamEvent: true,
    });
    recordClaudeCodeSubagentFinished({
      userId: "u1",
      sessionId: "s1",
      parentToolUseId: "toolu_1",
      summary: "done",
    });

    const snapshot = getClaudeCodeSubagentSnapshot({ userId: "u1", sessionId: "s1" });
    expect(snapshot.activities).toHaveLength(1);
    expect(snapshot.activities[0].status).toBe("completed");
    expect(snapshot.activities[0].streamAvailability).toBe("available");
    expect(snapshot.eventsByActivityId[snapshot.activities[0].id].map((event) => event.type)).toEqual([
      "subagent-started",
      "subagent-activity",
      "subagent-completed",
    ]);
    expect(seen).toEqual(["subagent-started", "subagent-activity", "subagent-completed"]);

    unsubscribe();
  });

  it("marks stream unavailable when no nested activity arrives", () => {
    recordClaudeCodeSubagentStarted({
      userId: "u1",
      sessionId: "s1",
      parentToolUseId: "toolu_2",
      description: "fallback probe",
    });

    recordClaudeCodeSubagentActivity({
      userId: "u1",
      sessionId: "s1",
      parentToolUseId: "toolu_2",
      type: "stream-unavailable",
      summary: "Live nested stream is unavailable; waiting for Claude Code completion.",
    });

    const snapshot = getClaudeCodeSubagentSnapshot({ userId: "u1", sessionId: "s1" });
    expect(snapshot.activities[0].streamAvailability).toBe("unavailable");
    expect(snapshot.eventsByActivityId[snapshot.activities[0].id].some((event) => event.type === "stream-unavailable")).toBe(true);
  });

  it("batches writes into one flush and trims finished history to the cap", () => {
    const sqlite = getRawSqlite();
    const countEvents = () =>
      (sqlite.prepare("SELECT COUNT(*) AS n FROM claudecode_subagent_events").get() as { n: number }).n;

    recordClaudeCodeSubagentStarted({
      userId: "u-batch",
      sessionId: "s-batch",
      parentToolUseId: "toolu_batch",
      description: "batched",
    });
    for (let i = 0; i < 200; i++) {
      recordClaudeCodeSubagentActivity({
        userId: "u-batch",
        sessionId: "s-batch",
        parentToolUseId: "toolu_batch",
        summary: `delta ${i}`,
        streamEvent: true,
      });
    }

    // Nothing written until the queue flushes.
    expect(countEvents()).toBe(0);
    flushPendingSubagentWrites();
    expect(countEvents()).toBe(201);

    recordClaudeCodeSubagentFinished({
      userId: "u-batch",
      sessionId: "s-batch",
      parentToolUseId: "toolu_batch",
      summary: "done",
    });
    flushPendingSubagentWrites();
    expect(countEvents()).toBe(160);

    const snapshot = getClaudeCodeSubagentSnapshot({ userId: "u-batch", sessionId: "s-batch" });
    const events = snapshot.eventsByActivityId[snapshot.activities[0].id];
    expect(events).toHaveLength(160);
    expect(events.at(-1)?.type).toBe("subagent-completed");
  });
});

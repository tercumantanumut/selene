import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearClaudeCodeSubagentActivityForTests,
  getClaudeCodeSubagentSnapshot,
  recordClaudeCodeSubagentActivity,
  recordClaudeCodeSubagentFinished,
  recordClaudeCodeSubagentStarted,
  subscribeToClaudeCodeSubagentActivity,
} from "@/lib/claudecode/subagent-activity-store";

describe("Claude Code native sub-agent activity store", () => {
  beforeEach(() => {
    clearClaudeCodeSubagentActivityForTests();
    vi.useFakeTimers();
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

    vi.advanceTimersByTime(5_001);

    const snapshot = getClaudeCodeSubagentSnapshot({ userId: "u1", sessionId: "s1" });
    expect(snapshot.activities[0].streamAvailability).toBe("unavailable");
    expect(snapshot.eventsByActivityId[snapshot.activities[0].id].some((event) => event.type === "stream-unavailable")).toBe(true);
  });
});

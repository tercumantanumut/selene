import { describe, expect, it } from "vitest";
import type { ChatTask } from "@/lib/background-tasks/types";
import { selectVisibleActiveTasks } from "@/lib/background-tasks/visible-active-tasks";

function chatTask(input: {
  runId: string;
  sessionId: string;
  characterId: string;
  metadata?: Record<string, unknown>;
}): ChatTask {
  return {
    type: "chat",
    runId: input.runId,
    userId: "user-1",
    characterId: input.characterId,
    sessionId: input.sessionId,
    status: "running",
    startedAt: "2026-06-04T12:00:00.000Z",
    pipelineName: "chat",
    triggerType: input.metadata?.isDelegation === true ? "delegation" : "chat",
    metadata: input.metadata,
  };
}

describe("selectVisibleActiveTasks", () => {
  it("hides delegated child chat rows when their initiator session has a visible active task", () => {
    const parent = chatTask({
      runId: "run-parent",
      sessionId: "session-parent",
      characterId: "agent-parent",
    });
    const delegateA = chatTask({
      runId: "run-delegate-a",
      sessionId: "session-delegate-a",
      characterId: "agent-a",
      metadata: {
        isDelegation: true,
        parentAgentId: "agent-parent",
        initiatorSessionId: "session-parent",
        characterName: "Explore",
      },
    });
    const delegateB = chatTask({
      runId: "run-delegate-b",
      sessionId: "session-delegate-b",
      characterId: "agent-b",
      metadata: {
        isDelegation: true,
        parentAgentId: "agent-parent",
        initiatorSessionId: "session-parent",
        characterName: "Plan",
      },
    });

    expect(selectVisibleActiveTasks([parent, delegateA, delegateB]).map((task) => task.runId)).toEqual([
      "run-parent",
    ]);
  });

  it("keeps delegated rows when there is no parent/root task row representing them", () => {
    const delegate = chatTask({
      runId: "run-delegate",
      sessionId: "session-delegate",
      characterId: "agent-a",
      metadata: {
        isDelegation: true,
        parentAgentId: "agent-parent",
        initiatorSessionId: "session-parent",
        characterName: "Explore",
      },
    });

    expect(selectVisibleActiveTasks([delegate]).map((task) => task.runId)).toEqual(["run-delegate"]);
  });

  it("keeps unrelated delegated rows for other active sessions", () => {
    const parent = chatTask({
      runId: "run-parent",
      sessionId: "session-parent",
      characterId: "agent-parent",
    });
    const unrelatedDelegate = chatTask({
      runId: "run-unrelated-delegate",
      sessionId: "session-delegate-other",
      characterId: "agent-other",
      metadata: {
        isDelegation: true,
        parentAgentId: "agent-other-parent",
        initiatorSessionId: "session-other-parent",
        characterName: "Backend",
      },
    });

    expect(selectVisibleActiveTasks([parent, unrelatedDelegate]).map((task) => task.runId)).toEqual([
      "run-parent",
      "run-unrelated-delegate",
    ]);
  });
});

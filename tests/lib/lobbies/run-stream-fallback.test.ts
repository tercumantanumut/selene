import { describe, expect, it } from "vitest";

import type { TaskEvent } from "@/lib/background-tasks/types";
import {
  inferLobbyLevelRoleForEvent,
  type RunStreamState,
} from "@/lib/lobbies/client/run-stream";

function progressEvent(runId: string): TaskEvent {
  return {
    eventType: "task:progress",
    runId,
    type: "chat",
    userId: "user-1",
    lobbyId: "lobby-1",
    timestamp: "2026-04-28T00:00:00.000Z",
  };
}

describe("inferLobbyLevelRoleForEvent", () => {
  it("routes reconnect-only synthesis events from the persisted synthesisRunId", () => {
    expect(
      inferLobbyLevelRoleForEvent({
        event: progressEvent("synthesis-run-1"),
        existingByRole: new Map(),
        synthesisRunId: "synthesis-run-1",
      }),
    ).toBe("synthesizer");
  });

  it("prefers existing run slots before synthesisRunId fallback", () => {
    const plannerState: RunStreamState = {
      runId: "synthesis-run-1",
      phase: "running",
      fragments: [],
      lastEventAt: "2026-04-28T00:00:00.000Z",
    };

    expect(
      inferLobbyLevelRoleForEvent({
        event: progressEvent("synthesis-run-1"),
        existingByRole: new Map([["planner", plannerState]]),
        synthesisRunId: "synthesis-run-1",
      }),
    ).toBe("planner");
  });
});

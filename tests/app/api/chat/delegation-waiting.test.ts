import { describe, expect, it, vi, beforeEach } from "vitest";

const delegationMocks = vi.hoisted(() => ({
  getActiveDelegationsForCharacter: vi.fn(),
}));

const commandExecutionMocks = vi.hoisted(() => ({
  getBackgroundProcess: vi.fn(),
}));

vi.mock("@/lib/ai/tools/delegate-to-subagent-tool", () => ({
  getActiveDelegationsForCharacter: delegationMocks.getActiveDelegationsForCharacter,
}));

vi.mock("@/lib/command-execution", () => ({
  getBackgroundProcess: commandExecutionMocks.getBackgroundProcess,
}));

import {
  hasRunningDelegationsForSession,
  hasDelegationsForSession,
  getBackgroundTasksForSession,
  hasRunningBackgroundTasksForSession,
  registerBackgroundTask,
  shouldStopTurn,
} from "@/app/api/chat/delegation-waiting";

describe("delegation waiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commandExecutionMocks.getBackgroundProcess.mockReturnValue(null);
  });

  it("reports running delegations only for active entries", () => {
    delegationMocks.getActiveDelegationsForCharacter.mockReturnValue([
      { delegationId: "del-1", running: false, completed: true },
      { delegationId: "del-2", running: true, completed: false },
    ]);

    expect(hasRunningDelegationsForSession("agent-init", "sess-1")).toBe(true);
    expect(delegationMocks.getActiveDelegationsForCharacter).toHaveBeenCalledWith("agent-init", "sess-1");
  });

  it("stops immediately when there is no character scope", () => {
    expect(hasRunningDelegationsForSession(null, "sess-1")).toBe(false);
  });

  it("keeps Claude Code alive after step 0 while delegations are still running", () => {
    delegationMocks.getActiveDelegationsForCharacter.mockReturnValue([
      { delegationId: "del-1", running: true, completed: false },
    ]);

    expect(
      shouldStopTurn({
        characterId: "agent-init",
        initiatorSessionId: "sess-1",
        stepCount: 1,
        maxSteps: 10,
      })
    ).toBe(false);
  });

  it("does not force-stop the turn when delegations are settled (model needs to observe results)", () => {
    delegationMocks.getActiveDelegationsForCharacter.mockReturnValue([
      { delegationId: "del-1", running: false, completed: true },
    ]);

    // Previously this returned true, which caused the serialization regression:
    // the model couldn't observe results before the turn was force-stopped.
    expect(
      shouldStopTurn({
        characterId: "agent-init",
        initiatorSessionId: "sess-1",
        stepCount: 1,
        maxSteps: 10,
      })
    ).toBe(false);
  });

  it("never stops before the first step has had a chance to run", () => {
    delegationMocks.getActiveDelegationsForCharacter.mockReturnValue([]);

    expect(
      shouldStopTurn({
        characterId: "agent-init",
        initiatorSessionId: "sess-1",
        stepCount: 0,
        maxSteps: 10,
      })
    ).toBe(false);
  });


  it("keeps the model loop alive until a background process has been checked once", () => {
    const processInfo = {
      id: "bg-1",
      command: "npm",
      args: ["run", "dev"],
      cwd: "/workspace",
      startedAt: Date.now() - 1000,
      settledAt: null,
      running: true,
      stdout: "Ready on http://localhost:3000",
      stderr: "",
      exitCode: null,
      signal: null,
      process: {},
      timeoutId: null,
    };
    commandExecutionMocks.getBackgroundProcess.mockReturnValue(processInfo);

    registerBackgroundTask("agent-init", "sess-bg", "bg-1");

    expect(hasRunningBackgroundTasksForSession("agent-init", "sess-bg")).toBe(true);

    processInfo.observedWhileRunning = true;

    expect(hasRunningBackgroundTasksForSession("agent-init", "sess-bg")).toBe(false);
    expect(getBackgroundTasksForSession("agent-init", "sess-bg")).toEqual([
      expect.objectContaining({
        processId: "bg-1",
        command: "npm run dev",
        running: true,
      }),
    ]);
  });

  it("still enforces the global max step limit", () => {
    delegationMocks.getActiveDelegationsForCharacter.mockReturnValue([
      { delegationId: "del-1", running: true, completed: false },
    ]);

    expect(
      shouldStopTurn({
        characterId: "agent-init",
        initiatorSessionId: "sess-1",
        stepCount: 10,
        maxSteps: 10,
      })
    ).toBe(true);
  });

  it("does not stop multi-step execution when session has no delegations at all", () => {
    delegationMocks.getActiveDelegationsForCharacter.mockReturnValue([]);

    expect(
      shouldStopTurn({
        characterId: "agent-subagent",
        initiatorSessionId: "sess-sub",
        stepCount: 1,
        maxSteps: 10,
      })
    ).toBe(false);

    expect(
      shouldStopTurn({
        characterId: "agent-subagent",
        initiatorSessionId: "sess-sub",
        stepCount: 5,
        maxSteps: 10,
      })
    ).toBe(false);
  });


  // ── Agent SDK backend single-step gate ──────────────────────────────────────
  // The SDK executes tools internally and streams tool_use blocks the AI SDK
  // can't match; without the gate a second step re-queries (duplicate response).

  it("SDK backend: force-stops after step 0 when there is no async work", () => {
    delegationMocks.getActiveDelegationsForCharacter.mockReturnValue([]);

    expect(
      shouldStopTurn({
        characterId: "agent-init",
        initiatorSessionId: "sess-1",
        stepCount: 1,
        maxSteps: 10,
        backend: "sdk",
      })
    ).toBe(true);
  });

  it("SDK backend: stays alive after step 0 while a delegation is still running", () => {
    delegationMocks.getActiveDelegationsForCharacter.mockReturnValue([
      { delegationId: "del-1", running: true, completed: false },
    ]);

    expect(
      shouldStopTurn({
        characterId: "agent-init",
        initiatorSessionId: "sess-1",
        stepCount: 1,
        maxSteps: 10,
        backend: "sdk",
      })
    ).toBe(false);
  });

  it("SDK backend: never stops before the first step has run", () => {
    delegationMocks.getActiveDelegationsForCharacter.mockReturnValue([]);

    expect(
      shouldStopTurn({
        characterId: "agent-init",
        initiatorSessionId: "sess-1",
        stepCount: 0,
        maxSteps: 10,
        backend: "sdk",
      })
    ).toBe(false);
  });

  it("Dario backend: never force-stops mid-loop (no async work)", () => {
    delegationMocks.getActiveDelegationsForCharacter.mockReturnValue([]);

    expect(
      shouldStopTurn({
        characterId: "agent-init",
        initiatorSessionId: "sess-1",
        stepCount: 1,
        maxSteps: 10,
        backend: "dario",
      })
    ).toBe(false);
  });

  it("hasDelegationsForSession returns false for null characterId", () => {
    expect(hasDelegationsForSession(null, "sess-1")).toBe(false);
  });

  it("hasDelegationsForSession detects any delegation regardless of running state", () => {
    delegationMocks.getActiveDelegationsForCharacter.mockReturnValue([
      { delegationId: "del-1", running: false, completed: true },
    ]);

    expect(hasDelegationsForSession("agent-init", "sess-1")).toBe(true);
  });
});

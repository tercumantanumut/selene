import { describe, expect, it } from "vitest";
import { resolveBackgroundRunState } from "@/components/chat/chat-interface-utils";

describe("background run resume state", () => {
  it("keeps tracking an interactive-wait foreground run without resuming background polling", () => {
    const state = resolveBackgroundRunState({
      isForegroundStreaming: false,
      hasActiveRun: true,
      runId: "run-chat",
      shouldResumeBackgroundRun: false,
    });

    expect(state.activeForegroundRunId).toBe("run-chat");
    expect(state.resumedForegroundRunId).toBeNull();
    expect(state.trackedRunId).toBe("run-chat");
    expect(state.shouldShowBackgroundRun).toBe(true);
    expect(state.shouldPollRun).toBe(false);
  });

  it("resumes background polling for a normal active run", () => {
    const state = resolveBackgroundRunState({
      isForegroundStreaming: false,
      hasActiveRun: true,
      runId: "run-chat",
      shouldResumeBackgroundRun: true,
    });

    expect(state.activeForegroundRunId).toBe("run-chat");
    expect(state.resumedForegroundRunId).toBe("run-chat");
    expect(state.trackedRunId).toBe("run-chat");
    expect(state.shouldShowBackgroundRun).toBe(true);
    expect(state.shouldPollRun).toBe(true);
  });

  it("polls stale-suspected runs even when resume is otherwise disabled", () => {
    const state = resolveBackgroundRunState({
      isForegroundStreaming: false,
      hasActiveRun: true,
      runId: "run-chat",
      health: "stale_suspected",
      shouldResumeBackgroundRun: false,
    });

    expect(state.trackedRunId).toBe("run-chat");
    expect(state.isStaleSuspected).toBe(true);
    expect(state.shouldPollRun).toBe(true);
  });

  it("does not treat a foreground-streaming turn as resumable background work", () => {
    const state = resolveBackgroundRunState({
      isForegroundStreaming: true,
      hasActiveRun: true,
      runId: "run-chat",
      shouldResumeBackgroundRun: true,
    });

    expect(state.activeForegroundRunId).toBeNull();
    expect(state.resumedForegroundRunId).toBeNull();
    expect(state.trackedRunId).toBeNull();
    expect(state.shouldShowBackgroundRun).toBe(false);
    expect(state.shouldPollRun).toBe(false);
  });
});

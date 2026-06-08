import { describe, expect, it } from "vitest";
import type { UnifiedTask } from "@/lib/background-tasks/types";
import { toBackgroundProcessInfo } from "@/lib/hooks/use-background-process-status";

function makeTask(overrides: Partial<UnifiedTask> = {}): UnifiedTask {
  return {
    type: "chat",
    runId: "bg-123",
    userId: "user-1",
    characterId: "char-1",
    sessionId: "sess-1",
    status: "running",
    startedAt: "2026-04-29T10:00:00.000Z",
    pipelineName: "background-process",
    triggerType: "tool",
    metadata: {
      isBackgroundProcess: true,
      toolName: "executeCommand",
      command: "npm run dev",
      cwd: "/workspace",
    },
    ...overrides,
  } as UnifiedTask;
}

describe("toBackgroundProcessInfo", () => {
  it("derives running background processes from active task entries", () => {
    const info = toBackgroundProcessInfo(
      makeTask(),
      Date.parse("2026-04-29T10:00:05.000Z"),
    );

    expect(info).toMatchObject({
      processId: "bg-123",
      command: "npm run dev",
      toolName: "executeCommand",
      cwd: "/workspace",
      running: true,
      elapsed: 5000,
    });
  });

  it("derives stopped background processes from completed task entries", () => {
    const info = toBackgroundProcessInfo(
      makeTask({
        status: "cancelled",
        completedAt: "2026-04-29T10:00:07.000Z",
        durationMs: 7000,
        metadata: {
          isBackgroundProcess: true,
          toolName: "bash",
          command: "npm run electron:dev",
          cwd: "/workspace",
          signal: "SIGTERM",
          exitCode: null,
        },
      }),
      Date.parse("2026-04-29T10:00:10.000Z"),
    );

    expect(info).toMatchObject({
      processId: "bg-123",
      command: "npm run electron:dev",
      toolName: "bash",
      running: false,
      elapsed: 7000,
      settledAt: "2026-04-29T10:00:07.000Z",
      signal: "SIGTERM",
    });
  });
});

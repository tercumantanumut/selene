import { beforeEach, describe, expect, it } from "vitest";

import { reconcileTaskSnapshotWithStores } from "@/lib/hooks/use-task-notifications";
import { useUnifiedTasksStore } from "@/lib/stores/unified-tasks-store";
import { useSessionSyncStore } from "@/lib/stores/session-sync-store";
import { isBackgroundProcessTask, type UnifiedTask } from "@/lib/background-tasks/types";

function makeBackgroundProcessTask(overrides: Partial<UnifiedTask> = {}): UnifiedTask {
  return {
    type: "chat",
    runId: "bg-1720000000000-1",
    userId: "user-1",
    characterId: "agent-1",
    sessionId: "session-1",
    status: "running",
    startedAt: new Date().toISOString(),
    pipelineName: "background-process",
    triggerType: "tool",
    metadata: {
      isBackgroundProcess: true,
      toolName: "bash",
      command: "npm run dev",
      cwd: "/workspace",
    },
    ...overrides,
  } as UnifiedTask;
}

describe("background process task handling", () => {
  beforeEach(() => {
    useUnifiedTasksStore.setState({
      tasks: [],
      tasksMap: new Map(),
      recentlyCompleted: [],
    });
    useSessionSyncStore.setState({
      sessionsById: new Map(),
      sessionsByCharacter: new Map(),
      activeRuns: new Map(),
      sessionActivityById: new Map(),
      sessionContextStatusById: new Map(),
      lastRefreshAt: Date.now(),
      listeners: new Set(),
    });
  });

  it("identifies background process tasks via metadata", () => {
    expect(isBackgroundProcessTask(makeBackgroundProcessTask())).toBe(true);
    expect(
      isBackgroundProcessTask(makeBackgroundProcessTask({ metadata: { isDelegation: true } })),
    ).toBe(false);
    expect(isBackgroundProcessTask({ type: "scheduled", metadata: { isBackgroundProcess: true } })).toBe(false);
  });

  it("does not overwrite the session's active chat run when reconciling a running background process", () => {
    const store = useUnifiedTasksStore.getState();
    const syncStore = useSessionSyncStore.getState();
    const bgTask = makeBackgroundProcessTask();

    // A real chat run owns the session's active-run marker.
    syncStore.setActiveRun("session-1", "run-chat-1");

    reconcileTaskSnapshotWithStores([], [bgTask], {
      addTask: store.addTask,
      updateTask: store.updateTask,
      completeTask: store.completeTask,
    });

    // The background process is tracked...
    expect(useUnifiedTasksStore.getState().tasksMap.has(bgTask.runId)).toBe(true);
    // ...but the chat run's active marker is untouched.
    expect(useSessionSyncStore.getState().activeRuns.get("session-1")).toBe("run-chat-1");
    expect(useSessionSyncStore.getState().getSessionActivity("session-1")).toBeFalsy();
  });

  it("completes a background process missing from the server without clearing the session's active run", () => {
    const store = useUnifiedTasksStore.getState();
    const syncStore = useSessionSyncStore.getState();
    const bgTask = makeBackgroundProcessTask();
    const chatTask = {
      type: "chat",
      runId: "run-chat-1",
      userId: "user-1",
      characterId: "agent-1",
      sessionId: "session-1",
      status: "running",
      startedAt: new Date().toISOString(),
      pipelineName: "chat",
      triggerType: "chat",
      metadata: {},
    } as UnifiedTask;

    store.addTask(bgTask);
    store.addTask(chatTask);
    syncStore.setActiveRun("session-1", "run-chat-1");

    // Server still knows the chat run but no longer tracks the bg process.
    reconcileTaskSnapshotWithStores(useUnifiedTasksStore.getState().tasks, [chatTask], {
      addTask: store.addTask,
      updateTask: store.updateTask,
      completeTask: store.completeTask,
    });

    // The stale background process is moved to recently-completed as cancelled...
    expect(useUnifiedTasksStore.getState().tasksMap.has(bgTask.runId)).toBe(false);
    expect(useUnifiedTasksStore.getState().recentlyCompleted[0]).toMatchObject({
      runId: bgTask.runId,
      status: "cancelled",
    });
    // ...while the actual chat run keeps its active marker.
    expect(useSessionSyncStore.getState().activeRuns.get("session-1")).toBe("run-chat-1");
  });
});

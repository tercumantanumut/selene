import type { UnifiedTask } from "@/lib/background-tasks/types";

function taskMetadata(task: UnifiedTask): Record<string, unknown> {
  return task.metadata && typeof task.metadata === "object" ? task.metadata : {};
}

function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isDelegationDisplayTask(task: UnifiedTask) {
  const metadata = taskMetadata(task);
  return task.type === "chat" && metadata.isDelegation === true;
}

function delegationOwnerSessionIds(task: UnifiedTask) {
  const metadata = taskMetadata(task);
  return [
    metadataString(metadata, "initiatorSessionId"),
    metadataString(metadata, "rootSessionId"),
  ].filter((sessionId): sessionId is string => Boolean(sessionId));
}

/**
 * Avoid rendering the same delegated work twice in active-task UIs.
 *
 * Delegated runs are first-class chat tasks so they can be opened directly and
 * keep task/session lifecycle state intact. When their owning/root session is
 * also represented by an active task row, the delegated run is displayed inside
 * that row via the scoped delegation indicator instead of as a second task row.
 */
export function selectVisibleActiveTasks(tasks: UnifiedTask[]): UnifiedTask[] {
  const representedSessionIds = new Set(
    tasks
      .filter((task) => !isDelegationDisplayTask(task))
      .map((task) => task.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId))
  );

  if (representedSessionIds.size === 0) {
    return tasks;
  }

  return tasks.filter((task) => {
    if (!isDelegationDisplayTask(task)) {
      return true;
    }

    return !delegationOwnerSessionIds(task).some((sessionId) => representedSessionIds.has(sessionId));
  });
}

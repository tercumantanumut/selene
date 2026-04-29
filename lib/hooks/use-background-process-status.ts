import { useCallback, useMemo, useState } from "react";
import { useUnifiedTasksStore } from "@/lib/stores/unified-tasks-store";
import type { UnifiedTask } from "@/lib/background-tasks/types";
import { resilientFetch } from "@/lib/utils/resilient-fetch";

export interface BackgroundProcessInfo {
  processId: string;
  command: string;
  cwd?: string;
  toolName?: string;
  running: boolean;
  elapsed: number;
  startedAt: string;
  settledAt?: string | null;
  exitCode?: number | null;
  signal?: string | null;
}

interface BackgroundProcessStatus {
  processes: BackgroundProcessInfo[];
  isLoading: boolean;
  error: string | null;
  stopProcess: (processId: string) => Promise<void>;
  stoppingProcessIds: Set<string>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableNumber(value: unknown): number | null | undefined {
  return typeof value === "number" || value === null ? value : undefined;
}

export function toBackgroundProcessInfo(task: UnifiedTask, now = Date.now()): BackgroundProcessInfo {
  const meta = task.metadata as Record<string, unknown> | undefined;
  return {
    processId: task.runId,
    command: asString(meta?.command) ?? task.runId,
    cwd: asString(meta?.cwd),
    toolName: asString(meta?.toolName),
    running: task.status === "running",
    elapsed: task.durationMs ?? Math.max(0, now - new Date(task.startedAt).getTime()),
    startedAt: task.startedAt,
    settledAt: task.completedAt ?? asString(meta?.settledAt) ?? null,
    exitCode: asNullableNumber(meta?.exitCode),
    signal: asString(meta?.signal) ?? null,
  };
}

export function useBackgroundProcessStatus(
  characterId: string | null,
  sessionId?: string | null,
): BackgroundProcessStatus {
  const tasks = useUnifiedTasksStore((s) => s.tasks);
  const recentlyCompleted = useUnifiedTasksStore((s) => s.recentlyCompleted);
  const completeTask = useUnifiedTasksStore((s) => s.completeTask);
  const updateTask = useUnifiedTasksStore((s) => s.updateTask);
  const [stoppingProcessIds, setStoppingProcessIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  const processes = useMemo(() => {
    if (!characterId || !sessionId) return [];
    const relevantTasks = [...tasks, ...recentlyCompleted];
    return relevantTasks
      .filter((task) => {
        const meta = task.metadata as Record<string, unknown> | undefined;
        return (
          meta?.isBackgroundProcess === true &&
          task.characterId === characterId &&
          task.sessionId === sessionId
        );
      })
      .map((task) => toBackgroundProcessInfo(task));
  }, [characterId, recentlyCompleted, sessionId, tasks]);

  const stopProcess = useCallback(async (processId: string) => {
    setError(null);
    setStoppingProcessIds((previous) => new Set(previous).add(processId));

    try {
      const { data, error: requestError } = await resilientFetch<{ ok?: boolean; task?: UnifiedTask | null; error?: string }>(
        `/api/background-processes/${encodeURIComponent(processId)}/kill`,
        { method: "POST", retries: 0 },
      );

      if (requestError || !data?.ok) {
        throw new Error(data?.error ?? requestError ?? "Failed to stop background process");
      }

      updateTask(processId, { status: "cancelled", completedAt: new Date().toISOString() });
      if (data.task) {
        completeTask(data.task);
      }
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
      throw stopError;
    } finally {
      setStoppingProcessIds((previous) => {
        const next = new Set(previous);
        next.delete(processId);
        return next;
      });
    }
  }, [completeTask, updateTask]);

  return { processes, isLoading: false, error, stopProcess, stoppingProcessIds };
}

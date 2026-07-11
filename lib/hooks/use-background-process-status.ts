import { useCallback, useEffect, useMemo, useState } from "react";
import { useUnifiedTasksStore } from "@/lib/stores/unified-tasks-store";
import type { TaskStatus, UnifiedTask } from "@/lib/background-tasks/types";
import { resilientFetch } from "@/lib/utils/resilient-fetch";

export interface BackgroundProcessInfo {
  processId: string;
  command: string;
  cwd?: string;
  toolName?: string;
  /** Final task status: running | succeeded | failed | cancelled | stale | queued */
  status: TaskStatus;
  running: boolean;
  elapsed: number;
  startedAt: string;
  settledAt?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  /** Why the process stopped: exit | timeout | killed | spawn-error */
  settleReason?: string;
  /** Human-readable failure reason, when status is failed */
  error?: string;
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
  const running = task.status === "running" || task.status === "queued";
  return {
    processId: task.runId,
    command: asString(meta?.command) ?? task.runId,
    cwd: asString(meta?.cwd),
    toolName: asString(meta?.toolName),
    status: task.status,
    running,
    elapsed: task.durationMs ?? Math.max(0, now - new Date(task.startedAt).getTime()),
    startedAt: task.startedAt,
    settledAt: task.completedAt ?? asString(meta?.settledAt) ?? null,
    exitCode: asNullableNumber(meta?.exitCode),
    signal: asString(meta?.signal) ?? null,
    settleReason: asString(meta?.settleReason),
    error: task.error,
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
  const [now, setNow] = useState(() => Date.now());

  const relevantTasks = useMemo(() => {
    if (!characterId || !sessionId) return [];
    return [...tasks, ...recentlyCompleted].filter((task) => {
      const meta = task.metadata as Record<string, unknown> | undefined;
      return (
        meta?.isBackgroundProcess === true &&
        task.characterId === characterId &&
        task.sessionId === sessionId
      );
    });
  }, [characterId, recentlyCompleted, sessionId, tasks]);

  const hasRunning = relevantTasks.some(
    (task) => task.status === "running" || task.status === "queued",
  );

  // Tick every second while any process is running so elapsed timers stay live.
  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [hasRunning]);

  const processes = useMemo(
    () => relevantTasks.map((task) => toBackgroundProcessInfo(task, now)),
    [relevantTasks, now],
  );

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

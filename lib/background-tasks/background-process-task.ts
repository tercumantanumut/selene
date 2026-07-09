import { getBackgroundProcess, killBackgroundProcess } from "@/lib/command-execution";
import type { BackgroundProcessInfo } from "@/lib/command-execution/types";
import { nowISO } from "@/lib/utils/timestamp";
import { taskRegistry } from "./registry";
import type { ChatTask, TaskStatus, UnifiedTask } from "./types";

type BackgroundProcessToolName = "bash" | "executeCommand";

interface RegisterBackgroundProcessTaskInput {
  processId: string;
  userId?: string;
  characterId?: string | null;
  sessionId: string;
  toolName: BackgroundProcessToolName;
  command: string;
  cwd: string;
}

interface KillBackgroundProcessTaskResult {
  ok: boolean;
  error?: string;
  task?: UnifiedTask;
}

export function statusForBackgroundProcess(info?: BackgroundProcessInfo, fallback: TaskStatus = "cancelled"): TaskStatus {
  if (!info) return fallback;
  if (info.running) return "running";
  // Explicit stop (user Stop button / kill API). Checked before signal and
  // exit code: at kill time the child's async "close" event has usually not
  // fired yet, so exitCode/signal are still null.
  if (info.settleReason === "killed") return "cancelled";
  if (info.settleReason === "timeout") return "failed";
  if (info.settleReason === "spawn-error") return "failed";
  if (info.signal) return "cancelled";
  // Settled but no exit code and no explicit reason: we cannot claim the
  // process failed — treat as the caller-provided fallback (interrupted).
  if (info.exitCode === null || info.exitCode === undefined) return fallback;
  return info.exitCode === 0 ? "succeeded" : "failed";
}

function errorForBackgroundProcess(info: BackgroundProcessInfo | undefined, status: TaskStatus): string | undefined {
  if (!info || status !== "failed") return undefined;
  if (info.settleReason === "timeout") return "Process timed out";
  if (info.settleReason === "spawn-error") return "Process failed to start";
  if (info.exitCode !== null && info.exitCode !== undefined && info.exitCode !== 0) {
    return `Process exited with code ${info.exitCode}`;
  }
  return "Process failed";
}

function backgroundProcessMetadata(
  info?: BackgroundProcessInfo,
): Record<string, unknown> {
  return {
    ...(info ? {
      command: [info.command, ...info.args].filter(Boolean).join(" "),
      cwd: info.cwd,
      exitCode: info.exitCode,
      signal: info.signal,
      settleReason: info.settleReason,
      settledAt: info.settledAt ? new Date(info.settledAt).toISOString() : undefined,
    } : {}),
  };
}

function findRecentlyCompletedTask(runId: string): UnifiedTask | undefined {
  return taskRegistry.listRecentlyCompleted().find((task) => task.runId === runId);
}

function completeBackgroundProcessTask(
  processId: string,
  info?: BackgroundProcessInfo | null,
  fallbackStatus: TaskStatus = "cancelled",
): UnifiedTask | undefined {
  const existing = taskRegistry.get(processId);
  if (!existing) return findRecentlyCompletedTask(processId);

  const status = statusForBackgroundProcess(info ?? undefined, fallbackStatus);
  if (status === "running") return existing;

  const startedAt = new Date(existing.startedAt).getTime();
  const settledAt = info?.settledAt ?? Date.now();
  console.log(`[BackgroundProcessTask] ${processId} settled: status=${status} exitCode=${info?.exitCode ?? "null"} signal=${info?.signal ?? "null"} reason=${info?.settleReason ?? "unknown"}`);
  return taskRegistry.updateStatus(processId, status, {
    durationMs: Math.max(0, settledAt - startedAt),
    error: errorForBackgroundProcess(info ?? undefined, status),
    metadata: {
      ...(existing.metadata ?? {}),
      ...backgroundProcessMetadata(info ?? undefined),
    },
  });
}

export function registerBackgroundProcessTask(input: RegisterBackgroundProcessTaskInput): void {
  if (!input.userId) return;

  const existing = taskRegistry.get(input.processId);
  const processInfo = getBackgroundProcess(input.processId);
  const task: ChatTask = {
    type: "chat",
    runId: input.processId,
    userId: input.userId,
    characterId: input.characterId ?? undefined,
    sessionId: input.sessionId,
    status: "running",
    startedAt: processInfo?.startedAt ? new Date(processInfo.startedAt).toISOString() : nowISO(),
    pipelineName: "background-process",
    triggerType: "tool",
    metadata: {
      ...(existing?.metadata ?? {}),
      isBackgroundProcess: true,
      toolName: input.toolName,
      command: input.command,
      cwd: input.cwd,
    },
  };

  if (existing) {
    taskRegistry.updateStatus(input.processId, "running", task);
  } else {
    taskRegistry.register(task);
  }

  if (processInfo && !processInfo.running) {
    completeBackgroundProcessTask(input.processId, processInfo);
  }
}

export function handleBackgroundProcessSettled(info: BackgroundProcessInfo): void {
  completeBackgroundProcessTask(info.id, info);
}

export function killTrackedBackgroundProcess(
  processId: string,
  userId?: string,
): KillBackgroundProcessTaskResult {
  const existing = taskRegistry.get(processId);
  if (userId && existing && existing.userId !== userId) {
    return { ok: false, error: "Background process not found." };
  }

  const killed = killBackgroundProcess(processId);
  if (!killed) {
    return { ok: false, error: `No background process found with ID '${processId}'.` };
  }

  const info = getBackgroundProcess(processId);
  const task = completeBackgroundProcessTask(processId, info, "cancelled");
  return { ok: true, task };
}

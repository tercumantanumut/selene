import { getBackgroundProcess, killBackgroundProcess } from "@/lib/command-execution";
import type { BackgroundProcessInfo } from "@/lib/command-execution/types";
import { nowISO } from "@/lib/utils/timestamp";
import { taskRegistry } from "./registry";
import type { ChatTask, TaskStatus, UnifiedTask } from "./types";

export type BackgroundProcessToolName = "bash" | "executeCommand";

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

function statusForBackgroundProcess(info?: BackgroundProcessInfo, fallback: TaskStatus = "cancelled"): TaskStatus {
  if (!info) return fallback;
  if (info.running) return "running";
  if (info.signal) return "cancelled";
  return info.exitCode === 0 ? "succeeded" : "failed";
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
      settledAt: info.settledAt ? new Date(info.settledAt).toISOString() : undefined,
    } : {}),
  };
}

function findRecentlyCompletedTask(runId: string): UnifiedTask | undefined {
  return taskRegistry.listRecentlyCompleted().find((task) => task.runId === runId);
}

export function completeBackgroundProcessTask(
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
  return taskRegistry.updateStatus(processId, status, {
    durationMs: Math.max(0, settledAt - startedAt),
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

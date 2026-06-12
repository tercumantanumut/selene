import { getActiveDelegationsForCharacter } from "@/lib/ai/tools/delegate-to-subagent-tool";
import { getBackgroundProcess } from "@/lib/command-execution";
import type { BackgroundProcessInfo } from "@/lib/command-execution/types";

// ── Session-scoped background task registry ──────────────────────────────
// Tracks which background process IDs were started in each session,
// so prepareStep can keep the turn alive while they run.
// Key: `${characterId}:${sessionId}`, Value: Set of processIds
const sessionBackgroundTasks = new Map<string, Set<string>>();
const BACKGROUND_TASK_STALE_TTL_MS = 10 * 60 * 1000;

export interface SessionBackgroundTaskSummary {
  processId: string;
  command: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  elapsed: number;
  startedAt: number;
  settledAt?: number | null;
}

function toBackgroundTaskSummary(info: BackgroundProcessInfo, now = Date.now()): SessionBackgroundTaskSummary {
  return {
    processId: info.id,
    command: [info.command, ...info.args].filter(Boolean).join(" "),
    cwd: info.cwd,
    running: info.running,
    exitCode: info.exitCode,
    signal: info.signal,
    elapsed: now - info.startedAt,
    startedAt: info.startedAt,
    settledAt: info.settledAt,
  };
}

function shouldKeepBackgroundTask(info: BackgroundProcessInfo, now = Date.now()): boolean {
  if (info.running) return true;
  return now - (info.settledAt ?? info.startedAt) <= BACKGROUND_TASK_STALE_TTL_MS;
}

function isBackgroundTaskStillNeedingModelObservation(info: BackgroundProcessInfo): boolean {
  if (!info.running) return false;

  // Force exactly one status check after a background process starts. If it is
  // still running after that check (typical dev server), release the model so it
  // can answer instead of looping list/status calls or starting duplicate servers.
  return info.observedWhileRunning !== true;
}

function sessionKey(characterId: string, sessionId: string): string {
  return `${characterId}:${sessionId}`;
}

/**
 * Register a background process ID as belonging to a session.
 * Called from executeCommand tool after a background process starts.
 */
export function registerBackgroundTask(
  characterId: string,
  sessionId: string,
  processId: string,
): void {
  const key = sessionKey(characterId, sessionId);
  let tasks = sessionBackgroundTasks.get(key);
  if (!tasks) {
    tasks = new Set();
    sessionBackgroundTasks.set(key, tasks);
  }
  tasks.add(processId);
}

/**
 * Return tracked background processes for a session.
 * Cleans up stale finished processes from the registry as a side effect.
 */
export function getBackgroundTasksForSession(
  characterId: string | null,
  sessionId: string,
): SessionBackgroundTaskSummary[] {
  if (!characterId) return [];

  const key = sessionKey(characterId, sessionId);
  const tasks = sessionBackgroundTasks.get(key);
  if (!tasks || tasks.size === 0) return [];

  const now = Date.now();
  const summaries: SessionBackgroundTaskSummary[] = [];
  for (const processId of tasks) {
    const info = getBackgroundProcess(processId);
    if (!info || !shouldKeepBackgroundTask(info, now)) {
      tasks.delete(processId);
      continue;
    }
    summaries.push(toBackgroundTaskSummary(info, now));
  }

  if (tasks.size === 0) {
    sessionBackgroundTasks.delete(key);
  }

  return summaries;
}

export function hasRunningBackgroundTasksForSession(
  characterId: string | null,
  sessionId: string,
): boolean {
  if (!characterId) return false;

  const key = sessionKey(characterId, sessionId);
  const tasks = sessionBackgroundTasks.get(key);
  if (!tasks || tasks.size === 0) return false;

  const now = Date.now();
  for (const processId of Array.from(tasks)) {
    const info = getBackgroundProcess(processId);
    if (!info || !shouldKeepBackgroundTask(info, now)) {
      tasks.delete(processId);
      continue;
    }
    if (isBackgroundTaskStillNeedingModelObservation(info)) {
      return true;
    }
  }

  if (tasks.size === 0) {
    sessionBackgroundTasks.delete(key);
  }

  return false;
}

function hasUnobservedRunningBackgroundTasksForSession(
  characterId: string | null,
  sessionId: string,
): boolean {
  return hasRunningBackgroundTasksForSession(characterId, sessionId);
}

// ── Delegation helpers ───────────────────────────────────────────────────

export function hasRunningDelegationsForSession(
  characterId: string | null,
  initiatorSessionId: string,
): boolean {
  if (!characterId) {
    return false;
  }

  return getActiveDelegationsForCharacter(characterId, initiatorSessionId).some(
    (delegation) => delegation.running,
  );
}

export function hasDelegationsForSession(
  characterId: string | null,
  initiatorSessionId: string,
): boolean {
  if (!characterId) {
    return false;
  }

  return getActiveDelegationsForCharacter(characterId, initiatorSessionId).length > 0;
}

// ── Turn control ─────────────────────────────────────────────────────────

/**
 * Check if the turn has async work (delegations or background tasks) still running.
 */
export function hasActiveAsyncWork(
  characterId: string | null,
  sessionId: string,
): boolean {
  return (
    hasRunningDelegationsForSession(characterId, sessionId) ||
    hasRunningBackgroundTasksForSession(characterId, sessionId)
  );
}

export function shouldStopTurn(input: {
  characterId: string | null;
  initiatorSessionId: string;
  stepCount: number;
  maxSteps: number;
  provider?: string;
}): boolean {
  if (input.stepCount >= input.maxSteps) {
    return true;
  }

  // No provider-specific stop gate. The Claude Code provider used to be the
  // Agent SDK, which streamed back tool_use blocks for internally-executed
  // tools (Read, Edit, Bash, …) the AI SDK couldn't match — we force-stopped
  // after step 1 to avoid a duplicate query. With the CLIProxyAPI bridge the
  // Claude Code provider is a plain Anthropic Messages API consumer; it
  // emits the same tool_use shape every other provider does and the AI SDK
  // loop ends naturally when the model returns a text-only response.
  return false;
}

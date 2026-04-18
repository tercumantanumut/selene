import type { InspectMessageContext } from "@/lib/design/workspace/inspect-context";

export interface LivePromptEntry {
  id: string;
  content: string;
  timestamp: number;
  stopIntent: boolean;
  metadata?: {
    kind?: "generic" | "delegation_completion";
    delegationId?: string;
    delegateName?: string;
    inspectContext?: InspectMessageContext | null;
  };
}

const globalForLivePromptQueue = globalThis as typeof globalThis & {
  livePromptQueues?: Map<string, LivePromptEntry[]>;
  livePromptSessionIndex?: Map<string, string>; // sessionId → runId
  livePromptQueueWaiters?: Map<string, Set<() => void>>;
};

function getQueueMap(): Map<string, LivePromptEntry[]> {
  if (!globalForLivePromptQueue.livePromptQueues) {
    globalForLivePromptQueue.livePromptQueues = new Map();
  }
  return globalForLivePromptQueue.livePromptQueues;
}

function getSessionIndex(): Map<string, string> {
  if (!globalForLivePromptQueue.livePromptSessionIndex) {
    globalForLivePromptQueue.livePromptSessionIndex = new Map();
  }
  return globalForLivePromptQueue.livePromptSessionIndex;
}

function getWaiterMap(): Map<string, Set<() => void>> {
  if (!globalForLivePromptQueue.livePromptQueueWaiters) {
    globalForLivePromptQueue.livePromptQueueWaiters = new Map();
  }
  return globalForLivePromptQueue.livePromptQueueWaiters;
}

/** Call once after agentRun.id is assigned, before streaming starts. */
export function createLivePromptQueue(runId: string, sessionId: string): void {
  getQueueMap().set(runId, []);
  getSessionIndex().set(sessionId, runId);
}

/**
 * Prefix used when reserving a queue by sessionId before the real agentRun.id
 * is known. Callers must never construct this key manually — use
 * `reserveLivePromptQueueBySession` and `promoteLivePromptQueueToRunId`.
 */
const PENDING_RUN_KEY_PREFIX = "pending-run:";

function pendingRunKey(sessionId: string): string {
  return `${PENDING_RUN_KEY_PREFIX}${sessionId}`;
}

/**
 * Reserve a live-prompt queue by sessionId before agentRun.id is known.
 *
 * Registers a placeholder runId keyed on the sessionId so that
 * `appendToLivePromptQueueBySession` starts returning true immediately after
 * /api/chat begins — before the slow awaits (session load, preflight check,
 * createAgentRun) finish. Closes the ~9–11 s race window that caused
 * mid-stream injections to receive 409 `no_active_run` on fresh runs.
 *
 * Must be followed either by `promoteLivePromptQueueToRunId` once agentRun.id
 * is assigned, or by `clearLivePromptQueueBySession` on any early-return path
 * (e.g. the context-window 413 early exit).
 *
 * If a stale reservation already exists for this session (prior aborted
 * request), it is cleared first so injections from the new run don't bleed
 * into it.
 */
export function reserveLivePromptQueueBySession(sessionId: string): void {
  const newKey = pendingRunKey(sessionId);
  const index = getSessionIndex();
  const queueMap = getQueueMap();
  const waiterMap = getWaiterMap();

  const existingKey = index.get(sessionId);
  if (existingKey && existingKey !== newKey) {
    // Stale entry from a prior run — drop it so this new reservation wins.
    queueMap.delete(existingKey);
    const staleWaiters = waiterMap.get(existingKey);
    if (staleWaiters) {
      for (const notify of [...staleWaiters]) {
        notify();
      }
      waiterMap.delete(existingKey);
    }
  }

  queueMap.set(newKey, []);
  index.set(sessionId, newKey);
}

/**
 * Rekey a reserved queue (from `reserveLivePromptQueueBySession`) to the real
 * agentRun.id once it's assigned. Preserves any entries and waiters that
 * landed on the placeholder key during the warmup window.
 *
 * Falls back to `createLivePromptQueue(runId, sessionId)` if no reservation
 * exists, so callers can promote unconditionally.
 *
 * Idempotent: safe to call again with the same (sessionId, runId) pair.
 */
export function promoteLivePromptQueueToRunId(sessionId: string, runId: string): void {
  const index = getSessionIndex();
  const queueMap = getQueueMap();
  const waiterMap = getWaiterMap();

  const oldKey = index.get(sessionId);
  if (!oldKey) {
    // No prior reservation — create a fresh queue under the real runId.
    createLivePromptQueue(runId, sessionId);
    return;
  }
  if (oldKey === runId) {
    // Already promoted.
    return;
  }

  const queue = queueMap.get(oldKey) ?? [];
  const waiters = waiterMap.get(oldKey);

  queueMap.set(runId, queue);
  queueMap.delete(oldKey);
  if (waiters) {
    waiterMap.set(runId, waiters);
    waiterMap.delete(oldKey);
  }
  index.set(sessionId, runId);

  // Wake any waiters that were parked on the placeholder — they were likely
  // waiting on the very entries we just carried over.
  if (waiters && queue.length > 0) {
    for (const notify of [...waiters]) {
      notify();
    }
  }
}

/**
 * Clear a queue by sessionId regardless of whether it's still a placeholder
 * reservation or a fully promoted run. Use on early-return / error paths
 * where agentRun.id may not be known yet (e.g. context-window 413 exit, or
 * outer catch handling a throw before createAgentRun).
 *
 * Safe to call even when no queue exists for the session.
 */
export function clearLivePromptQueueBySession(sessionId: string): void {
  const index = getSessionIndex();
  const key = index.get(sessionId);
  if (!key) return;

  getQueueMap().delete(key);
  const waiters = getWaiterMap().get(key);
  if (waiters) {
    for (const notify of [...waiters]) {
      notify();
    }
    getWaiterMap().delete(key);
  }
  index.delete(sessionId);
}

/**
 * Append an entry to the queue for the given run.
 * Returns false if no active queue exists for this runId (i.e. run is not active).
 * This is the O(1) in-memory "is active run?" check — no DB query needed.
 */
export function appendToLivePromptQueue(
  runId: string,
  entry: Omit<LivePromptEntry, "timestamp">
): boolean {
  const queue = getQueueMap().get(runId);
  if (!queue) return false;
  queue.push({ ...entry, timestamp: Date.now() });
  const waiters = getWaiterMap().get(runId);
  if (waiters) {
    for (const notify of [...waiters]) {
      notify();
    }
  }
  return true;
}

/**
 * Append an entry to the queue for the session's currently active run.
 * Resolves runId via the session index — no runId needed on the client.
 * Returns false if no active queue exists for this sessionId.
 */
export function appendToLivePromptQueueBySession(
  sessionId: string,
  entry: Omit<LivePromptEntry, "timestamp">
): boolean {
  const runId = getSessionIndex().get(sessionId);
  if (!runId) return false;
  return appendToLivePromptQueue(runId, entry);
}

/**
 * Atomically drain all pending entries for the given run.
 * Uses splice to read + clear in one synchronous tick — no seenIds tracking needed.
 * Returns an empty array if the queue doesn't exist or is empty.
 */
export function drainLivePromptQueue(runId: string): LivePromptEntry[] {
  const queue = getQueueMap().get(runId);
  if (!queue || queue.length === 0) return [];
  return queue.splice(0, queue.length);
}

/** Returns true if an active queue exists for this runId. */
export function hasLivePromptQueue(runId: string): boolean {
  return getQueueMap().has(runId);
}

/**
 * Resolve the queue key registered for this session.
 *
 * Returns the real `agentRun.id` once promoted, or the `pending-run:<sessionId>`
 * placeholder while the reservation is still in warmup. Returns `undefined` when
 * no reservation has been made yet.
 *
 * Callers that need to drain-before-remove on error paths where the run id
 * may not yet exist (e.g. the chat catch handler that fires before
 * `createAgentRun` returns) use this to pass the live key into
 * `drainLivePromptQueue`.
 */
export function getLivePromptQueueKeyBySession(sessionId: string): string | undefined {
  return getSessionIndex().get(sessionId);
}

/**
 * Wait until the queue receives at least one entry, or until the caller aborts.
 * Resolves immediately when entries are already available.
 */
export function waitForQueueMessage(runId: string, signal?: AbortSignal): Promise<void> {
  const queue = getQueueMap().get(runId);
  if (!queue) {
    return Promise.reject(new Error(`Live prompt queue not found for run ${runId}`));
  }
  if (queue.length > 0) {
    return Promise.resolve();
  }
  if (signal?.aborted) {
    return Promise.reject(new Error("Aborted"));
  }

  return new Promise<void>((resolve, reject) => {
    const waiters = getWaiterMap();
    const notify = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("Aborted"));
    };
    const cleanup = () => {
      const waiterSet = waiters.get(runId);
      if (waiterSet) {
        waiterSet.delete(notify);
        if (waiterSet.size === 0) {
          waiters.delete(runId);
        }
      }
      signal?.removeEventListener("abort", onAbort);
    };

    const waiterSet = waiters.get(runId) ?? new Set<() => void>();
    waiterSet.add(notify);
    waiters.set(runId, waiterSet);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Remove all queued entries whose metadata matches the given delegationId.
 * Used when an observe() call already consumed the delegation result —
 * the completion notification becomes redundant and would cause the model
 * to re-process the same result (duplicate/looped responses).
 */
export function removeFromQueueByDelegationId(sessionId: string, delegationId: string): number {
  const runId = getSessionIndex().get(sessionId);
  if (!runId) return 0;
  const queue = getQueueMap().get(runId);
  if (!queue || queue.length === 0) return 0;
  const before = queue.length;
  const filtered = queue.filter(
    (entry) => !(entry.metadata?.delegationId === delegationId)
  );
  if (filtered.length < before) {
    queue.length = 0;
    queue.push(...filtered);
  }
  return before - filtered.length;
}

/** Call in onFinish, onAbort, and error cleanup paths to release memory. */
export function removeLivePromptQueue(runId: string, sessionId: string): void {
  getQueueMap().delete(runId);
  getSessionIndex().delete(sessionId);
  const waiters = getWaiterMap().get(runId);
  if (waiters) {
    for (const notify of [...waiters]) {
      notify();
    }
    getWaiterMap().delete(runId);
  }
}

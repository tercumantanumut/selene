/**
 * Per-request bridge between Claude Agent SDK `tool_use_result` payloads and
 * the AI SDK passthrough tool executors that await them.
 *
 * Only used by the optional "sdk" Claude Code backend. The SDK executes its
 * tools internally and emits `tool_use` blocks the AI SDK can't match; the
 * passthrough executors (in tools-builder.ts) call `waitFor(toolCallId)` and
 * the streaming adapter calls `publish(toolCallId, output)` when the real
 * result arrives.
 */
import type { SdkToolResultBridge, SdkToolResultRecord } from "@/lib/ai/providers/mcp-context-store";

const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 250;
const MAX_BUFFERED_RESULTS = 256;
const MAX_CANCELLED_IDS = 1024;

type Waiter = (value: SdkToolResultRecord | undefined) => void;

export function createSdkToolResultBridge(): SdkToolResultBridge {
  const results = new Map<string, SdkToolResultRecord>();
  const waiters = new Map<string, Waiter[]>();
  /**
   * Tool-call IDs whose SDK stream ended without publishing a result. Waits
   * for these resolve immediately (undefined) instead of hanging — the
   * per-request bridge outlives a single SDK stream (multi-step runs), so
   * this is scoped per ID rather than disposing the whole bridge.
   */
  const cancelledIds = new Set<string>();
  let disposed = false;

  const resolveWaiters = (toolCallId: string, value: SdkToolResultRecord | undefined) => {
    const pending = waiters.get(toolCallId);
    if (!pending || pending.length === 0) return;
    waiters.delete(toolCallId);
    for (const resolve of pending) {
      resolve(value);
    }
  };

  const pruneOldestResults = () => {
    while (results.size > MAX_BUFFERED_RESULTS) {
      const oldestKey = results.keys().next().value;
      if (!oldestKey) break;
      results.delete(oldestKey);
    }
  };

  const removeWaiter = (toolCallId: string, waiter: Waiter) => {
    const queue = waiters.get(toolCallId);
    if (!queue || queue.length === 0) return;
    const next = queue.filter((entry) => entry !== waiter);
    if (next.length > 0) {
      waiters.set(toolCallId, next);
    } else {
      waiters.delete(toolCallId);
    }
  };

  const publish: SdkToolResultBridge["publish"] = (toolCallId, output, toolName) => {
    if (!toolCallId) return;
    const record = { output, ...(toolName ? { toolName } : {}) };
    results.set(toolCallId, record);
    pruneOldestResults();
    resolveWaiters(toolCallId, record);
  };

  const waitFor: SdkToolResultBridge["waitFor"] = (toolCallId, options) => {
    if (!toolCallId) return Promise.resolve(undefined);

    const existing = results.get(toolCallId);
    if (existing) {
      results.delete(toolCallId);
      return Promise.resolve(existing);
    }

    // Sticky: once the bridge is disposed or this ID was cancelled, nothing
    // can publish a result for it anymore — never park a waiter.
    if (disposed || cancelledIds.has(toolCallId)) {
      return Promise.resolve(undefined);
    }

    const abortSignal = options?.abortSignal;
    const timeoutMs =
      options?.timeoutMs === null
        ? null
        : Math.max(MIN_TIMEOUT_MS, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    return new Promise<SdkToolResultRecord | undefined>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const finish = (value: SdkToolResultRecord | undefined) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (abortSignal) {
          abortSignal.removeEventListener("abort", onAbort);
        }
        if (value) {
          results.delete(toolCallId);
        } else {
          removeWaiter(toolCallId, finish);
        }
        resolve(value);
      };

      const onAbort = () => finish(undefined);

      const queue = waiters.get(toolCallId) ?? [];
      queue.push(finish);
      waiters.set(toolCallId, queue);

      if (abortSignal) {
        if (abortSignal.aborted) {
          finish(undefined);
          return;
        }
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      if (timeoutMs !== null) {
        timeout = setTimeout(() => finish(undefined), timeoutMs);
      }
    });
  };

  const cancel: SdkToolResultBridge["cancel"] = (toolCallId) => {
    if (!toolCallId || results.has(toolCallId)) return;
    cancelledIds.add(toolCallId);
    while (cancelledIds.size > MAX_CANCELLED_IDS) {
      const oldest = cancelledIds.values().next().value;
      if (oldest === undefined) break;
      cancelledIds.delete(oldest);
    }
    resolveWaiters(toolCallId, undefined);
  };

  /**
   * Sticky end-of-life: every pending waiter resolves with undefined and any
   * later wait resolves immediately. Buffered results are kept so an executor
   * that reaches `waitFor` after disposal still receives its real output.
   */
  const dispose: SdkToolResultBridge["dispose"] = () => {
    disposed = true;
    for (const pending of waiters.values()) {
      for (const resolve of pending) {
        resolve(undefined);
      }
    }
    waiters.clear();
  };

  return {
    publish,
    waitFor,
    cancel,
    dispose,
  };
}

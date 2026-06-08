/**
 * Watchdog for stalled tool-input streaming.
 *
 * Some models (notably GPT-5.5/Codex) occasionally stall mid-tool-input —
 * they emit `tool-input-start` then stop sending deltas indefinitely,
 * leaving the chat run hung until the user manually stops. This watchdog
 * arms a per-toolCallId timer that fires if no progress is observed within
 * `stallMs`. On stall it invokes `onStall` (typically: record an error
 * tool-result part, then abort the run via the chat AbortController).
 *
 * Scope: the watchdog covers the JSON-args streaming phase only. The
 * caller must disarm the timer when args are complete (the `tool-call`
 * chunk) so tool execution — which has its own timeouts — is unaffected.
 */
export interface ToolInputStallWatchdog {
  /**
   * Start or reset the timer for `toolCallId`. Call on every
   * `tool-input-start` and `tool-input-delta` chunk.
   */
  arm(toolCallId: string, toolName?: string): void;
  /**
   * Clear the timer for `toolCallId`. Call when args are complete
   * (`tool-call` chunk) or a result has arrived (`tool-result`).
   */
  disarm(toolCallId: string): void;
  /** Clear every active timer. Call on abort or run completion. */
  disarmAll(): void;
}

export interface ToolInputStallWatchdogOptions {
  /** Threshold in milliseconds. Defaults to 300_000 (5 minutes). */
  stallMs?: number;
  /**
   * Invoked once per stalled toolCallId. The watchdog has already removed
   * its own bookkeeping for that id by the time `onStall` fires; the
   * callback decides whether to abort, log, or surface a UI error.
   */
  onStall: (toolCallId: string, toolName: string, stallMs: number) => void;
  /**
   * Optional gate. When it returns true, a fired timer is suppressed
   * (e.g. the run is already aborting). Useful to avoid duplicate side
   * effects when many timers fire near-simultaneously.
   */
  isCancelled?: () => boolean;
  /** Indirection for tests — defaults to `setTimeout`. */
  setTimer?: (handler: () => void, ms: number) => unknown;
  /** Indirection for tests — defaults to `clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_STALL_MS = 300_000;

export function createToolInputStallWatchdog(
  options: ToolInputStallWatchdogOptions
): ToolInputStallWatchdog {
  const stallMs =
    typeof options.stallMs === "number" && Number.isFinite(options.stallMs) && options.stallMs > 0
      ? options.stallMs
      : DEFAULT_STALL_MS;
  const setTimer = options.setTimer ?? ((h, ms) => setTimeout(h, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const isCancelled = options.isCancelled ?? (() => false);

  const handles = new Map<string, unknown>();
  const names = new Map<string, string>();

  const arm = (toolCallId: string, toolName?: string) => {
    if (!toolCallId) return;
    const existing = handles.get(toolCallId);
    if (existing !== undefined) clearTimer(existing);
    if (toolName) names.set(toolCallId, toolName);
    // Empty string signals "we never saw a name" so callers can skip
    // synthesizing a phantom-named tool-result on stall.
    const resolvedName = names.get(toolCallId) ?? "";
    const handle = setTimer(() => {
      handles.delete(toolCallId);
      names.delete(toolCallId);
      if (isCancelled()) return;
      options.onStall(toolCallId, resolvedName, stallMs);
    }, stallMs);
    handles.set(toolCallId, handle);
  };

  const disarm = (toolCallId: string) => {
    if (!toolCallId) return;
    const handle = handles.get(toolCallId);
    if (handle !== undefined) clearTimer(handle);
    handles.delete(toolCallId);
    names.delete(toolCallId);
  };

  const disarmAll = () => {
    for (const handle of handles.values()) clearTimer(handle);
    handles.clear();
    names.clear();
  };

  return { arm, disarm, disarmAll };
}

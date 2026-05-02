import { describe, expect, it, vi } from "vitest";
import { createToolInputStallWatchdog } from "@/lib/ai/tool-input-stall-watchdog";

/**
 * The watchdog uses injected timer functions in tests so we can fire the
 * pending callback directly instead of waiting wall-clock seconds.
 */
function makeFakeTimers() {
  const pending = new Map<number, () => void>();
  let nextHandle = 1;
  const setTimer = (handler: () => void) => {
    const handle = nextHandle++;
    pending.set(handle, handler);
    return handle;
  };
  const clearTimer = (handle: unknown) => {
    pending.delete(handle as number);
  };
  const fire = (handle: number) => {
    const handler = pending.get(handle);
    if (!handler) throw new Error(`no pending timer ${handle}`);
    pending.delete(handle);
    handler();
  };
  return { setTimer, clearTimer, fire, pending };
}

describe("createToolInputStallWatchdog", () => {
  it("invokes onStall when a timer fires for an armed toolCallId", () => {
    const timers = makeFakeTimers();
    const onStall = vi.fn();
    const watchdog = createToolInputStallWatchdog({
      stallMs: 60_000,
      onStall,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    watchdog.arm("call-1", "bash");
    expect(timers.pending.size).toBe(1);

    const [handle] = Array.from(timers.pending.keys());
    timers.fire(handle);

    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledWith("call-1", "bash", 60_000);
  });

  it("disarm clears the timer and prevents onStall", () => {
    const timers = makeFakeTimers();
    const onStall = vi.fn();
    const watchdog = createToolInputStallWatchdog({
      stallMs: 1_000,
      onStall,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    watchdog.arm("call-1", "bash");
    watchdog.disarm("call-1");
    expect(timers.pending.size).toBe(0);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("re-arming the same toolCallId resets the existing timer (only one fires)", () => {
    const timers = makeFakeTimers();
    const onStall = vi.fn();
    const watchdog = createToolInputStallWatchdog({
      stallMs: 1_000,
      onStall,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    watchdog.arm("call-1", "bash");
    watchdog.arm("call-1");
    watchdog.arm("call-1");
    // Only the most recent timer should remain pending.
    expect(timers.pending.size).toBe(1);

    const [handle] = Array.from(timers.pending.keys());
    timers.fire(handle);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("disarmAll clears every active timer", () => {
    const timers = makeFakeTimers();
    const onStall = vi.fn();
    const watchdog = createToolInputStallWatchdog({
      stallMs: 1_000,
      onStall,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    watchdog.arm("a", "bash");
    watchdog.arm("b", "Read");
    watchdog.arm("c", "Glob");
    expect(timers.pending.size).toBe(3);

    watchdog.disarmAll();
    expect(timers.pending.size).toBe(0);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("isCancelled gate suppresses onStall for fired timers", () => {
    const timers = makeFakeTimers();
    const onStall = vi.fn();
    let cancelled = false;
    const watchdog = createToolInputStallWatchdog({
      stallMs: 1_000,
      onStall,
      isCancelled: () => cancelled,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    watchdog.arm("call-1", "bash");
    cancelled = true;
    const [handle] = Array.from(timers.pending.keys());
    timers.fire(handle);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("falls back to default 60s when stallMs is invalid", () => {
    const timers = makeFakeTimers();
    const onStall = vi.fn();
    const watchdog = createToolInputStallWatchdog({
      stallMs: -1,
      onStall,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    watchdog.arm("call-1", "bash");
    const [handle] = Array.from(timers.pending.keys());
    timers.fire(handle);
    expect(onStall).toHaveBeenCalledWith("call-1", "bash", 60_000);
  });

  it("retains the toolName captured at arm time across re-arms without a name", () => {
    const timers = makeFakeTimers();
    const onStall = vi.fn();
    const watchdog = createToolInputStallWatchdog({
      stallMs: 1_000,
      onStall,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    watchdog.arm("call-1", "bash");
    watchdog.arm("call-1"); // no name on subsequent delta
    const [handle] = Array.from(timers.pending.keys());
    timers.fire(handle);
    expect(onStall).toHaveBeenCalledWith("call-1", "bash", 1_000);
  });

  it("passes empty toolName when no name was ever provided so callers can skip phantom side-effects", () => {
    // Regression: previously this fell back to the literal string "tool",
    // which then round-tripped to the model on the next turn as a phantom
    // function call named `tool` (confusing GPT-5/Codex reasoning).
    const timers = makeFakeTimers();
    const onStall = vi.fn();
    const watchdog = createToolInputStallWatchdog({
      stallMs: 1_000,
      onStall,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    watchdog.arm("call-1");
    const [handle] = Array.from(timers.pending.keys());
    timers.fire(handle);
    expect(onStall).toHaveBeenCalledWith("call-1", "", 1_000);
  });

  it("ignores empty toolCallIds for arm and disarm", () => {
    const timers = makeFakeTimers();
    const onStall = vi.fn();
    const watchdog = createToolInputStallWatchdog({
      stallMs: 1_000,
      onStall,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    watchdog.arm("");
    expect(timers.pending.size).toBe(0);
    watchdog.disarm(""); // must not throw
    expect(onStall).not.toHaveBeenCalled();
  });
});

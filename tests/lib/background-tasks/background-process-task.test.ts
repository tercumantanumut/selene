import { describe, expect, it } from "vitest";

import { statusForBackgroundProcess } from "@/lib/background-tasks/background-process-task";
import type { BackgroundProcessInfo } from "@/lib/command-execution/types";

function makeInfo(overrides: Partial<BackgroundProcessInfo> = {}): BackgroundProcessInfo {
  return {
    id: "bg-1",
    command: "npm",
    args: ["run", "dev"],
    cwd: "/workspace",
    startedAt: Date.now() - 5000,
    settledAt: Date.now(),
    running: false,
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    process: null as never,
    timeoutId: null,
    ...overrides,
  };
}

describe("statusForBackgroundProcess", () => {
  it("returns running while the process is alive", () => {
    expect(statusForBackgroundProcess(makeInfo({ running: true, settledAt: null }))).toBe("running");
  });

  it("returns cancelled for an explicit kill even before exitCode/signal arrive", () => {
    // Regression: killBackgroundProcess() marks running=false synchronously,
    // before the child's async "close" event delivers exitCode/signal. The
    // old mapping inferred "failed" from exitCode !== 0 and triggered a
    // spurious failure toast for user-initiated stops.
    expect(
      statusForBackgroundProcess(
        makeInfo({ settleReason: "killed", exitCode: null, signal: null }),
      ),
    ).toBe("cancelled");
  });

  it("returns failed for a timeout", () => {
    expect(statusForBackgroundProcess(makeInfo({ settleReason: "timeout" }))).toBe("failed");
  });

  it("returns failed for a spawn error", () => {
    expect(statusForBackgroundProcess(makeInfo({ settleReason: "spawn-error" }))).toBe("failed");
  });

  it("returns cancelled when the process was terminated by a signal", () => {
    expect(
      statusForBackgroundProcess(makeInfo({ settleReason: "exit", signal: "SIGTERM" })),
    ).toBe("cancelled");
  });

  it("maps natural exit codes to succeeded/failed", () => {
    expect(statusForBackgroundProcess(makeInfo({ settleReason: "exit", exitCode: 0 }))).toBe("succeeded");
    expect(statusForBackgroundProcess(makeInfo({ settleReason: "exit", exitCode: 1 }))).toBe("failed");
  });

  it("falls back instead of guessing when a settled process has no exit info", () => {
    expect(statusForBackgroundProcess(makeInfo({ exitCode: null, signal: null }))).toBe("cancelled");
    expect(statusForBackgroundProcess(makeInfo({ exitCode: null, signal: null }), "stale")).toBe("stale");
  });

  it("uses the fallback when process info is missing entirely", () => {
    expect(statusForBackgroundProcess(undefined)).toBe("cancelled");
    expect(statusForBackgroundProcess(undefined, "stale")).toBe("stale");
  });
});

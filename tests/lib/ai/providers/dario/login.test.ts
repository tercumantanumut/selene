import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { spawnMock, stopDarioSidecarAndWait } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  stopDarioSidecarAndWait: vi.fn(async () => undefined),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("@/lib/ai/providers/dario/sidecar", () => ({
  stopDarioSidecarAndWait,
}));

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn> };
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn() };
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return true;
  });
  return child;
}

describe("dario/login output capture", () => {
  let dataDir: string;
  let previousDataPath: string | undefined;
  let previousBin: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
    stopDarioSidecarAndWait.mockClear();
    delete (globalThis as any).__seleneDarioClaudeLogin;

    dataDir = mkdtempSync(join(tmpdir(), "selene-dario-login-"));
    previousDataPath = process.env.LOCAL_DATA_PATH;
    previousBin = process.env.SELENE_DARIO_BIN;
    process.env.LOCAL_DATA_PATH = dataDir;
    process.env.SELENE_DARIO_BIN = "dario-test";
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (previousDataPath === undefined) delete process.env.LOCAL_DATA_PATH;
    else process.env.LOCAL_DATA_PATH = previousDataPath;
    if (previousBin === undefined) delete process.env.SELENE_DARIO_BIN;
    else process.env.SELENE_DARIO_BIN = previousBin;
    delete (globalThis as any).__seleneDarioClaudeLogin;
  });

  it("captures an OAuth URL split across stdout chunks", async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const { startClaudeLogin } = await import("@/lib/ai/providers/dario/login");

    const started = startClaudeLogin();
    child.stdout.emit("data", Buffer.from("Open https://claude.ai/oa"));
    child.stdout.emit("data", Buffer.from("uth?code=abc\n"));

    const result = await started;

    expect(result.url).toBe("https://claude.ai/oauth?code=abc");
    expect(result.output).toEqual(["Open https://claude.ai/oauth?code=abc"]);
  });

  it("detects successful login output split across chunks", async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const { startClaudeLogin } = await import("@/lib/ai/providers/dario/login");

    const started = startClaudeLogin();
    child.stdout.emit("data", Buffer.from("Login suc"));
    child.stdout.emit("data", Buffer.from("cessful!\n"));

    const result = await started;

    expect(result.output).toEqual(["Login successful!"]);
    expect(stopDarioSidecarAndWait).toHaveBeenCalledTimes(1);
  });

  it("captures command output split across chunks as one line", async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const { refreshClaudeLogin } = await import("@/lib/ai/providers/dario/login");

    const refreshed = refreshClaudeLogin();
    child.stdout.emit("data", Buffer.from("Refresh suc"));
    child.stdout.emit("data", Buffer.from("cessful!\n"));
    child.exitCode = 0;
    child.emit("exit", 0, null);

    const result = await refreshed;

    expect(result.status).toBe("success");
    expect(result.output).toEqual(["Refresh successful!"]);
    expect(stopDarioSidecarAndWait).toHaveBeenCalledTimes(1);
  });
});

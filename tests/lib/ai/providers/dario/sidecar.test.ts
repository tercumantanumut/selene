import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

type FakeChild = EventEmitter & {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function makeStream(): NodeJS.ReadableStream {
  const stream = new EventEmitter() as NodeJS.ReadableStream & { setEncoding: ReturnType<typeof vi.fn> };
  stream.setEncoding = vi.fn();
  return stream;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = makeStream();
  child.stderr = makeStream();
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

function darioStatusResponse(status = 200): Response {
  return new Response(JSON.stringify({ authenticated: false, status: "none" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("dario/sidecar", () => {
  let dataDir: string;
  let previousDataPath: string | undefined;
  let previousPort: string | undefined;
  let previousBin: string | undefined;
  let previousAllowExternal: string | undefined;
  let previousFetch: typeof globalThis.fetch;
  let previousAnthropicUpstream: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
    delete (globalThis as any).__seleneDarioSidecar;
    delete (globalThis as any).__seleneDarioSidecarStart;
    delete (globalThis as any).__seleneDarioExitHooked;

    dataDir = mkdtempSync(join(tmpdir(), "selene-dario-sidecar-"));
    previousDataPath = process.env.LOCAL_DATA_PATH;
    previousPort = process.env.SELENE_DARIO_PORT;
    previousBin = process.env.SELENE_DARIO_BIN;
    previousAllowExternal = process.env.SELENE_DARIO_ALLOW_EXTERNAL;
    previousAnthropicUpstream = process.env.ANTHROPIC_UPSTREAM_API_KEY;
    previousFetch = globalThis.fetch;

    process.env.LOCAL_DATA_PATH = dataDir;
    process.env.SELENE_DARIO_PORT = "4568";
    process.env.SELENE_DARIO_BIN = "dario-test";
    process.env.ANTHROPIC_UPSTREAM_API_KEY = "must-not-leak";
    delete process.env.SELENE_DARIO_ALLOW_EXTERNAL;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (previousDataPath === undefined) delete process.env.LOCAL_DATA_PATH;
    else process.env.LOCAL_DATA_PATH = previousDataPath;
    if (previousPort === undefined) delete process.env.SELENE_DARIO_PORT;
    else process.env.SELENE_DARIO_PORT = previousPort;
    if (previousBin === undefined) delete process.env.SELENE_DARIO_BIN;
    else process.env.SELENE_DARIO_BIN = previousBin;
    if (previousAllowExternal === undefined) delete process.env.SELENE_DARIO_ALLOW_EXTERNAL;
    else process.env.SELENE_DARIO_ALLOW_EXTERNAL = previousAllowExternal;
    if (previousAnthropicUpstream === undefined) delete process.env.ANTHROPIC_UPSTREAM_API_KEY;
    else process.env.ANTHROPIC_UPSTREAM_API_KEY = previousAnthropicUpstream;
    globalThis.fetch = previousFetch;
    delete (globalThis as any).__seleneDarioSidecar;
    delete (globalThis as any).__seleneDarioSidecarStart;
    delete (globalThis as any).__seleneDarioExitHooked;
  });

  it("spawns dario proxy with Selene-owned env and treats /health 503 as listening", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response("{}", { status: 503 });
      if (url.endsWith("/status")) return darioStatusResponse();
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const { ensureDarioSidecarReady } = await import("@/lib/ai/providers/dario/sidecar");
    const ready = await ensureDarioSidecarReady();

    expect(ready.port).toBe(4568);
    expect(ready.baseUrl).toBe("http://127.0.0.1:4568/v1");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [binary, args, options] = spawnMock.mock.calls[0];
    expect(binary).toBe("dario-test");
    expect(args).toEqual(["proxy", "--port=4568", "--host=127.0.0.1"]);
    expect(options.env.DARIO_API_KEY).toMatch(/^selene-dario-/);
    expect(options.env.DARIO_PORT).toBe("4568");
    expect(options.env.DARIO_HOST).toBe("127.0.0.1");
    expect(options.env.ANTHROPIC_UPSTREAM_API_KEY).toBeUndefined();
  });

  it("single-flights concurrent startup calls", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    let releaseHealth!: () => void;
    const healthGate = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        await healthGate;
        return new Response("{}", { status: 200 });
      }
      if (url.endsWith("/status")) return darioStatusResponse();
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const { ensureDarioSidecarReady } = await import("@/lib/ai/providers/dario/sidecar");
    const first = ensureDarioSidecarReady();
    const second = ensureDarioSidecarReady();
    releaseHealth();

    await Promise.all([first, second]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("retries once when the spawned dario exits during startup", async () => {
    const firstChild = makeChild();
    const retryChild = makeChild();
    spawnMock
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(retryChild);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response("{}", { status: 200 });
      if (url.endsWith("/status")) return darioStatusResponse();
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const { ensureDarioSidecarReady } = await import("@/lib/ai/providers/dario/sidecar");
    const promise = ensureDarioSidecarReady();
    // first child detects port taken and exits
    firstChild.exitCode = 0;
    firstChild.emit("exit", 0, null);

    const ready = await promise;
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(ready.port).toBe(4568);
  });

  it("does not retry indefinitely when spawned dario exits during startup", async () => {
    spawnMock.mockImplementation(() => {
      const child = makeChild();
      setTimeout(() => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      }, 0);
      return child;
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response("{}", { status: 200 });
      if (url.endsWith("/status")) return darioStatusResponse();
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const { ensureDarioSidecarReady } = await import("@/lib/ai/providers/dario/sidecar");
    await expect(ensureDarioSidecarReady()).rejects.toThrow(/exited during startup after retry/);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("fails when /status rejects Selene's API key", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response("{}", { status: 200 });
      if (url.endsWith("/status")) return darioStatusResponse(401);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const { ensureDarioSidecarReady } = await import("@/lib/ai/providers/dario/sidecar");
    await expect(ensureDarioSidecarReady()).rejects.toThrow(/rejected Selene's API key/);
  });
});

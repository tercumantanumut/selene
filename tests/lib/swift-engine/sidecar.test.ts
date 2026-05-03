/**
 * Unit tests for SwiftEngineSidecarImpl.
 *
 * Strategy: stub `child_process.spawn` with a fake ChildProcess that exposes
 * stdin (a Writable that captures writes) and stdout (a Readable we drive
 * with simulated JSON-RPC frames). Tests cover the full lifecycle matrix:
 *
 *   a. spawn argv (binary path, --stdio, --data-dir)
 *   b. initialize handshake → state ready
 *   c. startup timeout → state stopped + lastError
 *   d. sendRequest before ready → SwiftEngineUnavailableError(starting)
 *   e. sendRequest correlation by id
 *   f. requestTimeoutMs exceeded → reject + error count
 *   g. unexpected exit → state degraded → restart attempted
 *   h. dispose → SIGTERM, then SIGKILL after 2s
 *   i. health() snapshot reflects requests/errors counts
 *   j. concurrent sendRequest → no id collisions
 *
 * Plus an integration smoke that actually spawns the real binary, gated on
 * SWIFT_ENGINE_INTEGRATION_TEST=1 so CI without the binary skips cleanly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { PassThrough, Writable } from "stream";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SwiftEngineSidecarImpl } from "@/lib/swift-engine/sidecar";
import {
  SwiftEngineUnavailableError,
  type SwiftEngineSidecar,
} from "@/lib/swift-engine/types";

// ---------------------------------------------------------------------------
// Fake child_process.spawn
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  /** Lines the child has received on stdin, one per `\n`-terminated frame. */
  receivedLines: string[];
  /** Spies for kill signals. */
  kill: ReturnType<typeof vi.fn>;
  /** Drive a JSON-RPC message into stdout. */
  emitFrame: (frame: object) => void;
  /** Simulate the child exiting (sets exitCode/signal, fires "exit"+"close"). */
  simulateExit: (code: number | null, signal?: NodeJS.Signals | null) => void;
}

interface FakeSpawnRecord {
  command: string;
  args: string[];
  options: unknown;
  child: FakeChild;
}

function makeFakeChild(): FakeChild {
  const emitter = new EventEmitter() as unknown as FakeChild;
  emitter.pid = Math.floor(1000 + Math.random() * 1000);
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.killed = false;
  emitter.receivedLines = [];

  // stdin: a Writable that captures whole \n-delimited frames.
  let stdinBuffer = "";
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinBuffer += chunk.toString("utf-8");
      let nl = stdinBuffer.indexOf("\n");
      while (nl !== -1) {
        emitter.receivedLines.push(stdinBuffer.slice(0, nl));
        stdinBuffer = stdinBuffer.slice(nl + 1);
        nl = stdinBuffer.indexOf("\n");
      }
      cb();
    },
  });
  emitter.stdin = stdin;

  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();

  emitter.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    emitter.killed = true;
    if (typeof signal === "string") {
      emitter.signalCode = signal;
    }
    return true;
  });

  emitter.emitFrame = (frame: object) => {
    emitter.stdout.write(JSON.stringify(frame) + "\n");
  };

  emitter.simulateExit = (
    code: number | null,
    signal: NodeJS.Signals | null = null,
  ) => {
    emitter.exitCode = code;
    emitter.signalCode = signal;
    emitter.emit("exit", code, signal);
    emitter.emit("close", code, signal);
  };

  return emitter;
}

function makeFakeSpawnFactory(records: FakeSpawnRecord[]): {
  spawnFn: any;
  records: FakeSpawnRecord[];
} {
  const spawnFn = ((command: string, args: string[], options: unknown) => {
    const child = makeFakeChild();
    records.push({ command, args, options, child });
    return child as any;
  }) as any;
  return { spawnFn, records };
}

/** Find the JSON-RPC line carrying the given method, parsing it. */
function findRequest(
  child: FakeChild,
  method: string,
): { id: string | number; params?: any } | null {
  for (const line of child.receivedLines) {
    try {
      const obj = JSON.parse(line);
      if (obj && obj.method === method && obj.id !== undefined) {
        return { id: obj.id, params: obj.params };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test fixture: temp tree with a fake "selene-engine" file so binary-resolver
// passes its existence check. The file is never actually executed because we
// inject a fake spawn function.
// ---------------------------------------------------------------------------

let tmpRoot: string;
let fakeBinary: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "selene-sidecar-"));
  fakeBinary = path.join(tmpRoot, "selene-engine");
  fs.writeFileSync(fakeBinary, "#!/bin/sh\n", { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

// Helper: respond to whatever initialize id the supervisor sent.
function respondInitialize(child: FakeChild): boolean {
  const req = findRequest(child, "initialize");
  if (!req) return false;
  child.emitFrame({
    jsonrpc: "2.0",
    id: req.id,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: "selene-engine", version: "0.1.0" },
    },
  });
  return true;
}

/** Wait for the supervisor to write at least one initialize line. */
async function waitForInitialize(child: FakeChild, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (findRequest(child, "initialize")) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for initialize line");
}

/** Wait until the fake spawn factory has recorded at least `n` spawns. */
async function waitForSpawnCount(
  records: FakeSpawnRecord[],
  n: number,
  attempts = 100,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (records.length >= n) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${n} spawn(s); got ${records.length}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SwiftEngineSidecarImpl", () => {
  it("(a) start() spawns the binary with --stdio + --data-dir", async () => {
    const records: FakeSpawnRecord[] = [];
    const { spawnFn } = makeFakeSpawnFactory(records);
    const sidecar = new SwiftEngineSidecarImpl(spawnFn);

    const startPromise = sidecar.start({
      binaryPath: fakeBinary,
      dataDir: "/tmp/selene-data",
      autoRestart: false,
    });

    // Wait for the supervisor's mutex to actually issue the spawn.
    await waitForSpawnCount(records, 1);
    expect(records).toHaveLength(1);
    expect(records[0].command).toBe(fakeBinary);
    expect(records[0].args).toContain("--stdio");
    expect(records[0].args).toContain("--data-dir");
    expect(records[0].args).toContain("/tmp/selene-data");

    // Complete the handshake so start() resolves.
    await waitForSpawnCount(records, 1);
    await waitForInitialize(records[0].child);
    respondInitialize(records[0].child);
    await startPromise;
  });

  it("(b) start() awaits initialize handshake; isReady() true", async () => {
    const records: FakeSpawnRecord[] = [];
    const { spawnFn } = makeFakeSpawnFactory(records);
    const sidecar = new SwiftEngineSidecarImpl(spawnFn);

    const p = sidecar.start({ binaryPath: fakeBinary, autoRestart: false });
    await waitForSpawnCount(records, 1);
    await waitForInitialize(records[0].child);
    expect(sidecar.isReady()).toBe(false); // still starting
    respondInitialize(records[0].child);
    await p;
    expect(sidecar.isReady()).toBe(true);
    expect(sidecar.health().state).toBe("ready");
  });

  it("(c) start() startupTimeoutMs exceeded → state stopped + lastError", async () => {
    const records: FakeSpawnRecord[] = [];
    const { spawnFn } = makeFakeSpawnFactory(records);
    const sidecar = new SwiftEngineSidecarImpl(spawnFn);

    await expect(
      sidecar.start({
        binaryPath: fakeBinary,
        autoRestart: false,
        startupTimeoutMs: 50,
      }),
    ).rejects.toThrow(SwiftEngineUnavailableError);

    const health = sidecar.health();
    expect(health.state).toBe("stopped");
    expect(health.lastError).toMatch(/startup timeout/);
  });

  it("(d) sendRequest before ready → throws SwiftEngineUnavailableError(starting)", async () => {
    const records: FakeSpawnRecord[] = [];
    const { spawnFn } = makeFakeSpawnFactory(records);
    const sidecar = new SwiftEngineSidecarImpl(spawnFn);

    // Kick off start() but don't await. The supervisor should be in "starting".
    const startPromise = sidecar
      .start({ binaryPath: fakeBinary, autoRestart: false, startupTimeoutMs: 100 })
      .catch(() => {});

    // Wait for the spawn to happen so state has flipped to "starting".
    await waitForSpawnCount(records, 1);
    expect(sidecar.health().state).toBe("starting");

    let caught: unknown = null;
    try {
      await sidecar.sendRequest({ method: "tools/list", params: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SwiftEngineUnavailableError);
    expect((caught as SwiftEngineUnavailableError).state).toBe("starting");

    await startPromise;
  });

  it("(e) sendRequest correlates response by id", async () => {
    const records: FakeSpawnRecord[] = [];
    const { spawnFn } = makeFakeSpawnFactory(records);
    const sidecar: SwiftEngineSidecar = new SwiftEngineSidecarImpl(spawnFn);

    const p = sidecar.start({ binaryPath: fakeBinary, autoRestart: false });
    await waitForSpawnCount(records, 1);
    await waitForInitialize(records[0].child);
    respondInitialize(records[0].child);
    await p;

    const child = records[0].child;
    const requestPromise = sidecar.sendRequest({
      method: "search/query",
      params: { q: "hello" },
    });

    // Find what id the supervisor used.
    let req: { id: string | number; params?: any } | null = null;
    for (let i = 0; i < 50; i++) {
      req = findRequest(child, "search/query");
      if (req) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(req).not.toBeNull();

    // Echo a matching response.
    child.emitFrame({
      jsonrpc: "2.0",
      id: req!.id,
      result: { hits: ["a", "b"] },
    });

    const resp = await requestPromise;
    expect(resp.result).toEqual({ hits: ["a", "b"] });
  });

  it("(f) sendRequest requestTimeoutMs exceeded rejects + increments errors", async () => {
    const records: FakeSpawnRecord[] = [];
    const { spawnFn } = makeFakeSpawnFactory(records);
    const sidecar = new SwiftEngineSidecarImpl(spawnFn);

    const p = sidecar.start({
      binaryPath: fakeBinary,
      autoRestart: false,
      requestTimeoutMs: 50,
    });
    await waitForSpawnCount(records, 1);
    await waitForInitialize(records[0].child);
    respondInitialize(records[0].child);
    await p;

    await expect(
      sidecar.sendRequest({ method: "search/query", params: {} }),
    ).rejects.toThrow(/timed out/);

    const health = sidecar.health();
    expect(health.totals.requests).toBe(1);
    expect(health.totals.errors).toBeGreaterThanOrEqual(1);
  });

  it("(g) unexpected child exit → state degraded → restart spawned", async () => {
    const records: FakeSpawnRecord[] = [];
    const { spawnFn } = makeFakeSpawnFactory(records);
    const sidecar = new SwiftEngineSidecarImpl(spawnFn);

    const p = sidecar.start({ binaryPath: fakeBinary });
    await waitForSpawnCount(records, 1);
    await waitForInitialize(records[0].child);
    respondInitialize(records[0].child);
    await p;

    expect(sidecar.isReady()).toBe(true);

    // Crash the child unexpectedly.
    records[0].child.simulateExit(137, "SIGKILL");

    // State should flip to "degraded" and a restart should be queued.
    const health = sidecar.health();
    expect(["degraded", "stopped"]).toContain(health.state);
    expect(health.totals.restarts).toBe(1);

    // Restart fires after RESTART_BACKOFF_MS=1000ms; wait for the second spawn.
    for (let i = 0; i < 60; i++) {
      if (records.length >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(records.length).toBeGreaterThanOrEqual(2);

    // Clean up: respond to the second initialize so the restart settles.
    await waitForInitialize(records[1].child);
    respondInitialize(records[1].child);
    // Drain anything in flight.
    await new Promise((r) => setTimeout(r, 20));
  });

  it("(h) dispose() sends SIGTERM then SIGKILL after grace, state stopped", async () => {
    const records: FakeSpawnRecord[] = [];
    const { spawnFn } = makeFakeSpawnFactory(records);
    const sidecar = new SwiftEngineSidecarImpl(spawnFn);

    const p = sidecar.start({ binaryPath: fakeBinary, autoRestart: false });
    await waitForSpawnCount(records, 1);
    await waitForInitialize(records[0].child);
    respondInitialize(records[0].child);
    await p;

    const child = records[0].child;
    // Don't acknowledge SIGTERM immediately — let the SIGKILL escalation fire.
    const disposePromise = sidecar.dispose();

    // Give the supervisor time to issue SIGTERM + escalate to SIGKILL.
    // Use a real clock; DISPOSE_GRACE_MS = 2000.
    await new Promise((r) => setTimeout(r, 50));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    // Now wait for SIGKILL escalation and child exit.
    setTimeout(() => child.simulateExit(null, "SIGKILL"), 2050);
    await disposePromise;

    // SIGKILL must have been sent before exit was simulated.
    const sigkillCall = (child.kill as any).mock.calls.find(
      (call: any[]) => call[0] === "SIGKILL",
    );
    expect(sigkillCall).toBeTruthy();
    expect(sidecar.health().state).toBe("stopped");
  }, 10000);

  it("(i) health() reflects request + error counts", async () => {
    const records: FakeSpawnRecord[] = [];
    const { spawnFn } = makeFakeSpawnFactory(records);
    const sidecar = new SwiftEngineSidecarImpl(spawnFn);

    const p = sidecar.start({
      binaryPath: fakeBinary,
      autoRestart: false,
      requestTimeoutMs: 30,
    });
    await waitForSpawnCount(records, 1);
    await waitForInitialize(records[0].child);
    respondInitialize(records[0].child);
    await p;

    const child = records[0].child;

    // One successful request.
    const ok = sidecar.sendRequest({ method: "ping", params: {} });
    for (let i = 0; i < 50; i++) {
      const req = findRequest(child, "ping");
      if (req) {
        child.emitFrame({ jsonrpc: "2.0", id: req.id, result: "pong" });
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    await ok;

    // One that times out.
    await expect(
      sidecar.sendRequest({ method: "slow", params: {} }),
    ).rejects.toThrow(/timed out/);

    const health = sidecar.health();
    expect(health.totals.requests).toBe(2);
    expect(health.totals.errors).toBeGreaterThanOrEqual(1);
    expect(health.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(health.pid).toBe(child.pid);
  });

  it("(j) concurrent sendRequest — all complete with no id collisions", async () => {
    const records: FakeSpawnRecord[] = [];
    const { spawnFn } = makeFakeSpawnFactory(records);
    const sidecar = new SwiftEngineSidecarImpl(spawnFn);

    const p = sidecar.start({ binaryPath: fakeBinary, autoRestart: false });
    await waitForSpawnCount(records, 1);
    await waitForInitialize(records[0].child);
    respondInitialize(records[0].child);
    await p;

    const child = records[0].child;

    // Fire 5 requests concurrently. They all use distinct method names so we
    // can correlate, but the supervisor has to mint distinct ids regardless.
    const inFlight = ["a", "b", "c", "d", "e"].map((tag) =>
      sidecar.sendRequest({ method: `op/${tag}`, params: { tag } }),
    );

    // Wait until all 5 lines have been written, then echo unique results.
    const idsSeen = new Set<string | number>();
    for (let attempt = 0; attempt < 100 && idsSeen.size < 5; attempt++) {
      for (const tag of ["a", "b", "c", "d", "e"]) {
        const req = findRequest(child, `op/${tag}`);
        if (req && !idsSeen.has(req.id)) {
          idsSeen.add(req.id);
          child.emitFrame({
            jsonrpc: "2.0",
            id: req.id,
            result: { tag },
          });
        }
      }
      if (idsSeen.size < 5) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    expect(idsSeen.size).toBe(5);

    const results = await Promise.all(inFlight);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.result).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Optional integration smoke against the real binary.
// Gated on SWIFT_ENGINE_INTEGRATION_TEST=1 so CI without the binary skips.
// ---------------------------------------------------------------------------

const integrationBinary =
  "/Users/ogkai/Documents/swiftapp/.build/release-bundle/macos/arm64/selene-engine";

const runIntegration =
  process.env.SWIFT_ENGINE_INTEGRATION_TEST === "1" &&
  fs.existsSync(integrationBinary);

describe.runIf(runIntegration)("SwiftEngineSidecarImpl integration", () => {
  it("performs a real initialize handshake against the bundled binary", async () => {
    const sidecar = new SwiftEngineSidecarImpl();
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "selene-sidecar-int-"),
    );
    try {
      await sidecar.start({
        binaryPath: integrationBinary,
        dataDir,
        autoRestart: false,
        startupTimeoutMs: 10_000,
      });
      expect(sidecar.isReady()).toBe(true);
      const health = sidecar.health();
      expect(health.state).toBe("ready");
      expect(health.pid).toBeGreaterThan(0);
    } finally {
      await sidecar.dispose();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

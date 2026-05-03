/**
 * SwiftEngineSidecar — supervisor that owns the lifecycle of the
 * selene-engine binary running as an Electron sidecar.
 *
 * Responsibilities:
 *   - Spawn the binary in `--stdio` mode
 *   - Perform the MCP initialize handshake
 *   - Multiplex JSON-RPC requests over a single stdio pipe
 *   - Auto-restart on unexpected exit (bounded: 3 restarts in 60s)
 *   - Graceful shutdown (close stdin → SIGTERM → SIGKILL after 2s)
 *
 * This is a NEW sidecar pattern, parallel to lib/mcp/stdio-transport.ts.
 * They intentionally do NOT share code — the MCP transport spawns Node-based
 * MCP servers (with bundled-node fallbacks, ELECTRON_RUN_AS_NODE shenanigans,
 * etc), while this supervisor spawns a NATIVE binary and has zero need for
 * any of that node-runtime gymnastics.
 *
 * Phase 1 ship constraint: SEARCH_ENGINE config defaults to "lance" so a
 * sidecar startup failure must NEVER block app boot. Callers should treat
 * SwiftEngineUnavailableError as "fall back to LanceDB".
 */

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  type SwiftEngineHealth,
  type SwiftEngineRequest,
  type SwiftEngineResponse,
  type SwiftEngineSidecar,
  type SwiftEngineSidecarState,
  type SwiftEngineSpawnOptions,
  SwiftEngineUnavailableError,
} from "./types";
import { resolveBinaryPath } from "./binary-resolver";
import {
  decodeResponses,
  encodeNotification,
  encodeRequest,
  type DecodedFrame,
  type JsonRpcResponse,
} from "./json-rpc-codec";

const DEFAULT_STARTUP_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const RESTART_BACKOFF_MS = 1000;
const RESTART_LIMIT = 3;
const RESTART_WINDOW_MS = 60_000;
const DISPOSE_GRACE_MS = 2000;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "selene-electron";
const CLIENT_VERSION = "0.1.0";

/** Test seam: child_process.spawn factory. Tests can override. */
export type SpawnFn = typeof spawn;

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Per-instance configuration that survives across restart cycles. */
interface ResolvedSpawnConfig {
  binaryPath: string;
  dataDir: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  autoRestart: boolean;
}

export class SwiftEngineSidecarImpl implements SwiftEngineSidecar {
  private state: SwiftEngineSidecarState = "idle";
  private child: ChildProcess | null = null;
  private startedAt: number | null = null;
  private lastError: string | undefined;
  private totals = { requests: 0, errors: 0, restarts: 0 };
  private manifest: SwiftEngineHealth["manifest"] | undefined;
  private manifestLoaded = false;

  private nextRequestId = 1;
  private pending = new Map<string, PendingRequest>();
  private stdoutBuffer = "";
  private stderrBuffer = "";

  private restartTimestamps: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private intentionalShutdown = false;

  private resolved: ResolvedSpawnConfig | null = null;
  private startPromise: Promise<void> | null = null;
  private spawnFn: SpawnFn;

  /** Mutex chain: every state-mutating action serializes through this promise. */
  private mutex: Promise<void> = Promise.resolve();

  constructor(spawnFn: SpawnFn = spawn) {
    this.spawnFn = spawnFn;
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------

  async start(options: SwiftEngineSpawnOptions = {}): Promise<void> {
    if (this.disposed) {
      throw new SwiftEngineUnavailableError(
        "stopped",
        "sidecar has been disposed",
      );
    }
    if (this.state === "ready") return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.runMutex(() => this.startInternal(options))
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  async sendRequest<TParams = unknown, TResult = unknown>(
    request: SwiftEngineRequest<TParams>,
  ): Promise<SwiftEngineResponse<TResult>> {
    if (this.state !== "ready") {
      throw new SwiftEngineUnavailableError(
        this.state,
        `cannot send "${request.method}" — sidecar state is ${this.state}`,
      );
    }
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) {
      throw new SwiftEngineUnavailableError(
        this.state,
        "child stdin not writable",
      );
    }

    const id = `req-${this.nextRequestId++}`;
    const wire = encodeRequest(id, request.method, request.params);
    const timeoutMs =
      this.resolved?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    this.totals.requests += 1;

    return new Promise<SwiftEngineResponse<TResult>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.totals.errors += 1;
          this.lastError = `request "${request.method}" timed out after ${timeoutMs}ms`;
          reject(new Error(this.lastError));
        }
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        resolve: (resp) => {
          if (resp && (resp as JsonRpcResponse).hasOwnProperty("error")) {
            this.totals.errors += 1;
          }
          // Strip the JSON-RPC envelope to match SwiftEngineResponse shape.
          const out: SwiftEngineResponse<TResult> = {};
          const r = resp as JsonRpcResponse<TResult>;
          if ("result" in r) out.result = (r as { result: TResult }).result;
          if ("error" in r) out.error = (r as { error: SwiftEngineResponse["error"] }).error;
          resolve(out);
        },
        reject: (err) => {
          this.totals.errors += 1;
          reject(err);
        },
        timer,
      });

      try {
        const ok = child.stdin!.write(wire);
        if (!ok) {
          // Drain back-pressure is normally fine; the request just sits in
          // the pending map until the response arrives or the timeout fires.
          child.stdin!.once("drain", () => {
            // no-op; just consume the event so it doesn't accumulate
          });
        }
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.totals.errors += 1;
        reject(
          err instanceof Error
            ? err
            : new Error(`stdin write failed: ${String(err)}`),
        );
      }
    });
  }

  isReady(): boolean {
    return this.state === "ready";
  }

  health(): SwiftEngineHealth {
    if (!this.manifestLoaded && this.resolved) {
      this.manifest = this.loadManifest(this.resolved.binaryPath);
      this.manifestLoaded = true;
    }
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      lastError: this.lastError,
      totals: { ...this.totals },
      manifest: this.manifest,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.intentionalShutdown = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    return this.runMutex(async () => {
      const child = this.child;
      if (!child) {
        this.state = "stopped";
        return;
      }

      const closePromise = new Promise<void>((resolve) => {
        const onClose = () => resolve();
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("close", onClose);
        child.once("exit", onClose);
      });

      // Close stdin first — gives the child a clean EOF to flush state.
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }

      // SIGTERM, then wait up to DISPOSE_GRACE_MS, then SIGKILL.
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }

      let timedOut = false;
      const sigkillTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, DISPOSE_GRACE_MS);
      sigkillTimer.unref?.();

      await closePromise;
      clearTimeout(sigkillTimer);
      void timedOut; // recorded only by test harness via spy

      this.state = "stopped";
      this.child = null;
      this.failAllPending(new Error("sidecar disposed"));
    });
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async runMutex<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }

  private async startInternal(options: SwiftEngineSpawnOptions): Promise<void> {
    if (this.state === "ready") return;
    if (this.disposed) {
      throw new SwiftEngineUnavailableError("stopped", "sidecar disposed");
    }

    const candidate = resolveBinaryPath({ explicit: options.binaryPath });
    if (!candidate) {
      this.state = "stopped";
      this.lastError = "selene-engine binary not found";
      throw new SwiftEngineUnavailableError("stopped", this.lastError);
    }

    const dataDir =
      options.dataDir ??
      this.resolved?.dataDir ??
      this.defaultDataDir();

    this.resolved = {
      binaryPath: candidate.path,
      dataDir,
      startupTimeoutMs:
        options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      requestTimeoutMs:
        options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      autoRestart: options.autoRestart ?? true,
    };

    this.intentionalShutdown = false;
    this.state = "starting";
    this.lastError = undefined;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    let child: ChildProcess;
    try {
      child = this.spawnFn(
        this.resolved.binaryPath,
        ["--stdio", "--data-dir", this.resolved.dataDir],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          detached: false,
          env: {
            ...process.env,
            // Prevent ANSI escapes from corrupting the JSON-RPC stream.
            TERM: "dumb",
            NO_COLOR: "1",
          },
        },
      );
    } catch (err) {
      this.state = "stopped";
      this.lastError =
        err instanceof Error ? err.message : `spawn failed: ${String(err)}`;
      throw new SwiftEngineUnavailableError("stopped", this.lastError);
    }

    this.child = child;
    this.startedAt = Date.now();
    this.attachChildHandlers(child);

    // Perform the MCP initialize handshake — bounded by startupTimeoutMs.
    try {
      await this.performInitializeHandshake(this.resolved.startupTimeoutMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = `initialize handshake failed: ${msg}`;
      this.state = "stopped";
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      this.child = null;
      throw new SwiftEngineUnavailableError("stopped", this.lastError);
    }

    this.state = "ready";
  }

  private attachChildHandlers(child: ChildProcess): void {
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      this.stdoutBuffer += text;
      const { frames, remaining } = decodeResponses(this.stdoutBuffer);
      this.stdoutBuffer = remaining;
      for (const frame of frames) {
        this.dispatchFrame(frame);
      }
    });
    child.stdout?.on("error", (err) => {
      this.lastError = `stdout error: ${err.message}`;
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      // Cap buffered stderr to avoid unbounded growth.
      this.stderrBuffer = (this.stderrBuffer + text).slice(-8192);
    });

    child.on("error", (err) => {
      this.lastError = `child error: ${err.message}`;
    });

    child.on("exit", (code, signal) => {
      this.handleChildExit(code, signal);
    });
  }

  private dispatchFrame(frame: DecodedFrame): void {
    if (frame.kind !== "response") {
      // Notifications and reverse-requests are ignored in Phase 1; the Swift
      // CLI only emits responses for our outbound requests right now.
      return;
    }
    const id = frame.message.id;
    if (id === null || id === undefined) return;
    const key = String(id);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(frame.message);
  }

  private async performInitializeHandshake(
    timeoutMs: number,
  ): Promise<void> {
    const child = this.child;
    if (!child || !child.stdin) {
      throw new Error("no child stdin");
    }

    const id = `init-${this.nextRequestId++}`;
    const wire = encodeRequest(id, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });

    const handshake = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`startup timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });

      const onEarlyExit = () => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          reject(
            new Error(
              `child exited during initialize handshake (stderr: ${this.stderrBuffer.trim().slice(-512)})`,
            ),
          );
        }
      };
      child.once("exit", onEarlyExit);

      try {
        child.stdin!.write(wire);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    const response = await handshake;
    if ("error" in response && response.error) {
      throw new Error(
        `initialize returned error: ${response.error.code} ${response.error.message}`,
      );
    }

    // Send the standard MCP "initialized" notification.
    try {
      child.stdin.write(encodeNotification("notifications/initialized"));
    } catch (err) {
      // Non-fatal: many servers don't strictly require it. Log and continue.
      console.warn(
        `[SwiftEngine] failed to send notifications/initialized: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private handleChildExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const wasRunning = this.child !== null;
    this.child = null;
    this.startedAt = null;

    if (this.intentionalShutdown || this.disposed) {
      this.state = "stopped";
      this.failAllPending(new Error("sidecar shut down"));
      return;
    }

    if (!wasRunning) {
      // Already cleaned up.
      return;
    }

    this.lastError = `child exited code=${code ?? "null"} signal=${signal ?? "null"}`;
    this.failAllPending(new Error(this.lastError));

    if (!this.resolved?.autoRestart) {
      this.state = "stopped";
      return;
    }

    // Restart bookkeeping: prune outside the rolling window, then count.
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter(
      (t) => now - t < RESTART_WINDOW_MS,
    );

    if (this.restartTimestamps.length >= RESTART_LIMIT) {
      this.state = "stopped";
      this.lastError = `restart budget exhausted (${RESTART_LIMIT} in ${RESTART_WINDOW_MS}ms)`;
      return;
    }

    this.state = "degraded";
    this.restartTimestamps.push(now);
    this.totals.restarts += 1;

    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.disposed || this.intentionalShutdown) return;
      // Replay the spawn with the previously resolved options.
      const opts: SwiftEngineSpawnOptions | undefined = this.resolved
        ? {
            binaryPath: this.resolved.binaryPath,
            dataDir: this.resolved.dataDir,
            startupTimeoutMs: this.resolved.startupTimeoutMs,
            requestTimeoutMs: this.resolved.requestTimeoutMs,
            autoRestart: this.resolved.autoRestart,
          }
        : undefined;
      this.start(opts).catch((err) => {
        this.lastError =
          err instanceof Error ? err.message : `restart failed: ${String(err)}`;
        this.state = "stopped";
      });
    }, RESTART_BACKOFF_MS);
    this.restartTimer.unref?.();
  }

  private failAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private defaultDataDir(): string {
    const baseDir =
      process.env.ELECTRON_USER_DATA_PATH ?? process.cwd();
    return path.join(baseDir, "swift-engine");
  }

  private loadManifest(
    binaryPath: string,
  ): SwiftEngineHealth["manifest"] | undefined {
    try {
      const manifestPath = path.join(
        path.dirname(binaryPath),
        "build-manifest.json",
      );
      if (!fs.existsSync(manifestPath)) return undefined;
      const raw = fs.readFileSync(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const sha256 = typeof parsed.sha256 === "string" ? parsed.sha256 : "";
      const arch = typeof parsed.arch === "string" ? parsed.arch : "";
      const swiftVersion =
        typeof parsed.swiftVersion === "string" ? parsed.swiftVersion : "";
      const builtAt = typeof parsed.builtAt === "string" ? parsed.builtAt : "";
      if (!sha256 && !arch && !swiftVersion && !builtAt) return undefined;
      return { sha256, arch, swiftVersion, builtAt };
    } catch {
      // Defensive: a malformed manifest must not crash health().
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let singleton: SwiftEngineSidecarImpl | null = null;

/** Returns the process-wide singleton supervisor. */
export function getSwiftEngineSidecar(): SwiftEngineSidecar {
  if (!singleton) {
    singleton = new SwiftEngineSidecarImpl();
  }
  return singleton;
}

/** Test-only: reset the singleton between tests. Not exported via index. */
export function __resetSwiftEngineSidecarForTests(spawnFn?: SpawnFn): void {
  singleton = new SwiftEngineSidecarImpl(spawnFn);
}

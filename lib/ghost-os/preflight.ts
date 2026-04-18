/**
 * Ghost OS Preflight
 *
 * Real preflight probe that goes beyond `ghost doctor` stdout parsing.
 * Detects the common failure modes the old wizard missed:
 *
 *  1. **TCC staleness** — macOS reports Screen Recording as granted, but
 *     actual capture fails. Happens when a prior Selene.app signature/entry
 *     was cached and the user re-installed/replaced the bundle.
 *  2. **Wrong responsible process** — the sidecar is attributed to Selene.app
 *     (TCC responsibility chain: launchd → Selene.app → next-server → ghost mcp).
 *     Granting to `/opt/homebrew/bin/ghost` has no effect; Selene.app must be
 *     the grantee.
 *  3. **Sidecar handshake failure** — binary present but MCP initialize fails
 *     (permission-denied signature, binary crash, etc.).
 *
 * The probe streams per-stage progress so the UI can render a visible
 * checklist instead of an opaque spinner.
 *
 * PLATFORM-AGNOSTIC: this module must not import `electron`. The TCC check
 * is injected by the caller (electron main passes a `permissionProbe`).
 * Server-side callers can invoke the handshake probe without TCC info.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { resolveGhostBinary } from "./setup";

// ---------------------------------------------------------------------------
// Progress stream types (mirrored in electron/preload.ts exposing `ghostos:setupProgress`)
// ---------------------------------------------------------------------------

export type PreflightStage =
  | "binary_located"
  | "permission_preflight"
  | "sidecar_spawn"
  | "mcp_handshake"
  | "first_tool_ping"
  | "complete";

export type StageStatus = "running" | "ok" | "failed" | "skipped";

export interface PreflightProgressEvent {
  stage: PreflightStage;
  status: StageStatus;
  detail?: string;
  error?: string;
  /** Epoch ms — useful for deriving per-stage durations */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Verdict types
// ---------------------------------------------------------------------------

export type PermissionVerdict =
  | { kind: "granted" }
  | { kind: "denied"; reason: "never-granted" | "user-denied" }
  | {
      kind: "tcc_stale";
      /** Copy rendered to user — explains the remove+re-add remediation */
      message: string;
    }
  | { kind: "wrong-responsible-process"; detectedParent: string }
  | { kind: "unknown"; error: string }
  | { kind: "non-darwin" }
  | { kind: "not-probed" };

export interface PreflightResult {
  binaryFound: boolean;
  binaryPath?: string;
  binaryVersion?: string;
  permission: PermissionVerdict;
  sidecarSpawn: { ok: boolean; error?: string; pid?: number };
  mcpHandshake: {
    ok: boolean;
    error?: string;
    protocolVersion?: string;
    serverName?: string;
  };
  toolPing: { ok: boolean; error?: string; toolCount?: number };
  /** True iff every stage completed without error */
  overallOk: boolean;
  durationMs: number;
  /** One-line human-readable summary for logs/telemetry */
  summary: string;
}

export interface PreflightOptions {
  onProgress?: (event: PreflightProgressEvent) => void;
  /**
   * Permission probe injected from electron main. If omitted, the permission
   * stage is reported as `not-probed` (server-side callers can still run the
   * handshake probe to diagnose binary/MCP issues).
   */
  permissionProbe?: () => Promise<PermissionVerdict>;
  /** Override auto-detected binary path (testing or explicit install paths) */
  binaryPath?: string;
  /** Abort the probe if this signal fires */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const HOMEBREW_PATHS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** Match Screen-Recording-related error signatures coming out of `ghost mcp` */
const SCREEN_PERMISSION_ERROR_RE =
  /screen\s*recording|screen\s*capture\s*permission|not\s+authorized\s+(?:to|for)\s+screen|cgdisplaycreate|kcgerror|permission\s+not\s+granted/i;

function now(): number {
  return Date.now();
}

function makeEvent(
  stage: PreflightStage,
  status: StageStatus,
  extras: { detail?: string; error?: string } = {},
): PreflightProgressEvent {
  return {
    stage,
    status,
    detail: extras.detail,
    error: extras.error,
    timestamp: now(),
  };
}

// ---------------------------------------------------------------------------
// Stage: sidecar handshake + first tool ping
// ---------------------------------------------------------------------------

interface HandshakeResult {
  spawnOk: boolean;
  spawnError?: string;
  spawnPid?: number;
  handshakeOk: boolean;
  handshakeError?: string;
  protocolVersion?: string;
  serverName?: string;
  toolPingOk: boolean;
  toolPingError?: string;
  toolCount?: number;
  /** Set if we saw a screen-recording permission error while probing */
  observedPermissionError?: boolean;
}

/**
 * Spawn `<binary> mcp`, perform a JSON-RPC 2.0 initialize handshake, then
 * call `tools/list`. Kills the child and resolves within ~10s regardless
 * of outcome so the wizard never hangs.
 */
async function probeSidecarHandshake(
  binaryPath: string,
  signal: AbortSignal | undefined,
  emit: (event: PreflightProgressEvent) => void,
): Promise<HandshakeResult> {
  const result: HandshakeResult = {
    spawnOk: false,
    handshakeOk: false,
    toolPingOk: false,
  };

  let child: ChildProcessWithoutNullStreams | null = null;
  let stderrBuf = "";
  let stdoutBuf = "";
  const pendingResponses = new Map<
    number,
    { resolve: (msg: unknown) => void; reject: (err: Error) => void }
  >();
  let nextId = 1;
  let killed = false;

  /**
   * Reject every pending JSON-RPC request so abort/exit paths fail fast
   * instead of waiting for each per-request timeout to fire. Idempotent —
   * the Map is cleared so repeat invocations are no-ops.
   */
  const rejectAllPending = (error: Error) => {
    for (const pending of pendingResponses.values()) {
      pending.reject(error);
    }
    pendingResponses.clear();
  };

  const cleanup = () => {
    if (killed) return;
    killed = true;
    try {
      child?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    // Give it a moment, then SIGKILL if still alive
    setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 1000);
  };

  const abortHandler = () => {
    rejectAllPending(new Error("Ghost OS preflight aborted"));
    cleanup();
  };

  // Fail fast if the signal is already aborted when we enter the probe —
  // otherwise spawn would run and we'd rely on the caller-supplied timer to
  // eventually kill the process.
  if (signal?.aborted) {
    result.spawnError = "Ghost OS preflight aborted before spawn";
    emit(makeEvent("sidecar_spawn", "failed", { error: result.spawnError }));
    return result;
  }
  signal?.addEventListener("abort", abortHandler);

  try {
    // ---- Stage: sidecar_spawn -------------------------------------------
    emit(makeEvent("sidecar_spawn", "running", { detail: `spawning ${path.basename(binaryPath)} mcp` }));

    try {
      child = spawn(binaryPath, ["mcp"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: [process.env.PATH || "", ...HOMEBREW_PATHS].join(":"),
        },
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.spawnError = msg;
      emit(makeEvent("sidecar_spawn", "failed", { error: msg }));
      return result;
    }

    // child.pid is set synchronously on Node; if it's undefined, spawn actually failed
    if (!child.pid) {
      result.spawnError = "spawn returned no pid — binary may not be executable";
      emit(makeEvent("sidecar_spawn", "failed", { error: result.spawnError }));
      return result;
    }

    result.spawnOk = true;
    result.spawnPid = child.pid;
    emit(makeEvent("sidecar_spawn", "ok", { detail: `pid ${child.pid}` }));

    // Asynchronous spawn failures (ENOENT, EACCES, exec format errors) are
    // delivered via the "error" event, NOT via the try/catch around
    // spawn(). Without a listener Node crashes the whole process on
    // uncaughtException. Register it BEFORE any stream interaction so we
    // never miss the event window.
    child.on("error", (err: Error) => {
      if (!result.spawnError) {
        result.spawnError = err.message;
      }
      rejectAllPending(err);
      cleanup();
    });

    // ---- Wire stdout/stderr ---------------------------------------------
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      // MCP stdio is newline-delimited JSON
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string; data?: unknown } };
          if (msg.id !== undefined && pendingResponses.has(msg.id)) {
            const pending = pendingResponses.get(msg.id)!;
            pendingResponses.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message || "MCP error"));
            } else {
              pending.resolve(msg);
            }
          }
        } catch {
          // Non-JSON line (banner, log) — ignore
        }
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
      if (SCREEN_PERMISSION_ERROR_RE.test(chunk)) {
        result.observedPermissionError = true;
      }
    });

    const childClosed = new Promise<void>((resolve) => {
      const onClosed = () => {
        rejectAllPending(
          new Error(
            `sidecar exited${stderrBuf ? `: ${stderrBuf.trim().slice(0, 400)}` : ""}`,
          ),
        );
        resolve();
      };
      child!.once("close", onClosed);
      child!.once("exit", onClosed);
    });

    // ---- Helper: send one JSON-RPC request with timeout -----------------
    const sendRequest = (method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> => {
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingResponses.delete(id);
          reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pendingResponses.set(id, {
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        try {
          child!.stdin.write(payload);
        } catch (err) {
          clearTimeout(timer);
          pendingResponses.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    };

    // ---- Stage: mcp_handshake -------------------------------------------
    emit(makeEvent("mcp_handshake", "running", { detail: "initialize" }));

    try {
      const initResponse = (await Promise.race([
        sendRequest(
          "initialize",
          {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "selene-preflight", version: "1.0.0" },
          },
          6000,
        ),
        childClosed.then(() => {
          throw new Error(
            `sidecar exited before handshake${stderrBuf ? `: ${stderrBuf.trim().slice(0, 400)}` : ""}`,
          );
        }),
      ])) as { result?: { protocolVersion?: string; serverInfo?: { name?: string } } };

      const info = initResponse.result;
      result.handshakeOk = true;
      result.protocolVersion = info?.protocolVersion;
      result.serverName = info?.serverInfo?.name;
      emit(
        makeEvent("mcp_handshake", "ok", {
          detail: `${info?.serverInfo?.name ?? "server"} (protocol ${info?.protocolVersion ?? "?"})`,
        }),
      );

      // Some MCP servers require an `initialized` notification after initialize
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      } catch {
        /* non-fatal */
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.handshakeError = msg;
      if (SCREEN_PERMISSION_ERROR_RE.test(msg) || SCREEN_PERMISSION_ERROR_RE.test(stderrBuf)) {
        result.observedPermissionError = true;
      }
      emit(makeEvent("mcp_handshake", "failed", { error: msg }));
      return result;
    }

    // ---- Stage: first_tool_ping -----------------------------------------
    emit(makeEvent("first_tool_ping", "running", { detail: "tools/list" }));

    try {
      const toolsResponse = (await Promise.race([
        sendRequest("tools/list", {}, 5000),
        // Race against childClosed so a mid-request sidecar exit surfaces
        // immediately with the stderr tail, instead of waiting for the
        // per-request timeout. Mirrors the mcp_handshake stage above.
        childClosed.then(() => {
          throw new Error(
            `sidecar exited before tools/list${stderrBuf ? `: ${stderrBuf.trim().slice(0, 400)}` : ""}`,
          );
        }),
      ])) as {
        result?: { tools?: unknown[] };
      };
      const toolCount = toolsResponse.result?.tools?.length ?? 0;
      result.toolCount = toolCount;
      // Treat zero tools as a probe FAILURE: the sidecar binary is present
      // and the JSON-RPC handshake completed, but the server exposes no
      // useful tools — almost always a sign that the binary launched in a
      // degraded mode (missing entitlements, partial install, wrong
      // version) where the user can technically connect but no MCP tool
      // calls would ever succeed. Surfacing this as a `failed` stage lets
      // the UI prompt the user to fix the install rather than silently
      // pretending Ghost OS is ready.
      if (toolCount === 0) {
        result.toolPingOk = false;
        result.toolPingError =
          "tools/list returned 0 tools — sidecar started but exposes no callable tools. Verify install completeness and required permissions.";
        emit(
          makeEvent("first_tool_ping", "failed", {
            error: result.toolPingError,
          }),
        );
        return result;
      }
      result.toolPingOk = true;
      emit(
        makeEvent("first_tool_ping", "ok", {
          detail: `${toolCount} tool${toolCount === 1 ? "" : "s"} discovered`,
        }),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.toolPingError = msg;
      if (SCREEN_PERMISSION_ERROR_RE.test(msg) || SCREEN_PERMISSION_ERROR_RE.test(stderrBuf)) {
        result.observedPermissionError = true;
      }
      emit(makeEvent("first_tool_ping", "failed", { error: msg }));
      return result;
    }

    return result;
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the Ghost OS preflight probe end-to-end.
 *
 * Each stage emits a progress event before and after, so the caller can
 * render a live checklist without polling.
 *
 * Never throws on operational errors — always resolves with a `PreflightResult`.
 * (Only throws on programmer errors like invalid options.)
 */
export async function runGhostOsPreflight(
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  const startedAt = now();
  const emit = opts.onProgress ?? (() => {});

  const result: PreflightResult = {
    binaryFound: false,
    permission: { kind: "not-probed" },
    sidecarSpawn: { ok: false },
    mcpHandshake: { ok: false },
    toolPing: { ok: false },
    overallOk: false,
    durationMs: 0,
    summary: "",
  };

  // ---- Stage: binary_located ----------------------------------------------
  emit(makeEvent("binary_located", "running"));
  try {
    const resolved = opts.binaryPath ?? (await resolveGhostBinary());
    if (resolved && fs.existsSync(resolved)) {
      result.binaryFound = true;
      result.binaryPath = resolved;
      // Try to resolve the real path so the UI can point users at the TCC-bound path
      try {
        result.binaryPath = fs.realpathSync(resolved);
      } catch {
        /* keep the symlink path — realpath is best-effort */
      }
      emit(makeEvent("binary_located", "ok", { detail: result.binaryPath }));
    } else {
      emit(
        makeEvent("binary_located", "failed", {
          error: "ghost binary not found in PATH or known Homebrew locations",
        }),
      );
      result.summary = "ghost binary missing";
      result.durationMs = now() - startedAt;
      return result;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emit(makeEvent("binary_located", "failed", { error: msg }));
    result.summary = `binary lookup failed: ${msg}`;
    result.durationMs = now() - startedAt;
    return result;
  }

  // ---- Stage: permission_preflight ----------------------------------------
  if (opts.permissionProbe) {
    emit(makeEvent("permission_preflight", "running"));
    try {
      const verdict = await opts.permissionProbe();
      result.permission = verdict;
      const ok = verdict.kind === "granted" || verdict.kind === "non-darwin";
      emit(
        makeEvent("permission_preflight", ok ? "ok" : "failed", {
          detail: describeVerdict(verdict),
          error: ok ? undefined : describeVerdict(verdict),
        }),
      );
      // If permission is clearly denied, we can skip the handshake — the
      // sidecar would just crash trying to use screen APIs. But ghost mcp
      // doesn't actually need screen permission to respond to `initialize` or
      // `tools/list`, so we still run the handshake for diagnostic coverage.
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.permission = { kind: "unknown", error: msg };
      emit(makeEvent("permission_preflight", "failed", { error: msg }));
    }
  } else {
    emit(
      makeEvent("permission_preflight", "skipped", {
        detail: "no permission probe injected (server-side context)",
      }),
    );
  }

  // ---- Stages: sidecar_spawn → mcp_handshake → first_tool_ping ------------
  const handshake = await probeSidecarHandshake(
    result.binaryPath!,
    opts.signal,
    emit,
  );
  result.sidecarSpawn = {
    ok: handshake.spawnOk,
    error: handshake.spawnError,
    pid: handshake.spawnPid,
  };
  result.mcpHandshake = {
    ok: handshake.handshakeOk,
    error: handshake.handshakeError,
    protocolVersion: handshake.protocolVersion,
    serverName: handshake.serverName,
  };
  result.toolPing = {
    ok: handshake.toolPingOk,
    error: handshake.toolPingError,
    toolCount: handshake.toolCount,
  };

  // If the handshake surfaced a screen-recording error but TCC said "granted",
  // upgrade the verdict to tcc_stale (handshake is the ground truth).
  if (
    handshake.observedPermissionError &&
    result.permission.kind === "granted"
  ) {
    result.permission = {
      kind: "tcc_stale",
      message:
        "Ghost OS reports a screen-recording error at runtime, but macOS says permission is granted. " +
        "This is a stale TCC entry — remove Selene from System Settings → Privacy → Screen Recording, " +
        "re-add it, and relaunch Selene.",
    };
  }

  // ---- Stage: complete ----------------------------------------------------
  result.overallOk =
    result.binaryFound &&
    result.sidecarSpawn.ok &&
    result.mcpHandshake.ok &&
    result.toolPing.ok &&
    (result.permission.kind === "granted" ||
      result.permission.kind === "non-darwin" ||
      result.permission.kind === "not-probed");

  result.summary = summarize(result);
  result.durationMs = now() - startedAt;
  emit(
    makeEvent("complete", result.overallOk ? "ok" : "failed", {
      detail: result.summary,
    }),
  );

  return result;
}

// ---------------------------------------------------------------------------
// Verdict helpers — exported for rendering
// ---------------------------------------------------------------------------

export function describeVerdict(verdict: PermissionVerdict): string {
  switch (verdict.kind) {
    case "granted":
      return "Screen Recording granted";
    case "denied":
      return verdict.reason === "never-granted"
        ? "Screen Recording not yet granted"
        : "Screen Recording denied by user";
    case "tcc_stale":
      return "Screen Recording toggle is cosmetic (TCC stale)";
    case "wrong-responsible-process":
      return `Permission granted to wrong process: ${verdict.detectedParent}`;
    case "unknown":
      return `Permission status unknown: ${verdict.error}`;
    case "non-darwin":
      return "Not macOS — screen recording permission N/A";
    case "not-probed":
      return "Permission not probed (server-side context)";
  }
}

function summarize(result: PreflightResult): string {
  if (!result.binaryFound) return "ghost binary missing";
  if (!result.sidecarSpawn.ok) return `sidecar spawn failed: ${result.sidecarSpawn.error ?? "unknown"}`;
  if (!result.mcpHandshake.ok) return `MCP handshake failed: ${result.mcpHandshake.error ?? "unknown"}`;
  if (!result.toolPing.ok) return `tools/list failed: ${result.toolPing.error ?? "unknown"}`;
  if (result.permission.kind === "tcc_stale") return "TCC stale — remove + re-add Selene.app";
  if (result.permission.kind === "denied") return "Screen Recording not granted";
  if (result.permission.kind === "granted") {
    return `OK — ${result.toolPing.toolCount ?? 0} tools available`;
  }
  return "preflight completed";
}

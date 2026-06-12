/**
 * CLIProxyAPI sidecar lifecycle.
 *
 * Spawns the `cliproxyapi` binary as a child process, polls /healthz until
 * the local HTTP server is accepting connections, and exposes a typed
 * `ensureSidecarReady()` callers use before issuing requests.
 *
 * The sidecar is a singleton per Node.js process. The shutdown handlers are
 * idempotent so re-importing the module is safe.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { buildEnvironmentForTarget } from "@/lib/process-env/policy";
import { isElectronProduction } from "@/lib/utils/environment";
import { ensureCliproxyConfig } from "./config";

const CLIPROXY_BINARY = process.env.SELENE_CLIPROXY_BIN?.trim() || "cliproxyapi";
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_INTERVAL_MS = 200;

interface SidecarState {
  child: ChildProcess;
  port: number;
  apiKey: string;
  ready: boolean;
  startedAt: number;
}

const g = globalThis as typeof globalThis & {
  __seleneCliproxySidecar?: SidecarState | null;
};
if (!("__seleneCliproxySidecar" in g)) g.__seleneCliproxySidecar = null;

function getActive(): SidecarState | null {
  return g.__seleneCliproxySidecar ?? null;
}

function setActive(state: SidecarState | null): void {
  g.__seleneCliproxySidecar = state;
}

export interface SidecarReady {
  port: number;
  apiKey: string;
  baseUrl: string;
}

async function pollHealth(port: number, deadline: number): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/healthz`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return true;
    } catch {
      // sidecar not yet listening — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  return false;
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && !child.killed;
}

/**
 * Stream the sidecar's stdout/stderr into selene's main process console so
 * the dev-logs viewer surfaces every request/response line the sidecar prints
 * (otherwise the pipes fill silently and we lose all visibility into what
 * selene is sending to Claude).
 */
function pipeChildOutput(child: ChildProcess): void {
  const forward = (stream: NodeJS.ReadableStream | null, level: "log" | "error"): void => {
    if (!stream) return;
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      let nlIndex = buffer.indexOf("\n");
      while (nlIndex !== -1) {
        const line = buffer.slice(0, nlIndex).trimEnd();
        buffer = buffer.slice(nlIndex + 1);
        if (line) console[level](`[cliproxy] ${line}`);
        nlIndex = buffer.indexOf("\n");
      }
    });
    stream.on("end", () => {
      if (buffer.trim()) console[level](`[cliproxy] ${buffer.trim()}`);
    });
  };
  forward(child.stdout, "log");
  forward(child.stderr, "error");
}

function attachLifecycle(child: ChildProcess): void {
  child.once("exit", (code, signal) => {
    const active = getActive();
    if (active && active.child === child) {
      setActive(null);
    }
    if (code !== 0 && code !== null) {
      console.warn(`[cliproxy] sidecar exited code=${code} signal=${signal ?? "none"}`);
    }
  });
  child.once("error", (err) => {
    console.error(`[cliproxy] sidecar spawn error: ${err.message}`);
  });
}

/**
 * Ensure the CLIProxyAPI sidecar is running and ready to serve requests.
 * Idempotent — returns the cached descriptor if the process is already up.
 */
export async function ensureSidecarReady(): Promise<SidecarReady> {
  const existing = getActive();
  if (existing && isAlive(existing.child) && existing.ready) {
    return {
      port: existing.port,
      apiKey: existing.apiKey,
      baseUrl: `http://127.0.0.1:${existing.port}/v1`,
    };
  }

  // Stale handle (process died) — clear and re-spawn.
  if (existing && !isAlive(existing.child)) {
    setActive(null);
  }

  const { configPath, apiKey, port } = ensureCliproxyConfig();

  // CLIProxyAPI invokes the Claude CLI for OAuth flows, so we sanitize the
  // process env via the shared policy: strips CLAUDECODE/ANTHROPIC_API_KEY
  // markers from nested sessions, prefers the user's shell PATH in production
  // builds, and normalizes Windows path keys.
  const { env } = buildEnvironmentForTarget({
    target: "claude-sdk",
    isProduction: isElectronProduction(),
    processEnv: process.env,
  });

  const child = spawn(CLIPROXY_BINARY, ["-config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: env as NodeJS.ProcessEnv,
    detached: false,
    windowsHide: true,
  });

  pipeChildOutput(child);
  attachLifecycle(child);

  const state: SidecarState = {
    child,
    port,
    apiKey,
    ready: false,
    startedAt: Date.now(),
  };
  setActive(state);

  const ready = await pollHealth(port, Date.now() + READY_TIMEOUT_MS);
  if (!ready) {
    stopSidecar();
    throw new Error(
      `CLIProxyAPI sidecar did not become ready within ${READY_TIMEOUT_MS}ms. ` +
        `Is the '${CLIPROXY_BINARY}' binary installed and on PATH?`,
    );
  }

  state.ready = true;
  return {
    port: state.port,
    apiKey: state.apiKey,
    baseUrl: `http://127.0.0.1:${state.port}/v1`,
  };
}

/** Stop the sidecar if it's running. Safe to call multiple times. */
function stopSidecar(): void {
  const active = getActive();
  if (!active) return;
  if (isAlive(active.child)) {
    active.child.kill("SIGTERM");
  }
  setActive(null);
}

// Best-effort cleanup on process exit so dev restarts don't leave orphan procs.
const ALREADY_HOOKED = "__seleneCliproxyExitHooked";
const exitHookGuard = globalThis as typeof globalThis & {
  [ALREADY_HOOKED]?: boolean;
};
if (!exitHookGuard[ALREADY_HOOKED]) {
  exitHookGuard[ALREADY_HOOKED] = true;
  for (const signal of ["SIGINT", "SIGTERM", "exit"] as const) {
    process.on(signal, () => stopSidecar());
  }
}

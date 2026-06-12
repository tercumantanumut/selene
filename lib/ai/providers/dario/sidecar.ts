/**
 * Dario sidecar lifecycle for the Claude Code provider.
 *
 * Dario is process-ready when its HTTP server responds on /health. Auth health
 * is intentionally separate and is read from /status.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { buildDarioEnvironment } from "./environment";
import {
  darioAuthHeaders,
  ensureDarioConfig,
  getDarioBaseUrl,
  getDarioOrigin,
} from "./config";
import { resolveDarioCommand, withDarioCommandArgs } from "./binary";

const READY_TIMEOUT_MS = 20_000;
const READY_POLL_INTERVAL_MS = 200;
const STOP_TIMEOUT_MS = 3_000;

interface SidecarState {
  child: ChildProcess;
  port: number;
  apiKey: string;
  ready: boolean;
  startedAt: number;
}

export interface DarioSidecarReady {
  port: number;
  apiKey: string;
  baseUrl: string;
}

type DarioGlobal = typeof globalThis & {
  __seleneDarioSidecar?: SidecarState | null;
  __seleneDarioSidecarStart?: Promise<DarioSidecarReady> | null;
  __seleneDarioExitHooked?: boolean;
};

const g = globalThis as DarioGlobal;
if (!("__seleneDarioSidecar" in g)) g.__seleneDarioSidecar = null;
if (!("__seleneDarioSidecarStart" in g)) g.__seleneDarioSidecarStart = null;

function getActive(): SidecarState | null {
  return g.__seleneDarioSidecar ?? null;
}

function setActive(state: SidecarState | null): void {
  g.__seleneDarioSidecar = state;
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && !child.killed;
}

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
        if (line) console[level](`[dario] ${line}`);
        nlIndex = buffer.indexOf("\n");
      }
    });
    stream.on("end", () => {
      if (buffer.trim()) console[level](`[dario] ${buffer.trim()}`);
    });
  };
  forward(child.stdout, "log");
  forward(child.stderr, "error");
}

function attachLifecycle(child: ChildProcess): void {
  child.once("exit", (code, signal) => {
    const active = getActive();
    if (active && active.child === child) setActive(null);
    if (code !== 0 && code !== null) {
      console.warn(`[dario] sidecar exited code=${code} signal=${signal ?? "none"}`);
    }
  });
  child.once("error", (err) => {
    console.error(`[dario] sidecar spawn error: ${err.message}`);
  });
}

async function pollDarioListening(port: number, deadline: number): Promise<boolean> {
  const url = `${getDarioOrigin(port)}/health`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      // Dario returns 503 on /health when OAuth is missing/broken. That still
      // proves the process is listening; auth is validated separately.
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      // sidecar not yet listening — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  return false;
}

async function validateDarioApiKey(port: number, apiKey: string): Promise<void> {
  const res = await fetch(`${getDarioOrigin(port)}/status`, {
    headers: darioAuthHeaders(apiKey),
    signal: AbortSignal.timeout(1_000),
  });

  if (res.status === 401) {
    throw new Error(
      "Dario rejected Selene's API key. Another Dario instance may already be using this port.",
    );
  }

  if (!res.ok) {
    throw new Error(`Dario /status returned HTTP ${res.status}`);
  }
}

async function startDarioSidecar(allowStartupRetry = true): Promise<DarioSidecarReady> {
  const config = ensureDarioConfig();
  const { apiKey, port, host } = config;
  const env = buildDarioEnvironment(config);
  const darioCommand = resolveDarioCommand();

  const child = spawn(
    darioCommand.command,
    withDarioCommandArgs(darioCommand, ["proxy", `--port=${port}`, `--host=${host}`]),
    {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      detached: false,
      windowsHide: true,
    },
  );

  pipeChildOutput(child);
  attachLifecycle(child);

  let spawnErrorMessage: string | null = null;
  child.once("error", (err) => {
    spawnErrorMessage = err.message;
  });

  const state: SidecarState = {
    child,
    port,
    apiKey,
    ready: false,
    startedAt: Date.now(),
  };
  setActive(state);

  const ready = await pollDarioListening(port, Date.now() + READY_TIMEOUT_MS);
  if (!ready) {
    stopDarioSidecar();
    const detail = spawnErrorMessage ? ` Spawn error: ${spawnErrorMessage}` : "";
    throw new Error(
      `Dario sidecar did not become ready within ${READY_TIMEOUT_MS}ms. `
      + `Tried: ${darioCommand.description}.${detail}`,
    );
  }

  await validateDarioApiKey(port, apiKey);
  // Dario exits quickly with code 0 when it detects an existing proxy on the
  // requested port. Give that path a chance to settle before accepting the
  // child as Selene-managed.
  await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));

  if (!isAlive(child)) {
    setActive(null);

    // A prior stopDarioSidecarAndWait may have freed the port, but the OS
    // TCP stack can keep it in TIME_WAIT for a brief window. Retry once
    // after settling to avoid a permanent error from a transient bind fail.
    if (process.env.SELENE_DARIO_ALLOW_EXTERNAL !== "1") {
      if (allowStartupRetry) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return startDarioSidecar(false);
      }

      throw new Error("Dario sidecar exited during startup after retry.");
    }
  }

  state.ready = true;
  return {
    port,
    apiKey,
    baseUrl: getDarioBaseUrl(port, host),
  };
}

/** Ensure the Selene-managed Dario sidecar is running and accepting requests. */
export async function ensureDarioSidecarReady(): Promise<DarioSidecarReady> {
  const existing = getActive();
  if (existing && isAlive(existing.child) && existing.ready) {
    return {
      port: existing.port,
      apiKey: existing.apiKey,
      baseUrl: getDarioBaseUrl(existing.port),
    };
  }

  if (g.__seleneDarioSidecarStart) {
    return g.__seleneDarioSidecarStart;
  }

  if (existing && !isAlive(existing.child)) setActive(null);

  g.__seleneDarioSidecarStart = startDarioSidecar().finally(() => {
    g.__seleneDarioSidecarStart = null;
  });
  return g.__seleneDarioSidecarStart;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isAlive(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
  });
}

async function waitForDarioPortClosed(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${getDarioOrigin(port)}/health`, { signal: AbortSignal.timeout(250) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
}


export function stopDarioSidecar(): void {
  const active = getActive();
  if (!active) return;
  if (isAlive(active.child)) active.child.kill("SIGTERM");
  setActive(null);
}

export async function stopDarioSidecarAndWait(timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  const active = getActive();
  if (!active) return;

  const child = active.child;
  const exit = waitForChildExit(child, timeoutMs);
  if (isAlive(child)) child.kill("SIGTERM");
  setActive(null);
  await exit;
  await waitForDarioPortClosed(active.port, Math.min(timeoutMs, 1_000));
}

export function isDarioSidecarReady(): boolean {
  const active = getActive();
  return !!active && isAlive(active.child) && active.ready;
}

if (!g.__seleneDarioExitHooked) {
  g.__seleneDarioExitHooked = true;
  for (const signal of ["SIGINT", "SIGTERM", "exit"] as const) {
    process.on(signal, () => stopDarioSidecar());
  }
}

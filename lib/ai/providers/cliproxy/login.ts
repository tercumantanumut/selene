/**
 * Drives `cliproxyapi -claude-login` from selene's auth route.
 *
 * The sidecar prints the OAuth URL to stdout and exits on completion or
 * timeout. We capture the URL, expose a stream of `outputLines` for
 * diagnostics, and let the UI poll `getLoginState()` for completion.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { buildEnvironmentForTarget } from "@/lib/process-env/policy";
import { isElectronProduction } from "@/lib/utils/environment";
import { ensureCliproxyConfig } from "./config";

const CLIPROXY_BINARY = process.env.SELENE_CLIPROXY_BIN?.trim() || "cliproxyapi";
const URL_PATTERN = /https?:\/\/[^\s"')]+/i;
const URL_WAIT_MS = 20_000;

export type LoginStatus = "pending" | "success" | "error";

interface LoginSession {
  child: ChildProcess;
  url: string | null;
  outputLines: string[];
  status: LoginStatus;
  errorMessage?: string;
  startedAt: number;
}

const g = globalThis as typeof globalThis & {
  __seleneCliproxyLogin?: LoginSession | null;
};
if (!("__seleneCliproxyLogin" in g)) g.__seleneCliproxyLogin = null;

function getActive(): LoginSession | null {
  return g.__seleneCliproxyLogin ?? null;
}

function setActive(state: LoginSession | null): void {
  g.__seleneCliproxyLogin = state;
}

/** Kill any in-flight login attempt. Safe to call when nothing is active. */
export function killClaudeLogin(): void {
  const active = getActive();
  if (!active) return;
  if (active.child.exitCode === null && !active.child.killed) {
    active.child.kill("SIGTERM");
  }
  setActive(null);
}

export interface LoginStart {
  url: string | null;
  output: string[];
}

/**
 * Spawn the sidecar in `-claude-login` mode. Resolves once the URL is
 * captured (or the timeout elapses). The process continues running until the
 * OAuth callback fires — call `awaitLoginCompletion()` to block on that.
 */
export async function startClaudeLogin(): Promise<LoginStart> {
  killClaudeLogin();

  const { configPath } = ensureCliproxyConfig();

  const { env } = buildEnvironmentForTarget({
    target: "claude-sdk",
    isProduction: isElectronProduction(),
    processEnv: process.env,
  });

  const child = spawn(
    CLIPROXY_BINARY,
    ["-claude-login", "-no-browser", "-config", configPath],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: env as NodeJS.ProcessEnv,
      detached: false,
      windowsHide: true,
    },
  );

  const session: LoginSession = {
    child,
    url: null,
    outputLines: [],
    status: "pending",
    startedAt: Date.now(),
  };
  setActive(session);

  const onData = (chunk: Buffer): void => {
    const text = chunk.toString();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      session.outputLines.push(trimmed);
      if (/claude authentication successful/i.test(trimmed)) {
        session.status = "success";
      } else if (/error|failed|unable/i.test(trimmed) && session.status === "pending") {
        // soft signal — don't overwrite a later "successful" line
      }
    }
    if (!session.url) {
      const match = text.match(URL_PATTERN);
      if (match) session.url = match[0];
    }
  };

  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  child.once("error", (err) => {
    session.status = "error";
    session.errorMessage = err.message;
    session.outputLines.push(`spawn error: ${err.message}`);
  });
  child.once("exit", (code) => {
    if (session.status === "pending") {
      if (code === 0) {
        // No explicit success line but exit-0 implies completion; defer to
        // the credentials check the caller will do next.
        session.status = "success";
      } else {
        session.status = "error";
        session.errorMessage = `cliproxyapi exited with code ${code}`;
      }
    }
  });

  const deadline = Date.now() + URL_WAIT_MS;
  while (Date.now() < deadline && !session.url && session.status === "pending") {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return { url: session.url, output: [...session.outputLines] };
}

export interface LoginState {
  active: boolean;
  status: LoginStatus;
  url: string | null;
  output: string[];
  errorMessage?: string;
}

/** Snapshot the current login session, or `null` if nothing is in flight. */
export function getLoginState(): LoginState | null {
  const active = getActive();
  if (!active) return null;
  return {
    active: active.child.exitCode === null && !active.child.killed,
    status: active.status,
    url: active.url,
    output: [...active.outputLines],
    errorMessage: active.errorMessage,
  };
}

/**
 * Block until the active login session reaches a terminal state, or `timeoutMs`
 * elapses. If no session is active, resolves immediately with `null`.
 */
export async function awaitLoginCompletion(
  timeoutMs = 120_000,
): Promise<LoginState | null> {
  const active = getActive();
  if (!active) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && active.status === "pending") {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return getLoginState();
}

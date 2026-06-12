import { type ChildProcess, spawn } from "node:child_process";
import { buildDarioEnvironment } from "./environment";
import { ensureDarioConfig } from "./config";
import { stopDarioSidecarAndWait } from "./sidecar";
import { resolveDarioCommand, withDarioCommandArgs } from "./binary";

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
  codeSubmitted: boolean;
}

export interface LoginStart {
  url: string | null;
  output: string[];
}

export interface LoginState {
  active: boolean;
  status: LoginStatus;
  url: string | null;
  output: string[];
  errorMessage?: string;
}

type DarioLoginGlobal = typeof globalThis & {
  __seleneDarioClaudeLogin?: LoginSession | null;
};

const g = globalThis as DarioLoginGlobal;
if (!("__seleneDarioClaudeLogin" in g)) g.__seleneDarioClaudeLogin = null;

function getActive(): LoginSession | null {
  return g.__seleneDarioClaudeLogin ?? null;
}

function setActive(state: LoginSession | null): void {
  g.__seleneDarioClaudeLogin = state;
}

function killActive(): void {
  const active = getActive();
  if (!active) return;
  if (active.child.exitCode === null && !active.child.killed) {
    active.child.kill("SIGTERM");
  }
  setActive(null);
}

function snapshotState(): LoginState | null {
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

const LOGIN_SUCCESS_PATTERNS = [
  /^found valid credentials\b/i,
  /^refresh successful!/i,
  /^login successful!/i,
];
const LOGIN_FAILURE_PATTERN = /\b(error|failed|failure|fatal|invalid_grant|rejected)\b/i;

export function isSuccessfulClaudeLoginOutput(output: string[] | undefined): boolean {
  if (!output || output.length === 0) return false;
  const hasSuccess = output.some((line) => LOGIN_SUCCESS_PATTERNS.some((pattern) => pattern.test(line.trim())));
  if (!hasSuccess) return false;
  return !output.some((line) => LOGIN_FAILURE_PATTERN.test(line));
}

function attachOutputCapture(session: LoginSession): void {
  const onData = (chunk: Buffer): void => {
    const text = chunk.toString();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      session.outputLines.push(trimmed);
      if (isSuccessfulClaudeLoginOutput([trimmed])) {
        session.status = "success";
      }
    }
    if (!session.url) {
      const match = text.match(URL_PATTERN);
      if (match) session.url = match[0];
    }
  };

  session.child.stdout?.on("data", onData);
  session.child.stderr?.on("data", onData);
}

/**
 * Start Dario's manual login flow.
 *
 * Dario prints an OAuth URL and waits for the pasted code on stdin. Selene's
 * existing UI already posts that code to /exchange, so we keep the child stdin
 * open and submit it from submitClaudeLoginCode().
 */
export async function startClaudeLogin(): Promise<LoginStart> {
  killActive();

  const config = ensureDarioConfig();
  const darioCommand = resolveDarioCommand();
  const child = spawn(darioCommand.command, withDarioCommandArgs(darioCommand, ["login", "--manual", "--no-proxy"]), {
    stdio: ["pipe", "pipe", "pipe"],
    env: buildDarioEnvironment(config),
    detached: false,
    windowsHide: true,
  });

  const session: LoginSession = {
    child,
    url: null,
    outputLines: [],
    status: "pending",
    startedAt: Date.now(),
    codeSubmitted: false,
  };
  setActive(session);
  attachOutputCapture(session);

  child.once("error", (err) => {
    session.status = "error";
    session.errorMessage = err.message;
    session.outputLines.push(`spawn error: ${err.message}`);
  });
  child.once("exit", (code) => {
    if (session.status === "pending") {
      if (code === 0) {
        session.status = "success";
      } else {
        session.status = "error";
        session.errorMessage = `dario login exited with code ${code}`;
      }
    }

    if (session.status === "success") {
      // Dario's proxy process caches credential reads briefly. If Settings
      // checked /status before login completed, restart Selene's sidecar so the
      // next status/read path cannot reuse stale unauthenticated state.
      void stopDarioSidecarAndWait();
    }
  });

  const deadline = Date.now() + URL_WAIT_MS;
  while (Date.now() < deadline && !session.url && session.status === "pending") {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (session.status === "success") {
    await stopDarioSidecarAndWait();
  }

  return { url: session.url, output: [...session.outputLines] };
}

export function submitClaudeLoginCode(code: string): void {
  const active = getActive();
  if (!active || active.child.exitCode !== null || active.child.killed) {
    throw new Error("No active Dario OAuth login. Click 'Login with Claude' to start a new flow.");
  }

  const trimmed = code.trim();
  if (!trimmed) {
    throw new Error("Paste the authorization code from the Claude login page.");
  }

  if (!active.codeSubmitted) {
    active.child.stdin?.write(`${trimmed}\n`);
    active.codeSubmitted = true;
  }
}

export function getClaudeLoginState(): LoginState | null {
  return snapshotState();
}

export async function awaitClaudeLoginCompletion(timeoutMs = 120_000): Promise<LoginState | null> {
  const active = getActive();
  if (!active) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && active.status === "pending") {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return snapshotState();
}

export function killClaudeLogin(): void {
  killActive();
}

async function runDarioCommand(args: string[]): Promise<LoginState> {
  const config = ensureDarioConfig();
  const darioCommand = resolveDarioCommand();
  const child = spawn(darioCommand.command, withDarioCommandArgs(darioCommand, args), {
    stdio: ["ignore", "pipe", "pipe"],
    env: buildDarioEnvironment(config),
    detached: false,
    windowsHide: true,
  });

  const outputLines: string[] = [];
  const capture = (chunk: Buffer): void => {
    for (const line of chunk.toString().split("\n")) {
      const trimmed = line.trim();
      if (trimmed) outputLines.push(trimmed);
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const status = await new Promise<LoginStatus>((resolve) => {
    child.once("error", (err) => {
      outputLines.push(`spawn error: ${err.message}`);
      resolve("error");
    });
    child.once("exit", (code) => resolve(code === 0 ? "success" : "error"));
  });

  if (status === "success") {
    await stopDarioSidecarAndWait();
  }

  return {
    active: false,
    status,
    url: null,
    output: outputLines,
    errorMessage: status === "error" ? outputLines[outputLines.length - 1] : undefined,
  };
}

export async function refreshClaudeLogin(): Promise<LoginState> {
  return runDarioCommand(["refresh"]);
}

export async function logoutClaudeLogin(): Promise<LoginState> {
  const result = await runDarioCommand(["logout"]);
  // Dario keeps an in-memory credential cache in the proxy process; restart it
  // after logout so subsequent status checks cannot reuse stale credentials.
  setActive(null);
  await stopDarioSidecarAndWait();
  return result;
}

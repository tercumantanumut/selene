/**
 * Drives `cliproxyapi -<provider>-login` flows from selene's auth routes.
 *
 * The sidecar prints the OAuth URL to stdout and exits on completion or
 * timeout. We capture the URL, expose a stream of `outputLines` for
 * diagnostics, and let the UI poll for completion. Two parallel flows
 * (`claude` and `codex`) are supported with independent state so a user
 * can log in to both in the same session without collision.
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

type LoginFlavor = "claude" | "codex";

interface FlavorDef {
  /** CLI flag passed to `cliproxyapi`. */
  flag: string;
  /** Regex matching the upstream success line we look for in stdout. */
  successPattern: RegExp;
  /** Global state slot key. */
  stateKey: string;
}

const FLAVORS: Record<LoginFlavor, FlavorDef> = {
  claude: {
    flag: "-claude-login",
    successPattern: /claude authentication successful/i,
    stateKey: "__seleneCliproxyClaudeLogin",
  },
  codex: {
    flag: "-codex-login",
    successPattern: /codex (login|authentication) successful/i,
    stateKey: "__seleneCliproxyCodexLogin",
  },
};

type GlobalSlots = typeof globalThis & {
  [k: string]: LoginSession | null | undefined;
};

function getActive(flavor: LoginFlavor): LoginSession | null {
  const g = globalThis as GlobalSlots;
  const slot = FLAVORS[flavor].stateKey;
  return (g[slot] as LoginSession | null | undefined) ?? null;
}

function setActive(flavor: LoginFlavor, state: LoginSession | null): void {
  const g = globalThis as GlobalSlots;
  g[FLAVORS[flavor].stateKey] = state;
}

function killActive(flavor: LoginFlavor): void {
  const active = getActive(flavor);
  if (!active) return;
  if (active.child.exitCode === null && !active.child.killed) {
    active.child.kill("SIGTERM");
  }
  setActive(flavor, null);
}

async function spawnLoginFlow(flavor: LoginFlavor): Promise<LoginStart> {
  killActive(flavor);

  const { configPath } = ensureCliproxyConfig();
  const def = FLAVORS[flavor];

  const { env } = buildEnvironmentForTarget({
    target: "claude-sdk",
    isProduction: isElectronProduction(),
    processEnv: process.env,
  });

  const child = spawn(
    CLIPROXY_BINARY,
    [def.flag, "-no-browser", "-config", configPath],
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
  setActive(flavor, session);

  const onData = (chunk: Buffer): void => {
    const text = chunk.toString();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      session.outputLines.push(trimmed);
      if (def.successPattern.test(trimmed)) {
        session.status = "success";
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
        // No explicit success line but exit-0 implies completion; the caller
        // re-reads the credentials directory to confirm.
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

function snapshotState(flavor: LoginFlavor): LoginState | null {
  const active = getActive(flavor);
  if (!active) return null;
  return {
    active: active.child.exitCode === null && !active.child.killed,
    status: active.status,
    url: active.url,
    output: [...active.outputLines],
    errorMessage: active.errorMessage,
  };
}

async function awaitFlavor(
  flavor: LoginFlavor,
  timeoutMs: number,
): Promise<LoginState | null> {
  const active = getActive(flavor);
  if (!active) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && active.status === "pending") {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return snapshotState(flavor);
}

// ── Claude flavor public API ────────────────────────────────────────────────

export function startClaudeLogin(): Promise<LoginStart> {
  return spawnLoginFlow("claude");
}

export function getClaudeLoginState(): LoginState | null {
  return snapshotState("claude");
}

export function awaitClaudeLoginCompletion(timeoutMs = 120_000): Promise<LoginState | null> {
  return awaitFlavor("claude", timeoutMs);
}

export function killClaudeLogin(): void {
  killActive("claude");
}

// ── Codex flavor public API ─────────────────────────────────────────────────

export function startCodexLogin(): Promise<LoginStart> {
  return spawnLoginFlow("codex");
}

export function getCodexLoginState(): LoginState | null {
  return snapshotState("codex");
}

export function awaitCodexLoginCompletion(timeoutMs = 120_000): Promise<LoginState | null> {
  return awaitFlavor("codex", timeoutMs);
}

export function killCodexLogin(): void {
  killActive("codex");
}

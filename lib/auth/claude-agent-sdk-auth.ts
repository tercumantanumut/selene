import path from "path";
import { execFile } from "child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { query as claudeAgentQuery } from "@anthropic-ai/claude-agent-sdk";
import { isElectronProduction } from "@/lib/utils/environment";
import { getNodeBinary, getCliPath } from "@/lib/auth/claude-login-process";
import { buildEnvironmentForTarget } from "@/lib/process-env/policy";

const DEFAULT_CLAUDE_AGENT_MODEL = "claude-sonnet-4-5-20250929";

const MAX_EBADF_RETRIES = 3;
const EBADF_RETRY_DELAY_MS = 2000;

function getBundledNodeBinDir(): string | null {
  const resourcesPath =
    process.env.ELECTRON_RESOURCES_PATH ||
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

  if (!resourcesPath) {
    return null;
  }

  const nodeBinaryName = process.platform === "win32" ? "node.exe" : "node";
  const bundledNodePath = path.join(resourcesPath, "standalone", "node_modules", ".bin", nodeBinaryName);
  if (!existsSync(bundledNodePath)) {
    return null;
  }

  return path.dirname(bundledNodePath);
}

function ensureSdkNodeShimDir(): string | null {
  const baseDir = process.env.ELECTRON_USER_DATA_PATH || tmpdir();
  const shimDir = path.join(baseDir, ".selene-node", "bin");
  const shimPath = path.join(shimDir, process.platform === "win32" ? "node.cmd" : "node");

  try {
    if (!existsSync(shimPath)) {
      mkdirSync(shimDir, { recursive: true });
      if (process.platform === "win32") {
        const contents = [
          "@echo off",
          "set ELECTRON_RUN_AS_NODE=1",
          "set ELECTRON_NO_ATTACH_CONSOLE=1",
          "set ELECTRON_ENABLE_LOGGING=0",
          `\"${process.execPath}\" %*`,
          "",
        ].join("\r\n");
        writeFileSync(shimPath, contents, "utf-8");
      } else {
        const escapedExecPath = process.execPath.replace(/"/g, '\\"');
        const contents = [
          "#!/bin/sh",
          "export ELECTRON_RUN_AS_NODE=1",
          `exec \"${escapedExecPath}\" \"$@\"`,
          "",
        ].join("\n");
        writeFileSync(shimPath, contents, "utf-8");
        chmodSync(shimPath, 0o755);
      }
    }
    return shimDir;
  } catch (error) {
    console.warn("[Agent SDK] Failed to create node shim dir:", error);
    return null;
  }
}

/**
 * Returns sanitized env for Agent SDK subprocesses.
 *
 * The SDK's `executable` option only accepts the literals "node" | "bun" | "deno",
 * so we must ensure that "node" resolves correctly via PATH. In packaged Electron
 * builds we prefer the bundled standalone Node binary, then fall back to an
 * Electron-as-Node shim if no real node binary is available.
 */
export function getSdkExecutableConfig(): {
  executable: "node";
  env: Record<string, string | undefined>;
} {
  const isProduction = isElectronProduction();
  const { env, source } = buildEnvironmentForTarget({
    target: "claude-sdk",
    isProduction,
  });

  if (isProduction) {
    // Ensure PATH has a base value regardless of shell env source
    if (source === "shell") {
      env.PATH = env.PATH || process.env.PATH;
      console.log("[Agent SDK] Production mode - using shell-resolved PATH");
    }

    // Always prepend bundled node to PATH in production, regardless of env source.
    // Without this, systems without a system-wide Node.js installation fail because
    // the shell-resolved PATH doesn't contain "node" — even though a real node.exe
    // is bundled at resources/standalone/node_modules/.bin/.
    const bundledNodeDir = getBundledNodeBinDir();
    if (bundledNodeDir && !env.PATH?.includes(bundledNodeDir)) {
      env.PATH = `${bundledNodeDir}${path.delimiter}${env.PATH || ""}`;
      console.log("[Agent SDK] Prepended bundled node dir:", bundledNodeDir);
    }

    // If no bundled node found, try system node or Electron-as-Node shim
    if (!bundledNodeDir) {
      const nodeBin = getNodeBinary();
      const nodeBase = path.basename(nodeBin).toLowerCase();
      const isRealNodeBinary = nodeBase === "node" || nodeBase === "node.exe";

      if (isRealNodeBinary) {
        const nodeDir = path.dirname(nodeBin);
        if (!env.PATH?.includes(nodeDir)) {
          env.PATH = `${nodeDir}${path.delimiter}${env.PATH || ""}`;
        }
        console.log("[Agent SDK] Production mode - fallback node binary:", nodeBin);
      } else {
        const shimDir = ensureSdkNodeShimDir();
        if (shimDir && !env.PATH?.includes(shimDir)) {
          env.PATH = `${shimDir}${path.delimiter}${env.PATH || ""}`;
          console.log("[Agent SDK] Production mode - using Electron-as-Node shim dir:", shimDir);
        }
      }
    }
  }

  return { executable: "node", env };
}
const URL_PATTERN = /https?:\/\/[^\s"')]+/i;

export interface ClaudeAgentSdkAuthStatus {
  authenticated: boolean;
  isAuthenticating: boolean;
  output: string[];
  email?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  authUrl?: string;
  error?: string;
}

interface ReadAuthStatusOptions {
  timeoutMs: number;
  model?: string;
}

function trimOutput(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-20);
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function extractAuthUrl(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = line.match(URL_PATTERN);
    if (match && match[0]) {
      return match[0];
    }
  }
  return undefined;
}

/**
 * Uses the official Claude Agent SDK as the single source of truth for auth status.
 *
 * This intentionally does not rely on app-managed OAuth token persistence, so the
 * app follows the SDK/CLI authentication state directly.
 */
export async function readClaudeAgentSdkAuthStatus(
  options: ReadAuthStatusOptions,
): Promise<ClaudeAgentSdkAuthStatus> {
  for (let attempt = 0; attempt <= MAX_EBADF_RETRIES; attempt++) {
    const result = await readClaudeAgentSdkAuthStatusOnce(options);

    // Retry on FD exhaustion (EBADF/EMFILE) — sync may be hogging descriptors.
    if (
      result.error &&
      attempt < MAX_EBADF_RETRIES &&
      /ebadf|emfile|enfile/i.test(result.error)
    ) {
      console.log(
        `[Agent SDK] ${result.error} — retrying in ${EBADF_RETRY_DELAY_MS}ms (${attempt + 1}/${MAX_EBADF_RETRIES})`,
      );
      await new Promise((r) => setTimeout(r, EBADF_RETRY_DELAY_MS));
      continue;
    }

    // If SDK query failed (not authenticated, has error), try CLI fallback
    if (!result.authenticated && result.error) {
      console.log(
        `[Agent SDK] SDK query failed (${result.error}), trying CLI fallback...`,
      );
      const cliFallback = await readAuthStatusViaCli(
        Math.min(options.timeoutMs, 10_000),
      );
      if (cliFallback) {
        return cliFallback;
      }
    }

    return result;
  }

  // Unreachable, but satisfies TypeScript
  return readClaudeAgentSdkAuthStatusOnce(options);
}

async function readClaudeAgentSdkAuthStatusOnce(
  options: ReadAuthStatusOptions,
): Promise<ClaudeAgentSdkAuthStatus> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), options.timeoutMs);

  const output: string[] = [];
  let isAuthenticating = false;
  let authenticated = false;
  let errorMessage: string | undefined;
  let accountInfo: {
    email?: string;
    subscriptionType?: string;
    tokenSource?: string;
    apiKeySource?: string;
  } | null = null;

  const { executable, env } = getSdkExecutableConfig();

  const sdkQuery = claudeAgentQuery({
    prompt: "Reply with OK.",
    options: {
      abortController,
      cwd: process.cwd(),
      executable,
      pathToClaudeCodeExecutable: getCliPath(),
      includePartialMessages: true,
      maxTurns: 1,
      model: options.model || DEFAULT_CLAUDE_AGENT_MODEL,
      permissionMode: "plan",
      env,
    },
  });

  try {
    for await (const message of sdkQuery) {
      if (message.type === "auth_status") {
        isAuthenticating = Boolean((message as { isAuthenticating?: boolean }).isAuthenticating);
        const lines = (message as { output?: string[] }).output;
        if (Array.isArray(lines)) {
          output.push(...lines);
        }
        const authError = (message as { error?: string }).error;
        if (authError) {
          errorMessage = authError;
        }
      }

      if (message.type === "assistant") {
        const assistantError = (message as { error?: string }).error;
        if (assistantError === "authentication_failed") {
          errorMessage = "authentication_failed";
        }
      }

      if (message.type === "result") {
        const isError = Boolean((message as { is_error?: boolean }).is_error);
        authenticated = !isError;
        if (isError && !errorMessage) {
          const subtype = (message as { subtype?: string }).subtype;
          errorMessage = subtype || "error_during_execution";
        }
      }
    }

    accountInfo = await sdkQuery.accountInfo().catch(() => null);

    if (
      accountInfo?.email ||
      accountInfo?.subscriptionType ||
      accountInfo?.tokenSource ||
      accountInfo?.apiKeySource
    ) {
      authenticated = true;
    }
  } catch (error) {
    if (!abortController.signal.aborted) {
      errorMessage = resolveErrorMessage(error);
    }
  } finally {
    clearTimeout(timeout);
  }

  const trimmedOutput = trimOutput(output);

  return {
    authenticated,
    isAuthenticating,
    output: trimmedOutput,
    email: accountInfo?.email,
    subscriptionType: accountInfo?.subscriptionType,
    tokenSource: accountInfo?.tokenSource,
    apiKeySource: accountInfo?.apiKeySource,
    authUrl: extractAuthUrl(trimmedOutput),
    error: errorMessage,
  };
}

/**
 * CLI fallback: runs `node cli.js auth status` and parses the output.
 * Used when the SDK query approach fails (e.g. spawn issues on Windows).
 * Inspired by t3code's approach.
 */
async function readAuthStatusViaCli(
  timeoutMs: number,
): Promise<ClaudeAgentSdkAuthStatus | null> {
  const nodeBinary = getNodeBinary();
  const cliPath = getCliPath();
  const { env } = getSdkExecutableConfig();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);

    const child = execFile(
      nodeBinary,
      [cliPath, "auth", "status"],
      {
        env: env as NodeJS.ProcessEnv,
        shell: process.platform === "win32",
        windowsHide: true,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        const combined = `${stdout}\n${stderr}`.toLowerCase();

        if (error && /enoent/i.test(error.message)) {
          resolve(null); // binary not found, can't fallback
          return;
        }

        // Check for "not logged in" patterns
        if (
          combined.includes("not logged in") ||
          combined.includes("login required") ||
          combined.includes("authentication required") ||
          combined.includes("run `claude login`") ||
          combined.includes("run claude login")
        ) {
          console.log("[Agent SDK] CLI fallback: not authenticated");
          resolve({
            authenticated: false,
            isAuthenticating: false,
            output: [stdout.trim(), stderr.trim()].filter(Boolean),
            error: "Not logged in. Run `claude login` in your terminal.",
          });
          return;
        }

        // Try JSON parse for auth boolean
        const trimmed = stdout.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try {
            const parsed = JSON.parse(trimmed);
            const authBool = extractAuthBooleanFromJson(parsed);
            if (authBool !== undefined) {
              console.log(`[Agent SDK] CLI fallback: authenticated=${authBool}`);
              resolve({
                authenticated: authBool,
                isAuthenticating: false,
                output: [trimmed],
                email: typeof parsed?.email === "string" ? parsed.email : undefined,
              });
              return;
            }
          } catch {
            // Not valid JSON, continue
          }
        }

        // Exit code 0 = likely authenticated
        if (!error) {
          console.log("[Agent SDK] CLI fallback: exit code 0, assuming authenticated");
          resolve({
            authenticated: true,
            isAuthenticating: false,
            output: [stdout.trim()].filter(Boolean),
          });
          return;
        }

        resolve(null); // Couldn't determine status
      },
    );
  });
}

/**
 * Recursively search for auth boolean in parsed JSON.
 */
function extractAuthBooleanFromJson(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBooleanFromJson(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"]) {
    if (typeof record[key] === "boolean") return record[key] as boolean;
  }
  for (const key of ["auth", "status", "session", "account"]) {
    const nested = extractAuthBooleanFromJson(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export async function attemptClaudeAgentSdkLogout(timeoutMs = 20_000): Promise<boolean> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  const { executable, env } = getSdkExecutableConfig();

  const sdkQuery = claudeAgentQuery({
    prompt: "/logout",
    options: {
      abortController,
      cwd: process.cwd(),
      executable,
      pathToClaudeCodeExecutable: getCliPath(),
      includePartialMessages: false,
      maxTurns: 1,
      permissionMode: "plan",
      env,
    },
  });

  try {
    for await (const _message of sdkQuery) {
      // Drain stream until result.
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

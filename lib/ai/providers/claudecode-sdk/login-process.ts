/**
 * Claude Agent SDK OAuth login subprocess management.
 *
 * Drives `node cli.js login` from `@anthropic-ai/claude-agent-sdk`, captures the
 * OAuth URL for the browser popup, accepts the pasted code over stdin, and
 * resolves on exit. Credentials are written to ~/.claude by the SDK CLI itself.
 *
 * This is the SDK-backend analogue of `lib/ai/providers/dario/login.ts`; the two
 * keep separate credential stores and must be imported by explicit path so the
 * same-named exports never collide.
 */
import { spawn, ChildProcess } from "child_process";
import path from "path";
import { isElectronProduction } from "@/lib/utils/environment";
import { buildEnvironmentForTarget } from "@/lib/process-env/policy";
import { consolidatePathKeys } from "@/lib/utils/windows-env";

// Resolved lazily so process.cwd() is evaluated at runtime, not build time.
// In production Electron builds, node_modules live under resourcesPath/standalone/.
export function getCliPath(): string {
  const resourcesPath =
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ||
    process.env.ELECTRON_RESOURCES_PATH;

  if (resourcesPath) {
    // Production Electron: modules are bundled under standalone/
    const prodPath = path.join(resourcesPath, "standalone", "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js");
    const fs = require("fs") as typeof import("fs");
    if (fs.existsSync(prodPath)) return prodPath;
  }

  return path.join(process.cwd(), "node_modules/@anthropic-ai/claude-agent-sdk/cli.js");
}

function fileExistsAndExecutable(filePath: string): boolean {
  const fs = require("fs") as typeof import("fs");
  if (!fs.existsSync(filePath)) return false;
  if (process.platform === "win32") return true;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getSystemNodeBinary(nodeName: string): string | null {
  const isWindows = process.platform === "win32";

  // On Windows, PATH and Path can coexist with different segments.
  // Use consolidatePathKeys to merge them properly instead of picking one.
  let resolvedPath: string;
  if (isWindows) {
    const envCopy = { ...process.env } as Record<string, string | undefined>;
    resolvedPath = consolidatePathKeys(envCopy);
  } else {
    resolvedPath = process.env.PATH || "";
  }
  const pathEntries = resolvedPath.split(path.delimiter).filter(Boolean);
  const fs = require("fs") as typeof import("fs");

  // Platform-specific well-known install directories
  const platformDirs: string[] = [];
  if (isWindows) {
    // Default Node.js installer location
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    platformDirs.push(
      path.join(programFiles, "nodejs"),
      path.join(programFilesX86, "nodejs"),
    );
  } else {
    platformDirs.push(
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/opt/local/bin",
    );
  }

  const candidateDirs = [...pathEntries, ...platformDirs];

  for (const dir of candidateDirs) {
    const candidate = path.join(dir, nodeName);
    if (fileExistsAndExecutable(candidate)) return candidate;
  }

  if (!isWindows) {
    // Check versioned homebrew installs (e.g. node@22, node@20)
    // These don't get symlinked to /opt/homebrew/bin when installed as node@XX
    for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt"]) {
      try {
        const entries = fs.readdirSync(prefix);
        for (const entry of entries) {
          if (entry.startsWith("node")) {
            const candidate = path.join(prefix, entry, "bin", nodeName);
            if (fileExistsAndExecutable(candidate)) return candidate;
          }
        }
      } catch {
        // directory doesn't exist
      }
    }
  }

  // Check common version manager paths
  // On Windows HOME is often unset; use USERPROFILE as fallback
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const versionManagerPaths = [
      path.join(home, ".volta", "bin"),
      path.join(home, ".fnm", "aliases", "default", "bin"),
    ];

    if (isWindows) {
      const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");

      versionManagerPaths.push(
        // nvm-windows stores node binaries under %APPDATA%\nvm\<version>\
        // and symlinks to %NVM_SYMLINK% (default: %ProgramFiles%\nodejs)
        ...(process.env.NVM_HOME ? [process.env.NVM_HOME] : []),
        ...(process.env.NVM_SYMLINK ? [process.env.NVM_SYMLINK] : []),
        path.join(appData, "nvm"),
        // fnm on Windows — check multishells, aliases, and FNM_MULTISHELL_PATH
        path.join(localAppData, "fnm_multishells"),
        path.join(appData, "fnm", "aliases", "default"),
        ...(process.env.FNM_MULTISHELL_PATH ? [process.env.FNM_MULTISHELL_PATH] : []),
        // volta on Windows
        path.join(localAppData, "Volta", "bin"),
      );
    }

    for (const dir of versionManagerPaths) {
      const candidate = path.join(dir, nodeName);
      if (fileExistsAndExecutable(candidate)) return candidate;
    }

    // nvm (Unix) / nvm-windows: check for any installed version
    const nvmDirs = isWindows
      ? [
          process.env.NVM_HOME,
          path.join(home, "AppData", "Roaming", "nvm"),
        ].filter(Boolean) as string[]
      : [path.join(home, ".nvm", "versions", "node")];

    for (const nvmDir of nvmDirs) {
      try {
        const versions = fs.readdirSync(nvmDir).sort().reverse();
        for (const ver of versions) {
          // nvm-windows: %NVM_HOME%\v20.11.0\node.exe
          // nvm (Unix): ~/.nvm/versions/node/v20.11.0/bin/node
          const candidate = isWindows
            ? path.join(nvmDir, ver, nodeName)
            : path.join(nvmDir, ver, "bin", nodeName);
          if (fileExistsAndExecutable(candidate)) return candidate;
        }
      } catch {
        // nvm not installed
      }
    }

    // fnm on Windows: check node-versions directory
    // Layout: %APPDATA%\fnm\node-versions\v20.11.0\installation\node.exe
    if (isWindows) {
      const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      const fnmVersionsDir = path.join(appData, "fnm", "node-versions");
      try {
        const versions = fs.readdirSync(fnmVersionsDir).sort().reverse();
        for (const ver of versions) {
          const candidate = path.join(fnmVersionsDir, ver, "installation", nodeName);
          if (fileExistsAndExecutable(candidate)) return candidate;
        }
      } catch {
        // fnm not installed
      }
    }
  }

  return null;
}

/**
 * Returns the Node.js binary used to run claude-agent-sdk/cli.js.
 * Resolution order:
 *   1. System node from PATH / common macOS install locations
 *   2. Bundled node at $ELECTRON_RESOURCES_PATH/standalone/node_modules/.bin/node
 *   3. process.cwd()/node_modules/.bin/node (standalone server cwd)
 *   4. process.execPath fallback
 */
export function getNodeBinary(): string {
  const nodeName = process.platform === "win32" ? "node.exe" : "node";

  const systemNode = getSystemNodeBinary(nodeName);
  if (systemNode) {
    console.log(`[claude-login] Node binary resolved: ${systemNode} (system)`);
    return systemNode;
  }

  const resourcesPath = process.env.ELECTRON_RESOURCES_PATH;
  if (resourcesPath) {
    const candidate = path.join(resourcesPath, "standalone", "node_modules", ".bin", nodeName);
    if (fileExistsAndExecutable(candidate)) {
      console.log(`[claude-login] Node binary resolved: ${candidate} (bundled)`);
      return candidate;
    }
  }

  const cwdCandidate = path.join(process.cwd(), "node_modules", ".bin", nodeName);
  if (fileExistsAndExecutable(cwdCandidate)) {
    console.log(`[claude-login] Node binary resolved: ${cwdCandidate} (cwd)`);
    return cwdCandidate;
  }

  console.warn(`[claude-login] No system/bundled node found, falling back to process.execPath: ${process.execPath}`);
  return process.execPath;
}

const URL_PATTERN = /https?:\/\/[^\s"')]+/i;

interface LoginProcessState {
  process: ChildProcess;
  url: string | null;
  outputLines: string[];
  resolved: boolean;
}

// Use globalThis so the singleton survives across Turbopack route-bundle isolation.
// Each API route gets its own module copy, but globalThis is always the same object.
const g = globalThis as typeof globalThis & { __claudeSdkLoginState?: LoginProcessState | null };
if (!("__claudeSdkLoginState" in g)) g.__claudeSdkLoginState = null;

function getActive(): LoginProcessState | null {
  return g.__claudeSdkLoginState ?? null;
}
function setActive(state: LoginProcessState | null): void {
  g.__claudeSdkLoginState = state;
}

function killActive(): void {
  const active = getActive();
  if (active && !active.process.killed) {
    active.process.kill("SIGTERM");
  }
  setActive(null);
}

const MAX_EBADF_RETRIES = 3;
const EBADF_RETRY_DELAY_MS = 2000;

/**
 * Starts `claude login` as a persistent subprocess with stdin pipe.
 * Waits up to `urlTimeoutMs` for the auth URL to appear in output,
 * then returns it so the caller can open a browser.
 *
 * Retries on EBADF/EMFILE (FD exhaustion) which can happen when the
 * background sync is consuming file descriptors.
 */
export async function startClaudeLoginProcess(
  urlTimeoutMs = 15_000,
): Promise<{ url: string | null; output: string[] }> {
  for (let attempt = 0; attempt <= MAX_EBADF_RETRIES; attempt++) {
    const result = await startClaudeLoginProcessOnce(urlTimeoutMs);

    // If spawn failed with EBADF/EMFILE, retry after a delay
    const hasSpawnError = result.output.some((line) =>
      /ebadf|emfile|enfile/i.test(line),
    );
    if (!result.url && hasSpawnError && attempt < MAX_EBADF_RETRIES) {
      console.log(
        `[claude-login] FD exhaustion — retrying in ${EBADF_RETRY_DELAY_MS}ms (${attempt + 1}/${MAX_EBADF_RETRIES})`,
      );
      await new Promise((r) => setTimeout(r, EBADF_RETRY_DELAY_MS));
      continue;
    }

    return result;
  }

  return startClaudeLoginProcessOnce(urlTimeoutMs);
}

async function startClaudeLoginProcessOnce(
  urlTimeoutMs: number,
): Promise<{ url: string | null; output: string[] }> {
  killActive();

  const nodeBinary = getNodeBinary();
  const isProduction = isElectronProduction();
  const useElectronRunAsNode = isProduction && nodeBinary === process.execPath;

  // Use the same sanitized env as the SDK auth check for consistency.
  // This ensures HOME, PATH, and USERPROFILE are set correctly on all platforms.
  const { env: sdkEnv } = buildEnvironmentForTarget({
    target: "claude-sdk",
    isProduction,
  });

  const spawnEnv = { ...sdkEnv } as NodeJS.ProcessEnv;
  // CLAUDECODE is already removed by CLAUDE_SDK_BLOCKED_KEYS in sanitizeEnvironment
  if (useElectronRunAsNode) {
    spawnEnv.ELECTRON_RUN_AS_NODE = "1";
  }

  const state: LoginProcessState = {
    process: spawn(nodeBinary, [getCliPath(), "login"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
      shell: process.platform === "win32",
      windowsHide: true,
    }),
    url: null,
    outputLines: [],
    resolved: false,
  };

  setActive(state);

  // Handle spawn errors to prevent unhandled crashes
  state.process.once("error", (err) => {
    console.error("[claude-login] spawn error:", err.message);
    state.outputLines.push(`spawn error: ${err.message}`);
    state.resolved = true;
  });

  function onData(chunk: Buffer) {
    const text = chunk.toString();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) state.outputLines.push(trimmed);
    }
    if (!state.url) {
      const match = text.match(URL_PATTERN);
      if (match) state.url = match[0];
    }
  }

  state.process.stdout?.on("data", onData);
  state.process.stderr?.on("data", onData);

  // Wait until URL appears or timeout
  const deadline = Date.now() + urlTimeoutMs;
  while (Date.now() < deadline && !state.url && !state.resolved) {
    await new Promise((r) => setTimeout(r, 150));
    if (state.process.exitCode !== null) break; // process exited early
  }

  return { url: state.url, output: state.outputLines };
}

/**
 * Writes the authorization code to the waiting subprocess stdin,
 * then waits for it to exit (success = exit code 0).
 */
export async function submitClaudeLoginCode(
  code: string,
  timeoutMs = 30_000,
): Promise<{ success: boolean; error?: string }> {
  const activeLogin = getActive();
  if (!activeLogin || activeLogin.process.killed || activeLogin.process.exitCode !== null) {
    return { success: false, error: "No active login process. Please restart the login flow." };
  }

  const proc = activeLogin.process;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ success: false, error: "Timed out waiting for claude to accept the code." });
    }, timeoutMs);

    proc.once("exit", (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0) {
        setActive(null);
        resolve({ success: true });
      } else {
        resolve({ success: false, error: `claude exited with code ${exitCode}` });
      }
    });

    proc.once("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });

    try {
      proc.stdin?.write(code.trim() + "\n");
    } catch (err) {
      clearTimeout(timer);
      resolve({ success: false, error: String(err) });
    }
  });
}

/** The OAuth URL captured from the active login subprocess, if any. */
export function getActiveLoginUrl(): string | null {
  return getActive()?.url ?? null;
}

/** Whether a login subprocess is currently active and awaiting a code. */
export function hasActiveLogin(): boolean {
  const active = getActive();
  return Boolean(active && !active.process.killed && active.process.exitCode === null);
}

/** Kill any hanging login subprocess. Call this before Agent SDK auth checks. */
export function killLoginProcess(): void {
  killActive();
}

/**
 * RTK (Rust Token Killer) manager.
 *
 * Provides binary resolution, feature gating, and environment wiring so command
 * execution can opt into RTK while safely falling back to direct execution.
 */

import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { spawn, spawnSync } from "child_process";
import { loadSettings, updateSetting } from "@/lib/settings/settings-manager";

function getLocalDataDir(): string {
  // turbopackIgnore: NFT cannot resolve process.cwd() at build time. Without
  // this marker the whole project gets pulled into every route's trace.
  const dataDir = process.env.LOCAL_DATA_PATH || join(/*turbopackIgnore: true*/ process.cwd(), ".local-data");
  if (!existsSync(/*turbopackIgnore: true*/ dataDir)) {
    mkdirSync(/*turbopackIgnore: true*/ dataDir, { recursive: true });
  }
  return dataDir;
}

/**
 * RTK supports overriding its DB location using RTK_DB_PATH.
 * We pin it to Selene's data directory so both products keep data together.
 */
export function getRTKDbPath(): string {
  return join(getLocalDataDir(), "rtk", "history.db");
}

function getPackagedRTKBinaryPath(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    || process.env.ELECTRON_RESOURCES_PATH;
  if (!resourcesPath) return null;

  let platformDir: string;
  if (process.platform === "darwin") {
    platformDir = process.arch === "arm64" ? "macos-arm64" : "macos-x64";
  } else if (process.platform === "win32") {
    platformDir = process.arch === "arm64" ? "windows-arm64" : "windows-x64";
  } else if (process.platform === "linux") {
    platformDir = process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  } else {
    return null;
  }

  const binaryName = process.platform === "win32" ? "rtk.exe" : "rtk";
  // turbopackIgnore: resourcesPath/platformDir are only known at runtime
  // (Electron packaged vs. dev). Letting NFT see this join causes whole-project tracing.
  const binaryPath = join(/*turbopackIgnore: true*/ resourcesPath, "binaries", "rtk", platformDir, binaryName);
  return existsSync(/*turbopackIgnore: true*/ binaryPath) ? binaryPath : null;
}

/**
 * Resolve RTK binary path.
 * - Packaged app: use bundled binary
 * - Dev: fall back to PATH lookup via plain `rtk`
 */
function resolveRTKBinaryPath(): string {
  return getPackagedRTKBinaryPath() || "rtk";
}

function getRTKSpawnEnv(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...(baseEnv || process.env) };
  env.RTK_DB_PATH = getRTKDbPath();
  return env;
}

function isRTKBinaryUsable(binaryPath: string): boolean {
  try {
    const probe = spawnSync(binaryPath, ["--version"], {
      stdio: "ignore",
      timeout: 2000,
      env: getRTKSpawnEnv(),
    });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
}

export function getRTKEnvironment(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return getRTKSpawnEnv(baseEnv);
}

/**
 * Cheap capability check used by startup and settings flows.
 */
export async function checkRTKInstalled(): Promise<boolean> {
  const binaryPath = resolveRTKBinaryPath();

  return new Promise((resolve) => {
    const child = spawn(binaryPath, ["--version"], {
      stdio: "pipe",
      timeout: 5000,
      env: getRTKSpawnEnv(),
    });

    let output = "";
    child.stdout?.on("data", (data) => {
      output += data.toString();
    });

    child.on("close", (code) => {
      const installed = code === 0 && output.toLowerCase().includes("rtk");
      updateSetting("rtkInstalled", installed);
      resolve(installed);
    });

    child.on("error", () => {
      updateSetting("rtkInstalled", false);
      resolve(false);
    });
  });
}

export async function initializeRTK(): Promise<void> {
  const dbPath = getRTKDbPath();
  const dbDir = dirname(dbPath);
  // turbopackIgnore: dbDir derives from process.cwd() / resourcesPath; runtime-only.
  if (!existsSync(/*turbopackIgnore: true*/ dbDir)) {
    mkdirSync(/*turbopackIgnore: true*/ dbDir, { recursive: true });
  }

  updateSetting("rtkDbPath", dbPath);

  const installed = await checkRTKInstalled();
  if (!installed) {
    console.log("[RTK] Not available - experimental RTK mode remains disabled");
    return;
  }

  const settings = loadSettings();
  if (settings.rtkEnabled) {
    console.log(`[RTK] Enabled with DB: ${dbPath}`);
  } else {
    console.log("[RTK] Installed but disabled in settings (experimental feature)");
  }
}

export function getRTKBinary(): string | null {
  const settings = loadSettings();
  if (!settings.rtkEnabled || !settings.rtkInstalled) {
    return null;
  }

  const binaryPath = resolveRTKBinaryPath();
  if (!isRTKBinaryUsable(binaryPath)) {
    // The persisted settings can become stale across dev/prod transitions.
    // Disable RTK eagerly so command execution falls back to direct mode.
    updateSetting("rtkInstalled", false);
    return null;
  }

  return binaryPath;
}

export function getRTKFlags(): string[] {
  const settings = loadSettings();
  const flags: string[] = [];

  if (settings.rtkVerbosity && settings.rtkVerbosity > 0) {
    flags.push(`-${"v".repeat(settings.rtkVerbosity)}`);
  }
  if (settings.rtkUltraCompact) {
    flags.push("-u");
  }

  return flags;
}

const RTK_SUPPORTED_COMMANDS = new Set([
  "git", "grep", "rg", "cat", "ls", "tree", "find", "diff", "head",
  "gh", "cargo", "npm", "pnpm", "npx", "vitest", "tsc", "eslint",
  "prettier", "playwright", "prisma", "docker", "kubectl", "curl", "wget",
  "pytest", "ruff", "pip", "uv", "go", "golangci-lint",
]);

export function shouldUseRTK(command: string): boolean {
  const normalized = command.toLowerCase();
  if (!RTK_SUPPORTED_COMMANDS.has(normalized)) {
    return false;
  }

  const settings = loadSettings();
  if (!settings.rtkEnabled || !settings.rtkInstalled) {
    return false;
  }

  return true;
}

export async function getRTKStats(): Promise<{
  totalSaved: number;
  savingsPercent: number;
  commandCount: number;
} | null> {
  const settings = loadSettings();
  if (!settings.rtkInstalled) {
    return null;
  }

  const binaryPath = resolveRTKBinaryPath();
  return new Promise((resolve) => {
    const child = spawn(binaryPath, ["gain", "--format", "json"], {
      stdio: "pipe",
      timeout: 5000,
      env: getRTKSpawnEnv(),
    });

    let output = "";
    child.stdout?.on("data", (data) => {
      output += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      try {
        const stats = JSON.parse(output);
        resolve({
          totalSaved: stats.total_savings_tokens || 0,
          savingsPercent: stats.savings_pct || 0,
          commandCount: stats.command_count || 0,
        });
      } catch {
        resolve(null);
      }
    });

    child.on("error", () => {
      resolve(null);
    });
  });
}

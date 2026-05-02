import * as path from "path";
import * as fs from "fs";
import * as nodeNet from "node:net";
import { utilityProcess, dialog, net } from "electron";
import { debugLog, debugError, debugVerbose } from "./debug-logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Port the H2 proxy listens on — what the renderer connects to. */
export const PROD_SERVER_PORT = 3456;
/** Port the Next.js standalone server actually listens on (internal, HTTP/1.1). */
export const NEXT_INTERNAL_PORT = 3457;
const WATCHER_RESOURCE_ERROR_REGEX = /(EMFILE|ENOSPC|EBADF|EAGAIN|too many open files|System limit for number of file watchers reached)/i;
const PORT_IN_USE_ERROR_REGEX = /\bEADDRINUSE\b|address already in use/i;
const MAX_SERVER_RESTARTS = 3;
const RESTART_RESET_INTERVAL = 5 * 60 * 1000;
const DEFAULT_PORT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_PORT_WAIT_POLL_MS = 250;


let nextServer: Electron.UtilityProcess | null = null;
let serverRestartCount = 0;
let serverRestartResetTimer: NodeJS.Timeout | null = null;
let lastServerError: string = "";

// ---------------------------------------------------------------------------
// Path verification helpers
// ---------------------------------------------------------------------------

function logDirectoryContents(dirPath: string, prefix: string = "", depth: number = 0, maxDepth: number = 2): void {
  if (depth > maxDepth) return;

  try {
    if (!fs.existsSync(dirPath)) {
      debugLog(`${prefix}[DIR NOT FOUND] ${dirPath}`);
      return;
    }

    const items = fs.readdirSync(dirPath);
    debugLog(`${prefix}${dirPath}/ (${items.length} items)`);

    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      try {
        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
          logDirectoryContents(itemPath, prefix + "  ", depth + 1, maxDepth);
        } else {
          debugLog(`${prefix}  ${item} (${stat.size} bytes)`);
        }
      } catch (e) {
        debugLog(`${prefix}  ${item} [ERROR: ${e}]`);
      }
    }
  } catch (e) {
    debugError(`${prefix}[ERROR reading ${dirPath}]:`, e);
  }
}

function verifyStandalonePaths(): void {
  debugLog("\n=== PATH VERIFICATION ===");

  const resourcesPath = process.resourcesPath;
  debugLog("[Paths] process.resourcesPath:", resourcesPath);

  const standaloneDir = path.join(resourcesPath, "standalone");
  const serverJs = path.join(standaloneDir, "server.js");
  const staticDir = path.join(standaloneDir, ".next", "static");
  const publicDir = path.join(standaloneDir, "public");

  debugLog("[Paths] Expected locations:");
  debugLog("  - standaloneDir:", standaloneDir);
  debugLog("  - serverJs:", serverJs);
  debugLog("  - staticDir:", staticDir);
  debugLog("  - publicDir:", publicDir);

  debugLog("[Paths] Existence checks:");
  debugLog("  - standaloneDir exists:", fs.existsSync(standaloneDir));
  debugLog("  - serverJs exists:", fs.existsSync(serverJs));
  debugLog("  - staticDir exists:", fs.existsSync(staticDir));
  debugLog("  - publicDir exists:", fs.existsSync(publicDir));

  // Log contents of resources directory
  debugLog("\n=== RESOURCES DIRECTORY CONTENTS ===");
  logDirectoryContents(resourcesPath, "", 0, 3);

  debugLog("=== END PATH VERIFICATION ===\n");
}

async function canBindLoopbackPort(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = nodeNet.createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      server.removeAllListeners();
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(error);
    });

    server.once("listening", () => {
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(true);
      });
    });

    server.listen(port, "127.0.0.1");
  });
}

export async function waitForLoopbackPortToBeAvailable(
  port: number,
  options: {
    label?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {}
): Promise<void> {
  const {
    label = `port ${port}`,
    timeoutMs = DEFAULT_PORT_WAIT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_PORT_WAIT_POLL_MS,
  } = options;

  const startTime = Date.now();
  let loggedWait = false;

  while (Date.now() - startTime < timeoutMs) {
    if (await canBindLoopbackPort(port)) {
      if (loggedWait) {
        debugLog(`[PortCheck] ${label} became available after ${Date.now() - startTime}ms`);
      }
      return;
    }

    if (!loggedWait) {
      loggedWait = true;
      debugLog(`[PortCheck] Waiting for ${label} on 127.0.0.1:${port} to become available`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`${label} is already in use on 127.0.0.1:${port}`);
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * HTTP health check — polls the server until it responds or the timeout expires.
 */
export async function waitForServerReady(url: string, timeoutMs: number = 30000): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 500;
  let attempts = 0;

  debugLog(`[HealthCheck] Starting health check for ${url} (timeout: ${timeoutMs}ms)`);

  while (Date.now() - startTime < timeoutMs) {
    attempts++;
    try {
      debugVerbose(`[HealthCheck] Attempt ${attempts} - fetching ${url}`);
      const response = await net.fetch(url);
      debugVerbose(`[HealthCheck] Response status: ${response.status}`);

      if (response.ok || response.status === 200) {
        debugLog(`[HealthCheck] Server is ready after ${attempts} attempts (${Date.now() - startTime}ms)`);
        return true;
      }
    } catch (e) {
      debugVerbose(`[HealthCheck] Attempt ${attempts} failed:`, e instanceof Error ? e.message : e);
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  debugError(`[HealthCheck] Server not ready after ${timeoutMs}ms and ${attempts} attempts`);
  return false;
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

interface StartNextServerOptions {
  userDataPath: string;
  /** Callback used to check if the Electron app is currently quitting. */
  isAppQuitting: () => boolean;
  /** Callback used to obtain a reference to the main window (may be null). */
  getMainWindow: () => { reload(): void } | null;
}

/**
 * Start the embedded Next.js standalone server in production mode.
 */
export async function startNextServer(opts: StartNextServerOptions): Promise<void> {
  debugLog("\n=== STARTING NEXT.JS SERVER ===");

  // First, verify all paths
  verifyStandalonePaths();

  return new Promise((resolve, reject) => {
    let isSettled = false;
    const settleResolve = () => {
      if (isSettled) return;
      isSettled = true;
      resolve();
    };
    const settleReject = (error: unknown) => {
      if (isSettled) return;
      isSettled = true;
      reject(error);
    };

    // In production, the standalone server is in extraResources/standalone/server.js
    // process.resourcesPath points to the Resources folder in the app bundle
    const resourcesPath = process.resourcesPath;
    const standaloneServer = path.join(resourcesPath, "standalone", "server.js");
    const standaloneDir = path.dirname(standaloneServer);

    debugLog("[Next.js] Resources path:", resourcesPath);
    debugLog("[Next.js] Standalone server path:", standaloneServer);
    debugLog("[Next.js] Standalone dir:", standaloneDir);
    debugLog("[Next.js] Server exists:", fs.existsSync(standaloneServer));
    debugLog("[Next.js] Using execPath:", process.execPath);

    if (!fs.existsSync(standaloneServer)) {
      debugError("[Next.js] Standalone server not found at:", standaloneServer);
      settleReject(new Error(`Standalone server not found: ${standaloneServer}`));
      return;
    }

    // Log the server.js file size and first few bytes to confirm it's valid
    try {
      const serverStat = fs.statSync(standaloneServer);
      debugLog("[Next.js] server.js file size:", serverStat.size, "bytes");
      const serverContent = fs.readFileSync(standaloneServer, "utf-8").slice(0, 500);
      debugLog("[Next.js] server.js first 500 chars:", serverContent);
    } catch (e) {
      debugError("[Next.js] Error reading server.js:", e);
    }

    debugLog("[Next.js] Spawning server process...");
    debugLog("[Next.js] Working directory:", standaloneDir);
    debugLog("[Next.js] Environment PORT:", NEXT_INTERNAL_PORT);

    // Use utilityProcess.fork() to run the Next.js standalone server.
    // This uses Electron's built-in Node.js runtime (correct ABI for native
    // modules like better-sqlite3) without spawning a visible OS process.
    // Unlike spawn(process.execPath) with ELECTRON_RUN_AS_NODE, this does NOT
    // cause a Terminal/dock icon to appear on macOS.
    try {
      nextServer = utilityProcess.fork(standaloneServer, [], {
        cwd: standaloneDir,
        env: {
          ...process.env,
          NODE_ENV: "production",
          PORT: String(NEXT_INTERNAL_PORT),
          HOSTNAME: "127.0.0.1",
          LOCAL_DATA_PATH: path.join(opts.userDataPath, "data"),
          NEXT_TELEMETRY_DISABLED: "1",
          ELECTRON_RESOURCES_PATH: resourcesPath,
          SELENE_PRODUCTION_BUILD: "1",
          SELENE_UNSAFE_AGENT_PERMISSIONS: process.env.SELENE_UNSAFE_AGENT_PERMISSIONS || "true",
          // Keep-alive timeout for idle sockets between requests (milliseconds).
          // Default is 5000ms which can recycle sockets too aggressively during
          // periods of bursty activity. Set to 10 minutes.
          KEEP_ALIVE_TIMEOUT: "600000",
        },
        stdio: "pipe",
        serviceName: "next-server",
      });
    } catch (error) {
      debugError("[Next.js] Failed to fork utility process:", error);
      settleReject(error);
      return;
    }

    debugLog("[Next.js] Spawn called, pid:", nextServer.pid);

    nextServer.stdout?.on("data", (data) => {
      const output = data.toString();
      debugVerbose("[Next.js stdout]", output);
      if (output.includes("Ready") || output.includes("started server") || output.includes("Listening")) {
        debugLog("[Next.js] Server ready signal detected!");
        settleResolve();
      }
    });

    nextServer.stderr?.on("data", (data) => {
      const output = data.toString();
      debugError("[Next.js stderr]", output);

      // Capture last meaningful error for crash diagnostics
      const trimmed = output.trim();
      if (trimmed.length > 10 && !trimmed.startsWith("[Next.js]")) {
        lastServerError = trimmed.slice(0, 300);
      }

      if (WATCHER_RESOURCE_ERROR_REGEX.test(output)) {
        debugError(
          "[Next.js] Watcher resource exhaustion detected in embedded server process. " +
          "Electron utilityProcess on macOS becomes fragile under FD pressure; exclude large sync subtrees " +
          "(.venv, __pycache__, site-packages, node_modules, image/font assets) or sync a smaller folder."
        );
      }

      if (PORT_IN_USE_ERROR_REGEX.test(output)) {
        settleReject(new Error(`Embedded Next.js server could not bind to 127.0.0.1:${NEXT_INTERNAL_PORT}`));
      }
    });

    nextServer.on("exit", (code) => {
      debugLog("[Next.js] Process exited with code:", code);
      nextServer = null;

      if (!isSettled) {
        settleReject(new Error(lastServerError || `Embedded Next.js server exited during startup (code: ${code ?? "unknown"})`));
        return;
      }

      // Don't auto-restart on intentional shutdown or when no window exists.
      if (opts.isAppQuitting() || !opts.getMainWindow()) {
        return;
      }

      if (serverRestartCount >= MAX_SERVER_RESTARTS) {
        debugError("[Next.js] Max restart attempts reached. Server will not auto-restart.");
        let crashMessage = "The application server has crashed repeatedly. Please restart the app manually.";
        if (lastServerError) {
          // Detect common crash causes
          if (lastServerError.includes("local_files_only") || lastServerError.includes("bge-") || lastServerError.includes("embedding")) {
            crashMessage += "\n\nLikely cause: The embedding model is incomplete or corrupted. Try re-downloading it from Settings.";
          } else if (lastServerError.includes("ENOMEM") || lastServerError.includes("heap")) {
            crashMessage += "\n\nLikely cause: Out of memory. Try using a smaller embedding model.";
          }
          crashMessage += `\n\nLast error: ${lastServerError.slice(0, 200)}`;
        }
        dialog.showErrorBox("Server Crashed", crashMessage);
        lastServerError = "";
        return;
      }

      serverRestartCount += 1;
      debugLog(`[Next.js] Auto-restarting server (attempt ${serverRestartCount}/${MAX_SERVER_RESTARTS})...`);

      if (serverRestartResetTimer) {
        clearTimeout(serverRestartResetTimer);
      }
      serverRestartResetTimer = setTimeout(() => {
        serverRestartCount = 0;
      }, RESTART_RESET_INTERVAL);

      setTimeout(() => {
        startNextServer(opts)
          .then(() => {
            debugLog("[Next.js] Server restarted successfully");
            opts.getMainWindow()?.reload();
          })
          .catch((error) => {
            debugError("[Next.js] Failed to restart server:", error);
          });
      }, 2000);
    });

    // Timeout fallback - proceed in degraded mode to avoid blocking app startup
    setTimeout(() => {
      if (isSettled) {
        return;
      }
      debugError("[Next.js] Timeout reached (5s), continuing in degraded startup mode while server may still be initializing");
      settleResolve();
    }, 5000);
  });
}

/**
 * Stop the Next.js server.
 */
export function stopNextServer(): void {
  if (nextServer) {
    nextServer.kill();
    nextServer = null;
  }
}

/**
 * Clear the server restart timer (call on before-quit).
 */
export function clearServerRestartTimer(): void {
  if (serverRestartResetTimer) {
    clearTimeout(serverRestartResetTimer);
    serverRestartResetTimer = null;
  }
}

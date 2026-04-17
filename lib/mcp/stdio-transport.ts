import spawn from "cross-spawn";
import type { ChildProcess, IOType } from "child_process";
import { execSync, spawnSync } from "child_process";
import { PassThrough, type Stream } from "stream";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { isEBADFError } from "@/lib/spawn-utils";

type StdioServerParameters = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    stderr?: IOType | Stream | number;
    cwd?: string;
    windowsHide?: boolean;
    /**
     * Logical server name (e.g. "ghostos", "filesystem"). Used as a stable
     * identifier for the stderr log file when running under Electron/prod
     * where stderr would otherwise be dropped to /dev/null. Optional — if
     * omitted the transport falls back to a command-derived label so older
     * callers still get a log they can open.
     */
    serverName?: string;
};

/**
 * Cap per-sidecar stderr log at 5 MB. Older content is kept in <name>.1 so
 * a postmortem still has recent context after rotation.
 */
const STDERR_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * How long `send()` will wait for the child's stdin pipe to drain before
 * escalating. If the child has stopped reading its stdin (classic stdio
 * deadlock: child blocked on a full stdout pipe → stops consuming stdin →
 * parent never gets a "drain" event), the parent would otherwise wait
 * forever. 15s is long enough to ride out legitimate bursts but short
 * enough that a wedged sidecar gets surfaced before the user gives up.
 */
const STDIO_WRITE_TIMEOUT_MS = 15_000;

function sanitizeServerNameForLog(raw: string): string {
    // Keep the path-safe subset; everything else collapses to "_".
    return raw.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64) || "mcp";
}

function getStderrLogPath(serverName: string): string {
    const baseDir = process.env.ELECTRON_USER_DATA_PATH || os.tmpdir();
    return path.join(baseDir, "logs", "mcp", `${sanitizeServerNameForLog(serverName)}-stderr.log`);
}

/**
 * Open (and if needed rotate) the stderr log file for this sidecar, returning
 * a file descriptor suitable for use as the child's stdio[2]. Returns null
 * if the file cannot be opened — callers should fall back to "ignore" in
 * that case so a logging failure never prevents the sidecar from starting.
 */
function openStderrLogFd(serverName: string): number | null {
    try {
        const logPath = getStderrLogPath(serverName);
        fs.mkdirSync(path.dirname(logPath), { recursive: true });

        // Rotate if the current log exceeds our cap.
        try {
            const stats = fs.statSync(logPath);
            if (stats.size > STDERR_LOG_MAX_BYTES) {
                const rotatedPath = `${logPath}.1`;
                try {
                    fs.unlinkSync(rotatedPath);
                } catch {
                    // prior .1 may not exist; fine.
                }
                fs.renameSync(logPath, rotatedPath);
            }
        } catch {
            // Log didn't exist yet — nothing to rotate.
        }

        const fd = fs.openSync(logPath, "a");
        const header =
            `\n=== [MCP ${serverName}] session start ${new Date().toISOString()} ` +
            `parentPid=${process.pid} ===\n`;
        try {
            fs.writeSync(fd, header);
        } catch {
            // Non-fatal — header is a nicety, not a requirement.
        }
        return fd;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[MCP] Failed to open stderr log for ${serverName}: ${message}`);
        return null;
    }
}

const DEFAULT_INHERITED_ENV_VARS = process.platform === "win32"
    ? [
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERNAME",
        "USERPROFILE",
        "PROGRAMFILES",
    ]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

/**
 * Known locations for Node.js binaries on macOS
 */
const MACOS_NODE_PATHS = [
    "/usr/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
];

type BundledNodeProbeCache = {
    binaryPath: string;
    usable: boolean;
};

let bundledNodeProbeCache: BundledNodeProbeCache | null = null;

function normalizeExecutableName(command: string): string {
    const baseName = path.basename(command).toLowerCase();
    return baseName.replace(/\.(cmd|exe|bat)$/i, "");
}

function isExecutable(filePath: string): boolean {
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}


/**
 * Attempt to resolve a command to its absolute path
 * Returns the original command if resolution fails
 */
function resolveCommandPath(command: string): string {
    const normalizedCommand = normalizeExecutableName(command);
    // Only resolve node-related commands that commonly fail
    if (!["npx", "node", "npm"].includes(normalizedCommand)) {
        return command;
    }

    // If already absolute, use as-is
    if (path.isAbsolute(command)) {
        return command;
    }

    // Avoid shell lookups on Windows to prevent "which" errors.
    if (process.platform === "win32") {
        return command;
    }

    // Try a POSIX lookup first (works if PATH is correct)
    try {
        const result = execSync(`command -v ${normalizedCommand}`, {
            encoding: "utf-8",
            timeout: 2000,
        }).trim();
        if (result && path.isAbsolute(result)) {
            console.log(`[MCP] Resolved command: ${command} -> ${result}`);
            return result;
        }
    } catch {
        // command -v failed, try known paths
    }

    // Fallback: Check known macOS paths directly
    if (process.platform === "darwin") {
        for (const dir of MACOS_NODE_PATHS) {
            const fullPath = path.join(dir, normalizedCommand);
            if (isExecutable(fullPath)) {
                console.log(`[MCP] Resolved command via known paths: ${command} -> ${fullPath}`);
                return fullPath;
            }
        }
    }

    // Return original command as last resort
    return command;
}

type ResolvedSpawnCommand = {
    command: string;
    args: string[];
    env?: Record<string, string>;
};

function isNodeRuntimeUsable(binaryPath: string): boolean {
    return isBundledNodeUsable(binaryPath);
}

function getSystemNodeExe(basePath: string | undefined): string | null {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const nodeBinaryName = process.platform === "win32" ? "node.exe" : "node";

    const pushCandidate = (candidate: string | null | undefined): void => {
        if (!candidate || !path.isAbsolute(candidate)) {
            return;
        }

        const normalized = path.normalize(candidate);
        if (seen.has(normalized)) {
            return;
        }

        seen.add(normalized);
        candidates.push(candidate);
    };

    for (const dir of (basePath ?? "").split(path.delimiter).filter(Boolean)) {
        pushCandidate(path.join(dir, nodeBinaryName));
    }

    pushCandidate(resolveCommandPath("node"));

    if (process.platform === "darwin") {
        for (const dir of MACOS_NODE_PATHS) {
            pushCandidate(path.join(dir, nodeBinaryName));
        }
    }

    for (const candidate of candidates) {
        if (process.platform !== "win32" && !isExecutable(candidate)) {
            continue;
        }

        if (!isNodeRuntimeUsable(candidate)) {
            continue;
        }

        return candidate;
    }

    return null;
}

function isBundledNodeUsable(binaryPath: string): boolean {
    if (bundledNodeProbeCache?.binaryPath === binaryPath) {
        return bundledNodeProbeCache.usable;
    }

    try {
        const probe = spawnSync(binaryPath, ["--version"], {
            // Keep stdin as a pipe to avoid ignore-related EBADF issues in some Electron contexts.
            stdio: ["pipe", "ignore", "ignore"],
            windowsHide: true,
            timeout: 2000,
        });

        const usable = !probe.error && probe.status === 0;
        if (!usable) {
            const reason = probe.error
                ? probe.error.message
                : `exitCode=${probe.status ?? "null"} signal=${probe.signal ?? "null"}`;
            console.warn(`[MCP] Bundled node probe failed: ${binaryPath} (${reason})`);
        }

        bundledNodeProbeCache = { binaryPath, usable };
        return usable;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[MCP] Bundled node probe threw for ${binaryPath}: ${message}`);
        bundledNodeProbeCache = { binaryPath, usable: false };
        return false;
    }
}

/**
 * Get path to bundled Node.js binary (Windows and macOS, production builds)
 * Returns null if not found or not on a supported platform
 */
function getBundledNodeExe(): string | null {
    if (process.platform !== "win32" && process.platform !== "darwin") {
        return null;
    }

    const resourcesPath = process.env.ELECTRON_RESOURCES_PATH
        || (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

    if (!resourcesPath) {
        return null;
    }

    const nodeBinaryName = process.platform === "win32" ? "node.exe" : "node";
    const bundledNodePath = path.join(resourcesPath, "standalone", "node_modules", ".bin", nodeBinaryName);

    try {
        if (!fs.existsSync(bundledNodePath)) {
            return null;
        }

        if (process.platform !== "win32" && !isExecutable(bundledNodePath)) {
            console.warn(`[MCP] Bundled ${nodeBinaryName} is not executable: ${bundledNodePath}`);
            return null;
        }

        if (!isBundledNodeUsable(bundledNodePath)) {
            console.warn(`[MCP] Bundled ${nodeBinaryName} is unusable, falling back to Electron runtime`);
            return null;
        }

        console.log(`[MCP] Found bundled ${nodeBinaryName} at: ${bundledNodePath}`);
        return bundledNodePath;
    } catch {
        // Ignore filesystem errors
    }

    return null;
}

function ensureNodeShimDir(): string | null {
    const baseDir = process.env.ELECTRON_USER_DATA_PATH || os.tmpdir();
    if (!baseDir) {
        return null;
    }

    const shimDir = path.join(baseDir, ".selene-node", "bin");
    const shimPath = path.join(shimDir, process.platform === "win32" ? "node.cmd" : "node");

    try {
        if (!fs.existsSync(shimPath)) {
            fs.mkdirSync(shimDir, { recursive: true });
            if (process.platform === "win32") {
                // Windows node.cmd shim - fallback if bundled node.exe not available
                // Note: cmd.exe may briefly flash a window when npm/npx spawns this shim.
                const contents = [
                    "@echo off",
                    "set ELECTRON_RUN_AS_NODE=1",
                    "set ELECTRON_NO_ATTACH_CONSOLE=1",
                    "set ELECTRON_ENABLE_LOGGING=0",
                    `"${process.execPath}" %*`,
                    "",
                ].join("\r\n");
                fs.writeFileSync(shimPath, contents, { encoding: "utf-8" });
            } else {
                const escapedExecPath = process.execPath.replace(/"/g, '\\"');
                const contents = [
                    "#!/bin/sh",
                    "export ELECTRON_RUN_AS_NODE=1",
                    `exec "${escapedExecPath}" "$@"`,
                    "",
                ].join("\n");
                fs.writeFileSync(shimPath, contents, { encoding: "utf-8", mode: 0o755 });
                fs.chmodSync(shimPath, 0o755);
            }
        }
        return shimDir;
    } catch {
        return null;
    }
}

/**
 * Get the directory containing a node binary that should be prepended to PATH.
 * This ensures spawned processes (like npx installing packages that internally
 * spawn `node`) can always find a working node runtime via PATH lookup.
 *
 * Priority: bundled node's .bin dir > Electron-as-Node shim dir > null
 */
function getNodeBinDir(): string | null {
    const bundledNode = getBundledNodeExe();
    if (bundledNode) {
        return path.dirname(bundledNode);
    }

    return ensureNodeShimDir();
}

function prependPath(existingPath: string | undefined, extraDir: string): string {
    const delimiter = path.delimiter;
    const trimmed = existingPath || "";
    const parts = trimmed.split(delimiter).filter(Boolean);
    if (parts.includes(extraDir)) {
        return trimmed;
    }
    return [extraDir, trimmed].filter(Boolean).join(delimiter);
}

function getBundledNpmCliPath(cliName: "npx-cli.js" | "npm-cli.js"): string | null {
    // In packaged Electron apps, process.resourcesPath is only available in the main process.
    // For the Next.js server (child process), we use ELECTRON_RESOURCES_PATH env var.
    const resourcesPath = process.env.ELECTRON_RESOURCES_PATH
        || (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    
    const candidates = [
        // Primary: bundled in resources/standalone/node_modules/npm/bin/
        path.join(resourcesPath ?? "", "standalone", "node_modules", "npm", "bin", cliName),
        // Fallback: relative to cwd (for dev mode)
        path.join(process.cwd(), "node_modules", "npm", "bin", cliName),
    ];
    
    console.log(`[MCP] Looking for bundled ${cliName}, resourcesPath=${resourcesPath}, candidates:`, candidates);

    for (const candidate of candidates) {
        try {
            if (candidate && fs.existsSync(candidate)) {
                return candidate;
            }
        } catch {
            // Ignore filesystem errors while probing.
        }
    }

    return null;
}

function resolveSpawnCommand(serverParams: StdioServerParameters): ResolvedSpawnCommand {
    const originalCommand = serverParams.command;
    const normalizedCommand = normalizeExecutableName(originalCommand);
    const baseArgs = serverParams.args ?? [];
    const resolvedCommand = resolveCommandPath(originalCommand);
    const nodeBinDir = getNodeBinDir();

    const basePath = serverParams.env?.PATH ?? process.env.PATH;

    // On Windows, prefer bundled node.exe to avoid console window flashing
    // The bundled node.exe is a real console app where windowsHide works correctly,
    // unlike Electron with ELECTRON_RUN_AS_NODE which still allocates a console
    const bundledNodeExe = getBundledNodeExe();

    if (normalizedCommand === "npx" || normalizedCommand === "npm") {
        const cliName = normalizedCommand === "npx" ? "npx-cli.js" : "npm-cli.js";
        const bundledCli = getBundledNpmCliPath(cliName);
        if (bundledCli) {
            // Prefer bundled node first, then a verified system node, and finally Electron.
            const systemNodeExe = getSystemNodeExe(basePath);
            const nodeRuntime = bundledNodeExe ?? systemNodeExe ?? process.execPath;
            const useElectronRunAsNode = !bundledNodeExe && !systemNodeExe;

            console.log(`[MCP] Using bundled npm CLI for ${originalCommand}: ${bundledCli} (runtime: ${nodeRuntime})`);
            return {
                command: nodeRuntime,
                args: [bundledCli, ...baseArgs],
                env: {
                    ...(useElectronRunAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
                    ...(nodeBinDir ? { PATH: prependPath(basePath, nodeBinDir) } : {}),
                },
            };
        }
    }

    if (normalizedCommand === "node" && !path.isAbsolute(resolvedCommand)) {
        // Use bundled node.exe on Windows if available
        if (bundledNodeExe) {
            console.log(`[MCP] Using bundled node.exe for node command: ${bundledNodeExe}`);
            return {
                command: bundledNodeExe,
                args: baseArgs,
                env: nodeBinDir ? { PATH: prependPath(basePath, nodeBinDir) } : undefined,
            };
        }

        const systemNodeExe = getSystemNodeExe(basePath);
        if (systemNodeExe) {
            console.log(`[MCP] Using system node for node command: ${systemNodeExe}`);
            return {
                command: systemNodeExe,
                args: baseArgs,
                env: nodeBinDir ? { PATH: prependPath(basePath, nodeBinDir) } : undefined,
            };
        }

        console.log("[MCP] Using Electron as Node runtime for node command");
        return {
            command: process.execPath,
            args: baseArgs,
            env: {
                ELECTRON_RUN_AS_NODE: "1",
                ...(nodeBinDir ? { PATH: prependPath(basePath, nodeBinDir) } : {}),
            },
        };
    }

    return {
        command: resolvedCommand,
        args: baseArgs,
        env: nodeBinDir ? { PATH: prependPath(basePath, nodeBinDir) } : undefined,
    };
}

function getDefaultEnvironment(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of DEFAULT_INHERITED_ENV_VARS) {
        const value = process.env[key];
        if (value === undefined) {
            continue;
        }
        if (value.startsWith("()")) {
            // Skip functions, which are a security risk.
            continue;
        }
        env[key] = value;
    }
    return env;
}

/**
 * Determine if we're running in a production (packaged) environment
 */
function isProductionBuild(): boolean {
    // Check various indicators of a packaged Electron app
    const isElectronDev = process.env.ELECTRON_IS_DEV === "1" || process.env.NODE_ENV === "development";

    // Check for explicit production marker (set by Electron main process)
    const hasProductionMarker = process.env.SELENE_PRODUCTION_BUILD === "1";

    // Check for resourcesPath (direct Electron) or ELECTRON_RESOURCES_PATH (Next.js server)
    const hasResourcesPath = !!(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
        || !!process.env.ELECTRON_RESOURCES_PATH;

    const isProduction = (hasProductionMarker || hasResourcesPath) && !isElectronDev;

    console.log(`[MCP] isProductionBuild check: hasProductionMarker=${hasProductionMarker}, hasResourcesPath=${hasResourcesPath}, isElectronDev=${isElectronDev}, result=${isProduction}`);

    return isProduction;
}

/**
 * Detect if we're running in an Electron environment (main or renderer process)
 * This checks for Electron-specific process properties
 */
function isElectronEnvironment(): boolean {
    return (
        typeof process !== 'undefined' &&
        (
            // Direct Electron indicator
            !!process.versions?.electron ||
            // Running as Electron node (ELECTRON_RUN_AS_NODE)
            process.env.ELECTRON_RUN_AS_NODE === '1' ||
            // Electron resources path indicators
            !!(process as any).resourcesPath ||
            !!process.env.ELECTRON_RESOURCES_PATH ||
            // Electron user data path
            !!process.env.ELECTRON_USER_DATA_PATH
        )
    );
}

export class StdioClientTransport implements Transport {
    private _process?: ChildProcess;
    private _readBuffer = new ReadBuffer();
    private _serverParams: StdioServerParameters;
    private _stderrStream: PassThrough | null = null;
    /** File descriptor for the persistent stderr log, when one was opened. */
    private _stderrLogFd: number | null = null;
    /** Absolute path of the persistent stderr log, for diagnostics/UI. */
    private _stderrLogPath: string | null = null;
    /** Guard that prevents processReadBuffer from queueing itself twice. */
    private _processScheduled = false;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(server: StdioServerParameters) {
        this._serverParams = server;
        if (server.stderr === "pipe" || server.stderr === "overlapped") {
            this._stderrStream = new PassThrough();
        }
    }

    async start(): Promise<void> {
        if (this._process) {
            throw new Error("StdioClientTransport already started!");
        }
        return new Promise((resolve, reject) => {
            // Resolve command path with bundled npm fallback for packaged apps.
            const resolvedSpawn = resolveSpawnCommand(this._serverParams);

            if (resolvedSpawn.command !== this._serverParams.command) {
                console.log(`[MCP] Resolved command: ${this._serverParams.command} -> ${resolvedSpawn.command}`);
            }

            // Determine if we're in production or Electron environment
            const isProduction = isProductionBuild();
            const isElectron = isElectronEnvironment();

            // In production/Electron we must NOT use "inherit" (EBADF) or a PassThrough
            // (avoid console-window flashing on Windows). Previously this branch returned
            // `"ignore"`, which dropped every sidecar error message — including the ones
            // we need to diagnose deadlocks and screen-capture failures — into /dev/null.
            //
            // Instead, open a rotating file log in ELECTRON_USER_DATA_PATH/logs/mcp/
            // and hand its file descriptor to the child as stdio[2]. A file-descriptor
            // stdio target is safe under Electron's utilityProcess (unlike "inherit") and
            // still hides any console window (unlike Electron-as-node running with
            // ELECTRON_RUN_AS_NODE=1). If opening the log fails for any reason we fall
            // back to "ignore" so logging can never prevent the sidecar from starting.
            const serverLogName = this._serverParams.serverName
                ?? path.basename(this._serverParams.command).replace(/\.(cmd|exe|bat)$/i, "");
            const stderrConfig: IOType | Stream | number = (() => {
                if (isProduction || isElectron) {
                    const fd = openStderrLogFd(serverLogName);
                    if (fd !== null) {
                        this._stderrLogFd = fd;
                        this._stderrLogPath = getStderrLogPath(serverLogName);
                        return fd;
                    }
                    // Couldn't open the log — keep behavior backwards-compatible.
                    return "ignore";
                }
                // Non-Electron dev: Allow user-specified stderr or default to 'pipe'
                return this._serverParams.stderr ?? "pipe";
            })();

            const stderrLabel =
                typeof stderrConfig === "string"
                    ? stderrConfig
                    : typeof stderrConfig === "number"
                        ? `fd(${this._stderrLogPath ?? stderrConfig})`
                        : "stream";
            console.log(`[MCP] Spawn config: platform=${process.platform}, isProduction=${isProduction}, isElectron=${isElectron}, stderr=${stderrLabel}`);

            const spawnOptions: any = {
                env: {
                    ...getDefaultEnvironment(),
                    ...this._serverParams.env,
                    ...resolvedSpawn.env,
                    // Prevent terminal detection and window spawning
                    TERM: "dumb",  // Disable color/interactive features
                    NO_COLOR: "1", // Disable colors
                    CI: "1",       // Many tools check this to disable interactive mode
                    // Electron-specific: prevent console window allocation
                    // When Electron runs with ELECTRON_RUN_AS_NODE=1, it may still allocate
                    // a console for stdio. These vars attempt to prevent that.
                    ELECTRON_NO_ATTACH_CONSOLE: "1",
                    ELECTRON_ENABLE_LOGGING: "0",
                    ELECTRON_NO_ASAR: "1",  // Disable asar support when running as Node
                },
                stdio: ["pipe", "pipe", stderrConfig],
                shell: false,
                cwd: this._serverParams.cwd,
                // CRITICAL: These options prevent terminal windows on ALL platforms
                // windowsHide: true - Hides console window on Windows (no-op on other platforms)
                // detached: false - Keeps process attached to parent, required for windowsHide
                windowsHide: true,
                detached: false,
            };

            console.log(`[MCP] Spawning: ${resolvedSpawn.command} ${(resolvedSpawn.args ?? []).join(" ")}`);
            
            const child = spawn(resolvedSpawn.command, resolvedSpawn.args ?? [], spawnOptions);
            this._process = child;
            // Track early exit for diagnostics
            let earlyExitCode: number | null = null;
            let earlyExitSignal: NodeJS.Signals | null = null;
            let spawnResolved = false;

            child.on("error", (error: Error) => {
                if (isEBADFError(error) && process.platform === "darwin") {
                    const ebadfError = new Error(
                        `MCP server "${resolvedSpawn.command}" failed to start: pipe creation failed with EBADF ` +
                        `in Electron utilityProcess on macOS. The stdio transport requires live pipes which are ` +
                        `not available in this environment. Consider using an SSE/streamable-HTTP transport instead.`
                    );
                    console.error("[MCP]", ebadfError.message);
                    reject(ebadfError);
                    this.onerror?.(ebadfError);
                    return;
                }
                reject(error);
                this.onerror?.(error);
            });
            child.on("spawn", () => {
                console.log(`[MCP] Process spawned with PID: ${child.pid}`);
                // Give process a brief moment to crash before declaring success.
                // Catches immediate failures (bad binary, missing deps, Gatekeeper kill).
                setTimeout(() => {
                    spawnResolved = true;
                    if (earlyExitCode !== null) {
                        const msg =
                            `MCP server process exited immediately with code ${earlyExitCode}` +
                            `${earlyExitSignal ? ` (signal: ${earlyExitSignal})` : ""}. ` +
                            `Command: ${resolvedSpawn.command} ${(resolvedSpawn.args ?? []).join(" ")}. ` +
                            `This may indicate the bundled Node.js binary cannot run on this system, ` +
                            `or the MCP package failed to install via npx.`;
                        console.error(`[MCP] ${msg}`);
                        reject(new Error(msg));
                    } else {
                        resolve();
                    }
                }, 150);
            });
            child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
                earlyExitCode = code;
                earlyExitSignal = signal;
                if (code !== null && code !== 0) {
                    console.error(
                        `[MCP] Process exited with code ${code}` +
                        `${signal ? ` (signal: ${signal})` : ""}` +
                        ` — command: ${resolvedSpawn.command} ${(resolvedSpawn.args ?? []).join(" ")}`
                    );
                } else if (signal) {
                    console.warn(`[MCP] Process killed by signal ${signal} — command: ${resolvedSpawn.command}`);
                }
                this._process = undefined;
                // If spawn already resolved, fire onclose normally.
                // If not yet resolved, the spawn handler's setTimeout will pick up the exit.
                if (spawnResolved) {
                    this.onclose?.();
                }
            });
            child.stdin?.on("error", (error: Error) => {
                this.onerror?.(error);
            });
            child.stdout?.on("data", (chunk: Buffer) => {
                this._readBuffer.append(chunk);
                this.scheduleProcessReadBuffer();
            });
            child.stdout?.on("error", (error: Error) => {
                this.onerror?.(error);
            });
            if (this._stderrStream && child.stderr) {
                child.stderr.pipe(this._stderrStream);
            }
        });
    }

    // fallow-ignore-next-line unused-class-member
    get stderr(): Stream | null {
        if (this._stderrStream) {
            return this._stderrStream;
        }
        return this._process?.stderr ?? null;
    }

    get pid(): number | null {
        return this._process?.pid ?? null;
    }

    /**
     * Absolute path of the stderr log file, if a file log was opened for this
     * sidecar. Useful for surfacing in the UI (e.g. a "View log" button) and
     * for pointing users at postmortem data after a hang.
     */
    get stderrLogPath(): string | null {
        return this._stderrLogPath;
    }

    /**
     * Schedule a drain of the read buffer. Uses a `setImmediate`-based step
     * loop so each message yields back to the event loop before the next one
     * is dispatched. The old implementation drained the entire buffer in a
     * tight `while (true)` loop, which could starve outbound stdin writes,
     * timers, and `"close"` events during a burst of large messages
     * (e.g. retina screenshots) and cause the classic writer-blocks-on-
     * full-pipe deadlock described in docs/bug-reports/2026-04-17-*.md.
     *
     * Idempotent: multiple chunk arrivals coalesce to a single drain loop.
     */
    private scheduleProcessReadBuffer(): void {
        if (this._processScheduled) {
            return;
        }
        this._processScheduled = true;
        setImmediate(() => this.drainReadBufferStep());
    }

    private drainReadBufferStep(): void {
        let message: JSONRPCMessage | null = null;
        try {
            message = this._readBuffer.readMessage();
        } catch (error) {
            this.onerror?.(error as Error);
        }

        if (message === null) {
            this._processScheduled = false;
            return;
        }

        try {
            this.onmessage?.(message);
        } catch (error) {
            this.onerror?.(error as Error);
        }

        // Yield to the event loop before the next message so stdin writes,
        // the stdin "drain" event, and process "close" can fire in between.
        setImmediate(() => this.drainReadBufferStep());
    }

    private closeStderrLogFd(): void {
        if (this._stderrLogFd !== null) {
            try {
                fs.closeSync(this._stderrLogFd);
            } catch {
                // best-effort — the child owns a duplicate fd
            }
            this._stderrLogFd = null;
        }
    }

    async close(): Promise<void> {
        if (this._process) {
            const processToClose = this._process;
            this._process = undefined;
            const closePromise = new Promise<void>(resolve => {
                processToClose.once("close", () => {
                    resolve();
                });
            });
            try {
                processToClose.stdin?.end();
            } catch {
                // ignore
            }
            await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 2000).unref())]);
            if (processToClose.exitCode === null) {
                try {
                    processToClose.kill("SIGTERM");
                } catch {
                    // ignore
                }
                await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 2000).unref())]);
            }
            if (processToClose.exitCode === null) {
                try {
                    processToClose.kill("SIGKILL");
                } catch {
                    // ignore
                }
            }
        }
        this._readBuffer.clear();
        this.closeStderrLogFd();
    }

    // fallow-ignore-next-line unused-class-member
    send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const stdin = this._process?.stdin;
            if (!stdin) {
                reject(new Error("Not connected"));
                return;
            }

            const json = serializeMessage(message);

            // ----- deadlock escape hatch -------------------------------------
            // If the child has stopped consuming stdin (classic stdio deadlock),
            // `stdin.write()` returns false and the "drain" event will never
            // fire. Previously this Promise hung forever. Now we bound it:
            //
            //  - If the timer fires we raise an error, escalate by killing the
            //    child so MCPClientManager's transport.onclose handler can evict
            //    the stale client and optionally respawn, and reject the Promise
            //    so the caller (client.callTool / client.listTools) stops waiting.
            //
            //  - We also honour the AbortSignal the MCP SDK may pass in
            //    `TransportSendOptions` — the old implementation ignored it,
            //    which made per-call cancellation impossible.
            // ------------------------------------------------------------------
            let settled = false;
            // The MCP SDK's TransportSendOptions doesn't expose `signal` in this
            // revision, but newer SDK versions add it. Read through a cast so
            // we honour it when present without pinning to a newer SDK.
            const signal = (options as { signal?: AbortSignal } | undefined)?.signal;

            const onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error("Aborted"));
            };

            const onTimeout = () => {
                if (settled) return;
                settled = true;
                cleanup();
                const err = new Error(
                    `MCP stdio write timed out after ${STDIO_WRITE_TIMEOUT_MS}ms — ` +
                    `sidecar is not consuming stdin (likely deadlocked on its stdout pipe)`
                );
                try {
                    this.onerror?.(err);
                } catch {
                    // subscriber threw; don't mask the timeout
                }
                // Escalate: kill the child so "close" fires and the manager
                // can clean up / auto-respawn. SIGKILL because the child is
                // wedged and won't respond to SIGTERM.
                try {
                    this._process?.kill("SIGKILL");
                } catch {
                    // process may already be gone
                }
                reject(err);
            };

            const timer = setTimeout(onTimeout, STDIO_WRITE_TIMEOUT_MS);

            const cleanup = () => {
                clearTimeout(timer);
                if (signal) {
                    signal.removeEventListener("abort", onAbort);
                }
            };

            if (signal) {
                if (signal.aborted) {
                    cleanup();
                    settled = true;
                    reject(new Error("Aborted"));
                    return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
            }

            const settleOk = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            };

            let writeReturned = false;
            try {
                writeReturned = stdin.write(json);
            } catch (error) {
                cleanup();
                settled = true;
                reject(error as Error);
                return;
            }
            if (writeReturned) {
                settleOk();
            } else {
                stdin.once("drain", settleOk);
            }
        });
    }
}

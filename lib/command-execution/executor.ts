/**
 * Command Executor
 *
 * Safe command execution using child_process.spawn.
 * Implements security measures:
 * - Shell execution (shell: true) - Required for Windows cmd.exe compatibility
 * - Sandboxed environment variables
 * - Timeout and output size limits
 * - Integration with validation and logging
 *
 * EBADF note: On macOS inside Electron's utilityProcess, creating stdio pipes
 * can fail with EBADF (bad file descriptor).  When that happens we fall back to
 * spawnWithFileCapture(), which runs the command via /bin/sh with stdio set to
 * ["ignore","ignore","ignore"] and redirects output to private temp files.
 * Pattern from openclaw/openclaw#4932 (Oceanswave:fix/async-file-capture-ebadf-fallback).
 */

import { spawn, ChildProcess } from "child_process";
import { validateCommand, validateExecutionDirectory } from "./validator";
import { commandLogger } from "./logger";
import { saveTerminalLog, updateTerminalLog } from "./log-manager";
import { isEBADFError, spawnWithFileCapture } from "@/lib/spawn-utils";
import { getResolvedShellEnvironment } from "@/lib/shell-env/resolver";
import { shouldUseRTK } from "@/lib/rtk";
import path from "path";
import type {
    ExecuteOptions,
    ExecuteResult,
    BackgroundProcessInfo,
    ExecuteCommandProgressUpdate,
} from "./types";
import {
    getBundledRuntimeInfo,
    buildSafeEnvironment,
    initializeCommandExecutionProcessEnv,
    resolveBundledNodeCommand,
    buildNotFoundDiagnostic,
    normalizeArgs,
} from "./executor-runtime";
import {
    BACKGROUND_TIMEOUT,
    DEFAULT_MAX_OUTPUT_SIZE,
    resolveTimeout,
    needsWindowsShell,
    wrapWithRTK,
    getRtkFallbackReason,
    buildExecuteSearchMetadata,
} from "./executor-rtk";
import { runEBADFFallback } from "./executor-ebadf";
import { nowISO } from "@/lib/utils/timestamp";

// EBADF helpers imported from @/lib/spawn-utils
// Re-export for backwards compatibility with tests
export { isEBADFError, spawnWithFileCapture } from "@/lib/spawn-utils";

// ── Background Process Registry ──────────────────────────────────────────────
const backgroundProcesses = new Map<string, BackgroundProcessInfo>();
const MAX_BACKGROUND_OUTPUT = 1048576; // 1MB per stream
const ESCALATION_DELAY_MS = 5000;
const BACKGROUND_LOG_SNAPSHOT_INTERVAL_MS = 5000;
let bgIdCounter = 0;

type TerminationReason = "timeout" | "output_limit" | "abort";

function hasMeaningfulOutput(stdout?: string, stderr?: string): boolean {
    return Boolean(stdout?.trim() || stderr?.trim());
}

function saveBackgroundLogSnapshot(info: BackgroundProcessInfo, force = false): string | undefined {
    if (!hasMeaningfulOutput(info.stdout, info.stderr)) {
        return info.logId;
    }

    const now = Date.now();
    if (!force && info.logId && info.lastLogSnapshotAt && now - info.lastLogSnapshotAt < BACKGROUND_LOG_SNAPSHOT_INTERVAL_MS) {
        return info.logId;
    }

    const logId = info.logId
        ? updateTerminalLog(info.logId, info.stdout, info.stderr)
        : saveTerminalLog(info.stdout, info.stderr);
    if (logId) {
        info.logId = logId;
        info.lastLogSnapshotAt = now;
    }
    return info.logId;
}

function nextBgId(): string {
    return `bg-${Date.now()}-${++bgIdCounter}`;
}

function isUnixLikePlatform(): boolean {
    return process.platform === "darwin" || process.platform === "linux";
}

function terminationMessage(reason: TerminationReason): string {
    if (reason === "abort") return "Process cancelled by abort signal";
    return "Process terminated due to timeout or output limit";
}

function terminateChildProcess(
    child: ChildProcess | null | undefined,
    _reason: TerminationReason,
    onSignalError?: (error: unknown) => void,
): void {
    if (!child) return;
    try {
        child.kill("SIGTERM");
    } catch (error) {
        onSignalError?.(error);
    }
    setTimeout(() => {
        try {
            child.kill("SIGKILL");
        } catch (error) {
            onSignalError?.(error);
        }
    }, ESCALATION_DELAY_MS);
}

function shellQuote(value: string): string {
    if (value.length === 0) return "''";
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildShellCommandLine(command: string, args: string[]): string {
    return [command, ...args].map(shellQuote).join(" ");
}

function getUserShellPath(): string | null {
    if (!isUnixLikePlatform()) return null;
    const shellEnv = getResolvedShellEnvironment();
    const candidate = shellEnv.SHELL || process.env.SHELL;
    if (candidate && path.isAbsolute(candidate)) {
        return candidate;
    }
    return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function isShellRetryEligibleCommand(command: string): boolean {
    const trimmed = command.trim();
    if (!trimmed) return false;
    // Only retry simple executable names through the login shell. This preserves
    // terminal-like resolution for commands such as `python` without turning the
    // command field into an unrestricted shell script surface.
    return !/[\s|&;<>$`(){}\n\r]/.test(trimmed);
}

interface ResolvedCommandRuntime {
    finalCommand: string;
    finalArgs: string[];
    finalEnv: NodeJS.ProcessEnv;
    wrapped: ReturnType<typeof wrapWithRTK>;
    resolution: ReturnType<typeof resolveBundledNodeCommand>["resolution"] | null;
    runtime: ReturnType<typeof getBundledRuntimeInfo>;
}

function resolveCommandRuntime(
    command: string,
    args: string[],
    baseEnv: NodeJS.ProcessEnv,
    options?: Parameters<typeof wrapWithRTK>[3]
): ResolvedCommandRuntime {
    const runtime = getBundledRuntimeInfo();
    const wrapped = wrapWithRTK(command, args, baseEnv, options);
    const resolved = wrapped.usingRTK
        ? { command: wrapped.command, args: wrapped.args, env: wrapped.env, resolution: null }
        : resolveBundledNodeCommand(wrapped.command, wrapped.args, wrapped.env, runtime);
    return {
        finalCommand: resolved.command,
        finalArgs: normalizeArgs(resolved.args),
        finalEnv: resolved.env as NodeJS.ProcessEnv,
        wrapped,
        resolution: resolved.resolution,
        runtime,
    };
}

function buildShellRetryOptions(options: ExecuteOptions, resolvedCommandLine?: string): ExecuteOptions {
    const commandLine = resolvedCommandLine || options.rawCommandLine || buildShellCommandLine(options.command, options.args);
    return {
        ...options,
        command: getUserShellPath() || "/bin/sh",
        args: ["-ilc", commandLine],
        rawCommandLine: commandLine,
        forceShellExecution: true,
        shellFallbackAttempted: true,
    };
}


/**
 * Start a command in the background. Returns immediately with a process ID.
 * The process continues running; call `getBackgroundProcess` to poll for output.
 *
 * @param options - Execution options (command, args, cwd, etc.)
 * @param allowedPaths - Array of allowed directory paths for validation
 * @returns Object with processId (or empty string on error) and optional error message
 */
export async function startBackgroundProcess(
    options: ExecuteOptions,
    allowedPaths: string[]
): Promise<{
    processId: string;
    error?: string;
    logId?: string;
}> {
    const { command, args, stdin, cwd, characterId, confirmRemoval, windowsVerbatimArguments, onBackgroundProcessSettled } = options;
    const timeout = options.timeout ?? BACKGROUND_TIMEOUT;
    const maxOutputSize = options.maxOutputSize ?? MAX_BACKGROUND_OUTPUT;
    const shouldRetryThroughShellOnMessage = (message: string): boolean => {
        if (!isShellRetryEligibleCommand(command)) return false;
        if (typeof stdin === "string" && stdin.length > 0) return true;
        return message.includes("ENOENT") && !path.isAbsolute(command) && !shouldUseRTK(command);
    };

    // Validate command
    const cmdValidation = validateCommand(command, args, { confirmRemoval });
    if (!cmdValidation.valid) {
        return { processId: "", error: cmdValidation.error };
    }

    // Validate working directory against allowed paths
    const cwdValidation = await validateExecutionDirectory(cwd, allowedPaths);
    if (!cwdValidation.valid) {
        return { processId: "", error: cwdValidation.error };
    }
    const resolvedCwd = cwdValidation.resolvedPath ?? cwd;

    initializeCommandExecutionProcessEnv();
    const baseEnv = buildSafeEnvironment(getBundledRuntimeInfo()) as NodeJS.ProcessEnv;

    // Wrap with RTK if enabled, otherwise resolve bundled Node/npm/npx in packaged builds.
    const { finalCommand, finalArgs, finalEnv } = resolveCommandRuntime(command, args, baseEnv);

    const id = nextBgId();

    try {
        const child = spawn(finalCommand, finalArgs, {
            cwd: resolvedCwd,
            shell: needsWindowsShell(finalCommand),
            // Use "pipe" for stdin rather than "ignore".  On macOS inside
            // Electron's utilityProcess "ignore" can itself trigger EBADF; we
            // close stdin immediately below to give the child EOF instead.
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            windowsVerbatimArguments: windowsVerbatimArguments ?? false,
            env: finalEnv,
        });

        const retryThroughShell = async (): Promise<{ processId: string }> => {
            const retryResult = await startBackgroundProcess(buildShellRetryOptions(options), allowedPaths);
            return { processId: retryResult.processId };
        };
        if (typeof stdin === "string" && stdin.length > 0) {
            child.stdin?.end(stdin);
        } else {
            child.stdin?.end(); // Send EOF — functionally identical to "ignore"
        }

        const info: BackgroundProcessInfo = {
            id,
            command,
            args,
            cwd,
            startedAt: Date.now(),
            settledAt: null,
            running: true,
            stdout: "",
            stderr: "",
            exitCode: null,
            signal: null,
            process: child,
            timeoutId: null,
        };

        let outputSize = 0;

        // Capture stdout
        child.stdout?.on("data", (chunk: Buffer) => {
            const data = chunk.toString();
            outputSize += data.length;
            if (outputSize <= maxOutputSize) {
                info.stdout += data;
            }
        });

        // Capture stderr
        child.stderr?.on("data", (chunk: Buffer) => {
            const data = chunk.toString();
            outputSize += data.length;
            if (outputSize <= maxOutputSize) {
                info.stderr += data;
            }
        });

        let backgroundProcessSettledNotified = false;
        const settleBackgroundProcess = (updates: Partial<Pick<BackgroundProcessInfo, "exitCode" | "signal" | "stdout" | "stderr" | "logId">> = {}) => {
            if (info.timeoutId) { clearTimeout(info.timeoutId); info.timeoutId = null; }
            if (!info.settledAt) info.settledAt = Date.now();
            info.running = false;
            Object.assign(info, updates);
            if (!backgroundProcessSettledNotified) {
                backgroundProcessSettledNotified = true;
                onBackgroundProcessSettled?.(info);
            }
        };

        // Handle completion
        child.on("close", (code, signal) => {
            // Save full log for background process too
            saveBackgroundLogSnapshot(info, true);
            settleBackgroundProcess({ exitCode: code, signal });

            commandLogger.logExecutionComplete(
                command, code, Date.now() - info.startedAt,
                { stdout: info.stdout.length, stderr: info.stderr.length },
                { characterId },
            );
        });

        // Handle spawn errors — including EBADF fallback
        child.on("error", async (error) => {
            // macOS Electron utilityProcess: pipe creation can fail with EBADF.
            // Re-run via file-capture (no pipes; output written to temp files).
            if (isEBADFError(error) && process.platform === "darwin") {
                console.warn("[Command Executor] spawn EBADF on background process – retrying with file-capture fallback");
                if (info.timeoutId) { clearTimeout(info.timeoutId); info.timeoutId = null; }

                try {
                    const fb = await spawnWithFileCapture(
                        finalCommand,
                        finalArgs,
                        resolvedCwd,
                        finalEnv,
                        timeout,
                        maxOutputSize,
                        stdin,
                    );
                    const stderr = fb.timedOut
                        ? fb.stderr + "\n[Background process timed out]"
                        : fb.stderr;
                    const logId = saveTerminalLog(fb.stdout, stderr);
                    settleBackgroundProcess({
                        exitCode: fb.exitCode,
                        signal: fb.signal,
                        stdout: fb.stdout,
                        stderr,
                        logId,
                    });
                    commandLogger.logExecutionComplete(
                        command, fb.exitCode, Date.now() - info.startedAt,
                        { stdout: info.stdout.length, stderr: info.stderr.length },
                        { characterId },
                    );
                } catch (fbErr) {
                    info.stderr += `\n[EBADF file-capture fallback failed] ${fbErr instanceof Error ? fbErr.message : fbErr}`;
                    const logId = saveBackgroundLogSnapshot(info, true);
                    settleBackgroundProcess({ stderr: info.stderr, logId });
                    commandLogger.logExecutionError(command, info.stderr, { characterId });
                }
                return;
            }

            if (shouldRetryThroughShellOnMessage(error.message) && isShellRetryEligibleCommand(command)) {
                const retryResult = await retryThroughShell();
                settleBackgroundProcess();
                if (retryResult.processId) {
                    const retriedInfo = backgroundProcesses.get(retryResult.processId);
                    if (retriedInfo) {
                        retriedInfo.id = id;
                        backgroundProcesses.set(id, retriedInfo);
                        backgroundProcesses.delete(retryResult.processId);
                    }
                } else {
                    info.stderr += "\n[Shell retry failed to start]";
                }
                return;
            }

            info.stderr += `\n[Spawn error] ${error.message}`;
            const logId = saveBackgroundLogSnapshot(info, true);
            settleBackgroundProcess({ stderr: info.stderr, logId });
            commandLogger.logExecutionError(command, error.message, { characterId });
        });

        // Background timeout
        info.timeoutId = setTimeout(() => {
            if (info.running) {
                info.stderr += "\n[Background process timed out]";
                const logId = saveBackgroundLogSnapshot(info, true);
                settleBackgroundProcess({ stderr: info.stderr, logId });
                try { child.kill("SIGTERM"); } catch { /* already dead */ }
                setTimeout(() => {
                    try { child.kill("SIGKILL"); } catch { /* already dead */ }
                }, 5000);
            }
        }, timeout);

        backgroundProcesses.set(id, info);
        commandLogger.logExecutionStart(command, args, cwd, { characterId });

        return { processId: id };
    } catch (error) {
        // macOS Electron utilityProcess: spawn() itself can throw EBADF
        // synchronously when pipe creation fails.  Retry via file-capture.
        if (isEBADFError(error) && process.platform === "darwin") {
            console.warn("[Command Executor] spawn() threw EBADF on background process – retrying with file-capture fallback");
            const info: BackgroundProcessInfo = {
                id,
                command,
                args,
                cwd,
                startedAt: Date.now(),
                settledAt: null,
                running: true,
                stdout: "",
                stderr: "",
                exitCode: null,
                signal: null,
                process: null as unknown as ChildProcess,
                timeoutId: null,
            };
            backgroundProcesses.set(id, info);
            commandLogger.logExecutionStart(command, args, cwd, { characterId });

            let fallbackProcessSettledNotified = false;
            const settleFallbackProcess = (updates: Partial<Pick<BackgroundProcessInfo, "exitCode" | "signal" | "stdout" | "stderr" | "logId">> = {}) => {
                if (!info.settledAt) info.settledAt = Date.now();
                info.running = false;
                Object.assign(info, updates);
                if (!fallbackProcessSettledNotified) {
                    fallbackProcessSettledNotified = true;
                    onBackgroundProcessSettled?.(info);
                }
            };

            // Run asynchronously; the caller gets the processId immediately.
            spawnWithFileCapture(
                finalCommand,
                finalArgs,
                resolvedCwd,
                finalEnv,
                timeout,
                maxOutputSize,
                stdin,
            ).then((fb) => {
                const stderr = fb.timedOut
                    ? fb.stderr + "\n[Background process timed out]"
                    : fb.stderr;
                const logId = saveTerminalLog(fb.stdout, stderr);
                settleFallbackProcess({
                    exitCode: fb.exitCode,
                    signal: fb.signal,
                    stdout: fb.stdout,
                    stderr,
                    logId,
                });
                commandLogger.logExecutionComplete(
                    command, fb.exitCode, Date.now() - info.startedAt,
                    { stdout: info.stdout.length, stderr: info.stderr.length },
                    { characterId },
                );
            }).catch((fbErr) => {
                info.stderr += `\n[EBADF file-capture fallback failed] ${fbErr instanceof Error ? fbErr.message : fbErr}`;
                const logId = saveBackgroundLogSnapshot(info, true);
                settleFallbackProcess({ stderr: info.stderr, logId });
                commandLogger.logExecutionError(command, info.stderr, { characterId });
            });

            return { processId: id };
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        const logId = errorMessage ? saveTerminalLog("", errorMessage) : undefined;
        return {
            processId: "",
            error: errorMessage,
            logId,
        };
    }
}

/**
 * Get background process status and output.
 */
export function getBackgroundProcess(processId: string): BackgroundProcessInfo | null {
    const info = backgroundProcesses.get(processId) ?? null;
    if (info?.running) {
        saveBackgroundLogSnapshot(info);
    }
    return info;
}

/**
 * Record that a background process has been observed by a tool call.
 */
export function markBackgroundProcessObserved(processId: string): BackgroundProcessInfo | null {
    const info = backgroundProcesses.get(processId) ?? null;
    if (!info) return null;

    info.lastObservedAt = Date.now();
    if (info.running) {
        info.observedWhileRunning = true;
    }
    return info;
}

/**
 * Kill a background process.
 */
export function killBackgroundProcess(processId: string): boolean {
    const info = backgroundProcesses.get(processId);
    if (!info) return false;
    if (!info.running) return true; // already done

    saveBackgroundLogSnapshot(info, true);
    info.running = false;
    info.settledAt = Date.now();
    if (info.timeoutId) clearTimeout(info.timeoutId);
    try {
        info.process.kill("SIGTERM");
        setTimeout(() => {
            try { info.process.kill("SIGKILL"); } catch { /* already dead */ }
        }, 3000);
    } catch { /* already dead */ }
    return true;
}

/**
 * List all background processes (for diagnostics).
 */
export function listBackgroundProcesses(): Array<{
    id: string;
    command: string;
    running: boolean;
    elapsed: number;
    logId?: string;
    exitCode?: number | null;
    startedAt?: string;
    settledAt?: string;
    cwd?: string;
}> {
    const now = Date.now();
    return Array.from(backgroundProcesses.values()).map((p) => {
        if (p.running) {
            saveBackgroundLogSnapshot(p);
        }
        return {
            id: p.id,
            command: `${p.command} ${p.args.join(" ")}`,
            running: p.running,
            elapsed: now - p.startedAt,
            logId: p.logId,
            exitCode: p.exitCode,
            startedAt: new Date(p.startedAt).toISOString(),
            settledAt: p.settledAt ? new Date(p.settledAt).toISOString() : undefined,
            cwd: p.cwd,
        };
    });
}

/**
 * Clean up finished background processes older than the given age (ms).
 */
export function cleanupBackgroundProcesses(maxAge = 600_000): void {
    const now = Date.now();
    for (const [id, info] of Array.from(backgroundProcesses.entries())) {
        const ageFrom = info.settledAt ?? info.startedAt;
        if (!info.running && now - ageFrom > maxAge) {
            backgroundProcesses.delete(id);
        }
    }
}

/**
 * Execute a command safely with validation and sandboxing
 */
export async function executeCommand(options: ExecuteOptions): Promise<ExecuteResult> {
    const {
        command,
        args,
        stdin,
        cwd,
        characterId,
        confirmRemoval,
        maxOutputSize = DEFAULT_MAX_OUTPUT_SIZE,
        forceDirectExecution = false,
        forceShellExecution = false,
        shellFallbackAttempted = false,
        rawCommandLine,
        fallbackReasonForDirectExecution,
        toolCallId,
        onProgress,
        windowsVerbatimArguments,
        abortSignal,
    } = options;

    const timeout = resolveTimeout(command, options.timeout);
    const effectiveRawCommandLine = rawCommandLine || buildShellCommandLine(command, args);
    const shouldWriteToStdin = typeof stdin === "string" && stdin.length > 0;
    const canRetryThroughShell = isUnixLikePlatform() && !shellFallbackAttempted && !forceShellExecution;
    const shouldRetryThroughShellOnMessage = (message: string): boolean => {
        if (!canRetryThroughShell) return false;
        if (!isShellRetryEligibleCommand(command)) return false;
        if (shouldWriteToStdin) return true;
        return message.includes("ENOENT") && !path.isAbsolute(command) && !shouldUseRTK(command);
    };
    const buildShellRetryOptionsFromCurrentState = (): ExecuteOptions => ({
        ...options,
        command: getUserShellPath() || "/bin/sh",
        args: ["-ilc", effectiveRawCommandLine],
        stdin: undefined,
        rawCommandLine: effectiveRawCommandLine,
        forceShellExecution: true,
        shellFallbackAttempted: true,
    });

    const context = { characterId };
    const startTime = Date.now();
    const startedAt = nowISO();
    const fullCommand = [command, ...args].join(" ").trim();
    const runningMessage = fullCommand ? `Running ${fullCommand}...` : "Running command...";
    const completedMessage = fullCommand ? `Completed ${fullCommand}` : "Command completed";
    const failedMessage = fullCommand ? `Failed ${fullCommand}` : "Command failed";

    commandLogger.logExecutionStart(command, args, cwd, context);

    const cmdValidation = validateCommand(command, args, { confirmRemoval });
    commandLogger.logValidation(cmdValidation.valid, command, cmdValidation.error, { characterId, cwd });

    if (!cmdValidation.valid) {
        commandLogger.logSecurityEvent("command_blocked", {
            command,
            args,
            reason: cmdValidation.error,
        }, context);

        const logId = cmdValidation.error ? saveTerminalLog("", cmdValidation.error) : undefined;
        return {
            success: false,
            stdout: "",
            stderr: "",
            exitCode: null,
            signal: null,
            error: cmdValidation.error,
            executionTime: Date.now() - startTime,
            logId,
        };
    }

    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let outputSize = 0;
        let killed = false;
        let terminationReason: TerminationReason | null = null;
        let timeoutId: NodeJS.Timeout | null = null;
        let child: ChildProcess | undefined;

        const terminate = (reason: TerminationReason): void => {
            if (terminationReason) return;
            killed = true;
            terminationReason = reason;
            terminateChildProcess(child, reason);
        };

        const onAbort = () => terminate("abort");
        const cleanupAbortListener = () => {
            abortSignal?.removeEventListener("abort", onAbort);
        };

        if (abortSignal?.aborted) {
            onAbort();
        } else {
            abortSignal?.addEventListener("abort", onAbort, { once: true });
        }

        const retryThroughShell = (): void => {
            cleanupAbortListener();
            void executeCommand(buildShellRetryOptionsFromCurrentState()).then(resolve);
        };

        /**
         * Check whether this RTK-wrapped command should fall back to direct execution
         * based on the RTK error output. If so, kick off the retry and return true
         * (caller should return immediately). Otherwise return false.
         *
         * Also computes and returns the fallbackReason so the caller can attach it
         * to search metadata without recomputing.
         */
        const checkRtkRetry = (params: {
            stderr?: string;
            error?: string;
            wrappedByRTK: boolean;
        }): { fallbackReason: ReturnType<typeof getRtkFallbackReason>; retried: boolean } => {
            const fallbackReason = getRtkFallbackReason({
                command,
                wrappedByRTK: params.wrappedByRTK,
                stderr: params.stderr,
                error: params.error,
            });
            const shouldRetryDirect =
                params.wrappedByRTK
                && !forceDirectExecution
                && (fallbackReason === "rtk_unrecognized_subcommand" || fallbackReason === "rtk_unknown_command");

            if (shouldRetryDirect) {
                cleanupAbortListener();
                void executeCommand({
                    ...options,
                    forceDirectExecution: true,
                    fallbackReasonForDirectExecution: fallbackReason,
                }).then(resolve);
                return { fallbackReason, retried: true };
            }
            return { fallbackReason, retried: false };
        };

        const emitProgress = (overrides: Partial<ExecuteCommandProgressUpdate> = {}) => {
            onProgress?.({
                toolCallId,
                command,
                args,
                cwd,
                stdout,
                stderr,
                status: "running",
                startedAt,
                message: runningMessage,
                ...overrides,
            });
        };

        initializeCommandExecutionProcessEnv();
        const baseEnv = buildSafeEnvironment(getBundledRuntimeInfo()) as NodeJS.ProcessEnv;
        const { finalCommand, finalArgs, finalEnv, wrapped, resolution, runtime } = resolveCommandRuntime(
            command, args, baseEnv, { forceDirect: forceDirectExecution }
        );
        const searchMetadata = buildExecuteSearchMetadata({
            originalCommand: command,
            finalCommand,
            wrappedByRTK: wrapped.usingRTK,
            fallbackTriggered: forceDirectExecution,
            fallbackReason: forceDirectExecution ? fallbackReasonForDirectExecution : undefined,
        });

        try {
            child = spawn(finalCommand, finalArgs, {
                cwd,
                timeout,
                shell: needsWindowsShell(finalCommand),
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
                windowsVerbatimArguments: windowsVerbatimArguments ?? false,
                env: finalEnv,
            });
            if (shouldWriteToStdin) {
                child.stdin?.end(stdin);
            } else {
                child.stdin?.end();
            }

            if (abortSignal?.aborted) {
                onAbort();
            }

            timeoutId = setTimeout(() => {
                terminate("timeout");
            }, timeout);

            emitProgress({ message: runningMessage });

            function handleStreamData(stream: "stdout" | "stderr", chunk: Buffer): void {
                const data = chunk.toString();
                outputSize += data.length;

                if (outputSize > maxOutputSize) {
                    if (!killed) {
                        terminate("output_limit");
                        stderr += "\n[Output size limit exceeded]";
                        emitProgress({
                            stderr,
                            status: "error",
                            message: failedMessage,
                            error: terminationMessage("output_limit"),
                        });
                    }
                } else {
                    if (stream === "stdout") {
                        stdout += data;
                    } else {
                        stderr += data;
                    }
                    // stdout/stderr are captured from the outer closure by emitProgress
                    emitProgress({ chunkStream: stream, chunkText: data, message: runningMessage });
                }
            }

            child.stdout?.on("data", (chunk: Buffer) => handleStreamData("stdout", chunk));

            child.stderr?.on("data", (chunk: Buffer) => handleStreamData("stderr", chunk));

            child.on("close", (code, signal) => {
                if (timeoutId) clearTimeout(timeoutId);
                cleanupAbortListener();

                const executionTime = Date.now() - startTime;

                commandLogger.logExecutionComplete(
                    command,
                    code,
                    executionTime,
                    {
                        stdout: stdout.length,
                        stderr: stderr.length,
                    },
                    context
                );

                const logId = saveTerminalLog(stdout, stderr);

                const { fallbackReason, retried } = terminationReason
                    ? { fallbackReason: undefined, retried: false }
                    : checkRtkRetry({ stderr, wrappedByRTK: wrapped.usingRTK });
                if (retried) return;

                const finalResult: ExecuteResult = {
                    success: !killed && code === 0,
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                    exitCode: code,
                    signal,
                    error: terminationReason ? terminationMessage(terminationReason) : undefined,
                    executionTime,
                    startedAt,
                    logId,
                    // Reflect the actual outcome: `killed` is set when the child was
                    // terminated via SIGTERM because it either timed out or exceeded
                    // `maxOutputSize` (see lines 618 and 638). Both cases are forms of
                    // truncation that downstream consumers (tool-result-stream-guard,
                    // tool-result-utils, UI truncation indicators) must learn about.
                    isTruncated: killed,
                    aborted: terminationReason === "abort",
                    searchMetadata: fallbackReason
                        ? buildExecuteSearchMetadata({
                            originalCommand: command,
                            finalCommand,
                            wrappedByRTK: wrapped.usingRTK,
                            fallbackTriggered: true,
                            fallbackReason,
                        })
                        : searchMetadata,
                };

                emitProgress({
                    stdout: finalResult.stdout,
                    stderr: finalResult.stderr,
                    status: finalResult.success ? "success" : "error",
                    executionTime,
                    exitCode: code,
                    error: finalResult.error,
                    logId,
                    isTruncated: killed,
                    aborted: terminationReason === "abort",
                    message: finalResult.success ? completedMessage : failedMessage,
                });

                resolve(finalResult);
            });

            child.on("error", async (error) => {
                if (timeoutId) clearTimeout(timeoutId);
                cleanupAbortListener();

                if (isEBADFError(error) && process.platform === "darwin") {
                    console.warn("[Command Executor] spawn EBADF – retrying with file-capture fallback");
                    resolve(await runEBADFFallback({
                        command,
                        finalCommand,
                        finalArgs,
                        cwd,
                        finalEnv,
                        timeout,
                        maxOutputSize,
                        stdinData: stdin,
                        startTime,
                        wrappedByRTK: wrapped.usingRTK,
                        characterId,
                        baseSearchMetadata: searchMetadata,
                    }));
                    return;
                }

                const executionTime = Date.now() - startTime;
                let errorMessage = error.message;

                if (shouldRetryThroughShellOnMessage(errorMessage)) {
                    cleanupAbortListener();
                    retryThroughShell();
                    return;
                }

                if (error.message.includes("ENOENT") || error.message.includes("spawn") && error.message.includes("not found")) {
                    const diagnostic = buildNotFoundDiagnostic(command, runtime, finalEnv, resolution);
                    const attemptedCommand = wrapped.usingRTK
                        ? `${finalCommand} (RTK wrapper for ${command})`
                        : finalCommand;
                    const commandHint = resolution
                        ? "Tip: bundled Node tools keep priority, but other commands still rely on your system PATH."
                        : "Tip: verify the executable is installed and available in the PATH Selene inherited from your OS.";
                    errorMessage = `Command execution failed: requested='${command}', attempted='${attemptedCommand}'. ${error.message}

${diagnostic}

${commandHint}`;
                }

                commandLogger.logExecutionError(command, errorMessage, context);

                const { fallbackReason, retried } = checkRtkRetry({ stderr, error: errorMessage, wrappedByRTK: wrapped.usingRTK });
                if (retried) return;

                const logId = errorMessage || stderr ? saveTerminalLog(stdout, stderr || errorMessage) : undefined;

                const failedResult: ExecuteResult = {
                    success: false,
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                    exitCode: null,
                    signal: null,
                    error: errorMessage,
                    executionTime,
                    startedAt,
                    logId,
                    searchMetadata: fallbackReason
                        ? buildExecuteSearchMetadata({
                            originalCommand: command,
                            finalCommand,
                            wrappedByRTK: wrapped.usingRTK,
                            fallbackTriggered: true,
                            fallbackReason,
                        })
                        : searchMetadata,
                };

                emitProgress({
                    stdout: failedResult.stdout,
                    stderr: failedResult.stderr,
                    status: "error",
                    executionTime,
                    error: errorMessage,
                    logId,
                    message: failedMessage,
                });

                resolve(failedResult);
            });
        } catch (error) {
            if (timeoutId) clearTimeout(timeoutId);
            cleanupAbortListener();

            if (isEBADFError(error) && process.platform === "darwin") {
                console.warn("[Command Executor] spawn() threw EBADF synchronously – retrying with file-capture fallback");
                runEBADFFallback({
                    command,
                    finalCommand,
                    finalArgs,
                    cwd,
                    finalEnv,
                    timeout,
                    maxOutputSize,
                    stdinData: stdin,
                    startTime,
                    wrappedByRTK: wrapped.usingRTK,
                    characterId,
                    baseSearchMetadata: searchMetadata,
                }).then(resolve);
                return;
            }

            const executionTime = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : "Unknown error";

            if (shouldRetryThroughShellOnMessage(errorMessage)) {
                cleanupAbortListener();
                retryThroughShell();
                return;
            }

            commandLogger.logExecutionError(command, errorMessage, context);
            const { fallbackReason, retried } = checkRtkRetry({ error: errorMessage, wrappedByRTK: wrapped.usingRTK });
            if (retried) return;

            const logId = errorMessage ? saveTerminalLog("", errorMessage) : undefined;

            const failedResult: ExecuteResult = {
                success: false,
                stdout: "",
                stderr: "",
                exitCode: null,
                signal: null,
                error: errorMessage,
                executionTime,
                startedAt,
                logId,
                searchMetadata: fallbackReason
                    ? buildExecuteSearchMetadata({
                        originalCommand: command,
                        finalCommand,
                        wrappedByRTK: wrapped.usingRTK,
                        fallbackTriggered: true,
                        fallbackReason,
                    })
                    : searchMetadata,
            };

            emitProgress({
                status: "error",
                executionTime,
                error: errorMessage,
                logId,
                message: failedMessage,
            });

            cleanupAbortListener();
            resolve(failedResult);
        }
    });
}

/**
 * Execute a command with path validation
 * This is the main entry point that validates the cwd against allowed paths
 */
export async function executeCommandWithValidation(
    options: ExecuteOptions,
    allowedPaths: string[]
): Promise<ExecuteResult> {
    const startTime = Date.now();

    // Validate execution directory
    const cwdValidation = await validateExecutionDirectory(options.cwd, allowedPaths);

    if (!cwdValidation.valid) {
        commandLogger.logSecurityEvent("path_validation_failed", {
            cwd: options.cwd,
            reason: cwdValidation.error,
        }, { characterId: options.characterId });

        const logId = cwdValidation.error ? saveTerminalLog("", cwdValidation.error) : undefined;

        return {
            success: false,
            stdout: "",
            stderr: "",
            exitCode: null,
            signal: null,
            error: cwdValidation.error,
            executionTime: Date.now() - startTime,
            logId,
            searchMetadata: buildExecuteSearchMetadata({
                originalCommand: options.command,
                finalCommand: options.command,
                wrappedByRTK: false,
            }),
        };
    }

    // Execute with validated path
    return executeCommand({
        ...options,
        cwd: cwdValidation.resolvedPath ?? options.cwd,
    });
}

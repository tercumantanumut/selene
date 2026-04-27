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
import { saveTerminalLog } from "./log-manager";
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
let bgIdCounter = 0;

function nextBgId(): string {
    return `bg-${Date.now()}-${++bgIdCounter}`;
}

function isUnixLikePlatform(): boolean {
    return process.platform === "darwin" || process.platform === "linux";
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
}> {
    const { command, args, stdin, cwd, characterId, confirmRemoval, windowsVerbatimArguments } = options;
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

        // Handle completion
        child.on("close", (code, signal) => {
            if (info.timeoutId) clearTimeout(info.timeoutId);
            info.running = false;
            info.exitCode = code;
            info.signal = signal;

            // Save full log for background process too
            info.logId = saveTerminalLog(info.stdout, info.stderr);

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
                    info.running = false;
                    info.exitCode = fb.exitCode;
                    info.signal = fb.signal;
                    info.stdout = fb.stdout;
                    info.stderr = fb.timedOut
                        ? fb.stderr + "\n[Background process timed out]"
                        : fb.stderr;
                    info.logId = saveTerminalLog(info.stdout, info.stderr);
                    commandLogger.logExecutionComplete(
                        command, fb.exitCode, Date.now() - info.startedAt,
                        { stdout: info.stdout.length, stderr: info.stderr.length },
                        { characterId },
                    );
                } catch (fbErr) {
                    info.running = false;
                    info.stderr += `\n[EBADF file-capture fallback failed] ${fbErr instanceof Error ? fbErr.message : fbErr}`;
                    commandLogger.logExecutionError(command, info.stderr, { characterId });
                }
                return;
            }

            if (shouldRetryThroughShellOnMessage(error.message) && isShellRetryEligibleCommand(command)) {
                const retryResult = await retryThroughShell();
                info.running = false;
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

            if (info.timeoutId) clearTimeout(info.timeoutId);
            info.running = false;
            info.stderr += `\n[Spawn error] ${error.message}`;
            commandLogger.logExecutionError(command, error.message, { characterId });
        });

        // Background timeout
        info.timeoutId = setTimeout(() => {
            if (info.running) {
                info.running = false;
                info.stderr += "\n[Background process timed out]";
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
                info.running = false;
                info.exitCode = fb.exitCode;
                info.signal = fb.signal;
                info.stdout = fb.stdout;
                info.stderr = fb.timedOut
                    ? fb.stderr + "\n[Background process timed out]"
                    : fb.stderr;
                info.logId = saveTerminalLog(info.stdout, info.stderr);
                commandLogger.logExecutionComplete(
                    command, fb.exitCode, Date.now() - info.startedAt,
                    { stdout: info.stdout.length, stderr: info.stderr.length },
                    { characterId },
                );
            }).catch((fbErr) => {
                info.running = false;
                info.stderr += `\n[EBADF file-capture fallback failed] ${fbErr instanceof Error ? fbErr.message : fbErr}`;
                commandLogger.logExecutionError(command, info.stderr, { characterId });
            });

            return { processId: id };
        }

        return {
            processId: "",
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Get background process status and output.
 */
export function getBackgroundProcess(processId: string): BackgroundProcessInfo | null {
    return backgroundProcesses.get(processId) ?? null;
}

/**
 * Kill a background process.
 */
export function killBackgroundProcess(processId: string): boolean {
    const info = backgroundProcesses.get(processId);
    if (!info) return false;
    if (!info.running) return true; // already done

    info.running = false;
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
}> {
    const now = Date.now();
    return Array.from(backgroundProcesses.values()).map((p) => ({
        id: p.id,
        command: `${p.command} ${p.args.join(" ")}`,
        running: p.running,
        elapsed: now - p.startedAt,
    }));
}

/**
 * Clean up finished background processes older than the given age (ms).
 */
export function cleanupBackgroundProcesses(maxAge = 600_000): void {
    const now = Date.now();
    for (const [id, info] of Array.from(backgroundProcesses.entries())) {
        if (!info.running && now - info.startedAt > maxAge) {
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

        return {
            success: false,
            stdout: "",
            stderr: "",
            exitCode: null,
            signal: null,
            error: cmdValidation.error,
            executionTime: Date.now() - startTime,
        };
    }

    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let outputSize = 0;
        let killed = false;
        let timeoutId: NodeJS.Timeout | null = null;
        let child: ChildProcess;

        const retryThroughShell = (): void => {
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

            timeoutId = setTimeout(() => {
                if (!killed) {
                    killed = true;
                    child.kill("SIGTERM");
                    setTimeout(() => {
                        try {
                            child.kill("SIGKILL");
                        } catch {
                            // Process already dead
                        }
                    }, 5000);
                }
            }, timeout);

            emitProgress({ message: runningMessage });

            function handleStreamData(stream: "stdout" | "stderr", chunk: Buffer): void {
                const data = chunk.toString();
                outputSize += data.length;

                if (outputSize > maxOutputSize) {
                    if (!killed) {
                        killed = true;
                        child.kill("SIGTERM");
                        stderr += "\n[Output size limit exceeded]";
                        emitProgress({
                            stderr,
                            status: "error",
                            message: failedMessage,
                            error: "Process terminated due to timeout or output limit",
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

                const { fallbackReason, retried } = checkRtkRetry({ stderr, wrappedByRTK: wrapped.usingRTK });
                if (retried) return;

                const finalResult: ExecuteResult = {
                    success: !killed && code === 0,
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                    exitCode: code,
                    signal,
                    error: killed ? "Process terminated due to timeout or output limit" : undefined,
                    executionTime,
                    startedAt,
                    logId,
                    // Reflect the actual outcome: `killed` is set when the child was
                    // terminated via SIGTERM because it either timed out or exceeded
                    // `maxOutputSize` (see lines 618 and 638). Both cases are forms of
                    // truncation that downstream consumers (tool-result-stream-guard,
                    // tool-result-utils, UI truncation indicators) must learn about.
                    isTruncated: killed,
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
                    message: finalResult.success ? completedMessage : failedMessage,
                });

                resolve(finalResult);
            });

            child.on("error", async (error) => {
                if (timeoutId) clearTimeout(timeoutId);

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

                const failedResult: ExecuteResult = {
                    success: false,
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                    exitCode: null,
                    signal: null,
                    error: errorMessage,
                    executionTime,
                    startedAt,
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
                    message: failedMessage,
                });

                resolve(failedResult);
            });
        } catch (error) {
            if (timeoutId) clearTimeout(timeoutId);

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
                retryThroughShell();
                return;
            }

            commandLogger.logExecutionError(command, errorMessage, context);
            const { fallbackReason, retried } = checkRtkRetry({ error: errorMessage, wrappedByRTK: wrapped.usingRTK });
            if (retried) return;

            const failedResult: ExecuteResult = {
                success: false,
                stdout: "",
                stderr: "",
                exitCode: null,
                signal: null,
                error: errorMessage,
                executionTime,
                startedAt,
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
                message: failedMessage,
            });

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

        return {
            success: false,
            stdout: "",
            stderr: "",
            exitCode: null,
            signal: null,
            error: cwdValidation.error,
            executionTime: Date.now() - startTime,
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

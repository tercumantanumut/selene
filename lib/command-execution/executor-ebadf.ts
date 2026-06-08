/**
 * EBADF file-capture fallback helpers for executeCommand.
 *
 * On macOS inside Electron's utilityProcess, creating stdio pipes can fail with
 * EBADF (bad file descriptor).  When that happens we retry the command via
 * spawnWithFileCapture(), which writes output to private temp files instead of pipes.
 *
 * Extracted from executor.ts to reduce repetition of the three EBADF retry paths.
 */

import { spawnWithFileCapture } from "@/lib/spawn-utils";
import { commandLogger } from "./logger";
import { saveTerminalLog } from "./log-manager";
import {
    getRtkFallbackReason,
    buildExecuteSearchMetadata,
} from "./executor-rtk";
import type { ExecuteResult, ExecuteSearchMetadata } from "./types";

interface EBADFFallbackContext {
    command: string;
    finalCommand: string;
    finalArgs: string[];
    cwd: string;
    finalEnv: NodeJS.ProcessEnv;
    timeout: number;
    maxOutputSize: number;
    stdinData?: string;
    startTime: number;
    wrappedByRTK: boolean;
    characterId: string | undefined;
    baseSearchMetadata: ExecuteSearchMetadata | undefined;
}

/**
 * Run the file-capture fallback and resolve to an ExecuteResult.
 * Returns null on error (caller should reject/resolve with own error result).
 */
export async function runEBADFFallback(
    ctx: EBADFFallbackContext
): Promise<ExecuteResult> {
    const {
        command, finalCommand, finalArgs, cwd, finalEnv,
        timeout, maxOutputSize, stdinData, startTime,
        wrappedByRTK, characterId, baseSearchMetadata,
    } = ctx;
    const context = { characterId };

    try {
        const fb = await spawnWithFileCapture(
            finalCommand,
            finalArgs,
            cwd,
            finalEnv,
            timeout,
            maxOutputSize,
            stdinData,
        );
        const executionTime = Date.now() - startTime;
        commandLogger.logExecutionComplete(
            command, fb.exitCode, executionTime,
            { stdout: fb.stdout.length, stderr: fb.stderr.length },
            context,
        );
        const logId = saveTerminalLog(fb.stdout, fb.stderr);
        const fallbackReason = getRtkFallbackReason({
            command,
            wrappedByRTK,
            stderr: fb.stderr,
        });

        return {
            success: fb.exitCode === 0 && !fb.timedOut,
            stdout: fb.stdout.trim(),
            stderr: fb.stderr.trim(),
            exitCode: fb.exitCode,
            signal: fb.signal,
            error: fb.timedOut ? "Process terminated due to timeout" : undefined,
            executionTime,
            logId,
            // `fb.truncated` is true when the child was killed by timeout OR
            // its raw output exceeded maxOutputSize and got clamped during
            // read-back (see lib/spawn-utils.ts). Both cases must be surfaced
            // so stream-guard / UI truncation indicators can react honestly.
            isTruncated: fb.truncated,
            searchMetadata: fallbackReason
                ? buildExecuteSearchMetadata({
                    originalCommand: command,
                    finalCommand,
                    wrappedByRTK,
                    fallbackTriggered: true,
                    fallbackReason,
                })
                : baseSearchMetadata,
        };
    } catch (fbErr) {
        const executionTime = Date.now() - startTime;
        const msg = fbErr instanceof Error ? fbErr.message : "File-capture fallback failed";
        commandLogger.logExecutionError(command, msg, context);
        const fallbackReason = getRtkFallbackReason({ command, wrappedByRTK, error: msg });

        return {
            success: false,
            stdout: "",
            stderr: "",
            exitCode: null,
            signal: null,
            error: msg,
            executionTime,
            searchMetadata: fallbackReason
                ? buildExecuteSearchMetadata({
                    originalCommand: command,
                    finalCommand,
                    wrappedByRTK,
                    fallbackTriggered: true,
                    fallbackReason,
                })
                : baseSearchMetadata,
        };
    }
}

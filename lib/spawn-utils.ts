/**
 * Shared EBADF spawn fallback utilities
 *
 * On macOS inside Electron's utilityProcess, creating stdio pipes for child
 * processes can fail with EBADF (bad file descriptor).  These helpers detect
 * the error and provide a file-capture fallback that avoids pipes entirely by
 * redirecting output to temp files on disk.
 */

import { spawn } from "child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Returns true when the error is an EBADF (bad file descriptor) failure.
 * On macOS in Electron's utilityProcess, creating stdio pipes triggers EBADF.
 */
export function isEBADFError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return (error as NodeJS.ErrnoException).code === "EBADF"
        || error.message.includes("EBADF");
}


/**
 * Spawn a command with stdout/stderr captured to temp files instead of pipes.
 *
 * On macOS in Electron's utilityProcess, creating stdio pipes fails with EBADF.
 * This fallback avoids all stdio pipes by binding child stdio to file descriptors.
 * and writing command output directly to temp files, then reading those files
 * once the process exits.
 *
 * @param stdinData - Optional data to write to a temp file and pipe via `< file`
 */
export async function spawnWithFileCapture(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeout: number,
    maxOutputSize: number,
    stdinData?: string,
): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    /**
     * True when the raw child output exceeded `maxOutputSize` and was clamped
     * during the read-back step, OR when the child was killed by the timeout.
     * Callers must treat this as the authoritative truncation signal so
     * downstream consumers can surface it. `timedOut` is retained for
     * backwards compatibility with callers that distinguish the two causes.
     */
    truncated: boolean;
}> {
    const tmpDir = await mkdtemp(join(tmpdir(), "selene-exec-"));
    const outFile = join(tmpDir, "out");
    const errFile = join(tmpDir, "err");
    const inFile = join(tmpDir, "in");

    try {
        // If stdin data is provided, write it to a temp file for redirection
        if (stdinData != null) {
            await writeFile(inFile, stdinData, "utf-8");
        }

        const outHandle = await open(outFile, "w");
        const errHandle = await open(errFile, "w");
        const inHandle = stdinData != null ? await open(inFile, "r") : null;

        let timedOut = false;

        try {
            const { exitCode, signal } = await new Promise<{
                exitCode: number | null;
                signal: NodeJS.Signals | null;
            }>((resolve, reject) => {
                const child = spawn(command, args, {
                    cwd,
                    env,
                    // Avoid stdio pipes entirely; child writes directly to temp files.
                    stdio: [inHandle ? inHandle.fd : "ignore", outHandle.fd, errHandle.fd],
                    windowsHide: true,
                });

                let settled = false;
                const settle = (v: { exitCode: number | null; signal: NodeJS.Signals | null }) => {
                    if (!settled) { settled = true; resolve(v); }
                };

                const timer = setTimeout(() => {
                    timedOut = true;
                    try { child.kill("SIGTERM"); } catch { /* already dead */ }
                    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ok */ } }, 5000);
                }, timeout);

                child.on("error", (err) => {
                    clearTimeout(timer);
                    if (!settled) { settled = true; reject(err); }
                });

                child.on("close", (code, sig) => {
                    clearTimeout(timer);
                    settle({ exitCode: code, signal: sig as NodeJS.Signals | null });
                });
            });

            const [rawOut, rawErr] = await Promise.all([
                readFile(outFile, "utf-8").catch(() => ""),
                readFile(errFile, "utf-8").catch(() => ""),
            ]);

            // The child writes directly to temp files with no live cap, so
            // size-based truncation is detected at read-back time by comparing
            // raw lengths to `maxOutputSize`. `timedOut` captures SIGTERM-by-
            // deadline. Either condition counts as truncation.
            const sizeExceeded =
                rawOut.length > maxOutputSize || rawErr.length > maxOutputSize;

            return {
                stdout: rawOut.slice(0, maxOutputSize),
                stderr: rawErr.slice(0, maxOutputSize),
                exitCode,
                signal,
                timedOut,
                truncated: timedOut || sizeExceeded,
            };
        } finally {
            await Promise.all([
                outHandle.close().catch(() => { /* noop */ }),
                errHandle.close().catch(() => { /* noop */ }),
                inHandle?.close().catch(() => { /* noop */ }),
            ]);
        }
    } finally {
        // Non-blocking cleanup; errors are silently ignored.
        rm(tmpDir, { recursive: true, force: true }).catch(() => { /* noop */ });
    }
}

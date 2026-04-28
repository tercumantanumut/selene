/**
 * Execute Command Tool
 *
 * AI tool wrapper for safe command execution within synced directories.
 * Follows the same patterns as ripgrep/tool.ts - runs directly on the server.
 */

import { tool, jsonSchema, type ToolExecutionOptions } from "ai";
import { logToolEvent } from "@/lib/ai/tool-registry/logging";
import fs from "fs/promises";
import path from "path";
import { getAccessibleSyncFolders } from "@/lib/vectordb/accessible-sync-folders";
import { getActiveWorktreePath, isOtherWorktreePath } from "@/lib/ai/filesystem";
import {
    executeCommandWithValidation,
    startBackgroundProcess,
    getBackgroundProcess,
    killBackgroundProcess,
    listBackgroundProcesses,
    cleanupBackgroundProcesses,
} from "@/lib/command-execution";
import { readTerminalLog } from "@/lib/command-execution/log-manager";
import { sliceLogText } from "@/lib/ai/log-slice";
import { recordRetrieval } from "@/lib/ai/output-stub-telemetry";
import { registerBackgroundTask } from "@/app/api/chat/delegation-waiting";
import type {
    ExecuteCommandToolOptions,
    ExecuteCommandInput,
    ExecuteCommandToolResult,
    ExecuteCommandProgressUpdate,
    InlineDiffPayload,
    InlineDiffFile,
} from "@/lib/command-execution/types";
import { createTwoFilesPatch } from "diff";

function extractToolCallId(options?: ToolExecutionOptions): string {
    if (!options || typeof options !== "object") return "";
    return typeof options.toolCallId === "string" ? options.toolCallId : "";
}

function toIsoTimestamp(timestamp: number): string {
    return new Date(timestamp).toISOString();
}

function isPythonExecutable(command: string): boolean {
    const normalized = command.trim().replace(/^["']|["']$/g, "").toLowerCase();
    return (
        normalized === "python" ||
        normalized === "python3" ||
        normalized === "python.exe" ||
        normalized === "python3.exe" ||
        normalized === "py" ||
        normalized === "py.exe"
    );
}

function stripOuterQuotes(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 2) return trimmed;
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

function normalizeCommandName(command: string): string {
    return path.basename(command.trim()).toLowerCase().replace(/\.(?:cmd|bat|exe)$/i, "");
}

function prepareCommandInput(
    command: string,
    args: string[],
    stdin?: string,
): { args: string[]; stdin?: string } {
    if (typeof stdin === "string" && stdin.length > 0) {
        return { args, stdin };
    }

    if (normalizeCommandName(command) !== "apply_patch" || args.length === 0) {
        return { args, stdin };
    }

    const lineJoinedPatch = args.join("\n").trim();
    const flatJoinedPatch = args.join(" ").trim();
    const candidatePatch = lineJoinedPatch.startsWith("*** Begin Patch")
        ? lineJoinedPatch
        : flatJoinedPatch;

    if (!candidatePatch.startsWith("*** Begin Patch")) {
        return { args, stdin };
    }

    return {
        args: [],
        stdin: candidatePatch.endsWith("\n") ? candidatePatch : `${candidatePatch}\n`,
    };
}

export interface ParsedPatchFile {
    filePath: string;
    operation: "add" | "modify" | "delete";
}

/**
 * Parse apply_patch text to extract file paths and operations from headers like:
 * *** Add File: src/foo.ts
 * *** Modify File: src/bar.tsx  (or *** Update File: ...)
 * *** Delete File: src/baz.ts
 */
export function parsePatchFileHeaders(patchText: string): ParsedPatchFile[] {
    const files: ParsedPatchFile[] = [];
    const headerRegex = /^\*\*\*\s+(Add|Modify|Update|Delete)\s+File:\s+(.+)$/gm;
    let match;
    while ((match = headerRegex.exec(patchText)) !== null) {
        const rawOp = match[1].toLowerCase();
        const op = (rawOp === "update" ? "modify" : rawOp) as "add" | "modify" | "delete";
        files.push({ filePath: match[2].trim(), operation: op });
    }
    return files;
}

/**
 * After a successful apply_patch, read the patched files from disk and compute
 * unified diffs against the git-tracked version (before state).
 * Falls back to raw patch text if diff computation fails.
 */
export async function computeInlineDiffs(
    patchText: string,
    cwd: string,
): Promise<InlineDiffPayload> {
    const parsedFiles = parsePatchFileHeaders(patchText);
    if (parsedFiles.length === 0) {
        return { files: [], rawPatch: patchText };
    }

    const diffFiles: InlineDiffFile[] = [];

    for (const file of parsedFiles) {
        const absPath = path.resolve(cwd, file.filePath);
        try {
            if (file.operation === "delete") {
                // File was deleted — show the removal diff from git
                diffFiles.push({
                    path: file.filePath,
                    operation: "delete",
                    diff: `File deleted: ${file.filePath}`,
                });
                continue;
            }

            // Read the current (post-patch) file content
            const afterContent = await fs.readFile(absPath, "utf-8");

            if (file.operation === "add") {
                // New file — diff against empty
                const diff = createTwoFilesPatch(
                    file.filePath,
                    file.filePath,
                    "",
                    afterContent,
                    "before",
                    "after",
                );
                diffFiles.push({ path: file.filePath, operation: "add", diff });
            } else {
                // Modified file — try to get the git-tracked version as "before"
                let beforeContent = "";
                try {
                    const { execSync } = await import("child_process");
                    beforeContent = execSync(
                        `git show HEAD:${JSON.stringify(file.filePath)}`,
                        { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
                    );
                } catch {
                    // File might be new to git or git not available — diff against empty
                }
                const diff = createTwoFilesPatch(
                    file.filePath,
                    file.filePath,
                    beforeContent,
                    afterContent,
                    "before",
                    "after",
                );
                diffFiles.push({ path: file.filePath, operation: "modify", diff });
            }
        } catch {
            // If we can't read the file, skip it
            diffFiles.push({
                path: file.filePath,
                operation: file.operation,
                diff: `Could not compute diff for ${file.filePath}`,
            });
        }
    }

    return { files: diffFiles, rawPatch: patchText };
}

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function resolveClaudePluginRootPlaceholder(command: string): Promise<string> {
    const placeholder = "${CLAUDE_PLUGIN_ROOT}";
    if (!command.includes(placeholder)) {
        return command;
    }

    const suffix = command.split(placeholder).slice(1).join(placeholder);
    const normalizedSuffix = suffix.replace(/^[\\/]+/, "");
    const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (envRoot && await pathExists(path.join(envRoot, normalizedSuffix))) {
        return command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, envRoot);
    }

    const pluginBases = [
        path.join(process.cwd(), "test_plugins"),
        path.join(process.cwd(), ".local-data", "plugins"),
        process.env.LOCAL_DATA_PATH ? path.join(process.env.LOCAL_DATA_PATH, "plugins") : null,
    ].filter((value): value is string => Boolean(value));

    for (const base of pluginBases) {
        let entries;
        try {
            entries = await fs.readdir(base, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const candidateRoot = path.join(base, entry.name);
            if (await pathExists(path.join(candidateRoot, normalizedSuffix))) {
                return command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, candidateRoot);
            }
        }
    }

    return command;
}

/**
 * Narrow compatibility shim for common LLM mistakes around Python inline scripts.
 * Keeps behavior unchanged for all other command shapes.
 */
export function normalizeExecuteCommandInput(
    command: string,
    args: string[]
): { command: string; args: string[] } {
    const trimmedCommand = command.trim();
    const normalizedArgs = Array.isArray(args) ? [...args] : [];

    // Case 1: command is a single string like:
    // "python -c from PIL import Image; print('ok')"
    if (normalizedArgs.length === 0) {
        const firstSpace = trimmedCommand.indexOf(" ");
        if (firstSpace > 0) {
            const executable = trimmedCommand.slice(0, firstSpace).trim();
            const remainder = trimmedCommand.slice(firstSpace + 1).trim();
            if (isPythonExecutable(executable) && remainder.startsWith("-c ")) {
                const script = stripOuterQuotes(remainder.slice(3));
                if (script.length > 0) {
                    return {
                        command: executable,
                        args: ["-c", script],
                    };
                }
            }
        }
    }

    // Case 2: args are split incorrectly after -c, e.g.:
    // args: ["-c", "from", "PIL", "import", "Image;print('ok')"]
    if (isPythonExecutable(trimmedCommand)) {
        const scriptFlagIndex = normalizedArgs.indexOf("-c");
        if (scriptFlagIndex >= 0 && normalizedArgs.length > scriptFlagIndex + 2) {
            const before = normalizedArgs.slice(0, scriptFlagIndex + 1);
            const script = stripOuterQuotes(normalizedArgs.slice(scriptFlagIndex + 1).join(" "));
            return {
                command: trimmedCommand,
                args: [...before, script],
            };
        }
    }

    return {
        command: trimmedCommand,
        args: normalizedArgs,
    };
}

/**
 * JSON Schema definition for the executeCommand tool input
 */
const executeCommandSchema = jsonSchema<ExecuteCommandInput & { logId?: string }>({
    type: "object",
    title: "ExecuteCommandInput",
    description: "Input schema for safe command execution within synced directories",
    properties: {
        command: {
            type: "string",
            description:
                "Command to execute (e.g., 'npm', 'git', 'ls', 'dir'). Use 'readLog' to read a full truncated output.",
        },
        args: {
            type: "array",
            items: { type: "string" },
            description:
                "Command arguments as an array (e.g., ['run', 'build'] for 'npm run build')",
        },
        cwd: {
            type: "string",
            description:
                "Working directory for the command. Must be within synced folders. If omitted, uses the first synced folder.",
        },
        timeout: {
            type: "number",
            description:
                "Timeout in milliseconds. Defaults: 30s for most commands, 120s for package managers (npm, npx, yarn, etc.). Max: 600000 (10 min).",
        },
        stdin: {
            type: "string",
            description:
                "Optional raw stdin payload written to the command before stdin is closed. Useful for tools like apply_patch.",
        },
        background: {
            type: "boolean",
            description:
                "Run in background mode. Returns immediately with a processId. Use processId to check status later. Ideal for long-running commands like npm install, npx create-*, builds, etc.",
        },
        processId: {
            type: "string",
            description:
                'Check status of a background process. Pass the processId returned from a background execution. Use command="kill" with processId to terminate a background process, or command="list" to see all background processes.',
        },
        logId: {
            type: "string",
            description: "The log ID to read when command is 'readLog'.",
        },
        head: {
            type: "number",
            description: "readLog only: return the first N lines of the log.",
        },
        tail: {
            type: "number",
            description: "readLog only: return the last N lines of the log.",
        },
        range: {
            type: "array",
            items: { type: "number" },
            minItems: 2,
            maxItems: 2,
            description:
                "readLog only: 1-indexed inclusive [startLine, endLine] range. Example: [400, 500].",
        },
        grep: {
            type: "string",
            description:
                "readLog only: regex pattern to search within the log. Returns matching lines with 2 lines of context each. Capped at 200 matches.",
        },
        confirmRemoval: {
            type: "boolean",
            description:
                "Required for removal commands (rm/rmdir/del/erase/rd). Set true only when deletion is explicitly intended.",
        },
    },
    required: [],
    additionalProperties: false,
});


/**
 * Create the executeCommand AI tool
 */
export function createExecuteCommandTool(options: ExecuteCommandToolOptions) {
    const { characterId, sessionId, onProgress } = options;

    return tool({
        description: `Execute shell commands safely within synced directories. Supports foreground and background execution.

**Security:**
- Commands only run within indexed/synced folders
- Removal commands require explicit confirmation (\`confirmRemoval: true\`)
- Smart default timeouts (30s normal, 120s for package managers)
- Output size limits prevent memory issues

**Efficiency:**
- For potentially large output, self-limit in the command itself (e.g., \`head\`, \`tail\`, or PowerShell \`Select-Object -First\`)
- Prefer \`localGrep\` for codebase file discovery/search (primary path)
- If \`localGrep\` is unavailable/fails, using this tool with \`command: "rg"\` is a supported fallback

**Common Use Cases:**
- Run tests: executeCommand({ command: "npm", args: ["test"] })
- Check git status: executeCommand({ command: "git", args: ["status"] })
- Install deps: executeCommand({ command: "npm", args: ["install"] })
- Read a stored log (first 200 lines by default): executeCommand({ command: "readLog", logId: "..." })
- Read specific slices (preferred — keeps context small):
  · executeCommand({ command: "readLog", logId: "...", head: 100 })
  · executeCommand({ command: "readLog", logId: "...", tail: 100 })
  · executeCommand({ command: "readLog", logId: "...", range: [400, 500] })
  · executeCommand({ command: "readLog", logId: "...", grep: "error" })
- Check background process: executeCommand({ processId: "bg-123" })
- Kill background process: executeCommand({ command: "kill", processId: "bg-123" })
- List background processes: executeCommand({ command: "list" })

**readLog retrieval policy:**
- Oversized tool outputs are replaced with a stub that contains an outline and a logId. Call readLog ONLY when the preview/outline is insufficient.
- Prefer grep/range/head over fetching the whole log. Each readLog call is hard-capped to ~8K tokens — chunked reads are expected for large logs.

**Background Mode:**
Use background: true for commands that take a long time (npm install, npx create-*, builds).
The tool returns immediately with a processId. Poll with processId to check status and get output.

**Parameters:**
- command: The executable (e.g., "python"). Or "kill"/"list" for background process management. Or 'readLog' to retrieve full output.
- args: Array of arguments (optional). For Python inline scripts, pass script as ONE arg after "-c"
- cwd: Working directory (optional, defaults to first synced folder)
- timeout: Max execution time in ms (auto-detected based on command type)
- background: Run in background and return processId (default: false)
- processId: Check/manage a background process by its ID
- logId: The log ID to read when command is 'readLog'
- confirmRemoval: Must be true for removal commands (rm/rmdir/del/erase/rd)`,

        inputSchema: executeCommandSchema,

        execute: async (
            input: ExecuteCommandInput & { logId?: string },
            toolCallOptions?: ToolExecutionOptions,
        ): Promise<ExecuteCommandToolResult> => {
            const toolCallId = extractToolCallId(toolCallOptions);
            const abortSignal = toolCallOptions?.abortSignal;
            const forwardProgress = (update: ExecuteCommandProgressUpdate) => {
                onProgress?.({
                    ...update,
                    toolCallId: update.toolCallId ?? toolCallId,
                    toolName: update.toolName ?? "executeCommand",
                });
            };

            // Validate characterId
            if (!characterId) {
                return {
                    status: "error",
                    error: "No agent context available. Command execution requires an agent with synced folders.",
                };
            }

            const { command, args = [], stdin, cwd, timeout, background, processId, logId, head, tail, range, grep, confirmRemoval = false } = input;

            // ── Read Log ────────────────────────────────────────────────
            if (command === "readLog" && logId) {
                const fullLog = readTerminalLog(logId);
                if (!fullLog) {
                    return {
                        status: "error",
                        error: `Log with ID '${logId}' not found. It may have been cleaned up or never existed.`,
                    };
                }

                // Apply the requested slice. Each call is hard-capped at ~8K tokens
                // so a single readLog can't re-inflate context — chunked reads are
                // expected for large logs.
                const slice = sliceLogText(fullLog, {
                    head,
                    tail,
                    range: Array.isArray(range) ? (range as [number, number]) : undefined,
                    grep,
                });

                recordRetrieval({
                    retrievalId: logId,
                    retrievalIdType: "logId",
                    sliceMode: slice.mode,
                    sliceParams: {
                        ...(head !== undefined ? { head } : {}),
                        ...(tail !== undefined ? { tail } : {}),
                        ...(range !== undefined ? { range } : {}),
                        ...(grep !== undefined ? { grep } : {}),
                        ...(slice.meta.matchCount !== undefined
                            ? { matches: slice.meta.matchCount }
                            : {}),
                    },
                    returnedTokens: Math.ceil(slice.content.length / 4),
                    budgetHit: slice.meta.budgetClamped === true,
                });

                const metaBits: string[] = [];
                if (slice.meta.fromLine !== undefined && slice.meta.toLine !== undefined) {
                    metaBits.push(`lines ${slice.meta.fromLine}–${slice.meta.toLine} of ${slice.totalLines}`);
                }
                if (slice.meta.matchCount !== undefined) {
                    metaBits.push(`${slice.meta.matchCount} match${slice.meta.matchCount === 1 ? "" : "es"}`);
                }
                if (slice.meta.budgetClamped) {
                    metaBits.push("budget-clamped");
                }
                const metaLabel = metaBits.length > 0 ? ` (${metaBits.join(", ")})` : "";
                const modeLabel = slice.mode === "default" ? "default head" : slice.mode;

                return {
                    status: "success",
                    stdout: slice.content,
                    message: `readLog '${logId}' — mode=${modeLabel}${metaLabel}.${
                        slice.meta.note ? " " + slice.meta.note : ""
                    }`,
                    logId,
                    isTruncated: slice.meta.budgetClamped === true,
                };
            }

            // ── Background process management ────────────────────────────
            // Check status of a background process
            if (processId && (!command || command === "status")) {
                const info = getBackgroundProcess(processId);
                if (!info) {
                    return {
                        status: "error",
                        error: `No background process found with ID '${processId}'. It may have been cleaned up.`,
                    };
                }
                const elapsed = Math.round((Date.now() - info.startedAt) / 1000);
                if (info.running) {
                    return {
                        status: "running",
                        processId: info.id,
                        stdout: info.stdout,
                        stderr: info.stderr,
                        startedAt: toIsoTimestamp(info.startedAt),
                        message: `Process '${info.command} ${info.args.join(" ")}' still running (${elapsed}s elapsed).`,
                    };
                }
                return {
                    status: info.exitCode === 0 ? "success" : "error",
                    processId: info.id,
                    stdout: info.stdout,
                    stderr: info.stderr,
                    exitCode: info.exitCode,
                    executionTime: Date.now() - info.startedAt,
                    startedAt: toIsoTimestamp(info.startedAt),
                    message: `Process finished after ${elapsed}s with exit code ${info.exitCode}.`,
                    logId: info.logId,
                };
            }

            // Kill a background process
            if (processId && command === "kill") {
                const killed = killBackgroundProcess(processId);
                if (!killed) {
                    return { status: "error", error: `No background process found with ID '${processId}'.` };
                }
                return { status: "success", message: `Background process '${processId}' terminated.` };
            }

            // List all background processes
            if (command === "list" && !processId) {
                // Periodically clean up old finished processes
                cleanupBackgroundProcesses();
                const procs = listBackgroundProcesses();
                if (procs.length === 0) {
                    return { status: "success", message: "No background processes." };
                }
                const lines = procs.map((p) => {
                    const elapsed = Math.round(p.elapsed / 1000);
                    return `[${p.id}] ${p.running ? "RUNNING" : "DONE"} (${elapsed}s) ${p.command}`;
                });
                return { status: "success", stdout: lines.join("\n"), message: `${procs.length} background process(es).` };
            }

            // ── Normal command execution ─────────────────────────────────
            // Validate command is provided
            if (!command || typeof command !== "string" || command.trim() === "") {
                return {
                    status: "error",
                    error: 'Missing or invalid command. Use: executeCommand({ command: "npm", args: ["test"] })',
                };
            }

            // Get synced folders for this agent
            let syncedFolders: string[];
            try {
                const folders = await getAccessibleSyncFolders(characterId);
                syncedFolders = folders.map((f) => f.folderPath);

                if (syncedFolders.length === 0) {
                    return {
                        status: "no_folders",
                        message:
                            "No synced folders configured. Add synced folders for this agent to enable command execution.",
                    };
                }
            } catch (error) {
                return {
                    status: "error",
                    error: `Failed to get synced folders: ${error instanceof Error ? error.message : "Unknown error"}`,
                };
            }

            // Determine working directory — prefer active worktree when available
            const worktreePath = await getActiveWorktreePath(sessionId);
            let executionDir = cwd;
            if (!executionDir) {
                executionDir = worktreePath || syncedFolders[0];
            }

            // Ensure worktree path is in allowed folders for cwd validation
            if (worktreePath && !syncedFolders.includes(worktreePath)) {
                syncedFolders = [worktreePath, ...syncedFolders];
            }

            // Exclude other worktree paths to prevent cross-workspace contamination
            if (worktreePath) {
                syncedFolders = syncedFolders.filter(
                    (p) => !isOtherWorktreePath(p, worktreePath)
                );
            }

            try {
                const resolvedCommand = await resolveClaudePluginRootPlaceholder(command);
                const normalizedInput = normalizeExecuteCommandInput(resolvedCommand, args);
                const preparedInput = prepareCommandInput(
                    normalizedInput.command,
                    normalizedInput.args,
                    stdin,
                );
                
                // ── Background execution ────────────────────────────────
                if (background) {
                    const maxBgTimeout = 600_000; // 10 min
                    const bgResult = await startBackgroundProcess(
                        {
                            command: normalizedInput.command,
                            args: preparedInput.args,
                            stdin: preparedInput.stdin,
                            cwd: executionDir,
                            timeout: Math.min(timeout || 600_000, maxBgTimeout),
                            characterId: characterId,
                            confirmRemoval,
                        },
                        syncedFolders
                    );
                
                    if (bgResult.error) {
                        return { status: "error", error: bgResult.error };
                    }

                    // Register with session so prepareStep keeps the turn alive
                    if (characterId && sessionId) {
                        registerBackgroundTask(characterId, sessionId, bgResult.processId);
                    }

                    console.log(`[executeCommand] Background process started: ${bgResult.processId}`);
                    return {
                        status: "background_started",
                        processId: bgResult.processId,
                        message: `Background process started. Use processId '${bgResult.processId}' to check status.`,
                    };
                }

                // ── Foreground execution ─────────────────────────────────
                const maxTimeout = 600_000; // 10 min for foreground too
                const initialOptions = {
                    command: normalizedInput.command,
                    args: preparedInput.args,
                    stdin: preparedInput.stdin,
                    cwd: executionDir,
                    timeout: timeout ? Math.min(timeout, maxTimeout) : undefined,
                    characterId: characterId,
                    confirmRemoval,
                    abortSignal,
                    onProgress: forwardProgress,
                };

                let result = await executeCommandWithValidation(
                    initialOptions,
                    syncedFolders
                );

                const fallbackReason = result.searchMetadata?.fallbackReason;
                if (
                    (fallbackReason === "rtk_rg_unrecognized_subcommand" || fallbackReason === "rtk_rg_unknown_command")
                    && normalizedInput.command.trim().toLowerCase() === "rg"
                ) {
                    logToolEvent({
                        level: "warn",
                        toolName: "executeCommand",
                        event: "retry",
                        error: `RTK rejected rg command (${fallbackReason}); retrying direct rg execution`,
                        metadata: {
                            searchPath: "shell_rg",
                            fallbackReason,
                            wrappedByRTK: true,
                        },
                    });

                    result = await executeCommandWithValidation(
                        {
                            ...initialOptions,
                            forceDirectExecution: true,
                            fallbackReasonForDirectExecution: fallbackReason,
                        },
                        syncedFolders
                    );
                }

                if (result.searchMetadata?.searchPath === "shell_rg") {
                    logToolEvent({
                        level: result.success ? "info" : "error",
                        toolName: "executeCommand",
                        event: result.success ? "success" : "error",
                        error: result.success ? undefined : result.error,
                        metadata: {
                            searchPath: result.searchMetadata.searchPath,
                            wrappedByRTK: result.searchMetadata.wrappedByRTK,
                            fallbackTriggered: result.searchMetadata.fallbackTriggered,
                            fallbackReason: result.searchMetadata.fallbackReason,
                            originalCommand: result.searchMetadata.originalCommand,
                            finalCommand: result.searchMetadata.finalCommand,
                        },
                    });
                }

                const isApplyPatch = normalizedInput.command.trim().toLowerCase() == "apply_patch";
                let inlineDiff: string | InlineDiffPayload | undefined;
                if (isApplyPatch) {
                    const rawPatch = (preparedInput.stdin || preparedInput.args.join("\n")).trim();
                    if (rawPatch && result.success) {
                        try {
                            inlineDiff = await computeInlineDiffs(rawPatch, executionDir);
                        } catch {
                            inlineDiff = rawPatch || undefined;
                        }
                    } else {
                        inlineDiff = rawPatch || undefined;
                    }
                }

                const toolResult: ExecuteCommandToolResult = {
                    status: result.success
                        ? "success"
                        : result.error?.includes("blocked")
                            ? "blocked"
                            : "error",
                    stdout: result.stdout,
                    stderr: result.stderr,
                    inlineDiff,
                    exitCode: result.exitCode,
                    executionTime: result.executionTime,
                    startedAt: result.startedAt,
                    error: result.error,
                    logId: result.logId,
                    isTruncated: result.isTruncated,
                    aborted: result.aborted,
                };

                return toolResult;
            } catch (error) {
                return {
                    status: "error",
                    error: `Execution error: ${error instanceof Error ? error.message : "Unknown error"}`,
                };
            }
        },
    });
}

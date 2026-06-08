import { tool, jsonSchema, type ToolExecutionOptions } from "ai";
import { resolveWorkspaceAwarePaths } from "@/lib/ai/filesystem";
import { areUnsafeAgentPermissionsEnabled } from "@/lib/config/unsafe-agent-permissions";
import {
  executeCommandWithValidation,
  startBackgroundProcess,
  getBackgroundProcess,
  markBackgroundProcessObserved,
  listBackgroundProcesses,
  cleanupBackgroundProcesses,
} from "@/lib/command-execution";
import {
  getPersistedCommandCwd,
  setPersistedCommandCwd,
} from "@/lib/command-execution/cwd-state";
import { validateExecutionDirectory, validateShellCommand } from "@/lib/command-execution/validator";
import { saveTerminalLog } from "@/lib/command-execution/log-manager";
import { registerBackgroundTask } from "@/app/api/chat/delegation-waiting";
import {
  handleBackgroundProcessSettled,
  killTrackedBackgroundProcess,
  registerBackgroundProcessTask,
} from "@/lib/background-tasks/background-process-task";
import type {
  ExecuteCommandProgressUpdate,
  ExecuteCommandToolOptions,
} from "@/lib/command-execution/types";

const DEFAULT_BASH_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BASH_TIMEOUT_MS = 30 * 60 * 1000;
const CWD_MARKER = "__SELENE_CWD__:";

const bashBackgroundCommands = new Map<string, string>();

type BashInput = {
  command?: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
  processId?: string;
  action?: "status" | "kill" | "list";
};

type BashToolResult = {
  status: "success" | "error" | "no_folders" | "blocked" | "running" | "background_started";
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  executionTime?: number;
  startedAt?: string;
  message?: string;
  error?: string;
  processId?: string;
  logId?: string;
  isTruncated?: boolean;
  /** Inline diff payload when apply_patch is detected in the command */
  inlineDiff?: string;
  aborted?: boolean;
};


function extractToolCallId(options?: ToolExecutionOptions): string {
  if (!options || typeof options !== "object") return "";
  return typeof options.toolCallId === "string" ? options.toolCallId : "";
}

function toIsoTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function normalizeTimeout(timeout?: number): number {
  if (!timeout || !Number.isFinite(timeout) || timeout <= 0) {
    return DEFAULT_BASH_TIMEOUT_MS;
  }
  return Math.min(Math.floor(timeout), MAX_BASH_TIMEOUT_MS);
}

function logRetrievalGuidance(logId?: string): string {
  return logId
    ? ` Use executeCommand({ command: "readLog", logId: "${logId}" }) for full output.`
    : "";
}

function formatBackgroundListMetadata(processInfo: {
  logId?: string;
  exitCode?: number | null;
  startedAt?: string;
  settledAt?: string;
  cwd?: string;
}): string {
  const metadata: string[] = [];
  if (processInfo.logId) metadata.push(`logId=${processInfo.logId}`);
  if (processInfo.exitCode !== undefined) metadata.push(`exitCode=${processInfo.exitCode}`);
  if (processInfo.startedAt) metadata.push(`startedAt=${processInfo.startedAt}`);
  if (processInfo.settledAt) metadata.push(`settledAt=${processInfo.settledAt}`);
  if (processInfo.cwd) metadata.push(`cwd=${processInfo.cwd}`);
  return metadata.length > 0 ? ` ${metadata.join(" ")}` : "";
}

function formatBashResult(result: {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  executionTime?: number;
  startedAt?: string;
  error?: string;
  logId?: string;
  isTruncated?: boolean;
  aborted?: boolean;
}, cleanedStdout?: string): BashToolResult {
  const status = result.success ? "success" : result.error?.includes("blocked") ? "blocked" : "error";
  const fullStdout = cleanedStdout ?? result.stdout;

  // Bash no longer applies a character-based inline cap. The downstream
  // `guardToolResultForStreaming` (lib/ai/tool-result-stream-guard.ts) is the
  // single source of truth for output sizing, using token-based tiers
  // (≤10K tokens passthrough, 10K–25K preview+stub, >25K stub-only).
  //
  // We only persist a terminal log here when the *executor itself* truncated
  // the output (timeout or 1MB process-level cap). In that case the result
  // already carries `isTruncated: true` and ideally a `logId`. We mint a logId
  // only as a fallback if the executor didn't supply one. For below-cap runs,
  // the stream-guard owns the storeFullContent fallback path.
  const executorTruncated =
    result.isTruncated || result.error === "Process terminated due to timeout or output limit";

  let logId = result.logId;
  if (!logId && executorTruncated) {
    logId = saveTerminalLog(fullStdout, result.stderr);
  }

  const message = executorTruncated
    ? `Process terminated by executor (timeout or output cap).${logRetrievalGuidance(logId)}`
    : undefined;

  return {
    status,
    stdout: fullStdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    executionTime: result.executionTime,
    startedAt: result.startedAt,
    error: result.error,
    message,
    logId,
    isTruncated: executorTruncated,
    aborted: result.aborted,
  };
}

/**
 * Detect `apply_patch <<'DELIM'\n...\nDELIM` heredoc patterns in the command
 * string and extract the patch content for stdin-based execution.
 * Also handles commands prefixed with `cd ... &&` or other shell preambles,
 * and PowerShell here-string syntax (`@'\n...\n'@ | apply_patch`).
 * Returns null if the command is not an apply_patch heredoc.
 */
function extractApplyPatchHeredoc(command: string): { stdin: string; patchText: string; cwd?: string } | null {
  // Normalize Windows line endings
  const normalized = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // --- Strategy 1: heredoc anywhere in the command ---
  const applyIdx = normalized.indexOf("apply_patch");
  if (applyIdx !== -1) {
    const prefix = normalized.slice(0, applyIdx).trim();
    const fromApplyPatch = normalized.slice(applyIdx);

    // Use greedy [\s\S]* with $ anchor for correct last-delimiter semantics
    const match = fromApplyPatch.match(/^apply_patch\s+<<\s*['"]?(\w+)['"]?\n([\s\S]*)\n\1\s*$/);
    if (match) {
      const body = match[2];
      if (!body || !body.includes("*** Begin Patch")) return null;

      // Extract cd target from prefix if present (e.g. `cd /d C:\foo &&`)
      let cwd: string | undefined;
      const cdMatch = prefix.match(/cd\s+(?:\/d\s+)?["']?([^"'&;]+?)["']?\s*(?:&&|;)\s*$/);
      if (cdMatch) cwd = cdMatch[1]?.trim();

      const stdin = body.endsWith("\n") ? body : `${body}\n`;
      return { stdin, patchText: body, cwd };
    }
  }

  // --- Strategy 2: PowerShell here-string: @'\n...\n'@ | apply_patch ---
  const psMatch = normalized.match(/^@'\n([\s\S]*)\n'@\s*\|\s*apply_patch\s*$/);
  if (psMatch) {
    const body = psMatch[1];
    if (!body || !body.includes("*** Begin Patch")) return null;
    const stdin = body.endsWith("\n") ? body : `${body}\n`;
    return { stdin, patchText: body };
  }

  return null;
}

function wrapShellCommand(command: string): { command: string; args: string[]; stdin?: string; windowsVerbatimArguments?: boolean } {
  if (process.platform === "win32") {
    const shellCommand = process.env.ComSpec || "cmd.exe";
    // Wrap the entire command in outer double quotes.  With /s /c, cmd.exe
    // strips the first and last quote characters, preserving inner quotes
    // and special characters (|, <, >, &) that appear inside quoted
    // arguments of the user's command.  windowsVerbatimArguments prevents
    // Node.js from applying C-runtime escaping which would break cmd.exe's
    // own quote handling.
    const inner = `${command} & set "SELENE_EXIT=!ERRORLEVEL!" & echo ${CWD_MARKER}!CD! & exit /b !SELENE_EXIT!`;
    return {
      command: shellCommand,
      args: ["/v:on", "/d", "/s", "/c", `"${inner}"`],
      windowsVerbatimArguments: true,
    };
  }

  const wrapped = `${command}
__selene_exit=$?
printf '\n${CWD_MARKER}%s\n' "$(pwd -P)"
exit $__selene_exit`;

  // Run the script through `-c` instead of piping it on stdin. Login shells can
  // source profile scripts that read stdin, which steals the command payload and
  // leaves the child hanging without ever reaching our exit marker.
  return {
    command: "/bin/sh",
    args: ["-lc", wrapped],
  };
}

function extractCwdMarker(stdout: string | undefined): { stdout: string; cwd: string | null } {
  if (!stdout) {
    return { stdout: "", cwd: null };
  }

  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith(CWD_MARKER)) continue;

    const cwd = line.slice(CWD_MARKER.length).trim();
    lines.splice(index, 1);
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    return {
      stdout: lines.join("\n"),
      cwd: cwd || null,
    };
  }

  return { stdout, cwd: null };
}

async function resolveExecutionContext(
  sessionId: string,
  characterId: string
): Promise<
  | {
      syncedFolders: string[];
      executionDir: string;
    }
  | {
      error: BashToolResult;
    }
> {
  let syncedFolders: string[];
  try {
    syncedFolders = await resolveWorkspaceAwarePaths(characterId, sessionId);

    if (syncedFolders.length === 0 && !areUnsafeAgentPermissionsEnabled()) {
      return {
        error: {
          status: "no_folders",
          message:
            "No synced folders configured. Add synced folders for this agent to enable command execution.",
        },
      };
    }
  } catch (error) {
    return {
      error: {
        status: "error",
        error: `Failed to get synced folders: ${error instanceof Error ? error.message : "Unknown error"}`,
      },
    };
  }

  const persistedCwd = await getPersistedCommandCwd(sessionId);
  const preferredExecutionDir = persistedCwd || syncedFolders[0] || process.cwd();
  const preferredValidation = await validateExecutionDirectory(preferredExecutionDir, syncedFolders);

  const executionDir = preferredValidation.valid
    ? preferredValidation.resolvedPath ?? preferredExecutionDir
    : syncedFolders[0] || process.cwd();

  return {
    syncedFolders,
    executionDir,
  };
}

const bashSchema = jsonSchema<BashInput>({
  type: "object",
  title: "BashInput",
  description: "Input for shell command execution with persistent working directory",
  properties: {
    command: {
      type: "string",
      description:
        "Shell command string to execute. Preserves working directory across calls.",
    },
    timeout: {
      type: "number",
      description: "Maximum execution time in milliseconds. Default is 30 minutes.",
    },
    description: {
      type: "string",
      description: "Short description of why the command is being run.",
    },
    run_in_background: {
      type: "boolean",
      description:
        "Run the command in the background and return immediately with a processId.",
    },
    processId: {
      type: "string",
      description:
        "ID of a background process started via run_in_background.",
    },
    action: {
      type: "string",
      enum: ["status", "kill", "list"],
      description:
        "Background process action: status, kill, or list.",
    },
  },
  required: [],
  additionalProperties: false,
});

export function createBashTool(options: ExecuteCommandToolOptions) {
  const { characterId, sessionId, userId, onProgress } = options;

  return tool({
    description: `Run shell commands with a single command string and a persistent working directory.

**How it works:**
- Each call runs in a fresh shell process
- The current working directory persists across calls for this session
- Use one command string instead of splitting command + args
- Supports foreground execution and background polling by processId

**Use this for:**
- git status, npm test, pnpm build, python -m pytest
- chained shell commands like \`cd app && npm test\`
- commands where quoting or pipes are easier as one string

**Background mode (long-running commands only):**
- Set \`run_in_background: true\` to start in background — returns a processId
- Later, pass that \`processId\` to check progress (defaults to status check)
- Use \`action: "kill"\` with \`processId\` to stop a background process
- Use \`action: "list"\` to inspect all background processes
- For regular commands, just provide \`command\` — never set \`action\` or \`processId\`

**Logs:**
- Results may include a \`logId\` for persisted output
- Retrieve full logs with \`executeCommand({ command: "readLog", logId: "..." })\`
- Use \`executeCommand({ command: "readLog", logId: "...", tail: 100 })\`, \`range\`, or \`grep\` for slices

**Safety:**
- Commands still run only from synced folders/worktrees
- \`SELENE_UNSAFE_AGENT_PERMISSIONS=true\` allows broader local filesystem access
- Prefer \`localGrep\`, \`readFile\`, \`editFile\`, and \`writeFile\` for direct codebase operations when possible`,
    inputSchema: bashSchema,
    execute: async (
      input: BashInput,
      toolCallOptions?: ToolExecutionOptions
    ): Promise<BashToolResult> => {
      const toolCallId = extractToolCallId(toolCallOptions);

      if (!characterId) {
        return {
          status: "error",
          error: "No agent context available. Bash execution requires an agent with synced folders.",
        };
      }

      // If a command is provided, always treat as command execution —
      // ignore action/processId even if the model hallucinated them.
      const isCommandExecution = !!input.command;
      const action = isCommandExecution
        ? undefined
        : input.action ?? (input.processId ? "status" : undefined);

      // Validate action constraints (only when NOT executing a command)
      if (action && action !== "list") {
        if (!input.processId) {
          return {
            status: "error",
            error: `bash action "${action}" requires processId.`,
          };
        }
      }

      if (action === "list") {
        cleanupBackgroundProcesses();
        const processes = listBackgroundProcesses();
        if (processes.length === 0) {
          return { status: "success", message: "No background processes." };
        }

        const stdout = processes
          .map((processInfo) => {
            const originalCommand = bashBackgroundCommands.get(processInfo.id) || processInfo.command;
            const elapsed = Math.round(processInfo.elapsed / 1000);
            return `[${processInfo.id}] ${processInfo.running ? "RUNNING" : "DONE"} (${elapsed}s) ${originalCommand}${formatBackgroundListMetadata(processInfo)}`;
          })
          .join("\n");

        return {
          status: "success",
          stdout,
          message: `${processes.length} background process(es).`,
        };
      }

      if (input.processId && action === "kill") {
        const result = killTrackedBackgroundProcess(input.processId, userId);
        if (!result.ok) {
          return { status: "error", error: result.error ?? `No background process found with ID '${input.processId}'.` };
        }
        bashBackgroundCommands.delete(input.processId);
        return {
          status: "success",
          message: `Background process '${input.processId}' terminated.`,
        };
      }

      if (input.processId && action === "status") {
        const info = getBackgroundProcess(input.processId);
        if (!info) {
          return {
            status: "error",
            error: `No background process found with ID '${input.processId}'. It may have been cleaned up.`,
          };
        }
        const cleanedStdout = extractCwdMarker(info.stdout);
        const elapsed = Math.round((Date.now() - info.startedAt) / 1000);
        markBackgroundProcessObserved(input.processId);
        const originalCommand = bashBackgroundCommands.get(info.id) || info.command;

        if (!info.running && cleanedStdout.cwd) {
          await setPersistedCommandCwd(sessionId, cleanedStdout.cwd);
        }

        if (info.running) {
          return {
            status: "running",
            processId: info.id,
            stdout: cleanedStdout.stdout,
            stderr: info.stderr,
            startedAt: toIsoTimestamp(info.startedAt),
            message: `Process '${originalCommand}' still running (${elapsed}s elapsed).${logRetrievalGuidance(info.logId)}`,
            logId: info.logId,
          };
        }

        bashBackgroundCommands.delete(info.id);
        return {
          status: info.exitCode === 0 ? "success" : "error",
          processId: info.id,
          stdout: cleanedStdout.stdout,
          stderr: info.stderr,
          exitCode: info.exitCode,
          executionTime: Date.now() - info.startedAt,
          startedAt: toIsoTimestamp(info.startedAt),
          message: `Process finished after ${elapsed}s with exit code ${info.exitCode}.${logRetrievalGuidance(info.logId)}`,
          logId: info.logId,
        };
      }

      const command = input.command?.trim();
      if (!command) {
        return {
          status: "error",
          error: 'Missing or invalid command. Use: executeCommand({ command: "git status" })',
        };
      }

      const shellValidation = validateShellCommand(command);
      if (!shellValidation.valid) {
        return {
          status: "blocked",
          error: shellValidation.error,
        };
      }

      const executionContext = await resolveExecutionContext(sessionId, characterId);
      if ("error" in executionContext) {
        return executionContext.error;
      }

      const { syncedFolders, executionDir } = executionContext;
      const timeout = normalizeTimeout(input.timeout);

      const forwardProgress = (update: ExecuteCommandProgressUpdate) => {
        const cleanedStdout = extractCwdMarker(update.stdout);
        onProgress?.({
          ...update,
          command,
          args: [],
          cwd: cleanedStdout.cwd ?? update.cwd,
          stdout: cleanedStdout.stdout,
          toolCallId: update.toolCallId ?? toolCallId,
          toolName: update.toolName ?? "bash",
        });
      };

      // Intercept apply_patch heredoc commands: extract patch content and
      // execute apply_patch directly with stdin instead of wrapping in a shell.
      const patchHeredoc = extractApplyPatchHeredoc(command);
      if (patchHeredoc) {
        const effectiveCwd = patchHeredoc.cwd || executionDir;
        const result = await executeCommandWithValidation(
          {
            command: "apply_patch",
            args: [],
            stdin: patchHeredoc.stdin,
            cwd: effectiveCwd,
            timeout,
            characterId,
            toolCallId,
            abortSignal: toolCallOptions?.abortSignal,
            onProgress: forwardProgress,
          },
          syncedFolders
        );

        return {
          ...formatBashResult(result),
          inlineDiff: patchHeredoc.patchText,
        };
      }

      const shellCommand = wrapShellCommand(command);

      if (input.run_in_background) {
        const backgroundResult = await startBackgroundProcess(
          {
            command: shellCommand.command,
            args: shellCommand.args,
            stdin: shellCommand.stdin,
            cwd: executionDir,
            timeout,
            characterId,
            windowsVerbatimArguments: shellCommand.windowsVerbatimArguments,
            onBackgroundProcessSettled: handleBackgroundProcessSettled,
          },
          syncedFolders
        );

        if (backgroundResult.error) {
          return { status: "error", error: backgroundResult.error };
        }

        bashBackgroundCommands.set(backgroundResult.processId, command);
        if (sessionId) {
          registerBackgroundTask(characterId, sessionId, backgroundResult.processId);
        }
        registerBackgroundProcessTask({
          processId: backgroundResult.processId,
          userId,
          characterId,
          sessionId,
          toolName: "bash",
          command,
          cwd: executionDir,
        });

        return {
          status: "background_started",
          processId: backgroundResult.processId,
          message: `Background process started. Use processId '${backgroundResult.processId}' to check status.${logRetrievalGuidance(backgroundResult.logId)}`,
          logId: backgroundResult.logId,
        };
      }

      const result = await executeCommandWithValidation(
        {
          command: shellCommand.command,
          args: shellCommand.args,
          stdin: shellCommand.stdin,
          cwd: executionDir,
          timeout,
          characterId,
          toolCallId,
          abortSignal: toolCallOptions?.abortSignal,
          onProgress: forwardProgress,
          windowsVerbatimArguments: shellCommand.windowsVerbatimArguments,
        },
        syncedFolders
      );

      const cleanedStdout = extractCwdMarker(result.stdout);
      if (cleanedStdout.cwd) {
        await setPersistedCommandCwd(sessionId, cleanedStdout.cwd);
      }

      return formatBashResult(result, cleanedStdout.stdout);
    },
  });
}

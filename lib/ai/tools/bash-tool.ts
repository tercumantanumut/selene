import { tool, jsonSchema, type ToolExecutionOptions } from "ai";
import { resolveWorkspaceAwarePaths } from "@/lib/ai/filesystem";
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

    if (syncedFolders.length === 0) {
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
  const preferredExecutionDir = persistedCwd || syncedFolders[0];
  const preferredValidation = await validateExecutionDirectory(preferredExecutionDir, syncedFolders);

  const executionDir = preferredValidation.valid
    ? preferredValidation.resolvedPath ?? preferredExecutionDir
    : syncedFolders[0];

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
        "Shell command string to execute. This tool preserves working directory across calls.",
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
        "ID of a background process to check or manage. Only use with processes started via run_in_background. Do NOT set this for regular commands.",
    },
    action: {
      type: "string",
      enum: ["status", "kill", "list"],
      description:
        "Background process management ONLY. Do NOT set this when running a command — just provide 'command' alone. 'status' checks a process by processId, 'kill' stops it, 'list' shows all background processes.",
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

**Safety:**
- Commands still run only from synced folders/worktrees
- Removal commands inside the shell string are blocked
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
            return `[${processInfo.id}] ${processInfo.running ? "RUNNING" : "DONE"} (${elapsed}s) ${originalCommand}`;
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
            message: `Process '${originalCommand}' still running (${elapsed}s elapsed).`,
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
          message: `Process finished after ${elapsed}s with exit code ${info.exitCode}.`,
          logId: info.logId,
        };
      }

      const command = input.command?.trim();
      if (!command) {
        return {
          status: "error",
          error: 'Missing or invalid command. Use: bash({ command: "git status" })',
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
          status: result.success
            ? "success"
            : result.error?.includes("blocked")
              ? "blocked"
              : "error",
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          executionTime: result.executionTime,
          startedAt: result.startedAt,
          error: result.error,
          logId: result.logId,
          isTruncated: result.isTruncated,
          aborted: result.aborted,
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
          message: `Background process started. Use processId '${backgroundResult.processId}' to check status.`,
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

      return {
        status: result.success
          ? "success"
          : result.error?.includes("blocked")
            ? "blocked"
            : "error",
        stdout: cleanedStdout.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        executionTime: result.executionTime,
        startedAt: result.startedAt,
        error: result.error,
        logId: result.logId,
        isTruncated: result.isTruncated,
        aborted: result.aborted,
      };
    },
  });
}

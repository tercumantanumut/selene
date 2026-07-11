/**
 * Command Execution Types
 * 
 * TypeScript interfaces for the command execution module.
 */

type ExecuteCommandLiveStatus = "running" | "success" | "error";

export interface ExecuteCommandProgressUpdate {
  toolCallId?: string;
  toolName?: string;
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  status: ExecuteCommandLiveStatus;
  startedAt: string;
  executionTime?: number;
  exitCode?: number | null;
  error?: string;
  message?: string;
  logId?: string;
  isTruncated?: boolean;
  aborted?: boolean;
  chunkStream?: "stdout" | "stderr";
  chunkText?: string;
}

/**
 * Options for executing a command
 */
export interface ExecuteOptions {
  /** Command to execute (e.g., 'npm', 'git', 'ls') */
  command: string;
  /** Command arguments (e.g., ['run', 'build']) */
  args: string[];
  /** Optional stdin payload written to the child process before closing stdin. */
  stdin?: string;
  /** Working directory. Unsafe mode allows any absolute path. */
  cwd: string;
  /** Character/agent ID for folder validation */
  characterId: string;
  /** Maximum execution time in milliseconds (default: 30000) */
  timeout?: number;
  /** Maximum output buffer size in bytes (default: 1048576 = 1MB) */
  maxOutputSize?: number;
  /** Internal use: skip RTK wrapping for this invocation */
  forceDirectExecution?: boolean;
  /** Internal use: retry the command through the user's login shell on Unix. */
  forceShellExecution?: boolean;
  /** Internal use: preserve the original raw command line for shell retries. */
  rawCommandLine?: string;
  /** Internal use: avoid infinite ENOENT -> shell fallback retry loops. */
  shellFallbackAttempted?: boolean;
  /** Internal use: preserve fallback reason when forcing direct execution */
  fallbackReasonForDirectExecution?: ExecuteSearchMetadata["fallbackReason"];
  /** Internal use: pass args verbatim to child process on Windows (skip Node.js C-runtime escaping). */
  windowsVerbatimArguments?: boolean;
  /** Tool call identifier used for live command progress projections. */
  toolCallId?: string;
  /** Abort signal from the owning AI SDK run/tool call. */
  abortSignal?: AbortSignal;
  /** Live progress callback for streaming command output into the UI. */
  onProgress?: (update: ExecuteCommandProgressUpdate) => void;
  /** Called whenever a background process settles. */
  onBackgroundProcessSettled?: (info: BackgroundProcessInfo) => void;
}

/**
 * Result of command execution
 */
export interface ExecuteSearchMetadata {
  /** Which search path was used by executeCommand */
  searchPath: "shell_rg";
  /** Whether command execution was wrapped by RTK */
  wrappedByRTK: boolean;
  /** Whether fallback to direct command was attempted after RTK failure */
  fallbackTriggered: boolean;
  /** Reason fallback was triggered */
  fallbackReason?:
    | "rtk_rg_unrecognized_subcommand"
    | "rtk_rg_unknown_command"
    | "rtk_unrecognized_subcommand"
    | "rtk_unknown_command";
  /** Original command requested by tool caller */
  originalCommand: string;
  /** Final executable used for the successful/returned run */
  finalCommand: string;
}

export interface ExecuteResult {
  /** Whether the command executed successfully (exit code 0) */
  success: boolean;
  /** Standard output from the command */
  stdout: string;
  /** Standard error from the command */
  stderr: string;
  /** Exit code (null if process was killed) */
  exitCode: number | null;
  /** Signal that killed the process (if any) */
  signal: string | null;
  /** Error message if execution failed */
  error?: string;
  /** Execution time in milliseconds */
  executionTime?: number;
  /** Timestamp captured when the command started. */
  startedAt?: string;
  /** Log ID for persistent storage */
  logId?: string;
  /** Whether the output was truncated in context */
  isTruncated?: boolean;
  /** Whether execution was cancelled by the caller's abort signal. */
  aborted?: boolean;
  /** Metadata for shell ripgrep compatibility/fallback diagnostics */
  searchMetadata?: ExecuteSearchMetadata;
}

/**
 * Validation result for paths and commands
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Resolved/normalized path (if valid) */
  resolvedPath?: string;
  /** Error message (if invalid) */
  error?: string;
}

/**
 * Options for the AI tool wrapper
 */
export interface ExecuteCommandToolOptions {
  /** Session ID for context */
  sessionId: string;
  /** User ID for task visibility */
  userId?: string;
  /** Character/agent ID for folder access */
  characterId?: string | null;
  /** Live command progress callback used while a foreground command is running. */
  onProgress?: (update: ExecuteCommandProgressUpdate) => void;
}

interface BashInput {
  /** Shell command string to execute */
  command?: string;
  /** Maximum execution time in milliseconds */
  timeout?: number;
  /** Optional note about why the command is running */
  description?: string;
  /** Run the command in the background */
  run_in_background?: boolean;
  /** Existing background process id */
  processId?: string;
  /** Background management action */
  action?: "status" | "kill" | "list";
}

interface BashToolResult {
  /** Execution status */
  status: "success" | "error" | "no_folders" | "blocked" | "running" | "background_started";
  /** Standard output */
  stdout?: string;
  /** Standard error */
  stderr?: string;
  /** Exit code */
  exitCode?: number | null;
  /** Execution time in milliseconds */
  executionTime?: number;
  /** Timestamp captured when the command started. */
  startedAt?: string;
  /** User-friendly message */
  message?: string;
  /** Error details */
  error?: string;
  /** Process ID for background processes */
  processId?: string;
  /** Log ID for persistent storage */
  logId?: string;
  /** Whether the output was truncated in context */
  isTruncated?: boolean;
  /** Whether execution was cancelled by the caller's abort signal. */
  aborted?: boolean;
}

/**
 * Input schema for the executeCommand AI tool
 */
export interface ExecuteCommandInput {
  /** Command to execute */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Optional raw stdin payload for commands that read from stdin */
  stdin?: string;
  /** Working directory. Unsafe mode allows any absolute path. */
  cwd?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Run in background and return processId immediately */
  background?: boolean;
  /** Process ID to check status of a background process (instead of executing a new command) */
  processId?: string;
  /** When command==="readLog": first N lines of the log */
  head?: number;
  /** When command==="readLog": last N lines of the log */
  tail?: number;
  /** When command==="readLog": 1-indexed inclusive [start, end] line range */
  range?: [number, number];
  /** When command==="readLog": regex search (matches returned with 2 lines of context) */
  grep?: string;
}

/**
 * Result type for the executeCommand AI tool
 */
export interface ExecuteCommandToolResult {
  /** Execution status */
  status: "success" | "error" | "no_folders" | "blocked" | "running" | "background_started";
  /** Standard output */
  stdout?: string;
  /** Standard error */
  stderr?: string;
  /** Optional apply_patch-style diff preview rendered inline by the UI */
  inlineDiff?: string | InlineDiffPayload;
  /** Exit code */
  exitCode?: number | null;
  /** Execution time in milliseconds */
  executionTime?: number;
  /** Timestamp captured when the command started. */
  startedAt?: string;
  /** User-friendly message */
  message?: string;
  /** Error details */
  error?: string;
  /** Process ID for background processes */
  processId?: string;
  /** Log ID for persistent storage */
  logId?: string;
  /** Whether the output was truncated in context */
  isTruncated?: boolean;
  /** Whether execution was cancelled by the caller's abort signal. */
  aborted?: boolean;
}

/**
 * A single file's diff within an apply_patch result
 */
export interface InlineDiffFile {
  /** File path relative to cwd */
  path: string;
  /** Operation type parsed from patch header */
  operation: "add" | "modify" | "delete";
  /** Unified diff string (before vs after) */
  diff: string;
}

/**
 * Structured inline diff payload with per-file diffs
 */
export interface InlineDiffPayload {
  /** Per-file computed diffs */
  files: InlineDiffFile[];
  /** Raw patch text as fallback */
  rawPatch: string;
}

/**
 * Why a background process stopped running.
 * - "exit": the process exited on its own (check exitCode/signal)
 * - "timeout": the background timeout fired and the process was terminated
 * - "killed": an explicit kill was requested (user stop or API kill)
 * - "spawn-error": the process failed to start or crashed during spawn
 */
export type BackgroundProcessSettleReason = "exit" | "timeout" | "killed" | "spawn-error";

/**
 * Info about a background process being tracked
 */
export interface BackgroundProcessInfo {
  /** Unique process identifier */
  id: string;
  /** The command that was executed */
  command: string;
  /** Command arguments */
  args: string[];
  /** Working directory */
  cwd: string;
  /** When the process started */
  startedAt: number;
  /** When the process finished or stopped */
  settledAt?: number | null;
  /** Whether the process is still running */
  running: boolean;
  /** Accumulated stdout */
  stdout: string;
  /** Accumulated stderr */
  stderr: string;
  /** Exit code (null if still running) */
  exitCode: number | null;
  /** Signal that killed the process */
  signal: string | null;
  /** Why the process stopped running (undefined while running) */
  settleReason?: BackgroundProcessSettleReason;
  /** The child process reference */
  process: import("child_process").ChildProcess;
  /** Timeout timer reference */
  timeoutId: NodeJS.Timeout | null;
  /** Log ID for persistent storage */
  logId?: string;
  /** Last time a running background log snapshot was saved */
  lastLogSnapshotAt?: number;
  /** Whether the tool loop has already observed this process while it was running */
  observedWhileRunning?: boolean;
  /** Last time the process status was observed by a tool call */
  lastObservedAt?: number;
}

/**
 * Log entry for command execution
 */
export interface CommandLogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error" | "security";
  category: "command_execution";
  event: string;
  data: Record<string, unknown>;
  userId?: string;
  characterId?: string;
  sessionId?: string;
}

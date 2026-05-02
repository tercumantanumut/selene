/**
 * Apply Patch Tool
 *
 * First-class AI tool for applying unified patches to files.
 * Accepts patch text directly — no shell, no heredoc, no platform issues.
 * This bypasses the bash/shell layer entirely, making it work identically
 * on Windows, macOS, and Linux.
 */

import { tool, jsonSchema, type ToolExecutionOptions } from "ai";
import { logToolEvent } from "@/lib/ai/tool-registry/logging";
import { resolveWorkspaceAwarePaths } from "@/lib/ai/filesystem";
import { areUnsafeAgentPermissionsEnabled } from "@/lib/config/unsafe-agent-permissions";
import { executeCommandWithValidation } from "@/lib/command-execution";
import { computeInlineDiffs } from "./execute-command-tool";
import type {
    ExecuteCommandToolOptions,
    ExecuteCommandProgressUpdate,
    InlineDiffPayload,
} from "@/lib/command-execution/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApplyPatchInput {
    patch: string;
    cwd?: string;
}

interface ApplyPatchToolResult {
    status: "success" | "error" | "blocked" | "no_folders";
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    executionTime?: number;
    startedAt?: string;
    error?: string;
    logId?: string;
    isTruncated?: boolean;
    inlineDiff?: string | InlineDiffPayload;
    message?: string;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const applyPatchSchema = jsonSchema<ApplyPatchInput>({
    type: "object",
    title: "ApplyPatchInput",
    description: "Input for applying a unified patch to files",
    properties: {
        patch: {
            type: "string",
            description: `The patch content in apply_patch format. Must start with "*** Begin Patch" and end with "*** End Patch".

**Format:**
\`\`\`
*** Begin Patch
*** Update File: path/to/file.ts
@@
 context line
-old line
+new line
 context line
*** Add File: path/to/newfile.ts
+new file content
*** Delete File: path/to/old.ts
*** End Patch
\`\`\`

**Operations:** Update File (modify existing), Add File (create new), Delete File (remove).
Each hunk starts with @@ and uses +/- prefixes for additions/removals. Context lines (space prefix) help locate the change.`,
        },
        cwd: {
            type: "string",
            description:
                "Working directory for the patch. Must be within synced folders. If omitted, uses the first synced folder or active worktree.",
        },
    },
    required: ["patch"],
    additionalProperties: false,
});

// ---------------------------------------------------------------------------
// Tool Factory
// ---------------------------------------------------------------------------

export function createApplyPatchTool(options: ExecuteCommandToolOptions) {
    const { characterId, sessionId, onProgress } = options;

    return tool({
        description: `Apply a patch to modify, create, or delete files. Accepts patch text directly — no shell wrapping needed.

**When to use:** For file modifications using the apply_patch format. This is the preferred way to apply patches — do NOT wrap in bash heredoc or shell commands.

**Patch format:**
- Start with \`*** Begin Patch\`, end with \`*** End Patch\`
- \`*** Update File: <path>\` — modify an existing file
- \`*** Add File: <path>\` — create a new file
- \`*** Delete File: <path>\` — remove a file
- Hunks start with \`@@\` and use \`+\`/\`-\` prefixes

**Example:**
\`\`\`
applyPatch({ patch: "*** Begin Patch\\n*** Update File: src/index.ts\\n@@\\n-old line\\n+new line\\n*** End Patch" })
\`\`\``,

        inputSchema: applyPatchSchema,

        execute: async (
            input: ApplyPatchInput,
            toolCallOptions?: ToolExecutionOptions,
        ): Promise<ApplyPatchToolResult> => {
            const toolCallId =
                toolCallOptions && typeof toolCallOptions === "object" && typeof toolCallOptions.toolCallId === "string"
                    ? toolCallOptions.toolCallId
                    : "";

            const forwardProgress = (update: ExecuteCommandProgressUpdate) => {
                onProgress?.({
                    ...update,
                    toolCallId: update.toolCallId ?? toolCallId,
                    toolName: update.toolName ?? "applyPatch",
                });
            };

            // Validate agent context
            if (!characterId) {
                return {
                    status: "error",
                    error: "No agent context available. Patch application requires an agent with synced folders.",
                };
            }

            const patch = input.patch?.trim();
            if (!patch) {
                return {
                    status: "error",
                    error: 'Missing patch content. Provide a patch starting with "*** Begin Patch".',
                };
            }

            if (!patch.startsWith("*** Begin Patch")) {
                return {
                    status: "error",
                    error: 'Invalid patch format. Patch must start with "*** Begin Patch".',
                };
            }

            if (!patch.includes("*** End Patch")) {
                return {
                    status: "error",
                    error: 'Invalid patch format. Patch must end with "*** End Patch".',
                };
            }

            // Use the same workspace-aware authorization roots as file tools.
            let syncedFolders: string[];
            try {
                syncedFolders = await resolveWorkspaceAwarePaths(characterId, sessionId);
                if (syncedFolders.length === 0 && !areUnsafeAgentPermissionsEnabled()) {
                    return {
                        status: "no_folders",
                        message: "No synced folders configured. Add synced folders for this agent to enable patch application.",
                    };
                }
            } catch (error) {
                return {
                    status: "error",
                    error: `Failed to get synced folders: ${error instanceof Error ? error.message : "Unknown error"}`,
                };
            }

            const executionDir = input.cwd || syncedFolders[0] || process.cwd();

            // Ensure patch ends with newline for stdin
            const stdin = patch.endsWith("\n") ? patch : `${patch}\n`;

            try {
                logToolEvent({
                    level: "info",
                    toolName: "applyPatch",
                    event: "start",
                    metadata: { cwd: executionDir, patchLength: patch.length },
                });

                const result = await executeCommandWithValidation(
                    {
                        command: "apply_patch",
                        args: [],
                        stdin,
                        cwd: executionDir,
                        timeout: 30_000,
                        characterId,
                        toolCallId,
                        onProgress: forwardProgress,
                    },
                    syncedFolders,
                );

                // Compute inline diffs for UI display
                let inlineDiff: string | InlineDiffPayload | undefined;
                if (result.success) {
                    try {
                        inlineDiff = await computeInlineDiffs(patch, executionDir);
                    } catch {
                        inlineDiff = patch;
                    }
                } else {
                    inlineDiff = patch;
                }

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
                    inlineDiff,
                };
            } catch (error) {
                return {
                    status: "error",
                    error: `Patch execution error: ${error instanceof Error ? error.message : "Unknown error"}`,
                };
            }
        },
    });
}

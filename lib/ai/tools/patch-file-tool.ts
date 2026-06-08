/**
 * Patch File Tool
 *
 * AI tool for applying multiple file operations atomically.
 * Validates all operations before applying any, ensuring no partial failures.
 * Supports: update (edit), create, delete operations.
 */

import { tool, jsonSchema } from "ai";
import { readFile, writeFile, access, unlink } from "fs/promises";
import { basename } from "path";
import {
  isPathAllowed,
  resolveWorkspaceAwarePaths,
  ensureParentDirectories,
  recordFileRead,
  recordFileWrite,
  wasFileReadBefore,
  isFileStale,
  runPostWriteDiagnostics,
  generateLineNumberDiff,
  generateBeforeAfterDiff,
  type DiagnosticResult,
} from "@/lib/ai/filesystem";
import { areUnsafeAgentPermissionsEnabled } from "@/lib/config/unsafe-agent-permissions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PatchFileToolOptions {
  sessionId: string;
  characterId?: string | null;
}

interface PatchOperation {
  action: "update" | "create" | "delete";
  filePath: string;
  oldString?: string;
  newString?: string;
}

interface PatchFileInput {
  operations: PatchOperation[];
}

interface PatchOperationResult {
  filePath: string;
  action: string;
  success: boolean;
  error?: string;
  diff?: string;
}

interface PatchFileResult {
  status: "success" | "partial" | "error" | "no_folders";
  filesChanged?: number;
  message?: string;
  error?: string;
  operations?: PatchOperationResult[];
  diagnostics?: DiagnosticResult[];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const patchFileSchema = jsonSchema<PatchFileInput>({
  type: "object",
  title: "PatchFileInput",
  description: "Input for batch file operations",
  properties: {
    operations: {
      type: "array",
      description: "List of file operations to apply atomically",
      items: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["update", "create", "delete"],
            description:
              "Operation type: update (replace string), create (new file), delete (remove file)",
          },
          filePath: {
            type: "string",
            description: "File path within synced folders",
          },
          oldString: {
            type: "string",
            description:
              "For update: the unique string to replace. Not needed for create/delete.",
          },
          newString: {
            type: "string",
            description:
              "For update: replacement string. For create: file content. Not needed for delete.",
          },
        },
        required: ["action", "filePath"],
      },
    },
  },
  required: ["operations"],
  additionalProperties: false,
});

// ---------------------------------------------------------------------------
// Tool Factory
// ---------------------------------------------------------------------------

export function createPatchFileTool(options: PatchFileToolOptions) {
  const { sessionId, characterId } = options;

  return tool({
    description: `Apply multiple file operations atomically across synced folders.

**Operations:**
- **update**: Replace a unique string in an existing file (same as editFile)
- **create**: Create a new file with content
- **delete**: Delete an existing file

**Safety:**
- All operations are validated before any writes (all-or-nothing)
- If any validation fails, no files are modified
- Paths restricted to synced folders
- Update operations require the file was previously read

**When to use:** Refactoring across multiple files, creating related files together, or applying a set of coordinated changes.`,

    inputSchema: patchFileSchema,

    execute: async (input: PatchFileInput): Promise<PatchFileResult> => {
      if (!characterId) {
        return {
          status: "error",
          error:
            "No agent context. Patch File requires an agent with synced folders.",
        };
      }

      const { operations } = input;

      if (!operations || operations.length === 0) {
        return {
          status: "error",
          error: "No operations provided.",
        };
      }

      // Get synced folders (workspace-aware — worktree path is included if active)
      let syncedFolders: string[];
      try {
        syncedFolders = await resolveWorkspaceAwarePaths(characterId, sessionId);
        if (syncedFolders.length === 0 && !areUnsafeAgentPermissionsEnabled()) {
          return {
            status: "no_folders",
            error:
              "No synced folders configured. Add synced folders in agent settings.",
          };
        }
      } catch (error) {
        return {
          status: "error",
          error: `Failed to get synced folders: ${error instanceof Error ? error.message : "Unknown error"}`,
        };
      }

      // =====================================================================
      // VALIDATION PASS — check all operations before applying any
      // =====================================================================
      const validationErrors: string[] = [];
      const resolvedOps: Array<{
        op: PatchOperation;
        validPath: string;
        currentContent?: string;
      }> = [];

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        const label = `Operation ${i + 1} (${op.action} ${basename(op.filePath)})`;

        // Validate path
        const validPath = await isPathAllowed(op.filePath, syncedFolders);
        if (!validPath) {
          validationErrors.push(
            `${label}: path not within synced folders`
          );
          continue;
        }

        if (op.action === "update") {
          if (!op.oldString) {
            validationErrors.push(
              `${label}: oldString is required for update`
            );
            continue;
          }

          // Check file was read before
          if (!wasFileReadBefore(sessionId, validPath)) {
            validationErrors.push(
              `${label}: file must be read with readFile before updating`
            );
            continue;
          }

          // Stale check
          if (await isFileStale(sessionId, validPath)) {
            validationErrors.push(
              `${label}: file modified since last read`
            );
            continue;
          }

          // Read and check uniqueness
          try {
            const content = await readFile(validPath, "utf-8");
            const firstIdx = content.indexOf(op.oldString);
            if (firstIdx === -1) {
              validationErrors.push(
                `${label}: oldString not found in file`
              );
              continue;
            }
            if (content.lastIndexOf(op.oldString) !== firstIdx) {
              validationErrors.push(
                `${label}: oldString appears multiple times — must be unique`
              );
              continue;
            }
            resolvedOps.push({ op, validPath, currentContent: content });
          } catch {
            validationErrors.push(`${label}: failed to read file`);
            continue;
          }
        } else if (op.action === "create") {
          if (op.newString === undefined || op.newString === null) {
            validationErrors.push(
              `${label}: newString (content) is required for create`
            );
            continue;
          }
          try {
            await access(validPath);
            validationErrors.push(`${label}: file already exists`);
            continue;
          } catch {
            // Good — file doesn't exist
          }
          resolvedOps.push({ op, validPath });
        } else if (op.action === "delete") {
          try {
            await access(validPath);
          } catch {
            validationErrors.push(`${label}: file does not exist`);
            continue;
          }
          resolvedOps.push({ op, validPath });
        } else {
          validationErrors.push(
            `${label}: unknown action "${op.action}"`
          );
        }
      }

      // If any validation errors, return all of them — no files modified
      if (validationErrors.length > 0) {
        return {
          status: "error",
          error: `Validation failed (no files modified):\n${validationErrors.map((e) => `  - ${e}`).join("\n")}`,
        };
      }

      // =====================================================================
      // APPLY PASS — execute all validated operations
      // =====================================================================
      const results: PatchOperationResult[] = [];
      const modifiedPaths: string[] = [];

      for (const { op, validPath, currentContent } of resolvedOps) {
        try {
          if (op.action === "update" && currentContent !== undefined) {
            const newContent =
              currentContent.slice(
                0,
                currentContent.indexOf(op.oldString!)
              ) +
              (op.newString ?? "") +
              currentContent.slice(
                currentContent.indexOf(op.oldString!) + op.oldString!.length
              );
            await writeFile(validPath, newContent, "utf-8");
            recordFileWrite(sessionId, validPath);
            recordFileRead(sessionId, validPath);
            modifiedPaths.push(validPath);
            
            const diff = generateLineNumberDiff(
              validPath,
              currentContent,
              op.oldString!,
              op.newString ?? ""
            );

            results.push({
              filePath: validPath,
              action: "update",
              success: true,
              diff,
            });
          } else if (op.action === "create") {
            await ensureParentDirectories(validPath);
            await writeFile(validPath, op.newString ?? "", "utf-8");
            recordFileWrite(sessionId, validPath);
            recordFileRead(sessionId, validPath);
            modifiedPaths.push(validPath);

            const diff = generateBeforeAfterDiff(validPath, "", op.newString ?? "");

            results.push({
              filePath: validPath,
              action: "create",
              success: true,
              diff,
            });
          } else if (op.action === "delete") {
            await unlink(validPath);
            results.push({
              filePath: validPath,
              action: "delete",
              success: true,
            });
          }
        } catch (error) {
          results.push({
            filePath: validPath,
            action: op.action,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      // Run diagnostics on modified files
      const diagnosticResults: DiagnosticResult[] = [];
      for (const modPath of modifiedPaths) {
        try {
          const diag = await runPostWriteDiagnostics(modPath, syncedFolders, 5000, "patch_file");
          if (diag) diagnosticResults.push(diag);
        } catch {
          // Diagnostics are optional
        }
      }

      const successCount = results.filter((r) => r.success).length;
      const failCount = results.filter((r) => !r.success).length;
      const totalErrors = diagnosticResults.reduce(
        (sum, d) => sum + d.errorCount,
        0
      );

      const parts = [`Patch applied: ${successCount} operation(s) succeeded`];
      if (failCount > 0) parts.push(`${failCount} failed`);
      if (totalErrors > 0) parts.push(`${totalErrors} diagnostic error(s)`);

      return {
        status: failCount > 0 ? "partial" : "success",
        filesChanged: successCount,
        message: parts.join(", "),
        operations: results,
        diagnostics:
          diagnosticResults.length > 0 ? diagnosticResults : undefined,
      };
    },
  });
}

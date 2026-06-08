/**
 * Read File Tool
 *
 * AI tool for reading file content from Synced Folders.
 * Enhanced with:
 * - Binary file detection (prevents dumping binary garbage)
 * - Head/Tail support for reading large files
 * - Line range support
 */

import { tool, jsonSchema } from "ai";
import { readFile } from "fs/promises";
import { basename } from "path";
import {
  isPathAllowed,
  resolveWorkspaceAwarePaths,
  recordFileRead,
  findSimilarFiles,
} from "@/lib/ai/filesystem";
import {
  getCodeLanguage,
  isBinaryFile,
  selectLines,
  formatLinesWithNumbers,
} from "@/lib/ai/tools/file-content-utils";
import {
  imageToDataUrl,
  isImageExtension,
  inferImageMimeType,
  splitDataUri,
} from "@/lib/ai/media/image-resolver";
import { areUnsafeAgentPermissionsEnabled } from "@/lib/config/unsafe-agent-permissions";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB
const MAX_LINE_COUNT = 5000;
const MAX_LINE_WIDTH = 2000;
// Images are typically larger than text files; a 10MB cap covers mobile photos
// while still bounding the per-turn payload (about 13MB after base64 encode).
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReadFileToolOptions {
  sessionId: string;
  characterId?: string | null;
  userId: string;
}

interface ReadFileInput {
  filePath: string;
  startLine?: number;
  endLine?: number;
  head?: number;
  tail?: number;
}

interface ReadFileImagePayload {
  dataUri: string;
  mediaType: string;
  byteLength: number;
}

interface ReadFileResult {
  status: "success" | "error";
  /**
   * Discriminant for downstream multimodal routing. Defaults to "text" when
   * absent for backward compatibility. The chat tool-result router lifts
   * `image` results into provider-native image content parts.
   */
  kind?: "text" | "image";
  filePath?: string;
  language?: string;
  lineRange?: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  content?: string;
  truncated?: boolean;
  message?: string;
  text?: string;
  error?: string;
  source?: "synced_folder";
  allowedFolders?: string[];
  isBinary?: boolean;
  image?: ReadFileImagePayload;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const readFileSchema = jsonSchema<ReadFileInput>({
  type: "object",
  title: "ReadFileInput",
  description: "Input schema for reading files from synced folders",
  properties: {
    filePath: {
      type: "string",
      description:
        "File path to read. Can be a relative path from a synced folder or an absolute path within synced folders",
    },
    startLine: {
      type: "number",
      minimum: 1,
      description: "Start line number (1-indexed, optional)",
    },
    endLine: {
      type: "number",
      minimum: 1,
      description: "End line number (1-indexed, optional)",
    },
    head: {
      type: "number",
      minimum: 1,
      description: "Read the first N lines of the file (optional)",
    },
    tail: {
      type: "number",
      minimum: 1,
      description: "Read the last N lines of the file (optional)",
    },
  },
  required: ["filePath"],
  additionalProperties: false,
});

// ---------------------------------------------------------------------------
// Tool Factory
// ---------------------------------------------------------------------------

export function createReadFileTool(options: ReadFileToolOptions) {
  const { sessionId, characterId } = options;

  return tool({
    description: `Read text or image content from synced folders and uploaded media.

**Text files:**
- **Smart Limiting**: Reads first 5000 lines by default.
- **Single Selection Mode**: Use exactly one mode per call: ('head') OR ('tail') OR ('startLine'/'endLine').
- **Head/Tail**: Use 'head' to read first N lines, 'tail' to read last N lines.
- **Line Range**: Use 'startLine'/'endLine' for specific sections.

**Images:**
- Supports user-uploaded images referenced by '/api/media/...' or 'local-media://...' URLs in chat history.
- Supports image files (.jpg, .jpeg, .png, .gif, .webp, .bmp, .svg) in synced folders.
- The image is materialized into the current turn only; call this tool again in a future turn to view the image again.
- Use this any time you need to actually look at an image instead of guessing from filename or context.

**Returns:** File content with line numbers and language for text; the inline image bytes for images.`,

    inputSchema: readFileSchema,

    execute: async (input: ReadFileInput): Promise<ReadFileResult> => {
      if (!characterId) {
        return {
          status: "error",
          error: "Read File requires an agent context.",
        };
      }

      const { filePath, startLine, endLine, head, tail } = input;

      // Guard: reject non-finite or negative numeric params early.
      // Degenerate model output (e.g. token repetition loops) can produce
      // Infinity or NaN values that bypass downstream range checks.
      if (startLine !== undefined && (!Number.isFinite(startLine) || startLine < 1)) {
        return { status: "error", error: `Invalid startLine: ${startLine}. Must be a positive integer.` };
      }
      if (endLine !== undefined && (!Number.isFinite(endLine) || endLine < 1)) {
        return { status: "error", error: `Invalid endLine: ${endLine}. Must be a positive integer.` };
      }
      if (head !== undefined && (!Number.isFinite(head) || head < 1)) {
        return { status: "error", error: `Invalid head: ${head}. Must be a positive integer.` };
      }
      if (tail !== undefined && (!Number.isFinite(tail) || tail < 1)) {
        return { status: "error", error: `Invalid tail: ${tail}. Must be a positive integer.` };
      }
      if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
        return { status: "error", error: `endLine (${endLine}) must be >= startLine (${startLine}).` };
      }

      // Validation
      if ((head || tail) && (startLine || endLine)) {
         return {
           status: "error",
           error: "Cannot specify both head/tail and startLine/endLine parameters.",
         };
      }
      if (head && tail) {
        return {
          status: "error",
          error: "Cannot specify both head and tail parameters.",
        };
      }

      // Guard: reject absurdly large range requests to prevent context bloat
      const MAX_RANGE_LINES = 10_000;
      if (head && head > MAX_RANGE_LINES) {
        return {
          status: "error",
          error: `Requested head=${head} exceeds maximum range of ${MAX_RANGE_LINES} lines. Use a smaller range or startLine/endLine.`,
        };
      }
      if (tail && tail > MAX_RANGE_LINES) {
        return {
          status: "error",
          error: `Requested tail=${tail} exceeds maximum range of ${MAX_RANGE_LINES} lines. Use a smaller range or startLine/endLine.`,
        };
      }
      if (startLine && endLine && (endLine - startLine + 1) > MAX_RANGE_LINES) {
        return {
          status: "error",
          error: `Requested range (${startLine}-${endLine} = ${endLine - startLine + 1} lines) exceeds maximum of ${MAX_RANGE_LINES} lines. Use a smaller range.`,
        };
      }

      // Storage-backed image refs ('/api/media/...', 'local-media://...',
      // 'data:image/...') bypass the synced-folder ACL — the Selene storage
      // sandbox enforces its own access control via isApprovedAbsoluteImagePath.
      const isStorageImageRef =
        filePath.startsWith("/api/media/") ||
        filePath.startsWith("local-media://") ||
        filePath.startsWith("data:image/");
      if (isStorageImageRef) {
        try {
          const dataUri = await imageToDataUrl(filePath);
          const split = splitDataUri(dataUri);
          if (!split) {
            return {
              status: "error",
              error: "Resolved image was not a base64 data URI.",
            };
          }
          // 4 base64 chars ~= 3 raw bytes (ignoring `=` padding noise).
          const approximateBytes = Math.floor((split.base64.length * 3) / 4);
          if (approximateBytes > MAX_IMAGE_SIZE_BYTES) {
            return {
              status: "error",
              error: `Image too large (${Math.round(approximateBytes / 1024)}KB). Max: ${MAX_IMAGE_SIZE_BYTES / 1024}KB.`,
            };
          }
          return {
            status: "success",
            kind: "image",
            filePath,
            image: {
              dataUri,
              mediaType: split.mediaType,
              byteLength: approximateBytes,
            },
            message: `Loaded image "${basename(filePath)}" (${split.mediaType}, ${Math.round(approximateBytes / 1024)} KB)`,
            source: "synced_folder",
          };
        } catch (error) {
          return {
            status: "error",
            error: `Failed to load image: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      }

      // Synced Folders (workspace-aware — worktree path is included if active)
      let syncedFolders: string[];
      try {
        // resolveWorkspaceAwarePaths already includes shared workflow folders
        // (via resolveSyncedFolderPaths → getAccessibleSyncFolders) and applies
        // worktree isolation filtering. No extra merge needed.
        syncedFolders = await resolveWorkspaceAwarePaths(characterId, sessionId);
        if (syncedFolders.length === 0 && !areUnsafeAgentPermissionsEnabled()) {
          return {
            status: "error",
            error: "No synced folders configured for this agent. Add folders in agent settings to enable file reading.",
          };
        }
      } catch (error) {
        return {
          status: "error",
          error: `Failed to get synced folders: ${error instanceof Error ? error.message : "Unknown error"}`,
        };
      }

      // Validate Path
      const validPath = await isPathAllowed(filePath, syncedFolders);
      if (!validPath) {
        const suggestions = await findSimilarFiles(characterId, filePath);
        // Keep hard error when suggestions exist (likely a typo the model can fix).
        // Use soft redirect when no suggestions — the file is simply outside synced
        // folders and the model should use its built-in Read tool instead.
        if (suggestions.length > 0) {
          const suggestionText = ` Did you mean: ${suggestions.map(s => `"${s}"`).join(", ")}?`;
          return {
            status: "error",
            error: `File does not exist at this path.${suggestionText} Tip: use executeCommand to run 'ls <folder_path>' to list directory contents and verify exact filenames before reading.`,
            allowedFolders: syncedFolders,
          };
        }
        return {
          status: "success",
          text: `File does not exist at this path. Use executeCommand to run 'ls <folder_path>' to list the directory contents and find the exact filename, or use the Read tool to read files from the filesystem directly.`,
        };
      }

      // Synced-folder image: read as buffer, base64-encode, return as kind:image.
      // Handled before the binary check because images are binary files.
      if (isImageExtension(validPath)) {
        try {
          const buffer = await readFile(validPath);
          if (buffer.byteLength > MAX_IMAGE_SIZE_BYTES) {
            return {
              status: "error",
              error: `Image too large (${Math.round(buffer.byteLength / 1024)}KB). Max: ${MAX_IMAGE_SIZE_BYTES / 1024}KB.`,
            };
          }
          const mediaType = inferImageMimeType(validPath);
          const base64 = buffer.toString("base64");
          recordFileRead(sessionId, validPath);
          return {
            status: "success",
            kind: "image",
            filePath: validPath,
            image: {
              dataUri: `data:${mediaType};base64,${base64}`,
              mediaType,
              byteLength: buffer.byteLength,
            },
            message: `Loaded image "${basename(validPath)}" (${mediaType}, ${Math.round(buffer.byteLength / 1024)} KB)`,
            source: "synced_folder",
          };
        } catch (error) {
          return {
            status: "error",
            error: `Failed to read image: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      }

      // Binary Check - soft redirect so the UI doesn't show an error icon.
      // Images are handled above; this catches non-image binaries.
      if (await isBinaryFile(validPath)) {
        return {
          status: "success",
          text: `File "${basename(validPath)}" is a non-text binary file (compiled, archive, etc). The readFile tool supports text files and images. Use the Read tool to read other binary files from the filesystem.`,
          filePath: validPath,
          isBinary: true,
        };
      }

      // Read File
      try {
        const content = await readFile(validPath, "utf-8");
        const allLines = content.split("\n");

        if (content.length > MAX_FILE_SIZE_BYTES) {
           if (!head && !tail && !startLine && !endLine) {
              return {
                status: "error",
                error: `File too large (${Math.round(content.length / 1024)}KB). Max: ${MAX_FILE_SIZE_BYTES / 1024}KB. Try using 'head' or 'tail' to read a portion.`,
                source: "synced_folder",
              };
           }
        }

        const { lines: selectedLines, actualStartLine, actualEndLine } = selectLines(allLines, {
          head, tail, startLine, endLine, maxLineCount: MAX_LINE_COUNT,
        });

        const lang = getCodeLanguage(validPath);
        const formattedContent = formatLinesWithNumbers(selectedLines, actualStartLine, MAX_LINE_WIDTH);

        const truncated = selectedLines.length < allLines.length;

        // Record Read
        recordFileRead(sessionId, validPath);

        return {
          status: "success",
          filePath: validPath,
          language: lang,
          lineRange: `${actualStartLine}-${actualEndLine}`,
          startLine: actualStartLine,
          endLine: actualEndLine,
          totalLines: allLines.length,
          content: formattedContent,
          truncated,
          message: truncated
            ? `Showing lines ${actualStartLine}-${actualEndLine} of ${allLines.length} total lines`
            : `Read ${allLines.length} lines from ${basename(validPath)}`,
          source: "synced_folder",
        };
      } catch (error) {
        return {
          status: "error",
          error: `Failed to read file: ${error instanceof Error ? error.message : "Unknown error"}`,
        };
      }
    },
  });
}

/**
 * File System Utilities
 *
 * Shared utilities for all file system tools (readFile, editFile, writeFile, patchFile).
 */

export {
  isPathAllowed,
  resolveWorkspaceAwarePaths,
  ensureParentDirectories,
  findSimilarFiles,
  isWorktreePath,
  resolveSyncedPath,
} from "./path-utils";

export {
  recordFileRead,
  recordFileWrite,
  wasFileReadBefore,
  isFileStale,
} from "./file-history";

export {
  runPostWriteDiagnostics,
  type DiagnosticResult,
} from "./diagnostics";

export {
  generateLineNumberDiff,
  generateBeforeAfterDiff,
} from "./diff-utils";

export {
  applyFileEdits,
  type FileEdit,
  type ApplyEditsResult,
} from "./edit-logic";

export {
  atomicWriteFile,
} from "./write-utils";

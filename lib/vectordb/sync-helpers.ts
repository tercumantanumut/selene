/**
 * Sync Service Helpers
 *
 * Pure utility functions used by the folder sync service:
 * file discovery, text scanning, concurrency, JSON parsing, and logging.
 */

import { readdir } from "fs/promises";
import { join, relative, extname } from "path";
import { loadSettings } from "@/lib/settings/settings-manager";
import { DEFAULT_PARALLEL_CONFIG, type ParallelConfig } from "./sync-types";
import { getResourceErrorCode, isFileDescriptorLimitError } from "./resource-errors";

// ---------------------------------------------------------------------------
// Parallel config
// ---------------------------------------------------------------------------

export function resolveParallelConfig(parallelConfig: Partial<ParallelConfig>): ParallelConfig {
  const settings = loadSettings();
  const isLocalEmbeddingProvider = settings.embeddingProvider === "local";
  const baseConcurrency = isLocalEmbeddingProvider ? 2 : DEFAULT_PARALLEL_CONFIG.concurrency;
  const requestedConcurrency =
    typeof parallelConfig.concurrency === "number" && Number.isFinite(parallelConfig.concurrency)
      ? Math.max(1, Math.floor(parallelConfig.concurrency))
      : baseConcurrency;

  return {
    ...DEFAULT_PARALLEL_CONFIG,
    ...parallelConfig,
    concurrency: isLocalEmbeddingProvider ? Math.min(requestedConcurrency, 2) : requestedConcurrency,
  };
}

// ---------------------------------------------------------------------------
// File size / content limits
// ---------------------------------------------------------------------------

/**
 * Maximum time to spend indexing a single file before aborting.
 * Prevents sync from hanging on problematic files.
 */
export const MAX_FILE_INDEXING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Extensions treated as plain text/code for line-based size checks.
 * Binary formats like PDF should not be decoded as UTF-8 for these checks.
 */
const TEXT_FILE_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "rst",
  "tex",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "java",
  "cpp",
  "c",
  "h",
  "go",
  "rs",
  "rb",
  "php",
  "html",
  "htm",
  "css",
  "xml",
  "json",
  "yaml",
  "yml",
  "log",
  "sql",
  "sh",
  "bat",
  "csv",
]);

export function shouldApplyTextLineChecks(filePath: string): boolean {
  const ext = extname(filePath).slice(1).toLowerCase();
  return TEXT_FILE_EXTENSIONS.has(ext);
}

export function scanTextFileLimits(
  content: string,
  maxFileLines: number,
  maxLineLength: number
): { lineCount: number; tooLongLineLength?: number } {
  let lineCount = 1;
  let currentLineLength = 0;

  for (let i = 0; i < content.length; i += 1) {
    const charCode = content.charCodeAt(i);

    if (charCode === 10) {
      lineCount += 1;
      if (lineCount > maxFileLines) {
        return { lineCount };
      }
      currentLineLength = 0;
      continue;
    }

    // Ignore CR in CRLF
    if (charCode === 13) {
      continue;
    }

    currentLineLength += 1;
    if (currentLineLength > maxLineLength) {
      return { lineCount, tooLongLineLength: currentLineLength };
    }
  }

  return { lineCount };
}

export function formatTimeout(ms: number): string {
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

/**
 * Simple concurrency limiter for parallel processing.
 * Limits the number of concurrent promises while maintaining order of results.
 */
export function createConcurrencyLimiter(concurrency: number) {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (queue.length > 0 && activeCount < concurrency) {
      activeCount++;
      const resolve = queue.shift()!;
      resolve();
    }
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // Wait for a slot to become available
    if (activeCount >= concurrency) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    } else {
      activeCount++;
    }

    try {
      return await fn();
    } finally {
      activeCount--;
      next();
    }
  };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Normalize extensions to ensure consistent format (without leading dots)
 */
export function normalizeExtensions(extensions: string[]): string[] {
  return extensions.map((ext) =>
    ext.startsWith(".") ? ext.slice(1).toLowerCase() : ext.toLowerCase()
  );
}

export function warnIfLargeLocalEmbeddingSync(folderPath: string, fileCount: number): void {
  const settings = loadSettings();
  const isLocalEmbeddingProvider = settings.embeddingProvider === "local";

  if (!isLocalEmbeddingProvider || fileCount <= 500) {
    return;
  }

  console.warn(
    `[VectorDB] Syncing ${fileCount} files with local embeddings may cause instability for ${folderPath}. ` +
      `Consider switching to OpenRouter embeddings for large imports.`
  );
}

/**
 * Check if a file should be included based on extension and patterns
 */
function shouldIncludeFile(
  filePath: string,
  includeExtensions: string[],
  shouldIgnore: (filePath: string) => boolean
): boolean {
  const ext = extname(filePath).slice(1).toLowerCase();

  // Check extension whitelist
  if (includeExtensions.length > 0 && !includeExtensions.includes(ext)) {
    return false;
  }

  return !shouldIgnore(filePath);
}

/**
 * Recursively discover files in a folder
 */
export async function discoverFiles(
  folderPath: string,
  basePath: string,
  recursive: boolean,
  includeExtensions: string[],
  shouldIgnore: (filePath: string) => boolean
): Promise<Array<{ filePath: string; relativePath: string }>> {
  const files: Array<{ filePath: string; relativePath: string }> = [];

  try {
    const entries = await readdir(folderPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(folderPath, entry.name);
      const relPath = relative(basePath, fullPath);

      if (entry.isDirectory()) {
        if (recursive && !shouldIgnore(fullPath)) {
          const subFiles = await discoverFiles(
            fullPath,
            basePath,
            recursive,
            includeExtensions,
            shouldIgnore
          );
          files.push(...subFiles);
        }
      } else if (entry.isFile()) {
        if (shouldIncludeFile(fullPath, includeExtensions, shouldIgnore)) {
          files.push({ filePath: fullPath, relativePath: relPath });
        }
      }
    }
  } catch (error) {
    if (isFileDescriptorLimitError(error)) {
      if (folderPath === basePath) {
        const code = getResourceErrorCode(error) ?? "file-descriptor limit";
        console.warn(
          `[SyncService] ${code} while discovering ${folderPath}; aborting this scan ` +
          `so a partial result cannot remove previously indexed files.`
        );
      }
      throw error;
    }

    console.error(`[SyncService] Error reading folder ${folderPath}:`, error);
  }

  return files;
}

// ---------------------------------------------------------------------------
// JSON / database helpers
// ---------------------------------------------------------------------------

/**
 * Parse JSON arrays from database — handle both properly stored arrays and
 * legacy double-stringified data. Drizzle's JSON mode should return arrays,
 * but older data may have been double-stringified.
 */
export function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

export function incrementSkipReason(reasons: Record<string, number>, key: string): void {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Smart reindex helpers
// ---------------------------------------------------------------------------

const SMART_REINDEX_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function shouldSmartReindex(
  lastRunMetadata: unknown,
  nowMs: number = Date.now()
): boolean {
  const metadata = parseJsonObject(lastRunMetadata);
  const lastSmartReindexAt =
    typeof metadata.smartReindexAt === "string"
      ? Date.parse(metadata.smartReindexAt)
      : Number.NaN;

  if (!Number.isFinite(lastSmartReindexAt)) {
    return true;
  }

  return nowMs - lastSmartReindexAt >= SMART_REINDEX_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// Progress logging
// ---------------------------------------------------------------------------

/**
 * Log progress during parallel processing
 */
export function logProgress(
  processed: number,
  total: number,
  fileName: string,
  status: "indexed" | "skipped" | "error",
  startTime: number
): void {
  const percent = Math.round((processed / total) * 100);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const rate = ((processed / (Date.now() - startTime)) * 1000).toFixed(1);

  // Log every 10 files or at key milestones
  if (processed % 10 === 0 || processed === total || processed <= 5) {
    console.log(
      `[SyncService] Progress: ${processed}/${total} (${percent}%) | ` +
        `Rate: ${rate} files/sec | Elapsed: ${elapsed}s | ` +
        `Last: ${fileName} [${status}]`
    );
  }
}

// ---------------------------------------------------------------------------
// Table name helpers
// ---------------------------------------------------------------------------

export function decodeAgentTableName(tableName: string): string | null {
  if (!tableName.startsWith("agent_")) return null;
  const suffix = tableName.slice("agent_".length);
  if (!suffix) return null;
  return suffix.replace(/_/g, "-");
}

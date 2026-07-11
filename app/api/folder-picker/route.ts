import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, basename, extname } from "path";
import { DEFAULT_IGNORE_PATTERNS, createAggressiveIgnore } from "@/lib/vectordb/ignore-patterns";
import { validateSyncFolderPath } from "@/lib/vectordb/path-validation";
import { loadSettings } from "@/lib/settings/settings-manager";

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

function shouldApplyTextLineChecks(filePath: string): boolean {
  const ext = extname(filePath).slice(1).toLowerCase();
  return TEXT_FILE_EXTENSIONS.has(ext);
}

function scanLineCount(content: string, maxFileLines: number): number {
  let lineCount = 1;

  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) {
      lineCount += 1;
      if (lineCount > maxFileLines) {
        return lineCount;
      }
    }
  }

  return lineCount;
}

/**
 * Parse .gitignore-style patterns from a file
 */
function parseIgnorePatterns(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => !line.startsWith("!")); // Skip negation patterns for simplicity
}

/**
 * POST /api/folder-picker
 * Analyzes a folder path and returns information about it,
 * including detected ignore patterns and file count preview.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { folderPath, includeExtensions, excludePatterns, recursive } = body;

    if (!folderPath || typeof folderPath !== "string") {
      return NextResponse.json(
        { error: "folderPath is required" },
        { status: 400 }
      );
    }

    const { normalizedPath, error } = await validateSyncFolderPath(folderPath);
    if (error) {
      const statusCode = error === "Folder does not exist." ? 404 : 400;
      return NextResponse.json({ error }, { status: statusCode });
    }

    // Detect ignore patterns from common ignore files
    const detectedPatterns: string[] = [];
    const ignoreFiles = [".gitignore", ".dockerignore", ".npmignore", ".eslintignore"];

    for (const ignoreFile of ignoreFiles) {
      const ignoreFilePath = join(normalizedPath, ignoreFile);
      if (existsSync(ignoreFilePath)) {
        try {
          const content = await readFile(ignoreFilePath, "utf-8");
          const patterns = parseIgnorePatterns(content);
          detectedPatterns.push(...patterns);
        } catch {
          // Ignore read errors
        }
      }
    }

    // Remove duplicates and merge with defaults. Mandatory runtime exclusions
    // are always retained even when the caller supplies a custom list.
    const allPatterns = [...new Set([...DEFAULT_IGNORE_PATTERNS, ...detectedPatterns])];

    // Count files that would be indexed (with a limit to avoid slowness)
    const extensions = includeExtensions || [".txt", ".md", ".json", ".ts", ".tsx", ".js", ".jsx", ".py", ".html", ".css"];
    const requestedExcludes = Array.isArray(excludePatterns)
      ? excludePatterns.filter((pattern): pattern is string => typeof pattern === "string")
      : [];
    const excludes = [...new Set([
      ...DEFAULT_IGNORE_PATTERNS,
      ...(requestedExcludes.length > 0 ? requestedExcludes : allPatterns),
    ])];
    const shouldIgnore = createAggressiveIgnore(excludes, normalizedPath, extensions);
    const shouldRecurse = recursive !== false;

    let fileCount = 0;
    const maxFilesToCount = 1000; // Limit to avoid slowness

    // Respect current user-configured file limits from settings.
    const settings = loadSettings();
    const maxFileLines = Math.max(100, Math.floor(settings.vectorSearchMaxFileLines ?? 3000));
    const maxLineChecks = 10;
    let lineChecksPerformed = 0;

    let largeFileCount = 0;
    const largeFileExamples: string[] = [];

    async function countFiles(dir: string, depth: number = 0): Promise<void> {
      if (fileCount >= maxFilesToCount) return;
      if (!shouldRecurse && depth > 0) return;

      try {
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (fileCount >= maxFilesToCount) break;

          // Check if should be excluded
          if (shouldIgnore(join(dir, entry.name))) continue;

          if (entry.isDirectory()) {
            await countFiles(join(dir, entry.name), depth + 1);
          } else if (entry.isFile()) {
            // Check extension
            const hasValidExtension = extensions.some((ext: string) => {
              const normalizedExt = ext.startsWith(".") ? ext : `.${ext}`;
              return entry.name.endsWith(normalizedExt);
            });
            if (hasValidExtension && !shouldIgnore(join(dir, entry.name))) {
              fileCount++;

              // Check line count on a small sample of text files for performance.
              const filePath = join(dir, entry.name);
              if (
                lineChecksPerformed < maxLineChecks &&
                shouldApplyTextLineChecks(filePath)
              ) {
                lineChecksPerformed += 1;
                try {
                  const content = await readFile(filePath, "utf-8");
                  const lineCount = scanLineCount(content, maxFileLines);
                  if (lineCount > maxFileLines) {
                    largeFileCount++;
                    if (largeFileExamples.length < 3) {
                      largeFileExamples.push(`${entry.name} (${lineCount} lines)`);
                    }
                  }
                } catch {
                  // Ignore read errors (binary files, etc.)
                }
              }
            }
          }
        }
      } catch {
        // Ignore permission errors, etc.
      }
    }

    await countFiles(normalizedPath);

    return NextResponse.json({
      folderPath: normalizedPath,
      folderName: basename(normalizedPath),
      detectedPatterns,
      mergedPatterns: allPatterns,
      fileCountPreview: fileCount,
      fileCountLimited: fileCount >= maxFilesToCount,
      maxFileLines,
      largeFileCount,
      largeFileExamples,
      exists: true,
    });
  } catch (error) {
    console.error("[folder-picker] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal error" },
      { status: 500 }
    );
  }
}

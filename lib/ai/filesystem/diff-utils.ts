import { basename } from "path";

const DEFAULT_MAX_DIFF_LINES = 400;

function truncateDiffLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }

  const omitted = lines.length - maxLines;
  return [
    ...lines.slice(0, maxLines),
    `... [diff truncated: ${omitted} more line${omitted === 1 ? "" : "s"}]`,
  ];
}

function getChangedLineSections(
  beforeContent: string,
  afterContent: string
): { prefix: number; removed: string[]; added: string[] } {
  const beforeLines = beforeContent.split("\n");
  const afterLines = afterContent.split("\n");

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }

  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;
  while (
    beforeSuffix >= prefix &&
    afterSuffix >= prefix &&
    beforeLines[beforeSuffix] === afterLines[afterSuffix]
  ) {
    beforeSuffix--;
    afterSuffix--;
  }

  return {
    prefix,
    removed:
      beforeSuffix >= prefix
        ? beforeLines.slice(prefix, beforeSuffix + 1)
        : [],
    added:
      afterSuffix >= prefix ? afterLines.slice(prefix, afterSuffix + 1) : [],
  };
}

export function calculateChangedLineCount(
  beforeContent: string,
  afterContent: string
): number {
  if (beforeContent === afterContent) {
    return 0;
  }

  const { removed, added } = getChangedLineSections(beforeContent, afterContent);
  return Math.max(removed.length, added.length);
}

/**
 * Generates a unified diff-like string with line numbers for a string replacement.
 */
export function generateLineNumberDiff(
  filePath: string,
  originalContent: string,
  oldString: string,
  newString: string,
  maxLines: number = DEFAULT_MAX_DIFF_LINES
): string {
  const fileName = basename(filePath);
  const startIdx = originalContent.indexOf(oldString);

  if (startIdx === -1) return `Error: oldString not found in ${fileName}`;

  const preMatch = originalContent.substring(0, startIdx);
  const startLine = preMatch.split("\n").length;

  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");

  const output = [
    `--- ${fileName}`,
    `+++ ${fileName}`,
    `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`,
  ];

  oldLines.forEach((line, i) => {
    output.push(`${startLine + i} | - ${line}`);
  });

  newLines.forEach((line, i) => {
    output.push(`${startLine + i} | + ${line}`);
  });

  return truncateDiffLines(output, maxLines).join("\n");
}

/**
 * Generates a line-numbered before/after diff for create/overwrite-style operations.
 * Uses a single hunk bounded by the common prefix/suffix to keep output concise.
 */
export function generateBeforeAfterDiff(
  filePath: string,
  beforeContent: string,
  afterContent: string,
  maxLines: number = DEFAULT_MAX_DIFF_LINES
): string {
  const fileName = basename(filePath);
  const { prefix, removed, added } = getChangedLineSections(
    beforeContent,
    afterContent
  );

  const startLine = prefix + 1;
  const output = [
    `--- ${fileName}`,
    `+++ ${fileName}`,
    `@@ -${startLine},${removed.length} +${startLine},${added.length} @@`,
  ];

  removed.forEach((line, i) => {
    output.push(`${startLine + i} | - ${line}`);
  });

  added.forEach((line, i) => {
    output.push(`${startLine + i} | + ${line}`);
  });

  return truncateDiffLines(output, maxLines).join("\n");
}

/**
 * @deprecated Dead code — no callers exist in the codebase.
 * readFile tool has its own built-in formatting (line numbers, range selection).
 * Kept temporarily for reference; safe to delete in a follow-up cleanup.
 */
function generateContentPreview(
  filePath: string,
  content: string,
  maxLines: number = 20
): string {
  const fileName = basename(filePath);
  const lines = content.split("\n");
  const totalLines = lines.length;

  const output = [`File: ${fileName} (${totalLines} lines)`];
  lines.slice(0, maxLines).forEach((line, i) => {
    output.push(`${i + 1} | ${line}`);
  });

  if (totalLines > maxLines) {
    output.push(`... (${totalLines - maxLines} more lines)`);
  }

  return output.join("\n");
}

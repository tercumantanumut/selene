import { structuredPatch, type StructuredPatch } from "diff";

const DEFAULT_MAX_DIFF_LINES = 400;
const DEFAULT_CONTEXT_LINES = 2;

export interface LineDiffResult {
  lines: string[];
  additions: number;
  deletions: number;
  changedLines: number;
}

type DiffHunk = StructuredPatch["hunks"][number];

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

function getFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").pop() || normalized;
}

function getHunkStats(hunks: DiffHunk[]): Omit<LineDiffResult, "lines"> {
  let additions = 0;
  let deletions = 0;
  let changedLines = 0;

  for (const hunk of hunks) {
    let runAdditions = 0;
    let runDeletions = 0;

    const flushRun = () => {
      changedLines += Math.max(runAdditions, runDeletions);
      runAdditions = 0;
      runDeletions = 0;
    };

    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        additions++;
        runAdditions++;
      } else if (line.startsWith("-")) {
        deletions++;
        runDeletions++;
      } else if (line.startsWith(" ")) {
        flushRun();
      }
    }

    flushRun();
  }

  return { additions, deletions, changedLines };
}

function formatLineDiff(
  filePath: string,
  beforeContent: string,
  afterContent: string,
  oldLineOffset = 0,
  newLineOffset = 0,
  context = DEFAULT_CONTEXT_LINES
): LineDiffResult {
  if (beforeContent === afterContent) {
    return { lines: [], additions: 0, deletions: 0, changedLines: 0 };
  }

  const fileName = getFileName(filePath);
  const patch = structuredPatch(
    fileName,
    fileName,
    beforeContent,
    afterContent,
    "",
    "",
    { context }
  );
  const output = [`--- ${fileName}`, `+++ ${fileName}`];

  for (const hunk of patch.hunks) {
    const oldStart = hunk.oldStart + oldLineOffset;
    const newStart = hunk.newStart + newLineOffset;
    output.push(
      `@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`
    );

    let oldLine = oldStart;
    let newLine = newStart;

    for (const line of hunk.lines) {
      if (line.startsWith("-")) {
        output.push(`${oldLine} | - ${line.slice(1)}`);
        oldLine++;
      } else if (line.startsWith("+")) {
        output.push(`${newLine} | + ${line.slice(1)}`);
        newLine++;
      } else if (line.startsWith(" ")) {
        output.push(`${oldLine} ${newLine} |   ${line.slice(1)}`);
        oldLine++;
        newLine++;
      } else {
        output.push(line);
      }
    }
  }

  return {
    lines: output,
    ...getHunkStats(patch.hunks),
  };
}

export function calculateChangedLineCount(
  beforeContent: string,
  afterContent: string
): number {
  return formatLineDiff("file", beforeContent, afterContent).changedLines;
}

/**
 * Generates a line-numbered diff for a string replacement at its real file offset.
 * Unchanged lines inside the supplied replacement snippet are emitted as neutral
 * context instead of being presented as removals and additions.
 */
export function generateLineNumberDiff(
  filePath: string,
  originalContent: string,
  oldString: string,
  newString: string,
  maxLines: number = DEFAULT_MAX_DIFF_LINES
): string {
  const fileName = getFileName(filePath);
  const startIdx = originalContent.indexOf(oldString);

  if (startIdx === -1) return `Error: oldString not found in ${fileName}`;

  const startLine = originalContent.substring(0, startIdx).split("\n").length;
  const result = formatLineDiff(
    filePath,
    oldString,
    newString,
    startLine - 1,
    startLine - 1
  );

  return truncateDiffLines(result.lines, maxLines).join("\n");
}

/**
 * Generates a line-numbered before/after diff with separate hunks and neutral
 * context. Only actual additions and removals receive change markers.
 */
export function generateBeforeAfterDiff(
  filePath: string,
  beforeContent: string,
  afterContent: string,
  maxLines: number = DEFAULT_MAX_DIFF_LINES
): string {
  const result = formatLineDiff(filePath, beforeContent, afterContent);
  return truncateDiffLines(result.lines, maxLines).join("\n");
}

/**
 * Generates display-ready diff lines and stats for clients that only have the
 * before/after snippets, such as Claude Code's Edit tool UI.
 */
export function generateSnippetDiff(
  filePath: string,
  beforeContent: string,
  afterContent: string,
  maxLines: number = DEFAULT_MAX_DIFF_LINES
): LineDiffResult {
  const result = formatLineDiff(filePath, beforeContent, afterContent);
  return {
    ...result,
    lines: truncateDiffLines(result.lines, maxLines),
  };
}

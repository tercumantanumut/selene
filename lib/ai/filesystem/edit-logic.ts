/**
 * Edit Logic for File System Tools
 * 
 * Implements "Fuzzy Match & Patch" algorithm to handle LLM-generated edits
 * that may have mismatched indentation or line endings.
 */

import { calculateChangedLineCount } from "./diff-utils";

export interface FileEdit {
  oldString: string;
  newString: string;
}

export interface ApplyEditsResult {
  success: boolean;
  newContent: string;
  diff: string;
  error?: string;
  linesChanged: number;
}

/**
 * Normalizes line endings to \n
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Detects indentation of a line
 */
function getIndentation(line: string): string {
  const match = line.match(/^(\s*)/);
  return match ? match[1] : "";
}

type SingleEditResult =
  | { success: true; content: string; linesChanged: number }
  | {
      success: false;
      error: string;
      reason: "empty_old_string" | "multiple_matches" | "not_found";
    };

/**
 * Some model/tool-call streams occasionally provide snippets copied from a JSON
 * representation instead of the literal file text, e.g. `\"` instead of `"` or
 * `\n` instead of an actual newline. Keep raw matching first, but if raw matching
 * fails, retry with these common JSON-style escapes decoded.
 */
function decodeCommonEscapedSnippet(text: string): string | null {
  if (!/\\(?:r|n|t|"|'|`)/.test(text)) return null;

  const decoded = text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\`/g, "`");

  return decoded === text ? null : decoded;
}

function buildEditCandidates(edit: FileEdit): FileEdit[] {
  const rawCandidate = {
    oldString: normalizeLineEndings(edit.oldString),
    newString: normalizeLineEndings(edit.newString),
  };

  const decodedOldString = decodeCommonEscapedSnippet(edit.oldString);
  if (!decodedOldString) return [rawCandidate];

  const decodedNewString = decodeCommonEscapedSnippet(edit.newString);
  const decodedCandidate = {
    oldString: normalizeLineEndings(decodedOldString),
    newString: normalizeLineEndings(decodedNewString ?? edit.newString),
  };

  if (decodedCandidate.oldString === rawCandidate.oldString) {
    return [rawCandidate];
  }

  return [rawCandidate, decodedCandidate];
}

function applySingleEdit(
  content: string,
  oldString: string,
  newString: string
): SingleEditResult {
  if (oldString === "") {
    // Creation mode (should be handled by caller, but supported here)
    // If content is empty, just set it. If not, append?
    // The tool definition says oldString="" creates a new file.
    // But if we are editing, maybe it means append?
    // For safety, let's assume this logic is primarily for replacement.
    // If the file is empty, we just return newString.
    if (content === "") {
      return {
        success: true,
        content: newString,
        linesChanged: newString.split("\n").length,
      };
    }

    return {
      success: false,
      error: "Empty oldString is only for creating new files.",
      reason: "empty_old_string",
    };
  }

  // 1. Try Exact Match
  const exactIndex = content.indexOf(oldString);
  if (exactIndex !== -1) {
    // Check uniqueness
    if (content.indexOf(oldString, exactIndex + 1) !== -1) {
      return {
        success: false,
        error: "oldString matches multiple locations in the file. Please provide more context.",
        reason: "multiple_matches",
      };
    }

    return {
      success: true,
      content:
        content.slice(0, exactIndex) +
        newString +
        content.slice(exactIndex + oldString.length),
      linesChanged: calculateChangedLineCount(oldString, newString),
    };
  }

  // 2. Fuzzy Match (Line-by-Line)
  const contentLines = content.split("\n");
  const searchLines = oldString.split("\n");

  // We need to find a block of lines in content where trimmed versions match searchLines trimmed
  let matchIndex = -1;
  let matchCount = 0;

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    let isMatch = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j].trim() !== searchLines[j].trim()) {
        isMatch = false;
        break;
      }
    }

    if (isMatch) {
      matchCount++;
      matchIndex = i;
    }
  }

  if (matchCount === 0) {
    return {
      success: false,
      error: "Could not find oldString in file (tried exact match and fuzzy line match).",
      reason: "not_found",
    };
  }

  if (matchCount > 1) {
    return {
      success: false,
      error: `Found ${matchCount} matches for oldString using fuzzy matching. Please provide more context.`,
      reason: "multiple_matches",
    };
  }

  // Found unique fuzzy match at matchIndex
  // Capture indentation from the first line of the match in the file
  const originalIndentation = getIndentation(contentLines[matchIndex]);

  // Apply indentation to newString
  const newLines = newString.split("\n");

  // Refined Indentation Logic:
  // We want to replace contentLines[matchIndex ... matchIndex + searchLines.length - 1]
  // with newString.

  // But we want to fix indentation if possible.
  // If we just replace the lines, we might break structure.

  // Let's look at how the MCP server does it.
  // "Capture the actual indentation of the first matching line in the file. Apply the captured indentation to the newString."

  const firstLineNew = newLines[0];
  const baseIndentNew = getIndentation(firstLineNew);

  const finalizedNewLines = newLines.map((line) => {
    // Remove the base indentation of the new string (relative to its first line)
    // And add the original indentation from the file.

    // Be careful: what if line is less indented than first line? (e.g. closing brace)
    // valid:   if (x) {
    //            foo();
    //          }
    // baseIndent is 2 spaces (if).

    // If newString is:
    //   if (y) {
    //     bar();
    //   }
    // baseIndentNew is 2 spaces.

    // If original file has:
    //         if (x) {
    // originalIndent is 8 spaces.

    // We want to shift newString by (8 - 2) = +6 spaces.

    // But we can't just subtract baseIndentNew length, because it might be tabs vs spaces.
    // Let's assume spaces for simplicity or just strip matching prefix.

    if (line.startsWith(baseIndentNew)) {
      return originalIndentation + line.slice(baseIndentNew.length);
    }

    // Line is to the left of the base indentation?
    // Just return it as is, or try to apply originalIndentation?
    // Usually this happens for closing braces if they were not part of the snippet properly.
    // Let's just prepend originalIndentation if it looks like it lacks indentation?
    return originalIndentation + line.trimLeft();
  });

  // Replace the lines
  const matchedLines = contentLines.slice(
    matchIndex,
    matchIndex + searchLines.length
  );
  contentLines.splice(matchIndex, searchLines.length, ...finalizedNewLines);

  return {
    success: true,
    content: contentLines.join("\n"),
    linesChanged: calculateChangedLineCount(
      matchedLines.join("\n"),
      finalizedNewLines.join("\n")
    ),
  };
}

/**
 * Apply edits to file content using fuzzy matching
 */
export function applyFileEdits(
  fileContent: string,
  edits: FileEdit[]
): ApplyEditsResult {
  // Detect original line ending style so we can restore it after editing
  const usesCRLF = fileContent.includes("\r\n");

  let content = normalizeLineEndings(fileContent);
  let totalLinesChanged = 0;

  for (const edit of edits) {
    const candidates = buildEditCandidates(edit);
    let applied = false;
    let notFoundError =
      "Could not find oldString in file (tried exact match and fuzzy line match).";

    for (const candidate of candidates) {
      const result = applySingleEdit(
        content,
        candidate.oldString,
        candidate.newString
      );

      if (result.success) {
        content = result.content;
        totalLinesChanged += result.linesChanged;
        applied = true;
        break;
      }

      if (result.reason !== "not_found") {
        return {
          success: false,
          newContent: fileContent,
          diff: "",
          error: result.error,
          linesChanged: 0,
        };
      }

      notFoundError = result.error;
    }

    if (!applied) {
      return {
        success: false,
        newContent: fileContent,
        diff: "",
        error: notFoundError,
        linesChanged: 0,
      };
    }
  }

  // Restore original line endings if the file used CRLF
  const finalContent = usesCRLF ? content.replace(/\n/g, "\r\n") : content;

  return {
    success: true,
    newContent: finalContent,
    diff: "", // Diff is generated by the caller using generateBeforeAfterDiff (line-numbered @@ hunks)
    linesChanged: totalLinesChanged,
  };
}

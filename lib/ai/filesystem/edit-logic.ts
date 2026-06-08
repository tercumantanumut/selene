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
    const oldString = normalizeLineEndings(edit.oldString);
    const newString = normalizeLineEndings(edit.newString);

    if (oldString === "") {
      // Creation mode (should be handled by caller, but supported here)
      // If content is empty, just set it. If not, append? 
      // The tool definition says oldString="" creates a new file. 
      // But if we are editing, maybe it means append? 
      // For safety, let's assume this logic is primarily for replacement.
      // If the file is empty, we just return newString.
      if (content === "") {
        content = newString;
        totalLinesChanged += newString.split("\n").length;
        continue;
      }
      // If file not empty, and oldString is empty, usually implies creation.
      // But here we might be in a multi-edit flow. 
      // Let's assume strict replacement logic for now.
      return {
        success: false,
        newContent: fileContent,
        diff: "",
        error: "Empty oldString is only for creating new files.",
        linesChanged: 0,
      };
    }

    // 1. Try Exact Match
    const exactIndex = content.indexOf(oldString);
    if (exactIndex !== -1) {
      // Check uniqueness
      if (content.indexOf(oldString, exactIndex + 1) !== -1) {
        return {
          success: false,
          newContent: fileContent,
          diff: "",
          error: "oldString matches multiple locations in the file. Please provide more context.",
          linesChanged: 0,
        };
      }
      
      content = content.slice(0, exactIndex) + newString + content.slice(exactIndex + oldString.length);
      totalLinesChanged += calculateChangedLineCount(oldString, newString);
      continue;
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
        newContent: fileContent,
        diff: "",
        error: "Could not find oldString in file (tried exact match and fuzzy line match).",
        linesChanged: 0,
      };
    }

    if (matchCount > 1) {
      return {
        success: false,
        newContent: fileContent,
        diff: "",
        error: `Found ${matchCount} matches for oldString using fuzzy matching. Please provide more context.`,
        linesChanged: 0,
      };
    }

    // Found unique fuzzy match at matchIndex
    // Capture indentation from the first line of the match in the file
    const originalIndentation = getIndentation(contentLines[matchIndex]);
    const searchIndentation = getIndentation(searchLines[0]);

    // Apply indentation to newString
    const newLines = newString.split("\n");
    const adjustedNewLines = newLines.map((line, index) => {
      // Calculate relative indentation of the new line compared to the first line of search string
      // But wait, newString comes from the LLM, likely with its own indentation logic.
      // Strategy: 
      // 1. If newString is single line, just use originalIndentation + trimmed line.
      // 2. If multi-line, preserve relative indentation?
      
      // Simpler approach: 
      // If the LLM provided indentation in newString, it might be trying to match the file.
      // Or it might be just generic indentation.
      
      // Let's try to preserve the *base* indentation of the file.
      // We assume the first line of newString corresponds to the first line of oldString replacement.
      
      if (index === 0) {
        return originalIndentation + line.trimLeft();
      }
      
      // For subsequent lines, we need to decide how to indent.
      // If newString has indentation, we should probably respect its relative indentation.
      // But if we are re-indenting a block, we might need to shift everything.
      
      // Let's just use the raw newString lines for now, but maybe apply the base indentation difference?
      // Actually, often the LLM will output the code block with 0 indentation or some arbitrary indentation.
      
      // Let's try: calculate the indentation of the first line of newString.
      // Then for every line, remove that base indentation, and add originalIndentation.
      
      return line; // Placeholder for now, let's refine this logic.
    });

    // Refined Indentation Logic:
    // We want to replace contentLines[matchIndex ... matchIndex + searchLines.length - 1]
    // with newString.
    
    // But we want to fix indentation if possible.
    // If we just replace the lines, we might break structure.
    
    // Let's look at how the MCP server does it. 
    // "Capture the actual indentation of the first matching line in the file. Apply the captured indentation to the newString."
    
    const firstLineNew = newLines[0];
    const baseIndentNew = getIndentation(firstLineNew);
    
    const finalizedNewLines = newLines.map(line => {
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
      } else {
        // Line is to the left of the base indentation? 
        // Just return it as is, or try to apply originalIndentation?
        // Usually this happens for closing braces if they were not part of the snippet properly.
        // Let's just prepend originalIndentation if it looks like it lacks indentation?
        return originalIndentation + line.trimLeft();
      }
    });
    
    // Replace the lines
    const matchedLines = contentLines.slice(
      matchIndex,
      matchIndex + searchLines.length
    );
    contentLines.splice(matchIndex, searchLines.length, ...finalizedNewLines);
    content = contentLines.join("\n");
    totalLinesChanged += calculateChangedLineCount(
      matchedLines.join("\n"),
      finalizedNewLines.join("\n")
    );
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

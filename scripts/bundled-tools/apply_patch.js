#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");

class PatchError extends Error {}

function fail(message) {
  throw new PatchError(message);
}

function readPatchFromStdin() {
  const input = fs.readFileSync(0, "utf8");
  if (!input.trim()) {
    fail("No patch content was provided on stdin.");
  }
  return input.replace(/\r\n/g, "\n");
}

function splitLines(text) {
  return text.split("\n");
}

function parsePatch(text) {
  const lines = splitLines(text);
  const beginIndex = lines.indexOf("*** Begin Patch");
  const endIndex = lines.lastIndexOf("*** End Patch");

  if (beginIndex === -1) {
    fail("Missing '*** Begin Patch' marker.");
  }
  if (endIndex === -1 || endIndex <= beginIndex) {
    fail("Missing '*** End Patch' marker.");
  }

  const body = lines.slice(beginIndex + 1, endIndex);
  const actions = [];
  let i = 0;

  while (i < body.length) {
    const line = body[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length).trim();
      i += 1;

      let moveTo = null;
      if (i < body.length && body[i].startsWith("*** Move to: ")) {
        moveTo = body[i].slice("*** Move to: ".length).trim();
        i += 1;
      }

      const section = [];
      while (i < body.length && !body[i].startsWith("*** ")) {
        section.push(body[i]);
        i += 1;
      }

      actions.push({
        type: "update",
        filePath,
        moveTo,
        hunks: parseHunks(section, filePath),
      });
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length).trim();
      i += 1;
      const contentLines = [];

      while (i < body.length && !body[i].startsWith("*** ")) {
        const contentLine = body[i];
        if (contentLine.startsWith("+")) {
          contentLines.push(contentLine.slice(1));
        } else if (contentLine === "") {
          contentLines.push("");
        } else {
          fail(
            `Invalid line in Add File '${filePath}'. Expected '+' prefix, got: ${JSON.stringify(contentLine)}`,
          );
        }
        i += 1;
      }

      actions.push({ type: "add", filePath, contentLines });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const filePath = line.slice("*** Delete File: ".length).trim();
      actions.push({ type: "delete", filePath });
      i += 1;
      continue;
    }

    fail(`Unknown patch header: ${line}`);
  }

  return actions;
}

function parseHunks(sectionLines, filePath) {
  const hunks = [];
  let i = 0;

  while (i < sectionLines.length) {
    const header = sectionLines[i];

    if (!header.startsWith("@@")) {
      if (!header.trim()) {
        i += 1;
        continue;
      }
      fail(`Expected hunk header (@@) in '${filePath}', got: ${header}`);
    }

    i += 1;
    const lines = [];

    while (i < sectionLines.length && !sectionLines[i].startsWith("@@")) {
      const line = sectionLines[i];

      if (line === "\\ No newline at end of file") {
        i += 1;
        continue;
      }

      if (line === "") {
        lines.push({ prefix: " ", text: "" });
        i += 1;
        continue;
      }

      const prefix = line[0];
      if (prefix !== " " && prefix !== "+" && prefix !== "-") {
        fail(`Invalid hunk line in '${filePath}': ${line}`);
      }

      lines.push({ prefix, text: line.slice(1) });
      i += 1;
    }

    hunks.push({ header, lines });
  }

  return hunks;
}

function resolveWorkspacePath(relativePath, rootDir) {
  if (!relativePath || relativePath.trim() === "") {
    fail("Encountered an empty file path in patch.");
  }

  const normalized = relativePath.replace(/\\/g, "/");
  const resolved = path.resolve(rootDir, normalized);
  if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) {
    fail(`Refusing to write outside current workspace: ${relativePath}`);
  }

  return resolved;
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function toLineArray(text) {
  const hasFinalNewline = text.endsWith("\n");
  const body = hasFinalNewline ? text.slice(0, -1) : text;
  const lines = body.length === 0 ? [] : body.split("\n");
  return { lines, hasFinalNewline };
}

function fromLineArray(lines, hasFinalNewline) {
  if (lines.length === 0) {
    return hasFinalNewline ? "\n" : "";
  }
  return lines.join("\n") + (hasFinalNewline ? "\n" : "");
}

function findSequence(lines, pattern, startIndex) {
  if (pattern.length === 0) {
    return startIndex;
  }

  for (let i = startIndex; i <= lines.length - pattern.length; i += 1) {
    let match = true;
    for (let j = 0; j < pattern.length; j += 1) {
      if (lines[i + j] !== pattern[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return i;
    }
  }

  return -1;
}

function applyHunksToLines(lines, hunks, filePath) {
  let cursor = 0;

  for (const hunk of hunks) {
    const search = [];
    const replacement = [];

    for (const line of hunk.lines) {
      if (line.prefix !== "+") {
        search.push(line.text);
      }
      if (line.prefix !== "-") {
        replacement.push(line.text);
      }
    }

    let index = findSequence(lines, search, cursor);
    if (index === -1) {
      index = findSequence(lines, search, 0);
    }

    if (index === -1) {
      fail(`Failed to apply hunk (${hunk.header}) for '${filePath}'.`);
    }

    lines.splice(index, search.length, ...replacement);
    cursor = index + replacement.length;
  }
}

function writeFileEnsuringDir(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/**
 * Plan a single action without touching the filesystem.
 *
 * Returns an "operation" describing the on-disk change to commit later.
 * Throwing here aborts the whole patch with no on-disk changes — that is
 * the atomicity contract: validate-all-then-commit-all, never partial.
 *
 * The planner uses an in-memory `virtualFs` map so a patch that touches
 * the same file twice (e.g. add then update, or two updates) sees its
 * own prior mutations during validation, matching what the committed
 * result will be.
 */
function planAction(action, rootDir, virtualFs) {
  if (action.type === "update") {
    const targetPath = resolveWorkspacePath(action.filePath, rootDir);
    let original;
    if (Object.prototype.hasOwnProperty.call(virtualFs, targetPath)) {
      const prior = virtualFs[targetPath];
      if (prior === null) {
        fail(`Cannot update missing file: ${action.filePath}`);
      }
      original = prior;
    } else {
      if (!fs.existsSync(targetPath)) {
        fail(`Cannot update missing file: ${action.filePath}`);
      }
      original = readTextFile(targetPath);
    }

    const parsed = toLineArray(original);
    applyHunksToLines(parsed.lines, action.hunks, action.filePath);
    const updated = fromLineArray(parsed.lines, parsed.hasFinalNewline);

    if (action.moveTo) {
      const movedPath = resolveWorkspacePath(action.moveTo, rootDir);
      virtualFs[targetPath] = null;
      virtualFs[movedPath] = updated;
      return { kind: "move", fromPath: targetPath, toPath: movedPath, content: updated };
    }

    virtualFs[targetPath] = updated;
    return { kind: "write", targetPath, content: updated };
  }

  if (action.type === "add") {
    const targetPath = resolveWorkspacePath(action.filePath, rootDir);
    const priorKnown = Object.prototype.hasOwnProperty.call(virtualFs, targetPath);
    const existsAlready = priorKnown ? virtualFs[targetPath] !== null : fs.existsSync(targetPath);
    if (existsAlready) {
      fail(`Cannot add file that already exists: ${action.filePath}`);
    }

    const body = action.contentLines.join("\n");
    const content = body.length > 0 ? `${body}\n` : "";
    virtualFs[targetPath] = content;
    return { kind: "write", targetPath, content };
  }

  if (action.type === "delete") {
    const targetPath = resolveWorkspacePath(action.filePath, rootDir);
    const priorKnown = Object.prototype.hasOwnProperty.call(virtualFs, targetPath);
    const existsNow = priorKnown ? virtualFs[targetPath] !== null : fs.existsSync(targetPath);
    if (!existsNow) {
      fail(`Cannot delete missing file: ${action.filePath}`);
    }
    virtualFs[targetPath] = null;
    return { kind: "delete", targetPath };
  }

  fail(`Unknown action type: ${action.type}`);
}

/**
 * Commit a planned operation to disk. Phase-2 only: by the time we reach
 * here every action has already been validated against the in-memory
 * virtual fs, so these writes are expected to succeed.
 */
function commitOperation(op) {
  if (op.kind === "write") {
    writeFileEnsuringDir(op.targetPath, op.content);
    return;
  }
  if (op.kind === "delete") {
    fs.unlinkSync(op.targetPath);
    return;
  }
  if (op.kind === "move") {
    // Write the updated content to the source path first, then move it.
    // This handles updates-with-rename atomically per file: the source
    // exists (we validated it) so the rename is just a path change.
    writeFileEnsuringDir(op.fromPath, op.content);
    fs.mkdirSync(path.dirname(op.toPath), { recursive: true });
    fs.renameSync(op.fromPath, op.toPath);
    return;
  }
  fail(`Unknown operation kind: ${op.kind}`);
}

function main() {
  const patchText = readPatchFromStdin();
  const actions = parsePatch(patchText);
  const rootDir = process.cwd();

  // Phase 1 — validate every action in memory. Any failure aborts the
  // entire patch with zero on-disk changes (atomicity across files).
  const operations = [];
  const virtualFs = Object.create(null);
  for (const action of actions) {
    operations.push(planAction(action, rootDir, virtualFs));
  }

  // Phase 2 — commit. All actions validated; writes should succeed.
  for (const op of operations) {
    commitOperation(op);
  }

  process.stdout.write("Done!\n");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`apply_patch failed: ${message}\n`);
  process.exitCode = 1;
}

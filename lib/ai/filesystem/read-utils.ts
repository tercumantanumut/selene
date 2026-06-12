/**
 * Read Utilities for synced-folder-scoped file reads (BA-4).
 *
 * All tool handlers that read from a character's synced folder MUST go
 * through `readSyncedFile()` rather than calling `fs.promises.readFile`
 * directly. The helper guarantees:
 *
 *   1. The source path is resolved via `resolveSyncedPath()` so only
 *      paths inside one of the character's synced folders reach the
 *      filesystem. Path containment uses the hardened BA-1 check in
 *      `isPathAllowed()` (realpath walks up the first existing ancestor
 *      and refuses to compare unresolved strings).
 *   2. A structured error with a stable `code` surfaces on every
 *      failure mode. Callers map these into agent-facing envelopes
 *      without parsing human-readable messages.
 *   3. A size cap is enforced BEFORE the read, so a pathological file
 *      cannot exhaust process memory before the caller sees an error.
 *
 * Do NOT add a second read helper — extend this one if a new caller
 * needs a different behavior flag (e.g. binary reads, streaming). One
 * entry point keeps the containment invariant auditable.
 */

import { stat, readFile } from "fs/promises";
import { resolveSyncedPath } from "./path-utils";

/** Hard cap for synced-folder reads (5 MiB). Matches the BA-4 spec. */
const READ_SYNCED_FILE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Stable error codes for `readSyncedFile()`. Callers SHOULD map these
 * 1:1 into tool-result envelopes so the agent can decide how to
 * recover without inspecting the human-readable message.
 */
export type ReadSyncedFileErrorCode =
  | "PATH_NOT_ALLOWED"
  | "FILE_NOT_FOUND"
  | "FILE_TOO_LARGE"
  | "READ_FAILED";

/**
 * Structured error emitted by `readSyncedFile()`. The thrown error
 * carries a stable `code`, the user-supplied `sourcePath` (NOT the
 * resolved absolute path — that lives on `resolvedPath` when known),
 * and for `FILE_TOO_LARGE` the observed `bytes` / enforced `limit`.
 */
class ReadSyncedFileError extends Error {
  readonly code: ReadSyncedFileErrorCode;
  readonly sourcePath: string;
  readonly resolvedPath?: string;
  readonly bytes?: number;
  readonly limit?: number;

  constructor(
    code: ReadSyncedFileErrorCode,
    sourcePath: string,
    message: string,
    extras: { resolvedPath?: string; bytes?: number; limit?: number } = {},
  ) {
    super(message);
    this.name = "ReadSyncedFileError";
    this.code = code;
    this.sourcePath = sourcePath;
    this.resolvedPath = extras.resolvedPath;
    this.bytes = extras.bytes;
    this.limit = extras.limit;
  }
}

/**
 * Type guard — preferred over `instanceof` because vitest `vi.mock()`
 * boundaries occasionally replay a different prototype chain when
 * thrown across module/test boundaries.
 */
export function isReadSyncedFileError(
  value: unknown,
): value is ReadSyncedFileError {
  if (!value || typeof value !== "object") return false;
  return (value as { name?: unknown }).name === "ReadSyncedFileError";
}

export interface ReadSyncedFileResult {
  /** The file contents decoded as UTF-8. */
  content: string;
  /** The realpathed absolute path the contents were read from. */
  resolvedPath: string;
  /** Byte count of the on-disk file (matches `Buffer.byteLength(content, "utf-8")`). */
  bytes: number;
  /**
   * Modification-time milliseconds captured by the SAME pre-read `stat()` that
   * gates the size check. Surfaced so callers never need a second `stat()`
   * round-trip after the content read — critical for the port action's CAS
   * path, where any intervening filesystem hop between the hash comparison
   * and `atomicWriteFile()` re-opens the TOCTOU race the hash was meant to
   * close.
   */
  mtimeMs: number;
}

/**
 * Read a file from within one of a character's synced folders.
 *
 * @param characterId   Agent character scope — drives `resolveSyncedPath()`.
 * @param sessionId     Session scope — lets the resolver prefer the
 *                      active worktree when one is set on the session.
 * @param sourcePath    Absolute or synced-folder-relative path.
 *
 * @throws {ReadSyncedFileError} with a stable `code` (PATH_NOT_ALLOWED,
 * FILE_NOT_FOUND, FILE_TOO_LARGE, READ_FAILED) for every failure mode.
 */
export async function readSyncedFile(args: {
  characterId: string;
  sessionId: string;
  sourcePath: string;
}): Promise<ReadSyncedFileResult> {
  const { characterId, sessionId, sourcePath } = args;

  // 1. Path containment — reuses the BA-1-hardened check inside
  //    `resolveSyncedPath()` which delegates to `isPathAllowed()`.
  const resolved = await resolveSyncedPath(sourcePath, characterId, sessionId);
  if (!resolved.ok) {
    throw new ReadSyncedFileError(
      "PATH_NOT_ALLOWED",
      sourcePath,
      resolved.error,
    );
  }
  const resolvedPath = resolved.validPath;

  // 2. Pre-read size probe — enforce the cap BEFORE the read so a huge
  //    file never reaches our buffer. Capture `mtimeMs` from the SAME stat
  //    call so callers (notably the port-action CAS path) don't need a
  //    follow-up `fs.stat` after the content read; any post-read async hop
  //    would reintroduce the race window the caller's hash compare is
  //    meant to close.
  let bytes: number;
  let mtimeMs: number;
  try {
    const s = await stat(resolvedPath);
    if (!s.isFile()) {
      throw new ReadSyncedFileError(
        "FILE_NOT_FOUND",
        sourcePath,
        `Source path "${sourcePath}" is not a regular file.`,
        { resolvedPath },
      );
    }
    bytes = s.size;
    mtimeMs = s.mtimeMs;
  } catch (error) {
    if (isReadSyncedFileError(error)) throw error;
    const err = error as NodeJS.ErrnoException | null;
    if (err?.code === "ENOENT") {
      throw new ReadSyncedFileError(
        "FILE_NOT_FOUND",
        sourcePath,
        `Source file "${sourcePath}" not found.`,
        { resolvedPath },
      );
    }
    throw new ReadSyncedFileError(
      "READ_FAILED",
      sourcePath,
      `Failed to stat "${sourcePath}": ${err?.message ?? "unknown error"}`,
      { resolvedPath },
    );
  }

  if (bytes > READ_SYNCED_FILE_MAX_BYTES) {
    throw new ReadSyncedFileError(
      "FILE_TOO_LARGE",
      sourcePath,
      `Source file "${sourcePath}" is ${bytes} bytes — exceeds the ${READ_SYNCED_FILE_MAX_BYTES}-byte limit.`,
      { resolvedPath, bytes, limit: READ_SYNCED_FILE_MAX_BYTES },
    );
  }

  // 3. Actual read. Any error here (missing file between stat + read,
  //    permission denied, EIO) surfaces as READ_FAILED with the
  //    underlying message preserved for debugging.
  let content: string;
  try {
    content = await readFile(resolvedPath, "utf-8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException | null;
    if (err?.code === "ENOENT") {
      throw new ReadSyncedFileError(
        "FILE_NOT_FOUND",
        sourcePath,
        `Source file "${sourcePath}" disappeared between stat and read.`,
        { resolvedPath },
      );
    }
    throw new ReadSyncedFileError(
      "READ_FAILED",
      sourcePath,
      `Failed to read "${sourcePath}": ${err?.message ?? "unknown error"}`,
      { resolvedPath },
    );
  }

  return { content, resolvedPath, bytes, mtimeMs };
}

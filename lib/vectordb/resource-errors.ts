/**
 * Resource-limit error classification shared by vector sync discovery and
 * file watching. Node may expose these failures through `error.code` or only
 * through a wrapped message, so both forms are handled.
 */

const FILE_DESCRIPTOR_ERROR_CODES = new Set(["EMFILE", "ENFILE"]);
const WATCHER_RESOURCE_ERROR_CODES = new Set([
  ...FILE_DESCRIPTOR_ERROR_CODES,
  "EBADF",
  "ENOSPC",
]);

const FILE_DESCRIPTOR_ERROR_MESSAGE = /\b(EMFILE|ENFILE)\b|too many open files|file table overflow/i;
const WATCHER_RESOURCE_ERROR_MESSAGE =
  /\b(EMFILE|ENFILE|EBADF|ENOSPC)\b|too many open files|file table overflow|system limit for number of file watchers reached/i;

interface ErrorLike {
  code?: unknown;
  message?: unknown;
}

export function getResourceErrorCode(error: unknown): string | null {
  if (error && typeof error === "object") {
    const code = (error as ErrorLike).code;
    if (typeof code === "string" && code.trim()) {
      return code.toUpperCase();
    }
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  const match = message.match(/\b(EMFILE|ENFILE|EBADF|ENOSPC)\b/i);
  return match?.[1]?.toUpperCase() ?? null;
}

export function isFileDescriptorLimitError(error: unknown): boolean {
  const code = getResourceErrorCode(error);
  if (code && FILE_DESCRIPTOR_ERROR_CODES.has(code)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  return FILE_DESCRIPTOR_ERROR_MESSAGE.test(message);
}

export function isWatcherResourceLimitError(error: unknown): boolean {
  const code = getResourceErrorCode(error);
  if (code && WATCHER_RESOURCE_ERROR_CODES.has(code)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  return WATCHER_RESOURCE_ERROR_MESSAGE.test(message);
}

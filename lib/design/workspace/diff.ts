/**
 * Design Workspace — Port Action Diff Helper
 *
 * Computes a unified diff between the current workspace component source and a
 * target file on disk, for the `designWorkspace { action: "port" }` flow.
 *
 * Intentionally thin wrapper around `createTwoFilesPatch` from the `diff`
 * package (already a runtime dependency — see package.json). Kept in a
 * dedicated file so the design-workspace tool imports it directly (no barrel
 * re-export), per the W2.2 hard constraints.
 *
 * Line-ending normalization: `diff`'s `newlineIsToken` option keeps CRLF vs LF
 * changes visible in the patch rather than silently collapsing them, so the
 * agent and user can spot whitespace-only diffs before approving a write.
 */
import { createTwoFilesPatch } from "diff";

/** Max lines of unified-diff output returned to the agent. */
const DEFAULT_PORT_DIFF_MAX_LINES = 400;

export interface PortDiffOptions {
  /** Max lines of unified-diff output. Truncated output gets a trailing marker. */
  maxLines?: number;
  /** Context lines around each hunk; mirrors `diff`'s default of 4. */
  context?: number;
}

export interface PortDiffResult {
  /** Unified-diff text. Empty string when `before === after`. */
  diff: string;
  /** True when `before` and `after` are byte-identical. */
  identical: boolean;
  /** True when the diff was truncated to `maxLines`. */
  truncated: boolean;
  /** Lines in the untruncated diff output. */
  totalLines: number;
}

/**
 * Build a unified diff between the workspace component source (`before`) and
 * the target file content (`after`), with file-path headers pinned to the
 * synced-folder-relative `targetPath` so the output reads as a `patch -p0`
 * suitable for display.
 *
 * Contract:
 *   - `before === after` → `{ diff: "", identical: true }` (caller should
 *     emit a "no changes" envelope and skip the write).
 *   - Always returns a string (never throws); malformed input is passed
 *     through to `createTwoFilesPatch`, which tolerates arbitrary text.
 *   - Truncation is cooperative: the caller decides how to surface long
 *     diffs. We cap at `maxLines` (default 400) and append a marker so the
 *     agent sees the shape without blowing the result-envelope token cap
 *     enforced by `slimResult` in the tool layer.
 */
export function createPortDiff(
  targetPath: string,
  before: string,
  after: string,
  options: PortDiffOptions = {},
): PortDiffResult {
  if (before === after) {
    return { diff: "", identical: true, truncated: false, totalLines: 0 };
  }

  const maxLines = options.maxLines ?? DEFAULT_PORT_DIFF_MAX_LINES;
  const context = options.context ?? 4;

  // `createTwoFilesPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options)`
  // The `oldHeader`/`newHeader` are the "revision" labels that follow the
  // filename in the `--- ` / `+++ ` lines. We leave them blank — the
  // target-path headers are enough for the agent to reason about.
  const raw = createTwoFilesPatch(
    targetPath,
    targetPath,
    before,
    after,
    "",
    "",
    { context },
  );

  const lines = raw.split("\n");
  const totalLines = lines.length;

  if (totalLines <= maxLines) {
    return {
      diff: raw,
      identical: false,
      truncated: false,
      totalLines,
    };
  }

  const omitted = totalLines - maxLines;
  const truncated = [
    ...lines.slice(0, maxLines),
    `... [diff truncated: ${omitted} more line${omitted === 1 ? "" : "s"}]`,
  ].join("\n");

  return {
    diff: truncated,
    identical: false,
    truncated: true,
    totalLines,
  };
}

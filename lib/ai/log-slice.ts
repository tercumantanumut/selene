/**
 * Log Slice Helpers
 *
 * Shared implementation of range-first slicing used by both
 * executeCommand({command:"readLog"}) and retrieveFullContent.
 *
 * Each call is capped at PER_CALL_TOKEN_BUDGET so a single retrieval cannot
 * re-inflate context by dumping the full log back.
 */

const CHARS_PER_TOKEN = 4;
export const PER_CALL_TOKEN_BUDGET = 8_000;
export const PER_CALL_CHAR_BUDGET = PER_CALL_TOKEN_BUDGET * CHARS_PER_TOKEN;

export const DEFAULT_HEAD_LINES = 200;
export const MAX_HEAD_TAIL_LINES = 5_000;
export const MAX_GREP_MATCHES = 200;
export const GREP_CONTEXT_LINES = 2;

export interface LogSliceInput {
  head?: number;
  tail?: number;
  range?: [number, number] | number[];
  grep?: string;
}

export interface LogSliceResult {
  /** The sliced content (already hard-capped to PER_CALL_CHAR_BUDGET). */
  content: string;
  /** Total number of lines in the source log. */
  totalLines: number;
  /** Which slicing mode was applied. */
  mode: "head" | "tail" | "range" | "grep" | "default";
  /** Mode-specific metadata for the caller to echo back to the model. */
  meta: {
    /** Head/tail/range bounds actually applied after clamping. */
    fromLine?: number;
    toLine?: number;
    /** Number of grep matches found (grep mode). */
    matchCount?: number;
    /** True when output was further clamped to the per-call budget. */
    budgetClamped?: boolean;
    /** Short explanation if the mode decision fell back to default. */
    note?: string;
  };
}

function clampBudget(text: string): { content: string; clamped: boolean } {
  if (text.length <= PER_CALL_CHAR_BUDGET) return { content: text, clamped: false };
  // Snap to the nearest newline so we don't mid-cut a line.
  const slice = text.slice(0, PER_CALL_CHAR_BUDGET);
  const snap = slice.lastIndexOf("\n");
  const content =
    snap > PER_CALL_CHAR_BUDGET * 0.5 ? slice.slice(0, snap) : slice;
  const omittedChars = text.length - content.length;
  return {
    content:
      content +
      `\n\n... [SLICE CLAMPED to ~${PER_CALL_TOKEN_BUDGET.toLocaleString()} tokens; ~${omittedChars.toLocaleString()} chars dropped from the tail of this slice. Request a narrower line range.] ...`,
    clamped: true,
  };
}

function sliceHead(lines: string[], n: number): LogSliceResult {
  const cap = Math.max(1, Math.min(n, MAX_HEAD_TAIL_LINES));
  const joined = lines.slice(0, cap).join("\n");
  const { content, clamped } = clampBudget(joined);
  return {
    content,
    totalLines: lines.length,
    mode: "head",
    meta: { fromLine: 1, toLine: Math.min(cap, lines.length), budgetClamped: clamped },
  };
}

function sliceTail(lines: string[], n: number): LogSliceResult {
  const cap = Math.max(1, Math.min(n, MAX_HEAD_TAIL_LINES));
  const start = Math.max(0, lines.length - cap);
  const joined = lines.slice(start).join("\n");
  const { content, clamped } = clampBudget(joined);
  return {
    content,
    totalLines: lines.length,
    mode: "tail",
    meta: { fromLine: start + 1, toLine: lines.length, budgetClamped: clamped },
  };
}

function sliceRange(lines: string[], start: number, end: number): LogSliceResult {
  // 1-indexed inclusive range.
  const from = Math.max(1, Math.floor(start));
  const to = Math.max(from, Math.min(Math.floor(end), lines.length));
  const joined = lines.slice(from - 1, to).join("\n");
  const { content, clamped } = clampBudget(joined);
  return {
    content,
    totalLines: lines.length,
    mode: "range",
    meta: { fromLine: from, toLine: to, budgetClamped: clamped },
  };
}

function grep(lines: string[], pattern: string): LogSliceResult {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    // Fall back to literal substring on invalid regex.
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped);
  }

  // Collect matching line indices.
  const matchIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matchIdxs.push(i);
      if (matchIdxs.length >= MAX_GREP_MATCHES) break;
    }
  }

  if (matchIdxs.length === 0) {
    return {
      content: `(no matches for pattern /${pattern}/)`,
      totalLines: lines.length,
      mode: "grep",
      meta: { matchCount: 0 },
    };
  }

  // Expand around each match by GREP_CONTEXT_LINES and merge overlapping windows.
  const windows: Array<[number, number]> = [];
  for (const idx of matchIdxs) {
    const lo = Math.max(0, idx - GREP_CONTEXT_LINES);
    const hi = Math.min(lines.length - 1, idx + GREP_CONTEXT_LINES);
    const last = windows[windows.length - 1];
    if (last && lo <= last[1] + 1) {
      last[1] = Math.max(last[1], hi);
    } else {
      windows.push([lo, hi]);
    }
  }

  const blocks: string[] = [];
  for (const [lo, hi] of windows) {
    const block = lines
      .slice(lo, hi + 1)
      .map((line, i) => {
        const lineNo = lo + i + 1;
        const hit = regex.test(line);
        return `${lineNo.toString().padStart(6)}${hit ? ":" : "-"} ${line}`;
      })
      .join("\n");
    blocks.push(block);
  }

  const joined = blocks.join("\n--\n");
  const { content, clamped } = clampBudget(joined);
  return {
    content,
    totalLines: lines.length,
    mode: "grep",
    meta: { matchCount: matchIdxs.length, budgetClamped: clamped },
  };
}

/**
 * Apply a slicing operation to raw log text.
 *
 * Precedence:
 *   range > legacy head > legacy tail > legacy grep > default(first DEFAULT_HEAD_LINES)
 *
 * Each mode is hard-capped to PER_CALL_TOKEN_BUDGET.
 */
export function sliceLogText(text: string, input: LogSliceInput): LogSliceResult {
  const lines = (text ?? "").split("\n");

  if (Array.isArray(input.range) && input.range.length === 2) {
    const [s, e] = input.range;
    if (
      Number.isFinite(s) &&
      Number.isFinite(e) &&
      (s as number) > 0 &&
      (e as number) > 0
    ) {
      return sliceRange(lines, s as number, e as number);
    }
  }

  if (typeof input.head === "number" && input.head > 0) {
    return sliceHead(lines, input.head);
  }

  if (typeof input.tail === "number" && input.tail > 0) {
    return sliceTail(lines, input.tail);
  }

  if (input.grep && input.grep.trim().length > 0) {
    return grep(lines, input.grep);
  }

  // Default: give the model a sensible head preview instead of the whole file.
  const result = sliceHead(lines, DEFAULT_HEAD_LINES);
  result.mode = "default";
  result.meta.note = `No valid range given — showing first ${DEFAULT_HEAD_LINES} lines. Use range: [startLine, endLine] for targeted reads.`;
  return result;
}

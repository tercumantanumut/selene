/**
 * Output Stub Builder
 *
 * Produces compact, retrieval-oriented stubs that replace oversized tool
 * outputs. A stub tells the model:
 *   - How big the original output was
 *   - Which retrieval ID to use (logId or contentId)
 *   - A short structural outline (line count, format, first/last line, …)
 *   - Optional head preview (for mid-tier outputs)
 *   - Ready-to-copy readLog / retrieveFullContent invocations
 *
 * The format is intentionally deterministic so the model can rely on the
 * shape when deciding whether it needs to follow up with a retrieval call.
 */

// Keep this local to avoid a circular import with output-limiter.
// Must match the value there (4 chars/token heuristic).
const CHARS_PER_TOKEN = 4;

export type RetrievalIdType = "logId" | "contentId";

export interface OutlineInfo {
  lineCount: number;
  byteLength: number;
  estimatedTokens: number;
  format: "text" | "json" | "empty";
  firstLine?: string;
  lastLine?: string;
  /** Top-level JSON keys if the content is JSON. Up to 10. */
  topLevelKeys?: string[];
  /** Rough stderr line count if the upstream object had a separate stderr field. */
  stderrLineCount?: number;
}

export interface BuildStubOptions {
  /** Tool name (for labelling the stub) */
  toolName: string;
  /** The full primary text of the original tool result */
  originalText: string;
  /** Precomputed outline; if omitted, will be derived from originalText */
  outline?: OutlineInfo;
  /** Retrieval ID (logId or contentId) */
  retrievalId?: string;
  /** Which retrieval tool pairs with the ID */
  idType?: RetrievalIdType;
  /** How many tokens of head preview to include. 0 = no preview. */
  previewTokens?: number;
  /** Optional extra stderr text length hint (used by executeCommand) */
  stderr?: string;
  /**
   * Whether the retrieval tool needed for this stub is currently loaded in the
   * model's active tool set. `executeCommand` can be discovered later for logId
   * retrieval, but a session-local contentId is only advertised when
   * retrieveFullContent is already loaded for the same turn.
   */
  retrievalToolLoaded?: boolean;
}

/** Rough estimate of tokens for an arbitrary string. */
function tokensOf(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function firstNonEmptyLine(text: string): string | undefined {
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.trim().length > 0) {
      return line.length > 200 ? line.slice(0, 200) + "…" : line;
    }
  }
  return undefined;
}

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim().length > 0) {
      return line.length > 200 ? line.slice(0, 200) + "…" : line;
    }
  }
  return undefined;
}

/**
 * Derive a structural outline from the raw text.
 * Cheap — safe to call on 500K char outputs (single pass).
 */
export function deriveOutline(
  text: string,
  opts: { stderr?: string } = {}
): OutlineInfo {
  const byteLength = text.length;
  if (!text) {
    return {
      lineCount: 0,
      byteLength: 0,
      estimatedTokens: 0,
      format: "empty",
    };
  }

  // Count lines without allocating a full split when possible
  let lineCount = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) lineCount++;
  }

  const parsed = tryParseJson(text);
  let topLevelKeys: string[] | undefined;
  let format: OutlineInfo["format"] = "text";
  if (parsed !== undefined) {
    format = "json";
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      topLevelKeys = Object.keys(parsed as Record<string, unknown>).slice(0, 10);
    } else if (Array.isArray(parsed)) {
      topLevelKeys = [`array[${parsed.length}]`];
    }
  }

  let stderrLineCount: number | undefined;
  if (opts.stderr) {
    stderrLineCount = 0;
    for (let i = 0; i < opts.stderr.length; i++) {
      if (opts.stderr.charCodeAt(i) === 10) stderrLineCount++;
    }
    if (opts.stderr.length > 0) stderrLineCount += 1;
  }

  return {
    lineCount,
    byteLength,
    estimatedTokens: tokensOf(text),
    format,
    firstLine: firstNonEmptyLine(text),
    lastLine: lastNonEmptyLine(text),
    topLevelKeys,
    stderrLineCount,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10}K chars`;
  return `${Math.round(n / 1024 / 102.4) / 10}M chars`;
}

function headPreview(text: string, previewTokens: number): string {
  if (previewTokens <= 0) return "";
  const budget = previewTokens * CHARS_PER_TOKEN;
  if (text.length <= budget) return text;
  // Snap to the last full line inside budget so we don't cut mid-token.
  const sliced = text.slice(0, budget);
  const snap = sliced.lastIndexOf("\n");
  return snap > budget * 0.5 ? sliced.slice(0, snap) : sliced;
}

function retrievalCall(
  idType: RetrievalIdType,
  id: string,
  range: [number, number]
): string {
  const extras = `range: [${range[0]}, ${range[1]}]`;
  if (idType === "logId") {
    return `executeCommand({ command: "readLog", logId: "${id}", ${extras} })`;
  }
  return `retrieveFullContent({ contentId: "${id}", ${extras} })`;
}

/**
 * Build the stub string that replaces an oversized tool output.
 */
export function buildOutputStub(opts: BuildStubOptions): string {
  const {
    toolName,
    originalText,
    retrievalId,
    idType = "contentId",
    previewTokens = 0,
    stderr,
    retrievalToolLoaded = true,
  } = opts;

  const outline = opts.outline ?? deriveOutline(originalText, { stderr });

  const tokensLabel = `~${outline.estimatedTokens.toLocaleString()} tokens`;
  const bytesLabel = formatBytes(outline.byteLength);
  const linesLabel = `${outline.lineCount.toLocaleString()} lines`;
  const idLabel = retrievalId ? `, ${idType}=${retrievalId}` : "";

  const header = `[STUB: tool=${toolName}, ${tokensLabel}, ${bytesLabel}, ${linesLabel}${idLabel}]`;

  const parts: string[] = [header];

  // Preview section (only for mid-tier outputs)
  if (previewTokens > 0) {
    const preview = headPreview(originalText, previewTokens);
    if (preview) {
      parts.push("");
      parts.push(`Preview (first ~${previewTokens.toLocaleString()} tokens):`);
      parts.push(preview);
      parts.push("...");
    }
  }

  // Outline section
  parts.push("");
  parts.push("Outline:");
  parts.push(`- Lines: ${outline.lineCount.toLocaleString()}`);
  parts.push(`- Format: ${outline.format === "json" ? "JSON" : outline.format === "empty" ? "empty" : "text (not JSON)"}`);
  if (outline.topLevelKeys && outline.topLevelKeys.length > 0) {
    parts.push(`- Top-level keys: ${outline.topLevelKeys.join(", ")}`);
  }
  if (outline.firstLine) {
    parts.push(`- First line: ${JSON.stringify(outline.firstLine)}`);
  }
  if (outline.lastLine && outline.lastLine !== outline.firstLine) {
    parts.push(`- Last line: ${JSON.stringify(outline.lastLine)}`);
  }
  if (outline.stderrLineCount !== undefined && outline.stderrLineCount > 0) {
    parts.push(`- Stderr present: yes (~${outline.stderrLineCount.toLocaleString()} lines)`);
  }

  // Retrieval section
  if (retrievalId) {
    parts.push("");
    parts.push("Retrieval:");

    if (idType === "contentId") {
      if (retrievalToolLoaded) {
        const suggestedEnd = Math.max(1, Math.min(outline.lineCount, 200));
        parts.push(`Retrieve lines: ${retrievalCall(idType, retrievalId, [1, suggestedEnd])}`);
        parts.push("Change the two line numbers to read another slice.");
      } else {
        parts.push("retrieveFullContent is not currently loaded, so this contentId is not safely retrievable from this turn.");
        parts.push("Use the outline/preview here, or re-run the original tool call with a smaller range/filter.");
      }
    } else {
      if (!retrievalToolLoaded) {
        parts.push('First load: searchTools({ query: "select:executeCommand" })');
      }

      const suggestedEnd = Math.max(1, Math.min(outline.lineCount, 200));
      parts.push(`Retrieve lines: ${retrievalCall(idType, retrievalId, [1, suggestedEnd])}`);
      parts.push("Change the two line numbers to read another slice.");
    }
  } else {
    parts.push("");
    parts.push("Full output NOT stored (no retrieval ID available). Re-run with a smaller/filtered command if needed.");
  }

  return parts.join("\n");
}

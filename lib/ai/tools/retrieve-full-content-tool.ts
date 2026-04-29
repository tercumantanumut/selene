import { tool, jsonSchema } from "ai";
import { withToolLogging } from "@/lib/ai/tool-registry/logging";
import { retrieveFullContent as getFullContent, listStoredContent } from "@/lib/ai/truncated-content-store";
import { sliceLogText } from "@/lib/ai/log-slice";
import { recordRetrieval } from "@/lib/ai/output-stub-telemetry";

// ==========================================================================
// Retrieve Full Content Tool
// ==========================================================================
// Allows the model to fetch previously-stored truncated content. Retrieval is
// documented as a line range, while legacy head/tail/grep fields remain
// tolerated for backward compatibility. Every call is hard-capped to ~8K tokens
// so a single retrieval can't re-inflate context.

interface RetrieveFullContentArgs {
  contentId: string;
  head?: number;
  tail?: number;
  range?: [number, number] | number[];
  grep?: string;
}

const retrieveFullContentSchema = jsonSchema<RetrieveFullContentArgs>({
  type: "object",
  title: "RetrieveFullContentInput",
  description:
    "Fetch a bounded slice of previously-truncated content by its contentId.",
  properties: {
    contentId: {
      type: "string",
      description:
        "The reference ID of the truncated content to retrieve (format: trunc_XXXXXXXX). This ID appears in the stub returned alongside oversized tool output.",
    },
    range: {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
      description:
        "1-indexed inclusive [startLine, endLine] line range. Example: [400, 500].",
    },
    // Legacy fields remain accepted so old saved tool calls and UI defaults do not fail,
    // but they are intentionally not described to agents.
    head: { type: "number" },
    tail: { type: "number" },
    grep: { type: "string" },
  },
  required: ["contentId"],
  additionalProperties: false,
});

interface RetrieveFullContentToolOptions {
  /** Current session ID for retrieving content */
  sessionId: string;
}

/**
 * Core retrieveFullContent execution logic.
 * Exported for unit-testing; consumers should use createRetrieveFullContentTool().
 */
function normalizePositiveLineCount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeLineRange(value: RetrieveFullContentArgs["range"]): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }

  const [rawStart, rawEnd] = value;
  if (
    typeof rawStart !== "number" ||
    typeof rawEnd !== "number" ||
    !Number.isFinite(rawStart) ||
    !Number.isFinite(rawEnd)
  ) {
    return undefined;
  }

  const start = Math.floor(rawStart);
  const end = Math.floor(rawEnd);
  if (start <= 0 || end <= 0) {
    return undefined;
  }

  return [start, end];
}

function normalizeGrep(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export async function executeRetrieveFullContent(
  options: RetrieveFullContentToolOptions,
  args: RetrieveFullContentArgs
) {
  const { sessionId } = options;
  const { contentId } = args;
  const head = normalizePositiveLineCount(args.head);
  const tail = normalizePositiveLineCount(args.tail);
  const range = normalizeLineRange(args.range);
  const grep = normalizeGrep(args.grep);

  const entry = getFullContent(sessionId, contentId);

  if (!entry) {
    const storedContent = listStoredContent(sessionId);
    const available = storedContent.map((c) => ({
      id: c.id,
      context: c.context,
      fullLength: c.fullLength,
    }));
    // Build a strongly-worded message so the model immediately latches onto
    // the real IDs rather than guessing (trunc_1, trunc_2, …). Previously
    // the model burned 2 retries before reading `availableContentIds`.
    let message: string;
    if (available.length === 0) {
      message =
        `Content with ID "${contentId}" was not found and there is no other stored content in this session. ` +
        `It may have expired (TTL: 1 hour) or the server restarted. ` +
        `Re-run the original tool call that produced this content instead of retrying retrieveFullContent.`;
    } else {
      const idList = available
        .map((c) => `  - ${c.id} (${c.context}, ${c.fullLength.toLocaleString()} chars)`)
        .join("\n");
      message =
        `Content with ID "${contentId}" was not found. ` +
        `DO NOT guess IDs. Use ONE of the following available contentIds from THIS session:\n${idList}\n` +
        `If none match the content you need, re-run the original tool call. ` +
        `The contentId you tried may have expired (TTL: 1 hour) or been evicted.`;
    }
    return {
      status: "not_found",
      contentId,
      message,
      availableContentIds: available,
    };
  }

  const slice = sliceLogText(entry.fullContent, {
    head,
    tail,
    range: Array.isArray(range) ? (range as [number, number]) : undefined,
    grep,
  });

  recordRetrieval({
    retrievalId: entry.id,
    retrievalIdType: "contentId",
    sliceMode: slice.mode,
    sliceParams: {
      ...(head !== undefined ? { head } : {}),
      ...(tail !== undefined ? { tail } : {}),
      ...(range !== undefined ? { range } : {}),
      ...(grep !== undefined ? { grep } : {}),
      ...(slice.meta.matchCount !== undefined
        ? { matches: slice.meta.matchCount }
        : {}),
    },
    returnedTokens: Math.ceil(slice.content.length / 4),
    budgetHit: slice.meta.budgetClamped === true,
  });

  const metaBits: string[] = [];
  if (slice.meta.fromLine !== undefined && slice.meta.toLine !== undefined) {
    metaBits.push(`lines ${slice.meta.fromLine}–${slice.meta.toLine} of ${slice.totalLines}`);
  }
  if (slice.meta.matchCount !== undefined) {
    metaBits.push(`${slice.meta.matchCount} match${slice.meta.matchCount === 1 ? "" : "es"}`);
  }
  if (slice.meta.budgetClamped) {
    metaBits.push("budget-clamped");
  }
  const metaLabel = metaBits.length > 0 ? ` (${metaBits.join(", ")})` : "";
  const modeLabel = slice.mode === "default" ? "default range preview" : slice.mode;

  return {
    status: "success",
    contentId: entry.id,
    context: entry.context,
    fullLength: entry.fullLength,
    totalLines: slice.totalLines,
    mode: slice.mode,
    content: slice.content,
    isTruncated: slice.meta.budgetClamped === true,
    message: `retrieveFullContent '${entry.id}' — mode=${modeLabel}${metaLabel}.${
      slice.meta.note ? " " + slice.meta.note : ""
    }`,
  };
}

export function createRetrieveFullContentTool(options: RetrieveFullContentToolOptions) {
  const { sessionId } = options;

  const executeWithLogging = withToolLogging(
    "retrieveFullContent",
    sessionId,
    (args: RetrieveFullContentArgs) => executeRetrieveFullContent(options, args)
  );

  return tool({
    description: `Retrieve a bounded slice of previously-truncated content.

**When to use:**
- You see a stub like "[STUB: tool=..., contentId=trunc_XXXXXXXX]" in a prior tool result and need part of the original content.

**When NOT to use:**
- ❌ Reading file contents (use readFile instead)
- ❌ Getting full file paths (use localGrep or vectorSearch)
- ❌ Any contentId that doesn't start with "trunc_"

**Retrieval policy:**
- Use \`range: [startLine, endLine]\` to read a bounded line slice.
- Each call is hard-capped at ~8K tokens; use another range for the next chunk.
- If no valid range is provided, the tool returns the first 200 lines.

**Parameters:**
- contentId (required) — the trunc_XXXXXXXX id from a stub
- range: [startLine, endLine] — 1-indexed inclusive line range`,
    inputSchema: retrieveFullContentSchema,
    execute: executeWithLogging,
  });
}

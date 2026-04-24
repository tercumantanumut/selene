import { estimateTokens } from "@/lib/ai/output-limiter";
import { buildOutputStub, deriveOutline } from "@/lib/ai/output-stub";
import { recordTier, type OutputTier } from "@/lib/ai/output-stub-telemetry";
import { storeFullContent } from "@/lib/ai/truncated-content-store";

// ============================================================================
// Tier thresholds (original output tokens)
// ============================================================================
// Outputs ≤ INLINE_PASSTHROUGH_TOKENS: pass through verbatim.
// INLINE_PASSTHROUGH_TOKENS < output ≤ PREVIEW_TIER_TOKENS: stub + small head preview.
// Outputs > PREVIEW_TIER_TOKENS: stub only (outline + retrieval, no preview).
export const INLINE_PASSTHROUGH_TOKENS = 10_000;
export const PREVIEW_TIER_TOKENS = 25_000;
/** Tokens of head preview included in the mid-tier stub. */
export const MID_TIER_PREVIEW_TOKENS = 1_500;

export const MIN_STREAM_TOOL_RESULT_TOKENS = 1;
export const MAX_STREAM_TOOL_RESULT_TOKENS = 25_000;

interface GuardToolResultForStreamingResult {
  blocked: boolean;
  estimatedTokens: number;
  result: unknown;
}

interface GuardToolResultForStreamingOptions {
  /** Historical option retained for callers; no longer drives tier thresholds. */
  maxTokens?: number;
  metadata?: Record<string, unknown>;
  /** Session ID used to store full content when the tool didn't already provide one. */
  sessionId?: string;
  /** Optional tool-call ID, surfaced in telemetry for correlation. */
  toolCallId?: string;
  /**
   * Live set of initially-loaded (non-deferred) tool names.
   * Used to determine whether the retrieval tool referenced by a stub
   * (executeCommand for logId, retrieveFullContent for contentId) is
   * available to the model or needs a searchTools step-0 first.
   */
  initialActiveTools?: Set<string>;
  /**
   * Live mutable set of tools discovered via searchTools during this request.
   * Mutated as the model discovers tools, so the guard always sees current state.
   */
  discoveredTools?: Set<string>;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function estimateTokensSafely(content: unknown): number {
  try {
    return estimateTokens(content);
  } catch {
    const fallback = typeof content === "string" ? content : safeStringify(content);
    return Math.ceil(fallback.length / 4);
  }
}

function extractRetrievalIds(result: unknown): {
  logId?: string;
  truncatedContentId?: string;
} {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {};
  }

  const record = result as Record<string, unknown>;
  const logId = typeof record.logId === "string" ? record.logId : undefined;
  const truncatedContentId =
    typeof record.truncatedContentId === "string" ? record.truncatedContentId : undefined;

  return { logId, truncatedContentId };
}

/**
 * Pull the "primary" text from a tool result for outline / preview purposes.
 * Mirrors the fields known to carry human-readable output across our tool surface.
 */
function extractPrimaryText(result: unknown): { text: string; stderr?: string } {
  if (typeof result === "string") return { text: result };
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { text: safeStringify(result) };
  }

  const obj = result as Record<string, unknown>;

  if (typeof obj.stdout === "string" || typeof obj.stderr === "string") {
    const stdout = typeof obj.stdout === "string" ? obj.stdout : "";
    const stderr = typeof obj.stderr === "string" ? obj.stderr : undefined;
    // Combine for outline/preview purposes — stdout first, then stderr.
    const combined = stderr ? `${stdout}\n${stderr}` : stdout;
    return { text: combined, stderr };
  }

  if (Array.isArray(obj.content)) {
    const textItems: string[] = [];
    for (const item of obj.content as unknown[]) {
      if (item && typeof item === "object" && "type" in (item as object)) {
        const i = item as Record<string, unknown>;
        if (i.type === "text" && typeof i.text === "string") textItems.push(i.text);
      }
    }
    if (textItems.length > 0) return { text: textItems.join("\n") };
  }

  for (const field of ["content", "text", "result", "results", "output", "summary", "markdown"] as const) {
    const value = obj[field];
    if (typeof value === "string") return { text: value };
  }

  return { text: safeStringify(result) };
}

/**
 * Replace the primary text of a tool result with the given stub string.
 * Preserves the surrounding result structure (exit codes, logId, status, …)
 * so downstream consumers (UI, loop guards) continue to work.
 */
function replacePrimaryText(result: unknown, stub: string): unknown {
  if (typeof result === "string") return stub;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return stub;
  }

  const obj = { ...(result as Record<string, unknown>) };

  if (typeof obj.stdout === "string" || typeof obj.stderr === "string") {
    obj.stdout = stub;
    // Stderr already summarised in the outline; drop its body to avoid duplication.
    if (typeof obj.stderr === "string" && obj.stderr.length > 0) {
      obj.stderr = "";
    }
    obj.isTruncated = true;
    return obj;
  }

  if (Array.isArray(obj.content)) {
    const items = obj.content as unknown[];
    let replacedOnce = false;
    obj.content = items.map((item) => {
      if (
        !replacedOnce &&
        item && typeof item === "object" &&
        (item as Record<string, unknown>).type === "text"
      ) {
        replacedOnce = true;
        return { ...(item as Record<string, unknown>), text: stub };
      }
      // Drop further text items so the stub doesn't get duplicated and
      // subsequent large text chunks don't blow the budget.
      if (item && typeof item === "object" && (item as Record<string, unknown>).type === "text") {
        return { ...(item as Record<string, unknown>), text: "" };
      }
      return item;
    });
    if (!replacedOnce) {
      obj.content = [{ type: "text", text: stub }, ...(obj.content as unknown[])];
    }
    obj.isTruncated = true;
    return obj;
  }

  for (const field of ["content", "text", "result", "results", "output", "summary", "markdown"] as const) {
    if (typeof obj[field] === "string") {
      obj[field] = stub;
      obj.isTruncated = true;
      return obj;
    }
  }

  // No known text field — attach the stub as `output`.
  obj.output = stub;
  obj.isTruncated = true;
  return obj;
}

/**
 * Guard tool results for streaming by replacing oversized output with a stub.
 *
 * Tiering (based on the original estimated tokens):
 *   - ≤ 10K tokens  → pass through verbatim (no notice, no log reference)
 *   - 10K–25K       → stub with a ~1.5K-token head preview (no tail)
 *   - > 25K         → stub only (outline + retrieval, no body)
 *
 * The full output is persisted to the session-scoped truncated content store
 * (or the tool's own logId is reused when present) so the model can retrieve
 * slices on demand via executeCommand({command:"readLog",…}) or retrieveFullContent(…).
 */
export function guardToolResultForStreaming(
  toolName: string,
  result: unknown,
  options: GuardToolResultForStreamingOptions = {}
): GuardToolResultForStreamingResult {
  const estimatedTokens = estimateTokensSafely(result);

  if (estimatedTokens <= INLINE_PASSTHROUGH_TOKENS) {
    // Telemetry: still record passthrough so tier distribution is complete.
    // Derive a cheap outline without JSON parsing for the passthrough path.
    const passthroughText = typeof result === "string" ? result : safeStringify(result);
    let lineCount = passthroughText ? 1 : 0;
    for (let i = 0; i < passthroughText.length; i++) {
      if (passthroughText.charCodeAt(i) === 10) lineCount++;
    }
    recordTier({
      sessionId: options.sessionId,
      toolCallId: options.toolCallId,
      toolName,
      originalTokens: estimatedTokens,
      originalChars: passthroughText.length,
      originalLines: lineCount,
      tier: "passthrough",
    });
    return {
      blocked: false,
      estimatedTokens,
      result,
    };
  }

  const { text: primaryText, stderr } = extractPrimaryText(result);
  const outline = deriveOutline(primaryText, { stderr });

  const retrieval = extractRetrievalIds(result);
  let retrievalId = retrieval.logId ?? retrieval.truncatedContentId;
  let idType: "logId" | "contentId" = retrieval.logId ? "logId" : "contentId";

  // If no retrieval ID was supplied by the tool, persist into the truncated
  // content store so the model still has a way to fetch slices later.
  // storeFullContent returns null if the backing store is unavailable —
  // we degrade silently and the stub still carries the preview/outline.
  if (!retrievalId && options.sessionId && primaryText) {
    try {
      const stored = storeFullContent(
        options.sessionId,
        `${toolName} output`,
        primaryText,
        0
      );
      if (stored) {
        retrievalId = stored;
        idType = "contentId";
      }
    } catch (err) {
      console.warn(
        `[StreamGuard] Failed to store full content for ${toolName}:`,
        err
      );
    }
  }

  const tier: OutputTier =
    estimatedTokens <= PREVIEW_TIER_TOKENS ? "preview_plus_stub" : "stub_only";
  const previewTokens = tier === "preview_plus_stub" ? MID_TIER_PREVIEW_TOKENS : 0;

  // Determine whether the retrieval tool needed for this stub is currently
  // loaded in the model's active tool set.  The stub then decides whether to
  // prepend a step-0 searchTools discovery instruction.
  const retrievalToolName =
    idType === "logId" ? "executeCommand" : "retrieveFullContent";
  const retrievalToolLoaded =
    options.initialActiveTools?.has(retrievalToolName) ||
    options.discoveredTools?.has(retrievalToolName) ||
    false;

  const stub = buildOutputStub({
    toolName,
    originalText: primaryText,
    outline,
    retrievalId,
    idType,
    previewTokens,
    stderr,
    retrievalToolLoaded,
  });

  const finalResult = replacePrimaryText(result, stub);

  recordTier({
    sessionId: options.sessionId,
    toolCallId: options.toolCallId,
    toolName,
    originalTokens: estimatedTokens,
    originalChars: outline.byteLength,
    originalLines: outline.lineCount,
    tier,
    retrievalId,
    retrievalIdType: retrievalId ? idType : undefined,
  });

  return {
    blocked: true, // Still flagged so loop guards keep tracking oversize tools.
    estimatedTokens,
    result: finalResult,
  };
}

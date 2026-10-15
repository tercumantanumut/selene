/**
 * Token-Aware Output Limiter
 *
 * Enforces token limits on tool outputs for the persisted chat history.
 * Stores full content for on-demand retrieval.
 *
 * This is the "history-writer" path: it runs when a tool result is being
 * normalised for the conversation history. For the live streaming path see
 * `tool-result-stream-guard.ts` (different, larger budget).
 */

import { storeFullContent } from "./truncated-content-store";
import { buildOutputStub, deriveOutline } from "./output-stub";

// ============================================================================
// Configuration
// ============================================================================

// Default guardrail for tool outputs included in chat context.
// Keep this conservative so one noisy tool call cannot crowd out conversation context.
// ~3,000 tokens = ~12,000 characters (4 chars/token estimate)
const MAX_TOOL_OUTPUT_TOKENS = 3000;
export const CHARS_PER_TOKEN = 4;

// ============================================================================
// Types
// ============================================================================

interface LimitResult {
  /** Whether the output was limited/truncated */
  limited: boolean;
  /** The output (stub if limited, original primary text if not) */
  output: string;
  /** Original content length in characters */
  originalLength: number;
  /** Truncated content length in characters */
  truncatedLength: number;
  /** Reference ID for retrieving full content (if stored) */
  contentId?: string;
  /** Estimated token count of original output */
  estimatedTokens: number;
}

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Estimate token count for arbitrary content
 * Handles strings, objects, arrays
 * Uses 4 chars/token heuristic (conservative estimate)
 */
export function estimateTokens(content: unknown): number {
  if (typeof content === "string") {
    return Math.ceil(content.length / CHARS_PER_TOKEN);
  }

  if (Array.isArray(content)) {
    return content.reduce((total, item) => total + estimateTokens(item), 0);
  }

  if (content && typeof content === "object") {
    return Math.ceil(JSON.stringify(content).length / CHARS_PER_TOKEN);
  }

  return 10; // Default minimum
}

// ============================================================================
// Content Extraction
// ============================================================================

/**
 * Extract primary text content from tool output
 * Returns the main text that would be sent to context
 */
function extractPrimaryText(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return null;

  const obj = output as Record<string, unknown>;

  // MCP tool results: { content: [{ type: "text", text: "..." }, ...] }
  if (obj.content && Array.isArray(obj.content)) {
    const textParts: string[] = [];
    for (const item of obj.content) {
      if (item && typeof item === "object" && "text" in item) {
        textParts.push(String(item.text));
      }
    }
    if (textParts.length > 0) return textParts.join("\n");
  }

  // executeCommand-style: concatenate stdout + stderr
  if (obj.stdout || obj.stderr) {
    const parts: string[] = [];
    if (typeof obj.stdout === "string") parts.push(obj.stdout);
    if (typeof obj.stderr === "string") parts.push(obj.stderr);
    return parts.join("\n");
  }

  for (const field of ["content", "text", "result", "results", "output", "markdown"]) {
    if (typeof obj[field] === "string") return obj[field] as string;
  }

  // Nested payloads (designWorkspace readSource and similar): { data: { code } }
  if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
    const data = obj.data as Record<string, unknown>;
    for (const field of ["code", "content", "text"]) {
      if (typeof data[field] === "string") return data[field] as string;
    }
  }

  // NOTE: `summary` is deliberately NOT treated as primary text — it is a short
  // derived digest. Storing it as the "full content" makes retrieveFullContent
  // useless for recovering the real payload; callers fall back to full JSON.

  return null;
}

// ============================================================================
// Main Limiting Function
// ============================================================================

/**
 * Apply token limit to tool output for chat-history persistence.
 *
 * If output exceeds limit:
 *   - Stores the full primary text (so the model can retrieve slices later)
 *   - Returns a stub string with outline + retrieval commands
 *
 * Below the limit the primary text passes through unchanged.
 */
export function limitToolOutput(
  output: unknown,
  toolName: string,
  sessionId?: string,
  options: {
    maxTokens?: number;
    charsPerToken?: number;
  } = {}
): LimitResult {
  const maxTokens = options.maxTokens ?? MAX_TOOL_OUTPUT_TOKENS;

  // Detect an existing logId (executeCommand persists its own log file).
  const obj = output && typeof output === "object" ? (output as Record<string, any>) : null;
  const existingLogId = typeof obj?.logId === "string" ? (obj.logId as string) : undefined;
  const alreadyTruncated = obj?.isTruncated || obj?.truncated;

  const estimatedTokens = estimateTokens(output);

  // --- Below budget: pass through ---
  if (estimatedTokens <= maxTokens) {
    if (alreadyTruncated && (existingLogId || obj?.truncatedContentId)) {
      const text = extractPrimaryText(output) ?? JSON.stringify(output);
      return {
        limited: false,
        output: text,
        originalLength: text.length,
        truncatedLength: text.length,
        estimatedTokens,
      };
    }

    const text = extractPrimaryText(output);
    if (text !== null) {
      return {
        limited: false,
        output: text,
        originalLength: text.length,
        truncatedLength: text.length,
        estimatedTokens,
      };
    }

    const serialized =
      typeof output === "string"
        ? output
        : (() => {
            try {
              const s = JSON.stringify(output);
              return typeof s === "string" ? s : String(output);
            } catch {
              return String(output);
            }
          })();
    return {
      limited: false,
      output: serialized,
      originalLength: serialized.length,
      truncatedLength: serialized.length,
      estimatedTokens,
    };
  }

  console.warn(
    `[OutputLimiter] Tool "${toolName}" output exceeds limit: ` +
      `~${estimatedTokens.toLocaleString()} tokens (limit: ${maxTokens.toLocaleString()})`
  );

  // --- Over budget: store full + return stub ---
  const primaryText =
    extractPrimaryText(output) ??
    (typeof output === "string"
      ? output
      : (() => {
          try {
            const s = JSON.stringify(output);
            return typeof s === "string" ? s : String(output);
          } catch {
            return String(output);
          }
        })());

  // Prefer an existing logId; otherwise store the full primary text.
  // storeFullContent may return null when the backing store is
  // unavailable — normalise to undefined so the stub omits the
  // retrieval hint rather than printing "contentId=null".
  let retrievalId: string | undefined = existingLogId;
  let idType: "logId" | "contentId" = existingLogId ? "logId" : "contentId";
  if (!existingLogId && sessionId) {
    const stored = storeFullContent(
      sessionId,
      `${toolName} output`,
      primaryText,
      0
    );
    retrievalId = stored ?? undefined;
    idType = "contentId";
  }

  const stderr =
    obj && typeof obj.stderr === "string" ? (obj.stderr as string) : undefined;
  const outline = deriveOutline(primaryText, { stderr });

  const stub = buildOutputStub({
    toolName,
    originalText: primaryText,
    outline,
    retrievalId,
    idType,
    previewTokens: 0, // chat-history path: no preview, the live stream already showed one
    stderr,
  });

  return {
    limited: true,
    output: stub,
    originalLength: primaryText.length,
    truncatedLength: stub.length,
    contentId: retrievalId,
    estimatedTokens,
  };
}

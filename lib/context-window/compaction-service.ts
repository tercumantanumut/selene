/**
 * Compaction Service
 *
 * Enhanced message compaction with multi-strategy approach:
 * 1. Automatic pruning (zero LLM cost) - deduplication, supersede writes, purge errors
 * 2. AI-driven summarization - structured summaries preserving critical context
 *
 * Inspired by OpenCode DCP (Dynamic Context Pruning) patterns.
 *
 * @see docs/CONTEXT_WINDOW_MANAGEMENT_DESIGN.md
 */

import { generateText } from "ai";
import { getLanguageModelForProvider } from "@/lib/ai/providers";
import { resolveSessionModelScopeForSession } from "@/lib/ai/session-model-resolver";
import {
  getNonCompactedMessages,
  updateSessionSummary,
  markMessagesAsCompactedByIds,
  getSession,
} from "@/lib/db/queries";
import { estimateMessageTokens } from "@/lib/utils";
import type { Message } from "@/lib/db/schema";
import { truncateOutput } from "@/lib/command-execution/log-manager";
import { formatTokenCount } from "./token-tracker";
import { getContextWindowConfig } from "./provider-limits";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompactionSummaryMethod =
  | "utility_model"
  | "utility_model_failed"
  | "deterministic_fallback"
  | "skipped";

export interface CompactionSummaryDiagnostics {
  provider?: string;
  modelId?: string;
  sourceTokens: number;
  boundedSourceTokens: number;
  promptTokens?: number;
  maxOutputTokens?: number;
  inputLimitTokens?: number;
  safetyTokens?: number;
  sourceTruncated: boolean;
  utilityDurationMs?: number;
  fallbackReason?: string;
}

export interface CompactionResult {
  /** Whether compaction succeeded */
  success: boolean;
  /** Tokens freed by compaction */
  tokensFreed: number;
  /** Number of messages compacted */
  messagesCompacted: number;
  /** The generated summary */
  newSummary: string;
  /** How the summary was produced, when known. */
  summaryMethod?: CompactionSummaryMethod;
  /** Bounded-input and utility-model diagnostics for observability. */
  summaryDiagnostics?: CompactionSummaryDiagnostics;
  /** Error message if failed */
  error?: string;
  /** Breakdown of savings by strategy */
  breakdown?: {
    autoPruned: number;
    summarized: number;
  };
}

interface CompactionOptions {
  /** Number of recent messages to keep uncompacted (default: 6) */
  keepRecentMessages: number;
  /** Maximum output tokens for the generated summary (default: 10000) */
  maxSummaryTokens: number;
  /** Whether to preserve user rules/constraints (default: true) */
  preserveRules: boolean;
  /** Tool names whose results should never be compacted */
  preserveToolResults: string[];
  /** Minimum live messages required before compaction (default: 1) */
  minMessagesForCompaction: number;
  /** Whether to run auto-pruning before summarization (default: true) */
  enableAutoPruning: boolean;
  /** Maximum age in turns for error results before purging (default: 4) */
  errorPurgeAge: number;
  /** Target number of tokens to free — used for adaptive keepRecentMessages */
  targetTokensToFree?: number;
  /** Allow a bounded local fallback when the summarizer fails during required compaction. */
  allowDeterministicFallback: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: CompactionOptions = {
  keepRecentMessages: 6,
  maxSummaryTokens: 10000,
  preserveRules: true,
  preserveToolResults: [
    "updatePlan", 
    "mcp_filesystem_write_file", 
    "mcp_filesystem_edit_file",
  ],
  minMessagesForCompaction: 1,
  enableAutoPruning: true,
  errorPurgeAge: 4,
  allowDeterministicFallback: false,
};

const UTILITY_COMPACTION_SOURCE_TOKEN_TARGET = 10_000;
const MIN_UTILITY_COMPACTION_SOURCE_TOKENS = 256;
const UTILITY_COMPACTION_TIMEOUT_MS = 5 * 60_000;
const MAX_FALLBACK_SUMMARY_CHARACTERS = 24_000;
const COMPACTION_OMISSION_MARKER =
  "\n\n[Middle context omitted to fit the utility-model input budget.]\n\n";

/**
 * Enhanced compaction prompt that generates structured summaries.
 * Designed to preserve critical context while being concise.
 */
function sanitizeUnicodeScalarValues(text: string): string {
  let sanitized = "";

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        sanitized += text[i] + text[i + 1];
        i++;
      } else {
        sanitized += "�";
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      sanitized += "�";
      continue;
    }

    sanitized += text[i];
  }

  return sanitized;
}

function truncateSummaryText(text: string, maxCodePoints: number): string {
  const sanitized = sanitizeUnicodeScalarValues(text);
  const codePoints = Array.from(sanitized);
  if (codePoints.length <= maxCodePoints) return sanitized;
  return codePoints.slice(0, maxCodePoints).join("");
}

function takeCodePointsWithinCharacterBudget(
  codePoints: string[],
  maxCharacters: number,
  fromEnd: boolean,
): string {
  const selected: string[] = [];
  let characters = 0;

  for (
    let index = fromEnd ? codePoints.length - 1 : 0;
    fromEnd ? index >= 0 : index < codePoints.length;
    index += fromEnd ? -1 : 1
  ) {
    const codePoint = codePoints[index];
    if (characters + codePoint.length > maxCharacters) break;
    selected.push(codePoint);
    characters += codePoint.length;
  }

  if (fromEnd) selected.reverse();
  return selected.join("");
}

function boundCompactionText(
  text: string,
  maxCharacters: number,
): { text: string; truncated: boolean } {
  const sanitized = sanitizeUnicodeScalarValues(text);
  if (sanitized.length <= maxCharacters) {
    return { text: sanitized, truncated: false };
  }

  const codePoints = Array.from(sanitized);
  const markerLength = COMPACTION_OMISSION_MARKER.length;
  const available = Math.max(0, maxCharacters - markerLength);
  const headBudget = Math.ceil(available * 0.65);
  const tailBudget = Math.max(0, available - headBudget);
  return {
    text: [
      takeCodePointsWithinCharacterBudget(codePoints, headBudget, false),
      COMPACTION_OMISSION_MARKER,
      takeCodePointsWithinCharacterBudget(codePoints, tailBudget, true),
    ].join(""),
    truncated: true,
  };
}

function buildCompactionSource(previousSummary: string | null, conversationText: string): string {
  const sections: string[] = [];
  if (previousSummary?.trim()) {
    sections.push(`**Previous summary to incorporate:**\n\n${previousSummary.trim()}`);
  }
  if (conversationText.trim()) {
    sections.push(`**New messages to incorporate:**\n\n${conversationText.trim()}`);
  }
  return sections.join("\n\n");
}

function buildDeterministicFallbackSummary(source: string): string {
  return boundCompactionText(source, MAX_FALLBACK_SUMMARY_CHARACTERS).text;
}

const ENHANCED_COMPACTION_PROMPT = `You are a conversation summarizer for an AI coding assistant. Create a structured summary that enables seamless continuation of the conversation.

**REQUIRED SECTIONS:**

1. **Primary Intent**: What is the user trying to accomplish? (1-2 sentences)

2. **Files & Code**: Which files were discussed/modified? Include:
   - File paths mentioned
   - Key functions/classes modified
   - Important code snippets (if critical to understanding)

3. **Tool Execution**: List important command executions and their Log IDs (logId).

4. **Decisions Made**: Important technical decisions and their rationale.

5. **Current State**: 
   - What's working
   - What's in progress
   - What's broken or needs fixing

5. **Rules & Constraints**: User preferences, restrictions, or requirements that MUST be preserved. Examples:
   - "User prefers TypeScript over JavaScript"
   - "Don't modify the database schema"
   - "Always use async/await, not callbacks"

6. **Next Steps**: Pending tasks or planned actions.

**FORMATTING RULES:**
- Be concise but preserve ALL critical details
- Use bullet points for readability
- Include exact file paths and function names
- Preserve error messages and stack traces if they're still relevant
- Preserve Log IDs (logId) for executed commands so they can be retrieved later
- DO NOT lose user constraints or preferences
- Keep the summary under 10000 tokens

**Conversation context to summarize:**

{conversationText}

Generate the structured summary:`;

interface UtilityCompactionBudget {
  maxSourceTokens: number;
  maxOutputTokens: number;
  inputLimitTokens: number;
  promptOverheadTokens: number;
  safetyTokens: number;
}

function getUtilityCompactionBudget(
  modelId: string,
  provider: Parameters<typeof getContextWindowConfig>[1],
  requestedOutputTokens: number,
): UtilityCompactionBudget {
  const config = getContextWindowConfig(modelId, provider);
  const inputLimitTokens = config.maxInputTokens ?? config.maxTokens;
  const promptOverheadTokens = estimateMessageTokens({
    content: ENHANCED_COMPACTION_PROMPT.replace("{conversationText}", ""),
  });
  const safetyTokens = Math.max(512, Math.ceil(inputLimitTokens * 0.02));
  const contextOutputCap = Math.max(512, Math.floor(inputLimitTokens * 0.25));
  const maxOutputTokens = Math.max(
    1,
    Math.min(
      requestedOutputTokens,
      config.maxOutputTokens ?? requestedOutputTokens,
      contextOutputCap,
    ),
  );
  const availableSourceTokens = Math.max(
    0,
    inputLimitTokens - promptOverheadTokens - maxOutputTokens - safetyTokens,
  );

  return {
    maxSourceTokens: Math.min(
      UTILITY_COMPACTION_SOURCE_TOKEN_TARGET,
      availableSourceTokens,
    ),
    maxOutputTokens,
    inputLimitTokens,
    promptOverheadTokens,
    safetyTokens,
  };
}

// ---------------------------------------------------------------------------
// Auto-Pruning Strategies
// ---------------------------------------------------------------------------

/**
 * Deduplicate repeated tool calls (keep most recent).
 * Example: Multiple readFile calls for the same file → keep only the last one.
 */
async function deduplicateToolResults(
  sessionId: string,
  messages: Message[]
): Promise<{ tokensFreed: number; prunedCount: number }> {
  const toolCallMap = new Map<string, { index: number; tokens: number; messageId: string }>();
  const messagesToPrune: { id: string; tokens: number }[] = [];

  // Find duplicate tool calls (same tool + same args hash)
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool" || msg.isCompacted) continue;

    const toolName = msg.toolName || "unknown";
    
    // Create a hash key from tool name and args
    let argsHash = "";
    if (Array.isArray(msg.content)) {
      const toolResultPart = (msg.content as Array<{ type?: string; input?: unknown }>).find(
        (p) => p.type === "tool-result"
      );
      if (toolResultPart?.input) {
        argsHash = JSON.stringify(toolResultPart.input);
      }
    }

    const key = `${toolName}:${argsHash}`;
    const existing = toolCallMap.get(key);

    if (existing) {
      // Collect the older duplicate for pruning (keep the newer one)
      messagesToPrune.push({ id: existing.messageId, tokens: existing.tokens });
    }

    // Track this occurrence (always update to the latest)
    const tokens = msg.tokenCount ?? estimateMessageTokens({ content: msg.content });
    toolCallMap.set(key, { index: i, tokens, messageId: msg.id });
  }

  // Actually mark the duplicate messages as compacted
  let tokensFreed = 0;
  let prunedCount = 0;

  if (messagesToPrune.length > 0) {
    const ids = messagesToPrune.map((m) => m.id);
    const compactedCount = await markMessagesAsCompactedByIds(sessionId, ids);
    if (compactedCount > 0) {
      tokensFreed = messagesToPrune.reduce((sum, m) => sum + m.tokens, 0);
      prunedCount = compactedCount;
      console.log(
        `[CompactionService] Deduplication: ${prunedCount} duplicate tool results pruned, ` +
        `${formatTokenCount(tokensFreed)} tokens freed`
      );
    }
  }

  return { tokensFreed, prunedCount };
}

/**
 * Supersede write operations with subsequent reads.
 * If a file was written and then read, the write result is redundant.
 */
async function supersedeWrites(
  sessionId: string,
  messages: Message[]
): Promise<{ tokensFreed: number; prunedCount: number }> {
  const readOperations = new Set<string>();
  const messagesToPrune: { id: string; tokens: number }[] = [];

  // First pass: identify read operations
  for (const msg of messages) {
    if (msg.role !== "tool" || msg.isCompacted) continue;
    
    const toolName = msg.toolName || "";
    if (toolName === "readFile" || toolName === "mcp_filesystem_read_file") {
      // Extract file path from content
      if (Array.isArray(msg.content)) {
        const resultPart = (msg.content as Array<{ type?: string; filePath?: string }>).find(
          (p) => p.type === "tool-result"
        );
        if (resultPart?.filePath) {
          readOperations.add(resultPart.filePath);
        }
      }
    }
  }

  // Second pass: find write operations for files that were subsequently read
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool" || msg.isCompacted) continue;
    
    const toolName = msg.toolName || "";
    if (
      toolName === "mcp_filesystem_write_file" ||
      toolName === "mcp_filesystem_edit_file"
    ) {
      // Extract file path
      if (Array.isArray(msg.content)) {
        const resultPart = (msg.content as Array<{ type?: string; path?: string }>).find(
          (p) => p.type === "tool-result"
        );
        if (resultPart?.path && readOperations.has(resultPart.path)) {
          // This write was superseded by a read — collect for pruning
          const tokens = msg.tokenCount ?? estimateMessageTokens({ content: msg.content });
          messagesToPrune.push({ id: msg.id, tokens });
        }
      }
    }
  }

  // Actually mark the superseded messages as compacted
  let tokensFreed = 0;
  let prunedCount = 0;

  if (messagesToPrune.length > 0) {
    const ids = messagesToPrune.map((m) => m.id);
    const compactedCount = await markMessagesAsCompactedByIds(sessionId, ids);
    if (compactedCount > 0) {
      tokensFreed = messagesToPrune.reduce((sum, m) => sum + m.tokens, 0);
      prunedCount = compactedCount;
      console.log(
        `[CompactionService] Supersede writes: ${prunedCount} write operations pruned, ` +
        `${formatTokenCount(tokensFreed)} tokens freed`
      );
    }
  }

  return { tokensFreed, prunedCount };
}

/**
 * Purge error results older than N turns.
 * Keeps the error message but removes verbose input/output.
 */
async function purgeOldErrors(
  sessionId: string,
  messages: Message[],
  maxAge: number = 4
): Promise<{ tokensFreed: number; prunedCount: number }> {
  // Keep failed tool results visible for forensic/audit history.
  // We no longer compact them away because replay/reload flows rely on error breadcrumbs.
  void sessionId;
  void messages;
  void maxAge;
  return { tokensFreed: 0, prunedCount: 0 };
}

// ---------------------------------------------------------------------------
// CompactionService Class
// ---------------------------------------------------------------------------

export class CompactionService {
  /**
   * Run automatic pruning strategies (zero LLM cost).
   *
   * @param sessionId - Session to prune
   * @param messages - Messages in the session
   * @param options - Pruning options
   * @returns Total tokens freed
   */
  static async autoPrune(
    sessionId: string,
    messages: Message[],
    options: Partial<CompactionOptions> = {}
  ): Promise<number> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    let totalTokensFreed = 0;

    // Strategy 1: Deduplicate tool results
    const dedupResult = await deduplicateToolResults(sessionId, messages);
    totalTokensFreed += dedupResult.tokensFreed;

    // Strategy 2: Supersede writes with reads
    const supersedeResult = await supersedeWrites(sessionId, messages);
    totalTokensFreed += supersedeResult.tokensFreed;

    // Strategy 3: Purge old errors
    const purgeResult = await purgeOldErrors(sessionId, messages, opts.errorPurgeAge);
    totalTokensFreed += purgeResult.tokensFreed;

    if (totalTokensFreed > 0) {
      console.log(
        `[CompactionService] Auto-pruning complete: ${formatTokenCount(totalTokensFreed)} tokens freed`
      );
    }

    return totalTokensFreed;
  }

  /**
   * Perform AI-driven compaction (summarization).
   *
   * @param sessionId - Session to compact
   * @param options - Compaction options
   * @returns Compaction result
   */
  static async compact(
    sessionId: string,
    options: Partial<CompactionOptions> = {}
  ): Promise<CompactionResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startTime = Date.now();

    console.log(`[CompactionService] Starting compaction for session ${sessionId}`);

    // Get session and messages
    const session = await getSession(sessionId);
    if (!session) {
      return {
        success: false,
        tokensFreed: 0,
        messagesCompacted: 0,
        newSummary: "",
        error: "Session not found",
      };
    }

    let messages = await getNonCompactedMessages(sessionId);

    // Step 1: Run zero-cost pruning first, then refresh the live message set.
    let autoPrunedTokens = 0;
    if (opts.enableAutoPruning && messages.length > 0) {
      autoPrunedTokens = await this.autoPrune(sessionId, messages, opts);
      if (autoPrunedTokens > 0) {
        messages = await getNonCompactedMessages(sessionId);
      }
    }

    const hasExistingSummary = Boolean(session.summary?.trim());
    if (messages.length === 0 && !hasExistingSummary) {
      console.log(
        `[CompactionService] Utility-model summary skipped: no conversation history available`,
      );
      return {
        success: autoPrunedTokens > 0,
        tokensFreed: autoPrunedTokens,
        messagesCompacted: 0,
        newSummary: "",
        summaryMethod: "skipped",
        summaryDiagnostics: {
          sourceTokens: 0,
          boundedSourceTokens: 0,
          sourceTruncated: false,
        },
        error: autoPrunedTokens > 0 ? undefined : "No conversation history available to compact",
        breakdown: { autoPruned: autoPrunedTokens, summarized: 0 },
      };
    }

    if (messages.length > 0 && messages.length < opts.minMessagesForCompaction && !hasExistingSummary) {
      console.log(
        `[CompactionService] Utility-model summary skipped: ` +
        `${messages.length} messages below minimum ${opts.minMessagesForCompaction}`,
      );
      return {
        success: autoPrunedTokens > 0,
        tokensFreed: autoPrunedTokens,
        messagesCompacted: 0,
        newSummary: "",
        summaryMethod: "skipped",
        summaryDiagnostics: {
          sourceTokens: 0,
          boundedSourceTokens: 0,
          sourceTruncated: false,
        },
        error: autoPrunedTokens > 0
          ? undefined
          : `Not enough messages to compact (${messages.length} < ${opts.minMessagesForCompaction})`,
        breakdown: { autoPruned: autoPrunedTokens, summarized: 0 },
      };
    }

    // Step 2: Identify messages to compact (adaptive keepRecentMessages).
    let keepRecent = opts.keepRecentMessages;
    const selectMessagesToCompact = (recentCount: number): Message[] => {
      const recentThreshold = messages.length - recentCount;
      return messages.filter((message, index) => {
        const isRecent = index >= recentThreshold;
        const isPreservedTool =
          message.role === "tool" &&
          Boolean(message.toolName) &&
          opts.preserveToolResults.includes(message.toolName!);
        return !isRecent && !isPreservedTool;
      });
    };
    const computeCompactableTokens = (selectedMessages: Message[]): number =>
      selectedMessages.reduce(
        (total, message) =>
          total + (message.tokenCount ?? estimateMessageTokens({ content: message.content })),
        0,
      );

    let messagesToCompact = selectMessagesToCompact(keepRecent);
    if (opts.targetTokensToFree && opts.targetTokensToFree > 0) {
      let compactableTokens = computeCompactableTokens(messagesToCompact);

      while (compactableTokens < opts.targetTokensToFree && keepRecent > 0) {
        keepRecent = Math.max(0, keepRecent - 2);
        messagesToCompact = selectMessagesToCompact(keepRecent);
        compactableTokens = computeCompactableTokens(messagesToCompact);
      }

      if (keepRecent !== opts.keepRecentMessages) {
        console.log(
          `[CompactionService] Adaptive keepRecent: ${opts.keepRecentMessages} → ${keepRecent} ` +
          `(need to free ${formatTokenCount(opts.targetTokensToFree)}, ` +
          `compactable: ${formatTokenCount(compactableTokens)})`,
        );
      }
    }

    if (messagesToCompact.length === 0 && !hasExistingSummary) {
      console.log(
        `[CompactionService] Utility-model summary skipped: ` +
        `no messages remain after preserving recent context`,
      );
      return {
        success: autoPrunedTokens > 0,
        tokensFreed: autoPrunedTokens,
        messagesCompacted: 0,
        newSummary: "",
        summaryMethod: "skipped",
        summaryDiagnostics: {
          sourceTokens: 0,
          boundedSourceTokens: 0,
          sourceTruncated: false,
        },
        error: autoPrunedTokens > 0
          ? undefined
          : "No messages available to compact after preserving recent messages",
        breakdown: { autoPruned: autoPrunedTokens, summarized: 0 },
      };
    }

    const lastMessageToCompact = messagesToCompact.at(-1);
    const summaryBoundaryId = lastMessageToCompact?.id ?? session.summaryUpToMessageId ?? null;
    const tokensBeforeCompaction = computeCompactableTokens(messagesToCompact);
    const previousSummaryTokens = session.summary
      ? estimateMessageTokens({ content: session.summary })
      : 0;
    const representedTokensBefore = previousSummaryTokens + tokensBeforeCompaction;

    if (messagesToCompact.length > 0) {
      console.log(
        `[CompactionService] Compacting ${messagesToCompact.length} messages ` +
        `(${formatTokenCount(tokensBeforeCompaction)} tokens)`,
      );
    } else {
      console.log(
        `[CompactionService] Recompacting existing summary ` +
        `(${formatTokenCount(previousSummaryTokens)} tokens)`,
      );
    }

    // Step 3: Build the source once, then fit the maximum useful slice into the
    // resolved utility model's safe input budget. A previous summary can itself
    // become the only oversized context, so it remains part of the source.
    const conversationText = this.formatMessagesForSummary(messagesToCompact, opts.preserveRules);
    const compactionSource = buildCompactionSource(session.summary ?? null, conversationText);
    const sourceTokens = estimateMessageTokens({ content: compactionSource });

    type PreparedSummary = {
      newSummary: string;
      summarizedTokensFreed: number;
      summaryTokens: number;
    };

    const prepareSummary = (candidateSummary: string): PreparedSummary => {
      const newSummary = sanitizeUnicodeScalarValues(candidateSummary).trim();
      if (!newSummary) {
        throw new Error("Compaction produced an empty summary");
      }

      const summaryTokens = estimateMessageTokens({ content: newSummary });
      const summarizedTokensFreed = representedTokensBefore - summaryTokens;
      if (summarizedTokensFreed <= 0) {
        throw new Error("Compaction did not reduce the represented context");
      }

      return { newSummary, summarizedTokensFreed, summaryTokens };
    };

    const persistPreparedSummary = async (
      prepared: PreparedSummary,
      summaryMethod: CompactionSummaryMethod,
      summaryDiagnostics: CompactionSummaryDiagnostics,
    ): Promise<CompactionResult> => {
      await updateSessionSummary(sessionId, prepared.newSummary, summaryBoundaryId);

      const compactedIds = messagesToCompact.map((message) => message.id);
      if (compactedIds.length > 0) {
        await markMessagesAsCompactedByIds(sessionId, compactedIds);
      }

      const totalTokensFreed = prepared.summarizedTokensFreed + autoPrunedTokens;
      const duration = Date.now() - startTime;
      console.log(
        `[CompactionService] Compaction complete in ${duration}ms: ` +
        `${messagesToCompact.length} messages compacted, ` +
        `${formatTokenCount(totalTokensFreed)} tokens freed, method=${summaryMethod}`,
      );

      return {
        success: true,
        tokensFreed: totalTokensFreed,
        messagesCompacted: messagesToCompact.length,
        newSummary: prepared.newSummary,
        summaryMethod,
        summaryDiagnostics,
        breakdown: {
          autoPruned: autoPrunedTokens,
          summarized: prepared.summarizedTokensFreed,
        },
      };
    };

    const failureResult = (
      error: unknown,
      summaryMethod: CompactionSummaryMethod,
      summaryDiagnostics: CompactionSummaryDiagnostics,
    ): CompactionResult => ({
      success: false,
      tokensFreed: autoPrunedTokens,
      messagesCompacted: 0,
      newSummary: session.summary || "",
      summaryMethod,
      summaryDiagnostics,
      error: error instanceof Error ? error.message : String(error),
      breakdown: { autoPruned: autoPrunedTokens, summarized: 0 },
    });

    const runDeterministicFallback = async (
      reason: string,
      utilityError: unknown,
      diagnostics: CompactionSummaryDiagnostics,
    ): Promise<CompactionResult> => {
      const failedDiagnostics: CompactionSummaryDiagnostics = {
        ...diagnostics,
        fallbackReason: reason,
      };

      if (!opts.allowDeterministicFallback || !compactionSource.trim()) {
        return failureResult(
          utilityError,
          "utility_model_failed",
          failedDiagnostics,
        );
      }

      try {
        const fallbackSummary = buildDeterministicFallbackSummary(compactionSource);
        const prepared = prepareSummary(fallbackSummary);
        console.warn(
          `[CompactionService] Deterministic fallback used: reason=${reason}, ` +
          `summary=${formatTokenCount(prepared.summaryTokens)} tokens`,
        );
        return await persistPreparedSummary(
          prepared,
          "deterministic_fallback",
          failedDiagnostics,
        );
      } catch (fallbackError) {
        console.error("[CompactionService] Deterministic fallback failed:", fallbackError);
        return failureResult(
          fallbackError,
          "utility_model_failed",
          failedDiagnostics,
        );
      }
    };

    const sessionMetadata =
      session.metadata && typeof session.metadata === "object" && !Array.isArray(session.metadata)
        ? (session.metadata as Record<string, unknown>)
        : null;

    let provider: Awaited<ReturnType<typeof resolveSessionModelScopeForSession>>["effectiveConfig"]["provider"];
    let utilityModelId: string;
    let prompt: string;
    let maxOutputTokens: number;
    let diagnostics: CompactionSummaryDiagnostics = {
      sourceTokens,
      boundedSourceTokens: 0,
      sourceTruncated: false,
    };

    try {
      const scope = await resolveSessionModelScopeForSession(sessionMetadata, {
        characterId: session.characterId,
      });
      provider = scope.effectiveConfig.provider;
      utilityModelId = scope.effectiveConfig.utilityModel;

      const budget = getUtilityCompactionBudget(
        utilityModelId,
        provider,
        opts.maxSummaryTokens,
      );
      if (budget.maxSourceTokens < MIN_UTILITY_COMPACTION_SOURCE_TOKENS) {
        throw new Error(
          `Utility model input budget is too small for compaction ` +
          `(${budget.maxSourceTokens} source tokens available)`,
        );
      }

      const boundedSource = boundCompactionText(
        compactionSource,
        Math.floor(budget.maxSourceTokens * 4),
      );
      prompt = ENHANCED_COMPACTION_PROMPT.replace(
        "{conversationText}",
        boundedSource.text,
      );
      maxOutputTokens = budget.maxOutputTokens;
      diagnostics = {
        provider,
        modelId: utilityModelId,
        sourceTokens,
        boundedSourceTokens: estimateMessageTokens({ content: boundedSource.text }),
        promptTokens: estimateMessageTokens({ content: prompt }),
        maxOutputTokens,
        inputLimitTokens: budget.inputLimitTokens,
        safetyTokens: budget.safetyTokens,
        sourceTruncated: boundedSource.truncated,
      };

      console.log(
        `[CompactionService] Utility-model summary requested: ` +
        `provider=${provider}, model=${utilityModelId}, ` +
        `source=${formatTokenCount(sourceTokens)}, ` +
        `bounded=${formatTokenCount(diagnostics.boundedSourceTokens)}, ` +
        `prompt=${formatTokenCount(diagnostics.promptTokens ?? 0)}, ` +
        `maxOutput=${formatTokenCount(maxOutputTokens)}, ` +
        `inputLimit=${formatTokenCount(budget.inputLimitTokens)}, ` +
        `truncated=${boundedSource.truncated}`,
      );
    } catch (error) {
      console.error(
        "[CompactionService] Utility-model summary could not be prepared:",
        error,
      );
      return runDeterministicFallback("input_or_model_resolution_failed", error, diagnostics);
    }

    const utilityStartedAt = Date.now();
    let utilityText: string;
    try {
      const utilityModel = getLanguageModelForProvider(provider, utilityModelId);
      const { text } = await generateText({
        model: utilityModel,
        prompt,
        maxOutputTokens,
        abortSignal: AbortSignal.timeout(UTILITY_COMPACTION_TIMEOUT_MS),
      });
      utilityText = text;
      diagnostics = {
        ...diagnostics,
        utilityDurationMs: Date.now() - utilityStartedAt,
      };
    } catch (error) {
      diagnostics = {
        ...diagnostics,
        utilityDurationMs: Date.now() - utilityStartedAt,
      };
      console.error("[CompactionService] Utility-model summary failed:", error);
      return runDeterministicFallback("utility_model_call_failed", error, diagnostics);
    }

    let preparedUtilitySummary: PreparedSummary;
    try {
      preparedUtilitySummary = prepareSummary(utilityText);
    } catch (error) {
      console.error("[CompactionService] Utility-model summary was unusable:", error);
      return runDeterministicFallback("utility_model_output_invalid", error, diagnostics);
    }

    console.log(
      `[CompactionService] Utility-model summary generated successfully: ` +
      `${formatTokenCount(preparedUtilitySummary.summaryTokens)} tokens in ` +
      `${diagnostics.utilityDurationMs ?? 0}ms`,
    );

    try {
      return await persistPreparedSummary(
        preparedUtilitySummary,
        "utility_model",
        diagnostics,
      );
    } catch (error) {
      console.error(
        `[CompactionService] Utility-model summary persistence failed; ` +
        `deterministic fallback was not attempted:`,
        error,
      );
      return failureResult(error, "utility_model", diagnostics);
    }
  }

  /**
   * Format messages for summarization with rule extraction.
   */
  private static formatMessagesForSummary(
    messages: Message[],
    preserveRules: boolean
  ): string {
    const formatted: string[] = [];
    const userRules: string[] = [];

    for (const msg of messages) {
      const role = msg.role.toUpperCase();
      let content: string;

      if (typeof msg.content === "string") {
        content = msg.content;

        // Extract rules from user messages
        if (preserveRules && msg.role === "user") {
          const rulePatterns = [
            /don't|do not|never|always|must|should|prefer|avoid|make sure/i,
            /constraint|requirement|rule|policy|important/i,
          ];
          if (rulePatterns.some((pattern) => pattern.test(content))) {
            userRules.push(truncateSummaryText(content, 200)); // Truncate long messages
          }
        }
      } else if (Array.isArray(msg.content)) {
        content = (msg.content as Array<any>)
          .map((part) => {
            if (part.type === "text" && part.text) return part.text;
            if (part.type === "image") return "[Image]";
            if (part.type === "tool-call") return `[Tool call: ${msg.toolName || "unknown"}]`;
            
            // FIX: Include tool result content instead of just the label
            if (part.type === "tool-result") {
                const toolName = msg.toolName || "unknown";
                let resultText = "";
                
                // Special handling for executeCommand results
                if (toolName === "executeCommand" && part.result) {
                    const res = part.result;
                    const stdout = res.stdout || "";
                    const stderr = res.stderr || "";
                    
                    // Use middle-truncation for terminal output
                    const truncated = truncateOutput(stdout + (stderr ? "\n" + stderr : ""), 200);
                    resultText = `[Tool result: executeCommand] Status: ${res.status}, ExitCode: ${res.exitCode}, LogID: ${res.logId || "none"} (IMPORTANT: PRESERVE THIS LOG ID)\nOutput: ${truncated.content}`;
                } else if (toolName === "memorize" && part.result) {
                    const res = part.result as any;
                    resultText = `[Tool result: memorize] Status: ${res.success ? "Success" : "Failed"}, Memory: "${res.message || ""}"`;
                } else if (part.result) {
                    // For other tools, provide a summarized JSON
                    resultText = `[Tool result: ${toolName}] ${truncateSummaryText(JSON.stringify(part.result), 500)}`;
                } else {
                    resultText = `[Tool result: ${toolName}]`;
                }
                
                return resultText;
            }
            
            return "[Content]";
          })
          .join(" ");

        // Extract rules from user messages
        if (preserveRules && msg.role === "user") {
          const textContent = content;
          const rulePatterns = [
            /don't|do not|never|always|must|should|prefer|avoid|make sure/i,
            /constraint|requirement|rule|policy|important/i,
          ];
          if (rulePatterns.some((pattern) => pattern.test(textContent))) {
            userRules.push(truncateSummaryText(textContent, 200));
          }
        }
      } else {
        content = truncateSummaryText(JSON.stringify(msg.content), 500);
      }

      // Preserve full user/assistant text until the model-aware global input
      // budget is applied. Tool messages remain locally capped because raw tool
      // payloads are usually redundant and can otherwise consume the whole slice.
      content = sanitizeUnicodeScalarValues(content);
      if (msg.role === "tool" && Array.from(content).length > 2_000) {
        content = truncateSummaryText(content, 2_000) + "... [truncated]";
      }

      formatted.push(`${role}: ${content}`);
    }

    let result = formatted.join("\n\n");

    if (userRules.length > 0) {
      result += `\n\n**DETECTED USER RULES (MUST PRESERVE):**\n${userRules.map((r) => `- ${r}`).join("\n")}`;
    }

    return sanitizeUnicodeScalarValues(result);
  }

  /**
   * Check if compaction is needed based on token count.
   *
   * @param sessionId - Session to check
   * @param currentTokens - Current token count
   * @param warningThreshold - Token threshold for warning
   * @returns Whether compaction is recommended
   */
  // fallow-ignore-next-line unused-class-member
  static shouldCompact(
    currentTokens: number,
    warningThreshold: number
  ): boolean {
    return currentTokens >= warningThreshold;
  }
}

// ---------------------------------------------------------------------------
// Backward Compatibility
// ---------------------------------------------------------------------------

/**
 * Legacy compaction function for backward compatibility.
 * Wraps the new CompactionService.
 *
 * @deprecated Use CompactionService.compact() instead
 */
async function compactIfNeeded(
  sessionId: string,
  modelId?: string,
  provider?: string
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;

  const messages = await getNonCompactedMessages(sessionId);
  if (messages.length < DEFAULT_OPTIONS.minMessagesForCompaction) return;

  // Estimate total tokens
  let totalTokens = 0;
  for (const msg of messages) {
    totalTokens += estimateMessageTokens({ content: msg.content });
  }

  if (session.summary) {
    totalTokens += estimateMessageTokens({ content: session.summary });
  }

  // Use default 140K threshold (70% of 200K) for backward compatibility
  const TOKEN_THRESHOLD = 140000;

  if (totalTokens < TOKEN_THRESHOLD) return;

  // Trigger compaction
  await CompactionService.compact(sessionId);
}

/**
 * Token Tracker
 *
 * Provides accurate token counting and usage tracking for context window management.
 * Tracks tokens by category (system, user, assistant, tools) for detailed analysis.
 *
 * @see docs/CONTEXT_WINDOW_MANAGEMENT_DESIGN.md
 */

import { estimateMessageTokens } from "@/lib/utils";
import type { Message } from "@/lib/db/schema";
import {
  getScopedFallbackMinConfidence,
  isScopedFallbackEnabled,
  shouldUseScopedCounting,
  type ContextScope,
  type ScopedCountOptions,
} from "./scoped-counting-contract";
import { LegacyScopeHeuristic } from "./fallback-scope-parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenUsage {
  /** Tokens used by system prompt */
  systemPromptTokens: number;
  /** Tokens used by user messages */
  userMessageTokens: number;
  /** Tokens used by assistant messages */
  assistantMessageTokens: number;
  /** Tokens used by tool call definitions/invocations */
  toolCallTokens: number;
  /** Tokens used by tool results */
  toolResultTokens: number;
  /** Tokens used by session summary (compacted history) */
  summaryTokens: number;
  /** Total tokens across all categories */
  totalTokens: number;
}

interface TokenBreakdown extends TokenUsage {
  /** Percentage breakdown by category */
  percentages: {
    systemPrompt: number;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    summary: number;
  };
  /** Human-readable formatted totals */
  formatted: {
    total: string;
    systemPrompt: string;
    userMessages: string;
    assistantMessages: string;
    tools: string;
    summary: string;
  };
}

interface TokenEstimate {
  /** Estimated tokens for the content */
  tokens: number;
  /** Confidence level of the estimate */
  confidence: "high" | "medium" | "low";
  /** Method used for estimation */
  method: "cached" | "calculated" | "estimated";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Average characters per token for estimation.
 * Based on empirical analysis of Claude/GPT tokenizers.
 * English text averages ~4 chars/token, code ~3.5 chars/token.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Overhead tokens per message for role markers, formatting, etc.
 */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Overhead tokens per tool call for schema, markers, etc.
 */
const TOOL_CALL_OVERHEAD_TOKENS = 10;

const LEGACY_ASSISTANT_TOKEN_RATIO_THRESHOLD = 1.3;

function isScopedModeActive(options: ScopedCountOptions): boolean {
  if (options.scopedMode === "legacy") return false;
  if (options.scopedMode === "scoped") return true;
  if (options.hasDelegatedAnnotations) return true;
  return shouldUseScopedCounting(options.provider);
}

interface ContentPartLike {
  type?: string;
  text?: string;
  contextScope?: string;
}

function getPartScope(part: unknown): "main" | "delegated" | undefined {
  if (!part || typeof part !== "object" || Array.isArray(part)) return undefined;
  const scope = (part as { contextScope?: unknown }).contextScope;
  return scope === "main" || scope === "delegated" ? scope : undefined;
}

function hasPartScopes(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => getPartScope(part) !== undefined);
}

function estimateMessageTokensForScope(
  msg: Message,
  includePart: (part: unknown) => boolean
): number {
  if (!Array.isArray(msg.content)) {
    return estimateContentTokens(msg.content);
  }

  const scopedParts = (msg.content as unknown[]).filter(includePart);
  if (scopedParts.length === 0) return 0;
  return estimateContentTokens(scopedParts);
}

function resolveLegacyMessageScope(
  msg: Message,
  heuristic: LegacyScopeHeuristic
): { scope: "main" | "delegated"; confidence: number } {
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    let delegatedVotes = 0;
    let mainVotes = 0;
    let confidenceTotal = 0;
    for (const part of msg.content) {
      const inferred = heuristic.inferPart(part);
      confidenceTotal += inferred.confidence;
      if (inferred.scope === "delegated") delegatedVotes += 1;
      else mainVotes += 1;
    }

    const avgConfidence = confidenceTotal / msg.content.length;
    if (delegatedVotes > mainVotes) {
      return { scope: "delegated", confidence: avgConfidence };
    }
    return { scope: "main", confidence: avgConfidence };
  }

  const inferred = heuristic.inferMessage(msg);
  return { scope: inferred.scope, confidence: inferred.confidence };
}

function resolveMessageScopeInclusion(
  msg: Message,
  options: ScopedCountOptions,
  heuristic: LegacyScopeHeuristic
): boolean {
  if (!isScopedModeActive(options)) {
    return true;
  }

  if (msg.role === "system") {
    return true;
  }

  const targetScope = options.targetScope ?? "main";
  const metadata = msg.metadata && typeof msg.metadata === "object" && !Array.isArray(msg.metadata)
    ? (msg.metadata as Record<string, unknown>)
    : null;

  const metadataScope = getPartScope(metadata);
  if (metadataScope) return metadataScope === targetScope;

  const fallbackEnabled = options.fallbackEnabled ?? isScopedFallbackEnabled();
  const minConfidence = options.fallbackMinConfidence ?? getScopedFallbackMinConfidence();

  if (Array.isArray(msg.content) && hasPartScopes(msg.content)) {
    const scopedParts = msg.content as unknown[];
    const targetParts = scopedParts.filter((part) => getPartScope(part) === targetScope);
    const otherScopedParts = scopedParts.filter((part) => {
      const scope = getPartScope(part);
      return scope !== undefined && scope !== targetScope;
    });

    if (targetParts.length > 0 && otherScopedParts.length === 0) return true;
    if (otherScopedParts.length > 0 && targetParts.length === 0) return false;

    // Mixed rows remain counted conservatively unless fallback heuristics are enabled and confident.
    if (!fallbackEnabled) return true;
  }

  if (!fallbackEnabled) {
    return true;
  }

  const inferred = resolveLegacyMessageScope(msg, heuristic);
  if (inferred.confidence < minConfidence) {
    return true;
  }

  return inferred.scope === targetScope;
}

function countToolCallOverheadForScope(
  content: unknown,
  includePart: (part: unknown) => boolean
): number {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content as ContentPartLike[]) {
    if (part?.type === "tool-call" && includePart(part)) {
      total += TOOL_CALL_OVERHEAD_TOKENS;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Token Estimation Helpers
// ---------------------------------------------------------------------------

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function extractUsageFromMetadata(metadata: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const usage = (metadata as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }

  const typedUsage = usage as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    totalTokens?: unknown;
  };

  return {
    inputTokens: toFiniteNumber(typedUsage.inputTokens),
    outputTokens: toFiniteNumber(typedUsage.outputTokens),
    totalTokens: toFiniteNumber(typedUsage.totalTokens),
  };
}

function isLegacyAssistantTotalTokenCount(
  msg: Message,
  estimatedTokens: number
): boolean {
  if (msg.role !== "assistant") return false;
  if (typeof msg.tokenCount !== "number" || msg.tokenCount <= 0) return false;

  const usage = extractUsageFromMetadata(msg.metadata);
  if (!usage || usage.totalTokens !== msg.tokenCount) return false;

  if ((usage.inputTokens ?? 0) > 0) {
    return true;
  }

  return msg.tokenCount > estimatedTokens * LEGACY_ASSISTANT_TOKEN_RATIO_THRESHOLD;
}

function isSyntheticToolResultMessage(msg: Message): boolean {
  if (msg.role !== "tool") return false;
  if (!msg.metadata || typeof msg.metadata !== "object" || Array.isArray(msg.metadata)) {
    return false;
  }
  return (msg.metadata as { syntheticToolResult?: unknown }).syntheticToolResult === true;
}

export function getReliableMessageTokenCount(msg: Message): number {
  const estimatedTokens = estimateMessageTokens({ content: msg.content });
  if (typeof msg.tokenCount !== "number" || msg.tokenCount <= 0) {
    return estimatedTokens;
  }

  if (isLegacyAssistantTotalTokenCount(msg, estimatedTokens)) {
    return estimatedTokens;
  }

  return msg.tokenCount;
}

// ---------------------------------------------------------------------------
// Token Estimation Helpers
// ---------------------------------------------------------------------------

/**
 * Estimate tokens for a string of text.
 *
 * @param text - The text to estimate
 * @returns Estimated token count
 */
function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for JSON content.
 *
 * @param content - The content to estimate (will be stringified if not string)
 * @returns Estimated token count
 */
function estimateContentTokens(content: unknown): number {
  if (!content) return 0;

  if (typeof content === "string") {
    return estimateTextTokens(content);
  }

  if (Array.isArray(content)) {
    let tokens = 0;
    for (const part of content) {
      if (typeof part === "object" && part !== null) {
        const typedPart = part as { type?: string; text?: string; image?: string };

        // Text parts
        if (typedPart.type === "text" && typedPart.text) {
          tokens += estimateTextTokens(typedPart.text);
        }
        // Image parts - estimate based on typical image token costs
        else if (typedPart.type === "image" || typedPart.image) {
          // Images typically cost ~1000-2000 tokens depending on size
          // Using conservative estimate
          tokens += 1500;
        }
        // Tool calls
        else if (typedPart.type === "tool-call") {
          tokens += estimateContentTokens(part) + TOOL_CALL_OVERHEAD_TOKENS;
        }
        // Tool results
        else if (typedPart.type === "tool-result") {
          tokens += estimateContentTokens(part);
        }
        // Other object types
        else {
          tokens += estimateTextTokens(JSON.stringify(part));
        }
      } else if (typeof part === "string") {
        tokens += estimateTextTokens(part);
      }
    }
    return tokens;
  }

  // Object content
  return estimateTextTokens(JSON.stringify(content));
}

// ---------------------------------------------------------------------------
// TokenTracker Class
// ---------------------------------------------------------------------------

export class TokenTracker {
  /**
   * Calculate detailed token usage breakdown for a session.
   *
   * @param sessionId - The session identifier
   * @param messages - Array of messages in the session
   * @param systemPromptLength - Length of the system prompt in characters
   * @param sessionSummary - Optional session summary from previous compaction
   * @returns Detailed token usage breakdown
   */
  static async calculateUsage(
    sessionId: string,
    messages: Message[],
    systemPromptLength: number,
    sessionSummary?: string | null,
    options?: ScopedCountOptions
  ): Promise<TokenUsage> {
    const resolvedOptions: ScopedCountOptions = options ?? {};
    const usage: TokenUsage = {
      systemPromptTokens: Math.ceil(systemPromptLength / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS,
      userMessageTokens: 0,
      assistantMessageTokens: 0,
      toolCallTokens: 0,
      toolResultTokens: 0,
      summaryTokens: sessionSummary
        ? estimateMessageTokens({ content: sessionSummary }) + MESSAGE_OVERHEAD_TOKENS
        : 0,
      totalTokens: 0,
    };

    const heuristic = new LegacyScopeHeuristic(resolvedOptions.sessionMetadata);

    for (const msg of messages) {
      // Skip compacted messages - they're represented in the summary
      if (msg.isCompacted || isSyntheticToolResultMessage(msg)) continue;

      const includeMessage = resolveMessageScopeInclusion(msg, resolvedOptions, heuristic);
      if (!includeMessage && isScopedModeActive(resolvedOptions)) {
        continue;
      }

      const includePart = (part: unknown): boolean => {
        if (!isScopedModeActive(resolvedOptions)) return true;
        const scope = getPartScope(part);
        if (scope) return scope === (resolvedOptions.targetScope ?? "main");
        return includeMessage;
      };

      // Ignore legacy assistant rows where tokenCount stores request-level totals.
      const baseTokens = isScopedModeActive(resolvedOptions)
        ? estimateMessageTokensForScope(msg, includePart)
        : getReliableMessageTokenCount(msg);
      if (baseTokens <= 0 && msg.role !== "system") {
        continue;
      }
      const messageTokens = baseTokens + MESSAGE_OVERHEAD_TOKENS;

      switch (msg.role) {
        case "user":
          usage.userMessageTokens += messageTokens;
          break;

        case "assistant":
          usage.assistantMessageTokens += messageTokens;
          usage.toolCallTokens += countToolCallOverheadForScope(msg.content, includePart);
          break;

        case "tool":
          usage.toolResultTokens += messageTokens;
          break;

        case "system":
          // System messages (other than main prompt) counted separately
          usage.systemPromptTokens += messageTokens;
          break;
      }
    }

    // Calculate total
    usage.totalTokens =
      usage.systemPromptTokens +
      usage.userMessageTokens +
      usage.assistantMessageTokens +
      usage.toolCallTokens +
      usage.toolResultTokens +
      usage.summaryTokens;

    return usage;
  }

  /**
   * Get detailed breakdown with percentages and formatted strings.
   *
   * @param usage - Token usage from calculateUsage
   * @returns Extended breakdown with percentages and formatting
   */
  // fallow-ignore-next-line unused-class-member
  static getBreakdown(usage: TokenUsage): TokenBreakdown {
    const total = usage.totalTokens || 1; // Avoid division by zero

    const toolsTotal = usage.toolCallTokens + usage.toolResultTokens;

    return {
      ...usage,
      percentages: {
        systemPrompt: (usage.systemPromptTokens / total) * 100,
        userMessages: (usage.userMessageTokens / total) * 100,
        assistantMessages: (usage.assistantMessageTokens / total) * 100,
        toolCalls: (usage.toolCallTokens / total) * 100,
        toolResults: (usage.toolResultTokens / total) * 100,
        summary: (usage.summaryTokens / total) * 100,
      },
      formatted: {
        total: formatTokenCount(usage.totalTokens),
        systemPrompt: formatTokenCount(usage.systemPromptTokens),
        userMessages: formatTokenCount(usage.userMessageTokens),
        assistantMessages: formatTokenCount(usage.assistantMessageTokens),
        tools: formatTokenCount(toolsTotal),
        summary: formatTokenCount(usage.summaryTokens),
      },
    };
  }

  /**
   * Estimate tokens for a new message before sending.
   *
   * @param content - The message content
   * @returns Token estimate with confidence
   */
  static estimateNewMessageTokens(content: unknown): TokenEstimate {
    const tokens = estimateContentTokens(content) + MESSAGE_OVERHEAD_TOKENS;

    return {
      tokens,
      confidence: typeof content === "string" ? "high" : "medium",
      method: "estimated",
    };
  }

  /**
   * Estimate tokens for a complete request (messages + system prompt).
   *
   * @param messages - Array of messages to send
   * @param systemPromptLength - Length of system prompt
   * @param sessionSummary - Optional session summary
   * @returns Total estimated tokens
   */
  // fallow-ignore-next-line unused-class-member
  static estimateRequestTokens(
    messages: Array<{ role: string; content: unknown }>,
    systemPromptLength: number,
    sessionSummary?: string | null
  ): number {
    let total = Math.ceil(systemPromptLength / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS;

    if (sessionSummary) {
      total += estimateTextTokens(sessionSummary) + MESSAGE_OVERHEAD_TOKENS;
    }

    for (const msg of messages) {
      total += estimateContentTokens(msg.content) + MESSAGE_OVERHEAD_TOKENS;
    }

    return total;
  }

  /**
   * Calculate how many tokens would be freed by compacting messages.
   *
   * @param messagesToCompact - Messages that would be compacted
   * @param estimatedSummaryTokens - Estimated tokens for the summary
   * @returns Net tokens that would be freed
   */
  // fallow-ignore-next-line unused-class-member
  static calculatePotentialSavings(
    messagesToCompact: Message[],
    estimatedSummaryTokens: number = 500
  ): number {
    let currentTokens = 0;

    for (const msg of messagesToCompact) {
      if (!msg.isCompacted && !isSyntheticToolResultMessage(msg)) {
        currentTokens += getReliableMessageTokenCount(msg);
        currentTokens += MESSAGE_OVERHEAD_TOKENS;
      }
    }

    // Savings = current tokens - summary tokens
    return Math.max(0, currentTokens - estimatedSummaryTokens);
  }

  /**
   * Find optimal compaction boundary to free target tokens.
   *
   * @param messages - All messages in session
   * @param targetTokensToFree - How many tokens we need to free
   * @param keepRecentCount - Minimum recent messages to keep
   * @returns Index of last message to compact, or -1 if not possible
   */
  // fallow-ignore-next-line unused-class-member
  static findCompactionBoundary(
    messages: Message[],
    targetTokensToFree: number,
    keepRecentCount: number = 6
  ): number {
    if (messages.length <= keepRecentCount) {
      return -1; // Not enough messages to compact
    }

    const maxCompactIndex = messages.length - keepRecentCount - 1;
    let accumulatedTokens = 0;

    for (let i = 0; i <= maxCompactIndex; i++) {
      const msg = messages[i];
      if (!msg.isCompacted && !isSyntheticToolResultMessage(msg)) {
        accumulatedTokens += getReliableMessageTokenCount(msg);
        accumulatedTokens += MESSAGE_OVERHEAD_TOKENS;
      }

      // Account for summary overhead (estimate ~500 tokens for summary)
      const netSavings = accumulatedTokens - 500;

      if (netSavings >= targetTokensToFree) {
        return i;
      }
    }

    // Return max possible boundary even if target not fully met
    return maxCompactIndex >= 0 ? maxCompactIndex : -1;
  }
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Format token count for display.
 *
 * @param tokens - Number of tokens
 * @returns Formatted string (e.g., "15.2K", "1.5M")
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return tokens.toString();
}

/**
 * Calculate percentage of context window used.
 *
 * @param currentTokens - Current token count
 * @param maxTokens - Maximum allowed tokens
 * @returns Percentage (0-100)
 */
function calculateUsagePercentage(currentTokens: number, maxTokens: number): number {
  if (maxTokens <= 0) return 0;
  return (currentTokens / maxTokens) * 100;
}

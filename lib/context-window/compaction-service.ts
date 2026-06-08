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
import { getUtilityModel } from "@/lib/ai/providers";
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompactionResult {
  /** Whether compaction succeeded */
  success: boolean;
  /** Tokens freed by compaction */
  tokensFreed: number;
  /** Number of messages compacted */
  messagesCompacted: number;
  /** The generated summary */
  newSummary: string;
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
  /** Minimum messages required before compaction (default: 10) */
  minMessagesForCompaction: number;
  /** Whether to run auto-pruning before summarization (default: true) */
  enableAutoPruning: boolean;
  /** Maximum age in turns for error results before purging (default: 4) */
  errorPurgeAge: number;
  /** Target number of tokens to free — used for adaptive keepRecentMessages */
  targetTokensToFree?: number;
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
  minMessagesForCompaction: 3, // Lowered from 10 to support sparse long-running sessions
  enableAutoPruning: true,
  errorPurgeAge: 4,
};

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

{previousSummary}

**New messages to incorporate:**

{conversationText}

Generate the structured summary:`;

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

    const messages = await getNonCompactedMessages(sessionId);
    
    // Check if we have enough messages for full compaction
    if (messages.length < opts.minMessagesForCompaction) {
      // FALLBACK STRATEGY: For sparse sessions, try auto-pruning only
      console.log(
        `[CompactionService] Insufficient messages for full compaction (${messages.length} < ${opts.minMessagesForCompaction}), ` +
        `attempting auto-pruning only`
      );
      
      if (opts.enableAutoPruning) {
        const autoPrunedTokens = await this.autoPrune(sessionId, messages, opts);
        if (autoPrunedTokens > 0) {
          console.log(
            `[CompactionService] Auto-pruning freed ${formatTokenCount(autoPrunedTokens)} tokens without summarization`
          );
          return {
            success: true,
            tokensFreed: autoPrunedTokens,
            messagesCompacted: 0,
            newSummary: session.summary || "",
            breakdown: { autoPruned: autoPrunedTokens, summarized: 0 },
          };
        }
      }
      
      // If auto-pruning didn't help, return the error
      return {
        success: false,
        tokensFreed: 0,
        messagesCompacted: 0,
        newSummary: "",
        error: `Not enough messages to compact (${messages.length} < ${opts.minMessagesForCompaction})`,
      };
    }

    // Step 1: Run auto-pruning first
    let autoPrunedTokens = 0;
    if (opts.enableAutoPruning) {
      autoPrunedTokens = await this.autoPrune(sessionId, messages, opts);
    }

    // Step 2: Identify messages to compact (adaptive keepRecentMessages)
    let keepRecent = opts.keepRecentMessages;
    
    // Identify messages to compact, while preserving specific tool results
    let messagesToCompact: Message[] = [];
    const recentThreshold = messages.length - keepRecent;
    
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const isRecent = i >= recentThreshold;
        const isPreservedTool = msg.role === "tool" && msg.toolName && opts.preserveToolResults.includes(msg.toolName);
        
        if (!isRecent && !isPreservedTool) {
            messagesToCompact.push(msg);
        }
    }

    // If targetTokensToFree is set, adaptively reduce keepRecent to free enough tokens
    const computeCompactableTokens = (msgs: Message[]) => {
      let total = 0;
      for (const msg of msgs) {
        total += msg.tokenCount ?? estimateMessageTokens({ content: msg.content });
      }
      return total;
    };

    if (opts.targetTokensToFree && opts.targetTokensToFree > 0) {
      let compactableTokens = computeCompactableTokens(messagesToCompact);

      // Reduce keepRecent until we can free enough tokens (allow going to 0)
      while (compactableTokens < opts.targetTokensToFree && keepRecent > 0) {
        keepRecent = Math.max(0, keepRecent - 2);
        
        // Re-calculate messages to compact with new threshold
        const newRecentThreshold = messages.length - keepRecent;
        messagesToCompact = [];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const isRecent = i >= newRecentThreshold;
            const isPreservedTool = msg.role === "tool" && msg.toolName && opts.preserveToolResults.includes(msg.toolName);
            if (!isRecent && !isPreservedTool) {
                messagesToCompact.push(msg);
            }
        }
        compactableTokens = computeCompactableTokens(messagesToCompact);
      }

      if (keepRecent !== opts.keepRecentMessages) {
        console.log(
          `[CompactionService] Adaptive keepRecent: ${opts.keepRecentMessages} → ${keepRecent} ` +
          `(need to free ${formatTokenCount(opts.targetTokensToFree)}, ` +
          `compactable: ${formatTokenCount(compactableTokens)})`
        );
      }
    }

    if (messagesToCompact.length === 0) {
      return {
        success: false,
        tokensFreed: autoPrunedTokens,
        messagesCompacted: 0,
        newSummary: session.summary || "",
        error: "No messages available to compact after preserving recent messages",
        breakdown: { autoPruned: autoPrunedTokens, summarized: 0 },
      };
    }

    const lastMessageToCompact = messagesToCompact[messagesToCompact.length - 1];

    // Step 3: Calculate tokens before compaction
    let tokensBeforeCompaction = 0;
    for (const msg of messagesToCompact) {
      tokensBeforeCompaction += msg.tokenCount ?? estimateMessageTokens({ content: msg.content });
    }

    console.log(
      `[CompactionService] Compacting ${messagesToCompact.length} messages ` +
      `(${formatTokenCount(tokensBeforeCompaction)} tokens)`
    );

    // Step 4: Format messages for summarization
    const conversationText = this.formatMessagesForSummary(messagesToCompact, opts.preserveRules);

    // Step 5: Build prompt
    const previousSummarySection = session.summary
      ? `**Previous summary to incorporate:**\n\n${session.summary}\n\n`
      : "";

    const prompt = ENHANCED_COMPACTION_PROMPT
      .replace("{previousSummary}", previousSummarySection)
      .replace("{conversationText}", conversationText);

    try {
      // Step 6: Generate summary
      const { text: newSummary } = await generateText({
        model: getUtilityModel(),
        prompt,
        maxOutputTokens: opts.maxSummaryTokens,
      });

      // Step 7: Calculate tokens freed
      const summaryTokens = Math.ceil(newSummary.length / 4);
      const summarizedTokensFreed = tokensBeforeCompaction - summaryTokens;
      const totalTokensFreed = summarizedTokensFreed + autoPrunedTokens;

      console.log(
        `[CompactionService] Summary generated: ${formatTokenCount(summaryTokens)} tokens ` +
        `(freed ${formatTokenCount(summarizedTokensFreed)} from summarization)`
      );

      // Step 8: Update database
      await updateSessionSummary(sessionId, newSummary, lastMessageToCompact.id);

      // Mark exactly the messages that were summarized to avoid timestamp-boundary drift.
      const compactedIds = messagesToCompact.map((message) => message.id);
      await markMessagesAsCompactedByIds(sessionId, compactedIds);

      const duration = Date.now() - startTime;
      console.log(
        `[CompactionService] Compaction complete in ${duration}ms: ` +
        `${messagesToCompact.length} messages compacted, ` +
        `${formatTokenCount(totalTokensFreed)} tokens freed`
      );

      return {
        success: true,
        tokensFreed: totalTokensFreed,
        messagesCompacted: messagesToCompact.length,
        newSummary,
        breakdown: {
          autoPruned: autoPrunedTokens,
          summarized: summarizedTokensFreed,
        },
      };
    } catch (error) {
      console.error("[CompactionService] Failed to compact:", error);
      return {
        success: false,
        tokensFreed: autoPrunedTokens,
        messagesCompacted: 0,
        newSummary: "",
        error: error instanceof Error ? error.message : String(error),
        breakdown: { autoPruned: autoPrunedTokens, summarized: 0 },
      };
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

      // Truncate very long messages (but we already did smart truncation for tool results)
      if (Array.from(sanitizeUnicodeScalarValues(content)).length > 2000) {
        content = truncateSummaryText(content, 2000) + "... [truncated]";
      } else {
        content = sanitizeUnicodeScalarValues(content);
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

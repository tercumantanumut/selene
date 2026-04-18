import type { UIMessage } from "ai";
import {
  isInternalAssistantLeakText,
  isInternalToolHistoryLeakText,
} from "@/lib/messages/internal-tool-history";
import type { ContextProvenance } from "@/lib/context-window/scoped-counting-contract";
import { parseMessageMetadata } from "@/lib/messages/parse-metadata";

type ToolInvocationState = "input-streaming" | "input-available" | "output-available" | "output-error" | "output-denied";

interface DBTextContentPart extends ContextProvenance {
  type: "text";
  text: string;
}

interface DBImageContentPart extends ContextProvenance {
  type: "image";
  image: string;
  filename?: string;
  mediaType?: string;
}

interface DBFileContentPart extends ContextProvenance {
  type: "file";
  url: string;
  filename?: string;
  mediaType?: string;
}

export interface DBToolCallPart extends ContextProvenance {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args?: unknown;
  argsText?: string;
  state?: ToolInvocationState;
  /** Pending hint for unresolved persisted calls and live progress projections. */
  active?: boolean;
  /** Timestamp for pending projections so stale delegated calls can expire. */
  timestamp?: string;
}

export interface DBToolResultPart extends ContextProvenance {
  type: "tool-result";
  toolCallId: string;
  toolName?: string;
  result?: unknown;
  // Legacy rows used `output` instead of `result`.
  output?: unknown;
  state?: Extract<ToolInvocationState, "output-available" | "output-error" | "output-denied">;
  errorText?: string;
  preliminary?: boolean;
  status?: string;
  timestamp?: string;
}

// Database content part types
export type DBContentPart =
  | DBTextContentPart
  | DBImageContentPart
  | DBFileContentPart
  | DBToolCallPart
  | DBToolResultPart;

export interface DBMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
  createdAt: Date | string;
  orderingIndex?: number | null;
  metadata?: unknown;
  tokenCount?: number | null;
  toolCallId?: string | null;  // For role="tool" messages, references the parent tool call
}

/**
 * Returns true if any message in the array carries the `livePromptInjected`
 * metadata flag (regardless of role — both sealed assistant messages and
 * injected user messages are tagged). Drives reconciliation deferral for
 * mid-stream injection flows.
 */
export function hasLivePromptInjectedMessages(dbMessages: Pick<DBMessage, "metadata">[]): boolean {
  return dbMessages.some(m => {
    const meta = parseMessageMetadata(m.metadata);
    return meta?.livePromptInjected === true;
  });
}

/**
 * Count user + assistant messages. Injected live-prompt user rows ARE counted
 * as visible — they render as first-class messages in the thread, so the
 * count must include them for reconciliation predicates to match the UI
 * shape. Tool and system rows are excluded as they never render.
 */
export function countVisibleConversationMessages(dbMessages: Pick<DBMessage, "role">[]): number {
  return dbMessages.filter((message) => message.role === "user" || message.role === "assistant").length;
}

/**
 * Convert [PASTE_CONTENT:N:M]...[/PASTE_CONTENT:N] tags into clean display text.
 * These tags are preserved in DB storage and need to be rendered cleanly in the UI.
 */
function expandPasteContentForDisplay(text: string): string {
  return text.replace(
    /\[PASTE_CONTENT:(\d+):\d+\]\n([\s\S]*?)\n\[\/PASTE_CONTENT:\1\]/g,
    (_match, _n, content) => content
  );
}

function toMessageTimestampMs(value: Date | string): number {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getOrderingIndexValue(msg: DBMessage): number {
  return typeof msg.orderingIndex === "number" ? msg.orderingIndex : Number.MAX_SAFE_INTEGER;
}

function collectReferencedToolCallIds(content: DBContentPart[]): Set<string> {
  const ids = new Set<string>();
  for (const part of content) {
    if (part.type === "tool-call" && typeof part.toolCallId === "string") {
      ids.add(part.toolCallId);
    }
  }
  return ids;
}

function buildScopedFallbackResults(
  globalToolResults: Map<string, ToolResultInfo>,
  referencedToolCallIds: Set<string>
): Map<string, ToolResultInfo> | undefined {
  if (referencedToolCallIds.size === 0) {
    return undefined;
  }

  const scoped = new Map<string, ToolResultInfo>();
  for (const toolCallId of referencedToolCallIds) {
    const info = globalToolResults.get(toolCallId);
    if (info) {
      scoped.set(toolCallId, info);
    }
  }

  return scoped.size > 0 ? scoped : undefined;
}

// Simpler part type that works with any UIMessage
// Note: For tool parts, we use the typed format `tool-${toolName}` to match what the AI SDK
// sends during streaming. This ensures proper handling by AISDKMessageConverter which uses
// isToolUIPart (matches both static tool-* and dynamic-tool) but extracts toolName differently.
// Using tool-* format ensures the correct toolName extraction via type.replace("tool-", "").
type SimplePart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; url: string; filename?: string }
  | {
      type: `tool-${string}`;
      toolCallId: string;
      state: ToolInvocationState;
      input?: unknown;
      output?: unknown;
      errorText?: string;
      preliminary?: boolean;
      active?: boolean;
    };

type ToolResultInfo = {
  result?: unknown;
  state?: ToolInvocationState;
  errorText?: string;
  toolName?: string;
  preliminary?: boolean;
};

function cloneToolResultInfo(info: ToolResultInfo): ToolResultInfo {
  return {
    result: info.result,
    state: info.state,
    errorText: info.errorText,
    toolName: info.toolName,
    preliminary: info.preliminary,
  };
}

interface BuildUIPartsOptions {
  fallbackResults?: Map<string, ToolResultInfo>;
  preserveFallbackOrphans?: boolean;
  stripInternalToolLeakText?: boolean;
}

type PersistedAttachmentMetadata = {
  name?: string;
  contentType?: string;
  url?: string;
};

function collectAttachmentMetadataFromContent(content: DBContentPart[]): PersistedAttachmentMetadata[] {
  const seen = new Set<string>();
  const attachments: PersistedAttachmentMetadata[] = [];

  for (const part of content) {
    if (part.type !== "image" && part.type !== "file") {
      continue;
    }

    const url = part.type === "image" ? part.image : part.url;
    if (typeof url !== "string" || url.length === 0 || seen.has(url)) {
      continue;
    }

    seen.add(url);
    attachments.push({
      url,
      name: part.filename,
      contentType: part.mediaType,
    });
  }

  return attachments;
}

function buildUIPartsFromDBContent(
  content: DBContentPart[],
  options: BuildUIPartsOptions = {}
): SimplePart[] {
  if (!Array.isArray(content) || content.length === 0) {
    return [];
  }

  const {
    fallbackResults,
    preserveFallbackOrphans = true,
    stripInternalToolLeakText = true,
  } = options;
  const hasToolCallLikeParts = content.some(
    (part) => part.type === "tool-call" || part.type === "tool-result"
  );

  const toolResults = new Map<string, ToolResultInfo>();
  if (fallbackResults) {
    for (const [id, info] of fallbackResults) {
      toolResults.set(id, cloneToolResultInfo(info));
    }
  }

  for (const part of content) {
    if (part.type === "tool-result") {
      const toolOutput = part.result !== undefined ? part.result : part.output;
      const inferredResultState: ToolInvocationState =
        part.state ??
        (part.errorText || String(part.status || "").toLowerCase() === "error"
          ? "output-error"
          : "output-available");

      toolResults.set(part.toolCallId, {
        result: toolOutput,
        state: inferredResultState,
        errorText: part.errorText,
        toolName: part.toolName,
        preliminary: part.preliminary,
      });
    }
  }

  const parts: SimplePart[] = [];
  const renderedToolCallIds = new Set<string>();

  for (const part of content) {
    if (part.type === "text" && part.text?.trim()) {
      const displayText = expandPasteContentForDisplay(part.text);
      if (
        stripInternalToolLeakText &&
        (isInternalToolHistoryLeakText(displayText) ||
          isInternalAssistantLeakText(displayText, {
            hasToolCallLikeParts,
          }))
      ) {
        continue;
      }
      parts.push({ type: "text", text: displayText });
    } else if (part.type === "image" && part.image) {
      parts.push({
        type: "file",
        mediaType: part.mediaType || "image/jpeg",
        url: part.image,
        ...(part.filename ? { filename: part.filename } : {}),
      });
    } else if (part.type === "file" && part.url) {
      parts.push({
        type: "file",
        mediaType: part.mediaType || "application/octet-stream",
        url: part.url,
        ...(part.filename ? { filename: part.filename } : {}),
      });
    } else if (part.type === "tool-call") {
      if (renderedToolCallIds.has(part.toolCallId)) {
        continue;
      }
      const toolResult = toolResults.get(part.toolCallId);
      const inferredState: ToolInvocationState =
        toolResult?.state ||
        part.state ||
        (toolResult?.result !== undefined || toolResult?.errorText
          ? "output-available"
          : "input-available");

      // Validate and parse tool call input to prevent malformed data from being sent to AI providers
      // This fixes the issue where incomplete argsText from streaming interruptions causes API errors
      let validInput: unknown;

      if (part.args !== undefined) {
        if (typeof part.args === "string") {
          try {
            validInput = JSON.parse(part.args);
          } catch {
            console.warn(
              `[CONVERTER] Skipping tool call ${part.toolCallId} (${part.toolName}) with invalid args JSON. ` +
              `State: ${part.state}, args preview: ${part.args.substring(0, 50)}...`
            );
            continue; // Skip invalid tool call input; synthetic fallback may still render from tool-result
          }
        } else {
          validInput = part.args;
        }
      } else if (part.argsText) {
        // Fallback to argsText, but validate it's complete JSON first
        try {
          validInput = JSON.parse(part.argsText);
        } catch {
          // argsText is incomplete or malformed JSON - skip this tool call
          console.warn(
            `[CONVERTER] Skipping tool call ${part.toolCallId} (${part.toolName}) with invalid argsText. ` +
            `State: ${part.state}, argsText preview: ${part.argsText?.substring(0, 50)}...`
          );
          continue; // Skip this tool call entirely; synthetic fallback may still render from tool-result
        }
      } else if (part.state === "input-streaming") {
        // Tool call is still streaming (should not happen in persisted messages)
        console.warn(
          `[CONVERTER] Skipping tool call ${part.toolCallId} (${part.toolName}) with state "input-streaming" - likely a streaming interruption`
        );
        continue; // Skip incomplete streaming tool calls
      } else {
        // No args or argsText, but not in streaming state - assume empty args
        // This handles tools that accept no parameters (e.g., MCP tools with optional params)
        validInput = {};
      }

      const isValidInputObject =
        validInput !== undefined &&
        validInput !== null &&
        typeof validInput === "object" &&
        !Array.isArray(validInput);

      // Only add tool call if we have valid input
      if (isValidInputObject) {
        const hasFinalOutput = inferredState.startsWith("output") || toolResult?.result !== undefined;
        // Always emit as "output-available" when we have a result, even for errors.
        // The AISDKMessageConverter maps "output-error" → result={error: errorText},
        // which discards the full result object. Using "output-available" preserves
        // the complete result so tool UIs can render error details (stdout, stderr, etc.).
        const emitState: ToolInvocationState =
          hasFinalOutput && inferredState === "output-error" && toolResult?.result !== undefined
            ? "output-available"
            : inferredState;
        // Guard: a tool call with a matching result in ANY message is resolved —
        // never mark it active. This prevents rehydrated/replayed tool calls from
        // re-triggering dispatch in tool UIs after stream persistence.
        const isGloballyResolved = toolResults.has(part.toolCallId);
        parts.push({
          type: `tool-${part.toolName}` as `tool-${string}`,
          toolCallId: part.toolCallId,
          state: emitState,
          input: validInput,
          output: hasFinalOutput ? toolResult?.result ?? null : undefined,
          errorText: toolResult?.errorText,
          preliminary: toolResult?.preliminary,
          active: part.active === true && !hasFinalOutput && !isGloballyResolved,
        });
        renderedToolCallIds.add(part.toolCallId);
      } else {
        console.warn(
          `[CONVERTER] Skipping tool call ${part.toolCallId} (${part.toolName}) - invalid tool input`
        );
      }
    }
  }

  // Preserve standalone tool results (or calls skipped due malformed args) by
  // synthesizing a minimal tool UI part so history remains visible after reload.
  if (preserveFallbackOrphans) {
    for (const [toolCallId, toolResult] of toolResults) {
      if (renderedToolCallIds.has(toolCallId)) continue;

      const toolName = toolResult.toolName || "tool";
      const rawState: ToolInvocationState =
        toolResult.state ||
        (toolResult.errorText ? "output-error" : "output-available");
      // Same as above: emit "output-available" when we have a result to preserve
      // the full result through the AISDKMessageConverter.
      const state: ToolInvocationState =
        rawState === "output-error" && toolResult.result !== undefined
          ? "output-available"
          : rawState;

      parts.push({
        type: `tool-${toolName}` as `tool-${string}`,
        toolCallId,
        state,
        input: {},
        output: toolResult.result ?? null,
        errorText: toolResult.errorText,
        preliminary: toolResult.preliminary,
      });
    }
  }

  return parts;
}

function convertContentPartsToUIParts(content: DBContentPart[]): UIMessage["parts"] {
  const parts = buildUIPartsFromDBContent(content);
  return parts as UIMessage["parts"];
}

function buildMessageCustomMetadata(
  dbMeta: { usage?: Record<string, unknown>; cache?: Record<string, unknown>; custom?: Record<string, unknown> } | undefined,
  tokenCount: number | null | undefined,
  content: DBContentPart[]
): Record<string, unknown> {
  const customMetadata: Record<string, unknown> = {};

  if (dbMeta?.usage) {
    customMetadata.usage = dbMeta.usage;
  }
  if (dbMeta?.cache) {
    customMetadata.cache = dbMeta.cache;
  }
  if (tokenCount) {
    customMetadata.tokenCount = tokenCount;
  }
  if (dbMeta?.custom?.inspectContext) {
    customMetadata.inspectContext = dbMeta.custom.inspectContext;
  }

  const existingAttachments = Array.isArray(dbMeta?.custom?.attachments)
    ? dbMeta?.custom?.attachments
    : [];
  const fallbackAttachments = collectAttachmentMetadataFromContent(content);
  const attachments =
    existingAttachments.length > 0 ? existingAttachments : fallbackAttachments;
  if (attachments.length > 0) {
    customMetadata.attachments = attachments;
  }

  return customMetadata;
}

/**
 * Convert a database message to UIMessage format for assistant-ui
 */
function convertDBMessageToUIMessage(dbMessage: DBMessage): UIMessage | null {
  // Skip system/tool role messages
  if (dbMessage.role === "system" || dbMessage.role === "tool") {
    return null;
  }

  const content = dbMessage.content as DBContentPart[];
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }

  const parts = buildUIPartsFromDBContent(content, {
    stripInternalToolLeakText: dbMessage.role === "assistant",
  });

  if (parts.length === 0) {
    return null;
  }

  // Build metadata for assistant-ui format
  // assistant-ui expects custom data in metadata.custom
  const dbMeta = dbMessage.metadata as {
    usage?: Record<string, unknown>;
    cache?: Record<string, unknown>;
    custom?: Record<string, unknown>;
  } | undefined;
  const customMetadata = buildMessageCustomMetadata(dbMeta, dbMessage.tokenCount, content);

  return {
    id: dbMessage.id,
    role: dbMessage.role as "user" | "assistant",
    parts: parts as UIMessage["parts"],
    metadata: Object.keys(customMetadata).length > 0 ? { custom: customMetadata } : undefined,
  } as UIMessage;
}

/**
 * Convert an array of database messages to UIMessage format.
 *
 * This function processes messages sequentially and merges tool results
 * from separate role="tool" messages into their corresponding tool-call parts.
 * This prevents the runtime from detecting "pending" tool calls and re-executing them.
 */
export function convertDBMessagesToUIMessages(dbMessages: DBMessage[]): UIMessage[] {
  const sortedMessages = [...dbMessages].sort((a, b) => {
    const orderingDelta = getOrderingIndexValue(a) - getOrderingIndexValue(b);
    if (orderingDelta !== 0) return orderingDelta;
    const createdAtDelta = toMessageTimestampMs(a.createdAt) - toMessageTimestampMs(b.createdAt);
    if (createdAtDelta !== 0) return createdAtDelta;
    return a.id.localeCompare(b.id);
  });

  // First pass: collect all tool results from role="tool" messages.
  // These are kept in a global map, then scoped per assistant message in pass two.
  const globalToolResults = new Map<string, ToolResultInfo>();
  for (const dbMsg of sortedMessages) {
    if (dbMsg.role !== "tool") continue;

    const content = dbMsg.content as DBContentPart[];
    if (!Array.isArray(content) || content.length === 0) {
      continue;
    }

    const collectToolResult = (toolCallId: string, part: DBToolResultPart) => {
      const toolOutput = part.result !== undefined ? part.result : part.output;
      const inferredState: ToolInvocationState =
        part.state ??
        (part.errorText || String(part.status || "").toLowerCase() === "error"
          ? "output-error"
          : "output-available");

      globalToolResults.set(toolCallId, {
        result: toolOutput,
        state: inferredState,
        errorText: part.errorText,
        toolName: part.toolName,
        preliminary: part.preliminary,
      });
    };

    for (const part of content) {
      if (part.type === "tool-result" && part.toolCallId) {
        collectToolResult(part.toolCallId, part);
      }
    }

    // Also check if toolCallId is at message level (some storage patterns)
    if (dbMsg.toolCallId) {
      const firstToolResult = content.find(
        (part): part is DBToolResultPart => part.type === "tool-result"
      );
      if (firstToolResult) {
        collectToolResult(dbMsg.toolCallId, firstToolResult);
      }
    }
  }

  // Second pass: build UI messages, scoping tool fallbacks to each assistant turn.
  const result: UIMessage[] = [];

  for (const dbMsg of sortedMessages) {
    // Skip system/tool messages - tool results are merged into assistant turns.
    // Injected live-prompt user rows are kept: they render as first-class
    // user messages in the thread, matching the live in-memory shape so the
    // force-reload in handleForegroundRunFinished does not truncate under
    // assistant-ui's cached cursor.
    if (dbMsg.role === "system" || dbMsg.role === "tool") continue;

    const content = dbMsg.content as DBContentPart[];
    if (!Array.isArray(content) || content.length === 0) {
      console.warn(`[CONVERTER] Dropping ${dbMsg.role} message ${dbMsg.id}: empty content array`);
      continue;
    }

    const scopedFallbackResults = dbMsg.role === "assistant"
      ? buildScopedFallbackResults(globalToolResults, collectReferencedToolCallIds(content))
      : undefined;

    const inlineParts = buildUIPartsFromDBContent(content, {
      // Scope fallback results to tool calls referenced by this assistant turn.
      fallbackResults: scopedFallbackResults,
      stripInternalToolLeakText: dbMsg.role === "assistant",
    });

    if (inlineParts.length === 0) {
      if (dbMsg.role === "assistant") {
        // Keep a minimal assistant bubble so stream interruptions do not erase turn history.
        inlineParts.push({ type: "text", text: "" });
      } else {
        console.warn(
          `[CONVERTER] Dropping ${dbMsg.role} message ${dbMsg.id}: all parts sanitized or unsupported`
        );
        continue;
      }
    }

    // Build metadata for assistant-ui format
    const dbMeta = dbMsg.metadata as {
      usage?: Record<string, unknown>;
      cache?: Record<string, unknown>;
      custom?: Record<string, unknown>;
    } | undefined;
    const customMetadata = buildMessageCustomMetadata(dbMeta, dbMsg.tokenCount, content);

    result.push({
      id: dbMsg.id,
      role: dbMsg.role as "user" | "assistant",
      parts: inlineParts as UIMessage["parts"],
      metadata: Object.keys(customMetadata).length > 0 ? { custom: customMetadata } : undefined,
    } as UIMessage);
  }

  // Injected-user rows now sit BETWEEN the sealed and continuation assistant
  // rows, so the two assistants are not adjacent and assistant-ui's sibling
  // branch heuristic ("← 2 / 2 →" picker) never triggers. No post-processing
  // merge is applied — the previous mergeConsecutiveAssistantMessages helper
  // was a workaround for the now-removed hide filter above.
  return result;
}

// ThreadMessageLike content part types (what runtime.thread.reset() expects)
type ThreadContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string; filename?: string; mediaType?: string }
  | { type: "file"; url: string; filename?: string; mediaType?: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: any; result?: any };

interface ThreadMessageLike {
  id?: string;
  role: "user" | "assistant" | "system";
  content: ThreadContentPart[];
  createdAt?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Convert UIMessage (with parts) to ThreadMessageLike (with content)
 * runtime.thread.reset() expects ThreadMessageLike format, not UIMessage format
 */
function convertUIMessageToThreadMessageLike(msg: UIMessage): ThreadMessageLike {
  const content: ThreadContentPart[] = [];

  for (const part of msg.parts || []) {
    if (part.type === "text" && "text" in part) {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "file" && "url" in part) {
      // Preserve original attachment metadata so rehydrated user messages stay byte-for-byte stable.
      content.push({
        type: "file",
        url: part.url,
        ...(typeof part.mediaType === "string" ? { mediaType: part.mediaType } : {}),
        ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
      });
    } else if (part.type === "dynamic-tool" && "toolName" in part) {
      // Dynamic tool parts need to be converted to tool-call with result
      const toolPart = part as { toolName: string; toolCallId: string; input: unknown; output: unknown };
      content.push({
        type: "tool-call",
        toolCallId: toolPart.toolCallId,
        toolName: toolPart.toolName,
        args: toolPart.input as any,
        result: toolPart.output,
      });
    } else if (part.type.startsWith("tool-") && "toolCallId" in part) {
      // Static tool parts (AI SDK v6): type is "tool-{name}"
      const toolPart = part as { type: string; toolCallId: string; input: unknown; output: unknown };
      content.push({
        type: "tool-call",
        toolCallId: toolPart.toolCallId,
        toolName: part.type.slice(5), // strip "tool-" prefix
        args: toolPart.input as any,
        result: toolPart.output,
      });
    }
  }

  // If no content parts were created, add a placeholder text
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    id: msg.id,
    role: msg.role as "user" | "assistant" | "system",
    content,
    metadata: (msg as UIMessage & { metadata?: Record<string, unknown> }).metadata,
  };
}

/**
 * Convert UIMessage array to ThreadMessageLike[] for runtime.thread.reset()
 * This is needed because useChatRuntime's messages prop doesn't work properly
 * with unstable_useRemoteThreadListRuntime's thread management.
 */
export function convertToThreadMessageLike(messages: UIMessage[]): ThreadMessageLike[] {
  return messages.map(convertUIMessageToThreadMessageLike);
}

/**
 * Generate a stable signature for content parts to detect meaningful changes.
 * Used to prevent unnecessary re-renders during streaming.
 */
function getContentPartsSignature(parts: DBContentPart[]): string {
    if (!parts || parts.length === 0) return "";
    
    // Create a lightweight signature that captures meaningful changes
    return parts.map(part => {
        switch (part.type) {
            case "text":
                return `t:${part.text?.length || 0}:${part.text?.slice(-20) || ""}`;
            case "tool-call":
                return `tc:${part.toolCallId}:${part.state || "pending"}`;
            case "tool-result":
                return `tr:${part.toolCallId}:${part.state || "done"}`;
            case "image":
                return `i:${part.image?.slice(-20) || ""}`;
            default:
                return `u:${(part as any).type}`;
        }
    }).join("|");
}

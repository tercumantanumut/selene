import { isInternalToolHistoryLeakText } from "@/lib/messages/internal-tool-history";
import { UNKNOWN_TOOL_NAME } from "@/lib/messages/tool-name-placeholder";

export type CodexInputItem = {
  type?: string;
  role?: string;
  id?: string;
  call_id?: string;
  callId?: string;
  tool_call_id?: string;
  toolCallId?: string;
  name?: string;
  content?: unknown;
  output?: unknown;
  [key: string]: unknown;
};

/**
 * Max serialized payload bytes before truncation kicks in (990 KB).
 * The Codex API appears to enforce an undocumented ~1 MB request body
 * limit — sessions with 1.2 MB payloads fail with opaque "Unknown error".
 * Set to 990 KB to leave headroom for the instructions/model fields that
 * transformCodexRequest adds on top of the input array.
 */
export const MAX_CODEX_PAYLOAD_BYTES = 990 * 1024;
export const MAX_CODEX_VISION_PAYLOAD_BYTES = 5 * 1024 * 1024;

const TOOL_CALL_TYPES = new Set([
  "function_call",
  "local_shell_call",
  "custom_tool_call",
]);

const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "local_shell_call_output",
  "custom_tool_call_output",
]);

const toTrimmedString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const getCallId = (item: CodexInputItem): string | null =>
  toTrimmedString(item.call_id) ??
  toTrimmedString(item.callId) ??
  toTrimmedString(item.tool_call_id) ??
  toTrimmedString(item.toolCallId) ??
  toTrimmedString(item.id);

const isToolCallType = (type: unknown): type is string =>
  typeof type === "string" && TOOL_CALL_TYPES.has(type);

const isToolOutputType = (type: unknown): type is string =>
  typeof type === "string" && TOOL_OUTPUT_TYPES.has(type);

function isImageLikeContentPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const candidate = part as Record<string, unknown>;
  const type = typeof candidate.type === "string" ? candidate.type : "";
  const mediaType =
    typeof candidate.mediaType === "string"
      ? candidate.mediaType
      : typeof candidate.media_type === "string"
        ? candidate.media_type
        : "";

  if (
    type === "image" ||
    type === "input_image" ||
    type === "image_url" ||
    type === "file" ||
    type === "input_file"
  ) {
    return true;
  }

  if (mediaType.startsWith("image/")) {
    return true;
  }

  const possibleUrls = [
    candidate.image,
    candidate.image_url,
    candidate.url,
    candidate.file_url,
    candidate.file_data,
  ];

  return possibleUrls.some(
    (value) =>
      typeof value === "string" &&
      (value.startsWith("data:image/") || value.includes("image/"))
  );
}

function itemHasImageInput(item: CodexInputItem): boolean {
  if (!Array.isArray(item.content)) return false;
  return item.content.some((part) => isImageLikeContentPart(part));
}

function getCodexPayloadLimit(input: CodexInputItem[]): number {
  const hasImageInput = input.some((item) => item.role === "user" && itemHasImageInput(item));
  return hasImageInput ? MAX_CODEX_VISION_PAYLOAD_BYTES : MAX_CODEX_PAYLOAD_BYTES;
}

const mapOutputTypeToCallType = (outputType: string): string => {
  if (outputType === "local_shell_call_output") return "local_shell_call";
  if (outputType === "custom_tool_call_output") return "custom_tool_call";
  return "function_call";
};

const mapCallTypeToOutputType = (callType: string): string => {
  if (callType === "local_shell_call") return "local_shell_call_output";
  if (callType === "custom_tool_call") return "custom_tool_call_output";
  return "function_call_output";
};

const buildSyntheticCallFromOutput = (
  outputItem: CodexInputItem,
  callId: string
): CodexInputItem => {
  const toolName =
    typeof outputItem.name === "string" && outputItem.name.length > 0
      ? outputItem.name
      : UNKNOWN_TOOL_NAME;
  const callType = mapOutputTypeToCallType(outputItem.type ?? "function_call_output");

  return {
    type: callType,
    call_id: callId,
    name: toolName,
    arguments: "{}",
  };
};

const buildSyntheticOutputFromCall = (
  callItem: CodexInputItem,
  callId: string
): CodexInputItem => {
  const toolName =
    typeof callItem.name === "string" && callItem.name.length > 0
      ? callItem.name
      : UNKNOWN_TOOL_NAME;
  const outputType = mapCallTypeToOutputType(callItem.type ?? "function_call");

  return {
    type: outputType,
    call_id: callId,
    name: toolName,
    output: {
      status: "error",
      error: "Tool call had no persisted output in conversation history.",
      reconstructed: true,
    },
  };
};

function sanitizeAssistantMessageContent(item: CodexInputItem): CodexInputItem | null {
  if (item.type !== "message" || item.role !== "assistant") {
    return item;
  }

  if (typeof item.content === "string") {
    return isInternalToolHistoryLeakText(item.content) ? null : item;
  }

  if (!Array.isArray(item.content)) {
    return item;
  }

  const cleanedParts = item.content.filter((part) => {
    if (typeof part === "string") {
      return !isInternalToolHistoryLeakText(part);
    }
    if (!part || typeof part !== "object") return true;
    const maybeText = (part as { text?: unknown }).text;
    if (typeof maybeText === "string" && isInternalToolHistoryLeakText(maybeText)) {
      return false;
    }
    return true;
  });

  if (cleanedParts.length === 0) {
    return null;
  }

  return cleanedParts.length === item.content.length
    ? item
    : { ...item, content: cleanedParts };
}

function getImagePartUrl(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const candidate = part as Record<string, unknown>;
  return toTrimmedString(candidate.image_url)
    ?? toTrimmedString(candidate.image)
    ?? toTrimmedString(candidate.url)
    ?? toTrimmedString(candidate.file_url)
    ?? toTrimmedString(candidate.file_data);
}

function isValidCodexImageUrl(url: string): boolean {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/.test(url);
}

function sanitizeInvalidImageMessageContent(item: CodexInputItem): CodexInputItem | null {
  if (item.type !== "message" || !Array.isArray(item.content)) {
    return item;
  }

  let removedInvalidImage = false;
  const cleanedParts = item.content.filter((part) => {
    if (!isImageLikeContentPart(part)) {
      return true;
    }

    const imageUrl = getImagePartUrl(part);
    if (!imageUrl) {
      return true;
    }

    if (isValidCodexImageUrl(imageUrl)) {
      return true;
    }

    removedInvalidImage = true;
    return false;
  });

  if (!removedInvalidImage) {
    return item;
  }

  console.warn("[CODEX] Dropping invalid image payload from request history", {
    role: item.role,
    removedParts: item.content.length - cleanedParts.length,
  });

  if (cleanedParts.length === 0) {
    return null;
  }

  return {
    ...item,
    content: cleanedParts,
  };
}

/**
 * Extract nested tool-call parts from an assistant message's content array
 * and return them as top-level function_call items.
 *
 * When the AI SDK or stored session data includes tool-call parts nested
 * inside assistant message content (instead of as top-level function_call
 * items), the normalizer can't match them with their corresponding outputs.
 * This causes synthetic empty-arg calls to be created, bloating the payload.
 *
 * Returns [cleanedMessage, ...extractedCalls] or [originalMessage] if no
 * extraction was needed.
 */
function extractNestedToolCalls(item: CodexInputItem): CodexInputItem[] {
  if (item.type !== "message" || item.role !== "assistant") return [item];
  if (!Array.isArray(item.content)) return [item];

  const toolCallParts: CodexInputItem[] = [];
  const remainingContent: unknown[] = [];

  for (const part of item.content as Array<Record<string, unknown>>) {
    if (!part || typeof part !== "object") {
      remainingContent.push(part);
      continue;
    }

    // AI SDK format: {type: "tool-call", toolCallId, toolName, input}
    if (part.type === "tool-call" && typeof part.toolCallId === "string") {
      const args =
        part.input !== undefined ? JSON.stringify(part.input) : "{}";
      toolCallParts.push({
        type: "function_call",
        call_id: part.toolCallId as string,
        name: (typeof part.toolName === "string" && part.toolName.length > 0
          ? part.toolName
          : UNKNOWN_TOOL_NAME) as string,
        arguments: args,
      });
      continue;
    }

    // Responses API format nested inside content (shouldn't happen but be safe)
    if (
      isToolCallType(part.type as string | undefined) &&
      typeof (part.call_id ?? part.callId ?? part.toolCallId) === "string"
    ) {
      const cid = (part.call_id ?? part.callId ?? part.toolCallId) as string;
      toolCallParts.push({
        type: part.type as string,
        call_id: cid,
        name: (typeof part.name === "string" && part.name.length > 0
          ? part.name
          : UNKNOWN_TOOL_NAME) as string,
        arguments:
          typeof part.arguments === "string" ? part.arguments : "{}",
      });
      continue;
    }

    remainingContent.push(part);
  }

  if (toolCallParts.length === 0) return [item];

  const result: CodexInputItem[] = [];

  // Keep the assistant message with remaining content (text parts, etc.)
  if (remainingContent.length > 0) {
    result.push({ ...item, content: remainingContent });
  }

  // Add extracted tool calls as top-level items
  result.push(...toolCallParts);

  if (toolCallParts.length > 0) {
    console.log(
      `[CODEX] Extracted ${toolCallParts.length} nested tool-call parts from assistant message content`
    );
  }

  return result;
}

export function filterCodexInput(
  input: CodexInputItem[] | undefined,
): CodexInputItem[] | undefined {
  if (!Array.isArray(input)) return input;

  const normalized: CodexInputItem[] = [];

  for (const rawItem of input) {
    if (rawItem.type === "item_reference") continue;

    // Drop transient item IDs, but preserve tool correlation when upstream
    // encodes call IDs as `id` instead of `call_id`.
    const itemWithoutId = rawItem.id
      ? (({ id, ...rest }) => rest as CodexInputItem)(rawItem)
      : rawItem;
    const callId = getCallId(rawItem);
    const item =
      callId &&
      (isToolCallType(rawItem.type) || isToolOutputType(rawItem.type)) &&
      !toTrimmedString(itemWithoutId.call_id)
        ? { ...itemWithoutId, call_id: callId }
        : itemWithoutId;

    const sanitized = sanitizeAssistantMessageContent(item);
    if (!sanitized) continue;
    const imageSanitized = sanitizeInvalidImageMessageContent(sanitized);
    if (!imageSanitized) continue;

    // NOTE: We intentionally do NOT extract nested tool-call parts from
    // assistant message content arrays. The old extractNestedToolCalls()
    // created top-level function_call items without matching outputs,
    // which normalizeOrphanedToolOutputs then "fixed" with synthetic error
    // outputs. The model saw those errors as real failures and retried
    // the same tool calls → infinite loop. Nested tool-call parts stay
    // inside assistant content where they are harmless context.
    normalized.push(imageSanitized);
  }

  return normalized;
}

export function normalizeOrphanedToolOutputs(input: CodexInputItem[]): CodexInputItem[] {
  const normalized: CodexInputItem[] = [];
  const seenCallIds = new Set<string>();
  const seenOutputIds = new Set<string>();
  let reconstructedCalls = 0;
  let reconstructedResults = 0;
  let droppedDuplicateCalls = 0;
  let droppedDuplicateOutputs = 0;

  for (const item of input) {
    if (isToolCallType(item.type)) {
      const callId = getCallId(item);
      if (!callId) {
        normalized.push(item);
        continue;
      }

      if (seenCallIds.has(callId)) {
        droppedDuplicateCalls += 1;
        continue;
      }

      seenCallIds.add(callId);
      normalized.push(item);
      continue;
    }

    if (isToolOutputType(item.type)) {
      const callId = getCallId(item);
      if (!callId) {
        normalized.push(item);
        continue;
      }

      if (seenOutputIds.has(callId)) {
        droppedDuplicateOutputs += 1;
        continue;
      }

      if (!seenCallIds.has(callId)) {
        normalized.push(buildSyntheticCallFromOutput(item, callId));
        seenCallIds.add(callId);
        reconstructedCalls += 1;
      }

      seenOutputIds.add(callId);
      normalized.push(item);
      continue;
    }

    normalized.push(item);
  }

  for (const callId of seenCallIds) {
    if (seenOutputIds.has(callId)) continue;

    const callItem = normalized.find(
      (candidate) =>
        isToolCallType(candidate.type) &&
        getCallId(candidate) === callId
    );
    if (!callItem) continue;

    normalized.push(buildSyntheticOutputFromCall(callItem, callId));
    reconstructedResults += 1;
  }

  if (
    reconstructedCalls > 0 ||
    reconstructedResults > 0 ||
    droppedDuplicateCalls > 0 ||
    droppedDuplicateOutputs > 0
  ) {
    console.warn(
      `[CODEX] Normalized tool history before request: ` +
        `reconstructedCalls=${reconstructedCalls}, ` +
        `reconstructedResults=${reconstructedResults}, ` +
        `droppedDuplicateCalls=${droppedDuplicateCalls}, ` +
        `droppedDuplicateOutputs=${droppedDuplicateOutputs}`
    );
  }

  return normalized;
}

/**
 * Max bytes for a single non-tool item (anchor) before it gets truncated.
 * System prompts, developer messages, and assistant messages can be huge
 * (5MB+ in observed production cases). If anchors exceed the payload budget
 * on their own, no amount of tool-pair dropping helps — the model gets zero
 * context and loops. Capping anchors ensures room for recent tool history.
 */
const MAX_ANCHOR_ITEM_BYTES = 50 * 1024;

/**
 * Minimum number of recent tool pairs to preserve during last-resort
 * truncation. Without this floor, the model loses ALL tool history
 * when anchors are large, causing it to repeat the same tool calls
 * indefinitely (the observed infinite-loop bug).
 */
const MIN_PRESERVED_TOOL_PAIRS = 5;

/**
 * Truncate a message item's content if it exceeds maxBytes.
 * Handles both string content and array content (e.g. developer messages
 * with [{type: "input_text", text: "..."}]).
 */
function capItemContent(item: CodexInputItem, maxBytes: number): CodexInputItem {
  const serialized = JSON.stringify(item);
  if (serialized.length <= maxBytes) return item;

  // String content — simple truncation
  if (typeof item.content === "string") {
    const kept = item.content.slice(0, maxBytes);
    return {
      ...item,
      content: `${kept}\n\n[... system prompt truncated — original was ${(item.content.length / 1024).toFixed(0)} KB]`,
    };
  }

  // Array content (e.g. [{type: "input_text", text: "..."}])
  if (Array.isArray(item.content)) {
    const cappedParts: unknown[] = [];
    let budget = maxBytes;

    for (const part of item.content as Array<Record<string, unknown>>) {
      if (isImageLikeContentPart(part)) {
        cappedParts.push(part);
        budget -= JSON.stringify(part).length;
        continue;
      }

      const partStr = JSON.stringify(part);
      if (partStr.length <= budget) {
        cappedParts.push(part);
        budget -= partStr.length;
      } else if (budget > 200 && typeof part === "object" && part !== null) {
        // Try to truncate the text field within the part
        const textField = (part as { text?: string }).text;
        if (typeof textField === "string" && textField.length > 200) {
          const keptText = textField.slice(0, budget);
          cappedParts.push({
            ...part,
            text: `${keptText}\n\n[... truncated — original was ${(textField.length / 1024).toFixed(0)} KB]`,
          });
        }
        break;
      } else {
        break;
      }
    }

    return { ...item, content: cappedParts.length > 0 ? cappedParts : "[Content too large — truncated]" };
  }

  // Unknown structure — replace with placeholder
  return {
    ...item,
    content: `[Content truncated — original was ${(serialized.length / 1024).toFixed(0)} KB]`,
  };
}

/**
 * Truncate oversized Codex input when payload exceeds MAX_CODEX_PAYLOAD_BYTES.
 *
 * Truncation is purely byte-budget driven — no per-item caps.
 *
 * Strategy:
 * 1. If payload is within the byte budget, return as-is.
 * 2. Cap oversized anchor items (system prompts, developer messages) that
 *    can be 5MB+ and would starve the budget on their own.
 * 3. If still over budget, drop oldest tool call/output pairs until the
 *    payload fits. A developer message is inserted so the model knows what
 *    context was removed. At least MIN_PRESERVED_TOOL_PAIRS recent pairs
 *    are always kept.
 */
export function truncateCodexInput(input: CodexInputItem[]): CodexInputItem[] {
  const payloadLimit = getCodexPayloadLimit(input);

  // Fast path: payload within byte budget
  if (JSON.stringify(input).length <= payloadLimit) {
    return input;
  }

  // Phase 1: Cap oversized anchor items (non-tool items).
  // System prompts and developer messages can be 5MB+ — if anchors alone
  // exceed the budget, dropping tool pairs is futile and causes the model
  // to loop. Cap anchors so there's room for recent tool history.
  let cappedAnchors = 0;
  let capped = input.map((item) => {
    if (isToolCallType(item.type) || isToolOutputType(item.type)) return item;
    if (itemHasImageInput(item)) return item;
    const serialized = JSON.stringify(item);
    if (serialized.length <= MAX_ANCHOR_ITEM_BYTES) return item;

    cappedAnchors++;
    return capItemContent(item, MAX_ANCHOR_ITEM_BYTES);
  });

  if (cappedAnchors > 0) {
    console.log(
      `[CODEX] Capped ${cappedAnchors} oversized anchor items ` +
        `(max ${(MAX_ANCHOR_ITEM_BYTES / 1024).toFixed(0)} KB each)`
    );
  }

  // Re-check after anchor capping
  if (JSON.stringify(capped).length <= payloadLimit) {
    return capped;
  }

  // Phase 2: Drop oldest tool pairs until under byte budget, but ALWAYS
  // preserve at least MIN_PRESERVED_TOOL_PAIRS recent pairs.
  // Without this floor, the model loses all context and loops.
  type IndexedItem = { index: number; item: CodexInputItem };
  const anchors: IndexedItem[] = [];
  const toolItems: IndexedItem[] = [];

  for (let i = 0; i < capped.length; i++) {
    const item = capped[i];
    if (isToolCallType(item.type) || isToolOutputType(item.type)) {
      toolItems.push({ index: i, item });
    } else {
      anchors.push({ index: i, item });
    }
  }

  if (toolItems.length === 0) return capped;

  const pairMap = new Map<string, IndexedItem[]>();
  const pairOrder: string[] = [];

  for (const ti of toolItems) {
    const cid = getCallId(ti.item) ?? `__no_id_${ti.index}`;
    if (!pairMap.has(cid)) {
      pairMap.set(cid, []);
      pairOrder.push(cid);
    }
    pairMap.get(cid)!.push(ti);
  }

  // Never drop below this many recent pairs — model needs SOME context
  // to avoid repeating the same tool calls.
  const maxDroppable = Math.max(0, pairOrder.length - MIN_PRESERVED_TOOL_PAIRS);

  let dropCount = 0;
  const droppedToolNames = new Map<string, number>();

  const rebuild = (): CodexInputItem[] => {
    const kept = new Set<number>();
    for (const a of anchors) kept.add(a.index);
    for (let p = dropCount; p < pairOrder.length; p++) {
      for (const ti of pairMap.get(pairOrder[p])!) {
        kept.add(ti.index);
      }
    }
    return capped.filter((_, i) => kept.has(i));
  };

  while (
    dropCount < maxDroppable &&
    JSON.stringify(rebuild()).length > payloadLimit
  ) {
    // Track what we're dropping so we can summarize for the model
    const cid = pairOrder[dropCount];
    const pair = pairMap.get(cid)!;
    for (const ti of pair) {
      if (isToolCallType(ti.item.type)) {
        const name = typeof ti.item.name === "string" ? ti.item.name : "unknown";
        droppedToolNames.set(name, (droppedToolNames.get(name) || 0) + 1);
      }
    }
    dropCount++;
  }

  const result = rebuild();

  // Insert a summary so the model knows what context was trimmed
  if (dropCount > 0) {
    const droppedItems = capped.length - result.length;
    const preserved = pairOrder.length - dropCount;

    const toolSummary = Array.from(droppedToolNames.entries())
      .map(([name, count]) => `${name} (×${count})`)
      .join(", ");

    const summaryItem: CodexInputItem = {
      type: "message",
      role: "developer",
      content:
        `[Context trimmed: ${dropCount} earlier tool call/output pairs were removed ` +
        `to fit API payload limits. Removed: ${toolSummary}. ` +
        `${preserved} most recent pairs preserved below.]`,
    };

    // Insert summary before the first remaining tool item
    const firstToolIdx = result.findIndex(
      (item) => isToolCallType(item.type) || isToolOutputType(item.type)
    );
    if (firstToolIdx > 0) {
      result.splice(firstToolIdx, 0, summaryItem);
    } else if (firstToolIdx === 0) {
      result.unshift(summaryItem);
    } else {
      result.push(summaryItem);
    }

    console.warn(
      `[CODEX] Payload truncation: dropped ${droppedItems} items ` +
        `(${dropCount} tool pairs), ` +
        `${(JSON.stringify(capped).length / 1024).toFixed(0)}KB → ` +
        `${(JSON.stringify(result).length / 1024).toFixed(0)}KB, ` +
        `${preserved} pairs preserved` +
        `${preserved <= MIN_PRESERVED_TOOL_PAIRS ? ` (floor active)` : ""}`
    );
  }

  return result;
}

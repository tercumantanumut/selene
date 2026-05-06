/**
 * message-prep.ts
 *
 * Prepares messages for the AI streaming request:
 * - Builds refetch tools for tool-result enhancement
 * - Enhances frontend messages with DB tool results
 * - Converts messages to the AI SDK core format
 * - Splits tool-result parts from assistant messages for native Claude providers
 * - Strips stale <environment_details> and injects a fresh block
 */

import type { ModelMessage, UserModelMessage } from "ai";
import {
  createRetrieveFullContentTool,
} from "@/lib/ai/tools";
import { createWebSearchTool } from "@/lib/ai/web-search";
import { createVectorSearchToolV2 } from "@/lib/ai/vector-search";
import { createReadFileTool } from "@/lib/ai/tools/read-file-tool";
import { createLocalGrepTool } from "@/lib/ai/ripgrep";
import { createSendMessageToChannelTool } from "@/lib/ai/tools/channel-tools";
import { createSkillTool } from "@/lib/ai/tools/skill-tool";
import {
  enhanceFrontendMessagesWithToolResults,
  type FrontendMessage,
} from "@/lib/messages/tool-enhancement";
import { splitToolResultsFromAssistantMessages } from "./message-splitter";
import { extractContent } from "./content-extractor";
import { MAX_TOOL_REFETCH } from "./content-sanitizer";
import { getMessages } from "@/lib/db/queries-messages";
import type { DBContentPart } from "@/lib/messages/converter";
import { providerRejectsInlineImages } from "@/lib/ai/provider-types";

// ─── Provider-scoped reasoning re-injection ───────────────────────────────────

/**
 * Providers that require assistant-side `reasoning_content` to round-trip on
 * every follow-up request after a thinking-mode turn. DeepSeek's documented
 * contract: "The `reasoning_content` in the thinking mode must be passed back
 * to the API" — without it the server returns HTTP 400 on the next turn that
 * carries tool results from the same thread.
 *
 * Anthropic's thinking blocks ALSO need to round-trip, but they additionally
 * require a provider-issued `signature` that Selene does not currently capture
 * at the streaming layer — injecting reasoning without a signature breaks
 * requests to Claude. We therefore gate injection to DeepSeek only.
 */
const PROVIDERS_REQUIRING_REASONING_REPLAY = new Set<string>(["deepseek"]);

/**
 * Synthetic reasoning text used when an assistant message has no recorded
 * chain-of-thought. This happens when the conversation interleaves
 * foreign-provider turns (e.g. Claude Code, Codex, Kimi) with DeepSeek
 * thinking-mode turns: foreign providers emit responses without
 * `reasoning_content`, but DeepSeek's API in thinking mode requires
 * `reasoning_content` on every prior assistant message in the history.
 * Emitting this placeholder satisfies the round-trip contract without
 * misrepresenting what the other model thought.
 *
 * Historically scoped to tool-call turns only, but DeepSeek v4 rejects ANY
 * prior assistant turn missing reasoning — pure-text turns included. We
 * therefore synthesize a placeholder on every foreign turn that lacks
 * reasoning, not just tool-call turns.
 */
const FOREIGN_TOOL_CALL_REASONING_PLACEHOLDER =
  "(Tool calls on this turn were produced by a non-thinking-mode assistant; no chain-of-thought was captured. Continuing from the resulting tool outputs.)";

const FOREIGN_TEXT_REASONING_PLACEHOLDER =
  "(This turn was produced by a non-thinking-mode assistant; no chain-of-thought was captured. Continuing from the resulting text.)";

type StructuredAssistantPart = {
  type?: string;
  text?: unknown;
};

function getStructuredAssistantParts(msg: FrontendMessage): StructuredAssistantPart[] {
  if (Array.isArray(msg.parts)) {
    return msg.parts as StructuredAssistantPart[];
  }
  if (Array.isArray(msg.content)) {
    return msg.content as StructuredAssistantPart[];
  }
  return [];
}

function replaceStructuredAssistantParts(
  msg: FrontendMessage,
  parts: StructuredAssistantPart[],
): FrontendMessage {
  if (Array.isArray(msg.parts)) {
    return { ...msg, parts: parts as FrontendMessage["parts"] };
  }
  if (Array.isArray(msg.content)) {
    return { ...msg, content: parts };
  }
  return { ...msg, parts: parts as FrontendMessage["parts"] };
}

function collectReasoningTextsFromDbContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const part of content as DBContentPart[]) {
    if (part && (part as { type?: string }).type === "reasoning") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) {
        texts.push(text);
      }
    }
  }
  return texts;
}

/**
 * Returns true if the message's UI parts include at least one tool invocation
 * (any `tool-<name>`, `dynamic-tool`, or legacy `tool-call` part). A
 * `tool-result` alone does not count — it's the companion to a call, not the
 * call itself.
 */
function structuredAssistantPartsHaveToolCall(parts: StructuredAssistantPart[] | undefined): boolean {
  if (!Array.isArray(parts)) return false;
  for (const part of parts) {
    const type = part?.type;
    if (typeof type !== "string") continue;
    if (type === "tool-result") continue;
    if (type === "tool-call") return true;
    if (type === "dynamic-tool") return true;
    if (type.startsWith("tool-")) return true;
  }
  return false;
}

function structuredAssistantPartsHaveReasoning(parts: StructuredAssistantPart[] | undefined): boolean {
  if (!Array.isArray(parts)) return false;
  for (const part of parts) {
    if (part?.type === "reasoning" && typeof part.text === "string" && part.text.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Re-inject reasoning parts into assistant messages before `extractContent`
 * converts them to ModelMessages. Two cases are handled:
 *
 *   1. The DB has stored reasoning for the message — we restore it verbatim.
 *      The UI pipeline strips reasoning parts in `buildUIPartsFromDBContent`,
 *      so without this step reasoning never reaches the client (and therefore
 *      never makes it back into the outbound request).
 *
 *   2. The assistant message has tool-call parts but no reasoning anywhere
 *      (not in frontend parts, not in DB content). This is the foreign-model
 *      case: e.g. Claude Code or Codex produced tool calls without emitting
 *      `reasoning_content`. When the user later switches back to DeepSeek
 *      thinking mode, DeepSeek's API rejects the conversation with
 *      "The `reasoning_content` in the thinking mode must be passed back to
 *      the API." We inject a neutral placeholder reasoning block so the
 *      outbound request is valid. The placeholder describes the actual
 *      situation rather than fabricating thought.
 */
async function injectReasoningFromDbForProvider(
  frontendMessages: FrontendMessage[],
  sessionId: string,
  provider: string | undefined,
): Promise<FrontendMessage[]> {
  console.log(
    `[CHAT API] injectReasoningFromDbForProvider invoked: provider=${provider ?? "undefined"}, sessionId=${sessionId}, messages=${frontendMessages.length}`,
  );
  if (!provider || !PROVIDERS_REQUIRING_REASONING_REPLAY.has(provider)) {
    return frontendMessages;
  }

  const assistantIdsInRequest = new Set<string>();
  for (const msg of frontendMessages) {
    if (msg.role === "assistant" && typeof msg.id === "string" && msg.id.length > 0) {
      assistantIdsInRequest.add(msg.id);
    }
  }

  // Fetch DB content for all assistant messages in the request. We need this
  // for case 1 (verbatim replay) AND case 2 (detecting that the DB also has
  // no reasoning before we synthesize a placeholder).
  let reasoningByMessageId = new Map<string, string[]>();
  if (assistantIdsInRequest.size > 0) {
    try {
      const dbMessages = (await getMessages(sessionId)) as Array<{
        id: string;
        role: string;
        content: unknown;
      }>;
      for (const dbMsg of dbMessages) {
        if (dbMsg.role !== "assistant") continue;
        if (!assistantIdsInRequest.has(dbMsg.id)) continue;
        const texts = collectReasoningTextsFromDbContent(dbMsg.content);
        if (texts.length > 0) {
          reasoningByMessageId.set(dbMsg.id, texts);
        }
      }
    } catch (error) {
      console.warn(
        `[CHAT API] Failed to fetch DB messages for reasoning re-injection (provider=${provider}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Fall through — we may still synthesize placeholders from frontend
      // parts alone, which is better than letting the request fail.
      reasoningByMessageId = new Map();
    }
  }

  let matchedDbMessageCount = 0;
  let injectedFromDbCount = 0;
  let synthesizedPlaceholderCount = 0;
  let assistantToolCallTurnCount = 0;
  let assistantTurnsWithoutReasoningCount = 0;

  const enhanced = frontendMessages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    const existingParts = [...getStructuredAssistantParts(msg)];
    const hasFrontendReasoning = structuredAssistantPartsHaveReasoning(existingParts);
    const dbTexts =
      typeof msg.id === "string" ? reasoningByMessageId.get(msg.id) : undefined;
    const hasToolCall = structuredAssistantPartsHaveToolCall(existingParts);

    if (hasToolCall) {
      assistantToolCallTurnCount += 1;
    }
    if (!hasFrontendReasoning && (!dbTexts || dbTexts.length === 0)) {
      assistantTurnsWithoutReasoningCount += 1;
    }

    // Case 1: DB has reasoning — replay it (unless frontend already has the
    // same text, e.g. if a future refactor starts carrying reasoning through
    // the UI converter).
    if (dbTexts && dbTexts.length > 0) {
      matchedDbMessageCount += 1;
      const existingReasoningTexts = new Set<string>();
      for (const part of existingParts) {
        if (part && part.type === "reasoning" && typeof part.text === "string") {
          existingReasoningTexts.add(part.text);
        }
      }
      const reasoningParts = dbTexts
        .filter((text) => !existingReasoningTexts.has(text))
        .map((text) => ({ type: "reasoning" as const, text }));

      if (reasoningParts.length > 0) {
        injectedFromDbCount += reasoningParts.length;
        return replaceStructuredAssistantParts(msg, [...reasoningParts, ...existingParts]);
      }
      return msg;
    }

    // Case 2: No reasoning anywhere. DeepSeek thinking mode rejects any prior
    // assistant turn that lacks `reasoning_content`, regardless of whether
    // that turn performed a tool call or only produced text. A single
    // foreign-provider turn in history (Kimi, Claude Code, Codex, etc.)
    // otherwise poisons every subsequent DeepSeek request in the session.
    // Skip empty assistant turns (no text, no tool calls) — those are
    // placeholder rows that never went on the wire and don't need reasoning.
    const hasAnyMeaningfulPart = existingParts.some((part) => {
      const type = part?.type;
      if (typeof type !== "string") return false;
      if (type === "text") return typeof part.text === "string" && (part.text as string).length > 0;
      if (type === "tool-result") return false; // companion part only
      if (type === "tool-call" || type === "dynamic-tool" || type.startsWith("tool-")) return true;
      return false;
    });
    if (!hasFrontendReasoning && hasAnyMeaningfulPart) {
      synthesizedPlaceholderCount += 1;
      const placeholderText = hasToolCall
        ? FOREIGN_TOOL_CALL_REASONING_PLACEHOLDER
        : FOREIGN_TEXT_REASONING_PLACEHOLDER;
      return replaceStructuredAssistantParts(msg, [
        { type: "reasoning" as const, text: placeholderText },
        ...existingParts,
      ]);
    }

    return msg;
  });

  console.log(
    `[CHAT API] Reasoning re-injection for provider=${provider}: ` +
      `matched ${matchedDbMessageCount} DB message(s), ` +
      `${injectedFromDbCount} part(s) from DB, ` +
      `${synthesizedPlaceholderCount} placeholder(s) synthesized for foreign-provider turn(s), ` +
      `${assistantToolCallTurnCount} assistant tool-call turn(s) inspected, ` +
      `${assistantTurnsWithoutReasoningCount} assistant turn(s) had no reasoning before injection.`,
  );

  return enhanced;
}

// ─── Post-split reasoning guarantee ───────────────────────────────────────────

/**
 * Final safety net for providers that require `reasoning_content` on every
 * assistant message. `splitToolResultsFromAssistantMessages` can carve a single
 * assistant turn with trailing text into two assistant `ModelMessage`s (step 1:
 * text + tool-calls; step 2: post-tool-result text). The step-2 message does
 * not carry over reasoning from the original turn, so DeepSeek rejects it with:
 *   "The `reasoning_content` in the thinking mode must be passed back to the API."
 *
 * This pass runs AFTER the splitter and prepends a reasoning placeholder to any
 * assistant `ModelMessage` that has no reasoning part. Because `ModelMessage`
 * content can be either a string or a structured parts array, we normalize
 * string content to a `[reasoning, text]` array so the placeholder is always
 * addressable by the provider adapter.
 */
function ensureReasoningOnAllAssistantMessages(
  messages: ModelMessage[],
  provider: string | undefined,
): ModelMessage[] {
  if (!provider || !PROVIDERS_REQUIRING_REASONING_REPLAY.has(provider)) {
    return messages;
  }

  let injectedCount = 0;
  let inspectedCount = 0;

  const guarded = messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    inspectedCount += 1;

    // String content — no parts array to inspect. Wrap in a structured parts
    // array so we can prepend a reasoning block.
    if (typeof msg.content === "string") {
      const text = msg.content;
      if (text.length === 0) return msg;
      injectedCount += 1;
      return {
        ...msg,
        content: [
          { type: "reasoning", text: FOREIGN_TEXT_REASONING_PLACEHOLDER },
          { type: "text", text },
        ],
      } as ModelMessage;
    }

    if (!Array.isArray(msg.content)) return msg;

    const parts = msg.content as Array<{ type?: string; text?: unknown }>;
    const hasReasoning = parts.some(
      (p) => p?.type === "reasoning" && typeof p.text === "string" && (p.text as string).length > 0,
    );
    if (hasReasoning) return msg;

    // Skip empty arrays — nothing to guard.
    if (parts.length === 0) return msg;

    // Determine which placeholder to use: if the message carries any tool-call
    // part, use the tool-call placeholder; otherwise the pure-text one.
    const hasToolCallPart = parts.some((p) => {
      const type = p?.type;
      if (typeof type !== "string") return false;
      if (type === "tool-result") return false;
      return type === "tool-call" || type === "dynamic-tool" || type.startsWith("tool-");
    });
    const placeholderText = hasToolCallPart
      ? FOREIGN_TOOL_CALL_REASONING_PLACEHOLDER
      : FOREIGN_TEXT_REASONING_PLACEHOLDER;

    injectedCount += 1;
    return {
      ...msg,
      content: [
        { type: "reasoning", text: placeholderText },
        ...parts,
      ] as ModelMessage["content"],
    } as ModelMessage;
  });

  console.log(
    `[CHAT API] Post-split reasoning guarantee for provider=${provider}: ` +
      `inspected ${inspectedCount} assistant ModelMessage(s), ` +
      `injected reasoning placeholder into ${injectedCount} message(s).`,
  );

  return guarded;
}

// --- Lazy image references ---------------------------------------------------

// The set of image-rejecting providers lives in `lib/ai/provider-types.ts` so
// the chat composer can import the same helper and warn before send. Server-side
// prep uses the same capability to avoid sending pixels to blind providers.

type ImageReference = {
  reference: string;
  isDataUri: boolean;
  mediaType?: string;
};

const DATA_URI_PLACEHOLDER_PREVIEW = 96;
const MAX_URL_PLACEHOLDER_LENGTH = 512;
const RAW_BASE64_RE = /^[A-Za-z0-9+/=]+$/;

function extractImageReference(part: {
  type?: string;
  image?: unknown;
  mediaType?: unknown;
  data?: unknown;
  url?: unknown;
}): ImageReference | null {
  const mediaType = typeof part.mediaType === "string" ? part.mediaType : undefined;

  if (part.type === "image" && typeof part.image === "string" && part.image.length > 0) {
    const image = part.image;
    if (mediaType && RAW_BASE64_RE.test(image) && image.length > 32) {
      return { reference: `data:${mediaType};base64,${image}`, isDataUri: true, mediaType };
    }
    if (image.startsWith("data:")) {
      return { reference: image, isDataUri: true, mediaType };
    }
    return { reference: image, isDataUri: false, mediaType };
  }

  if (part.type === "file") {
    for (const field of ["data", "url", "image"] as const) {
      const value = (part as Record<string, unknown>)[field];
      if (typeof value !== "string" || value.length === 0) continue;
      if (value.startsWith("data:")) {
        return { reference: value, isDataUri: true, mediaType };
      }
      return { reference: value, isDataUri: false, mediaType };
    }
  }

  return null;
}

function escapeForToolString(value: string): string {
  return value.replace(/["\\\n\r]/g, (ch) =>
    ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : `\\${ch}`,
  );
}

function formatLazyImageReference(ref: ImageReference | null): string {
  const prefix = "[Attachment image: ";
  if (!ref) {
    return `${prefix}image unavailable - no stable URL could be recovered; ask the user to re-attach or switch to a vision-capable provider.]`;
  }

  if (ref.isDataUri) {
    const preview = ref.reference.slice(0, DATA_URI_PLACEHOLDER_PREVIEW);
    return (
      `${prefix}inline base64 (${ref.mediaType || "unknown type"}) preview=\`${preview}...\` - ` +
      "not addressable by stable URL. Ask the user to re-attach the image if you need to view it again.]"
    );
  }

  const displayUrl =
    ref.reference.length > MAX_URL_PLACEHOLDER_LENGTH
      ? `${ref.reference.slice(0, MAX_URL_PLACEHOLDER_LENGTH - 3)}...`
      : ref.reference;
  return `${prefix}to view, call readFile("${escapeForToolString(displayUrl)}")]`;
}

function formatBlindProviderImageReference(ref: ImageReference | null): string {
  const base =
    "[image attachment omitted - selected provider cannot view images in Selene. " +
    "Switch to a vision-capable model to inspect this attachment.";
  if (!ref || ref.isDataUri) {
    return `${base}]`;
  }
  const displayUrl =
    ref.reference.length > MAX_URL_PLACEHOLDER_LENGTH
      ? `${ref.reference.slice(0, MAX_URL_PLACEHOLDER_LENGTH - 3)}...`
      : ref.reference;
  return `${base} Attachment ref: ${escapeForToolString(displayUrl)}]`;
}

type ImageRewriteResult = {
  messages: ModelMessage[];
  droppedImageCount: number;
  droppedReferenceCount: number;
};

function rewriteImagePartsForProvider(
  messages: ModelMessage[],
  provider: string | undefined,
): ImageRewriteResult {
  const providerRejectsImages = providerRejectsInlineImages(provider);
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  let droppedImageCount = 0;
  let droppedReferenceCount = 0;
  let touchedMessageCount = 0;

  const rewrittenMessages = messages.map((msg, msgIdx) => {
    if (msg.role === "tool") return msg;
    if (!Array.isArray(msg.content)) return msg;

    const isCurrentUserTurn = msg.role === "user" && msgIdx === lastUserIdx;
    const shouldKeepInline = isCurrentUserTurn && !providerRejectsImages;
    if (shouldKeepInline) return msg;

    const parts = msg.content as Array<{
      type?: string;
      image?: unknown;
      mediaType?: unknown;
      data?: unknown;
      url?: unknown;
    }>;

    let changed = false;
    const rewritten: typeof parts = [];
    for (const part of parts) {
      const type = part?.type;
      const mediaType = typeof part?.mediaType === "string" ? part.mediaType : "";
      const isImagePart = type === "image";
      const isFileImage = type === "file" && mediaType.startsWith("image/");

      if (isImagePart || isFileImage) {
        droppedImageCount += 1;
        changed = true;
        const ref = extractImageReference(part);
        if (ref) droppedReferenceCount += 1;
        const text = providerRejectsImages
          ? formatBlindProviderImageReference(ref)
          : formatLazyImageReference(ref);
        rewritten.push({ type: "text", text } as typeof part);
        continue;
      }

      rewritten.push(part);
    }

    if (!changed) return msg;
    touchedMessageCount += 1;
    return { ...msg, content: rewritten as ModelMessage["content"] } as ModelMessage;
  });

  if (droppedImageCount > 0) {
    console.log(
      `[CHAT API] Rewrote ${droppedImageCount} image part(s) across ${touchedMessageCount} message(s) ` +
        `for provider=${provider ?? "unknown"} (recovered ${droppedReferenceCount}/${droppedImageCount} ref(s), ` +
        `providerRejectsImages=${providerRejectsImages}).`,
    );
  }

  return { messages: rewrittenMessages, droppedImageCount, droppedReferenceCount };
}

// ─── Public interface ─────────────────────────────────────────────────────────

interface MessagePrepArgs {
  messages: FrontendMessage[];
  sessionId: string;
  userId: string;
  characterId: string | null;
  sessionMetadata: Record<string, unknown>;
  currentModelId: string | undefined;
  currentProvider: string | undefined;
  sessionSummary?: string | null;
}

interface MessagePrepResult {
  coreMessages: ModelMessage[];
  enhancedMessages: FrontendMessage[];
  /**
   * Count of image parts rewritten to text because they were stale history
   * images or the active provider cannot view inline images.
   */
  droppedImagesForProvider: number;
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function prepareMessagesForRequest(
  args: MessagePrepArgs
): Promise<MessagePrepResult> {
  const {
    messages,
    sessionId,
    userId,
    characterId,
    sessionMetadata,
    currentModelId,
    currentProvider,
    sessionSummary,
  } = args;

  // Build refetch tools for enhanceFrontendMessagesWithToolResults
  const refetchTools = {
    sendMessageToChannel: createSendMessageToChannelTool({
      sessionId,
      userId,
      sessionMetadata,
    }),
    readFile: createReadFileTool({
      sessionId,
      userId,
      characterId: characterId || null,
    }),
    localGrep: createLocalGrepTool({
      sessionId,
      characterId: characterId || null,
    }),
    vectorSearch: createVectorSearchToolV2({
      sessionId,
      userId,
      characterId: characterId || null,
      sessionMetadata,
    }),
    webSearch: createWebSearchTool({
      sessionId,
      userId,
      characterId: characterId || null,
    }),
    retrieveFullContent: createRetrieveFullContentTool({ sessionId }),
    skill: createSkillTool({
      sessionId,
      userId,
      characterId: characterId || "",
    }),
  };

  // Enhance frontend messages with tool results from database
  let enhancedMessages = await enhanceFrontendMessagesWithToolResults(
    messages,
    sessionId,
    {
      refetchTools,
      maxRefetch: MAX_TOOL_REFETCH,
    }
  );

  console.log(
    `[CHAT API] Enhanced ${enhancedMessages.length} messages with DB tool results`
  );

  // Providers with mandatory reasoning replay (DeepSeek thinking mode) require
  // `reasoning_content` on every follow-up request. The UI pipeline strips
  // reasoning parts, so we restore them from the DB here before extraction.
  enhancedMessages = await injectReasoningFromDbForProvider(
    enhancedMessages,
    sessionId,
    currentProvider,
  );

  const lastUserMessageIndex = enhancedMessages.map((msg) => msg.role).lastIndexOf("user");

  // Convert to core format for the AI SDK. Only the current user turn is allowed
  // to inline pixels; older images stay as stable refs and are rewritten below.
  let coreMessages: ModelMessage[] = await Promise.all(
    enhancedMessages.map(async (msg, idx) => {
      const shouldInlineUserImages =
        msg.role === "user" &&
        idx === lastUserMessageIndex &&
        !providerRejectsInlineImages(currentProvider);
      const content = await extractContent(
        msg as Parameters<typeof extractContent>[0],
        true, // includeUrlHelpers
        shouldInlineUserImages,
        sessionId
      );
      console.log(
        `[CHAT API] Message ${idx} (${msg.role}):`,
        JSON.stringify(
          {
            hasParts: !!(msg as { parts?: unknown[] }).parts,
            partsCount: (msg as { parts?: unknown[] }).parts?.length,
            partTypes: (
              msg as { parts?: Array<{ type: string }> }
            ).parts?.map((p) => p.type),
            contentType:
              typeof content === "string" ? "string" : "array",
            contentLength:
              typeof content === "string"
                ? content.length
                : (content as unknown[]).length,
            contentPreview:
              Array.isArray(content)
                ? (content as Array<{ type: string; image?: string; text?: string }>).map((part) => ({
                    type: part.type,
                    hasImage: typeof part.image === "string",
                    imagePreview:
                      typeof part.image === "string"
                        ? part.image.slice(0, 80)
                        : undefined,
                    textPreview:
                      typeof part.text === "string"
                        ? part.text.slice(0, 120)
                        : undefined,
                  }))
                : typeof content === "string"
                  ? content.slice(0, 200)
                  : null,
          },
          null,
          2
        )
      );
      return {
        role: msg.role as "user" | "assistant" | "system",
        content,
      } as ModelMessage;
    })
  );

  // Split tool-result parts from assistant messages into separate role:"tool"
  // messages. Both Anthropic and OpenAI APIs require tool results as distinct
  // messages — the AI SDK OpenAI converter silently drops tool-result parts
  // that remain inline in assistant messages, causing "Tool results are missing"
  // errors on follow-up turns.
  coreMessages = splitToolResultsFromAssistantMessages(coreMessages);

  // Final safety net: the splitter may synthesize new assistant messages from
  // trailing text after tool calls, which inherit no reasoning. DeepSeek
  // thinking mode rejects any assistant message without `reasoning_content`,
  // so we prepend a placeholder to any assistant ModelMessage still missing
  // reasoning after all prior injections.
  coreMessages = ensureReasoningOnAllAssistantMessages(coreMessages, currentProvider);

  // Current-turn images stay inline for vision-capable providers. All prior
  // image parts become lazy refs that the model can materialize with readFile.
  // Blind providers (DeepSeek) get a transparent refusal placeholder instead.
  const imageStripResult = rewriteImagePartsForProvider(coreMessages, currentProvider);
  coreMessages = imageStripResult.messages;
  const droppedImagesForProvider = imageStripResult.droppedImageCount;

  if (sessionSummary?.trim()) {
    coreMessages = [
      {
        role: "system",
        content: `Previous conversation summary:\n${sessionSummary.trim()}`,
      },
      ...coreMessages,
    ];
  }

  // Log coreMessages structure after all sanitization
  console.log(
    `[CHAT API] Final coreMessages (${coreMessages.length} messages) before streamText:`
  );
  coreMessages.forEach((msg, idx) => {
    if (typeof msg.content === "string") {
      console.log(
        `  [${idx}] role=${msg.role}, content=string(${msg.content.length})`
      );
    } else if (Array.isArray(msg.content)) {
      const types = (
        msg.content as Array<{ type: string; toolCallId?: string; image?: string; mediaType?: string }>
      ).map((p) => {
        const suffix = p.toolCallId
          ? `:${p.toolCallId}`
          : p.type === "image"
            ? ":image"
            : p.type === "file" && typeof p.mediaType === "string"
              ? `:${p.mediaType}`
              : "";
        return p.type + suffix;
      });
      console.log(
        `  [${idx}] role=${msg.role}, parts=[${types.join(", ")}]`
      );
      if (msg.role === "user") {
        console.log(
          `  [${idx}] userContentDetail=${JSON.stringify(
            (msg.content as Array<{ type: string; image?: string; text?: string; mediaType?: string }>).map((part) => ({
              type: part.type,
              mediaType: part.mediaType,
              imagePreview:
                typeof part.image === "string" ? part.image.slice(0, 120) : undefined,
              textPreview:
                typeof part.text === "string" ? part.text.slice(0, 120) : undefined,
            })),
          )}`
        );
      }
    }
  });

  // Validate tool call inputs before sending to AI SDK
  coreMessages.forEach((msg, idx) => {
    if (Array.isArray(msg.content)) {
      msg.content.forEach((part: any, partIdx) => {
        if (part.type === "tool-use" && part.input !== undefined) {
          if (typeof part.input === "string") {
            try {
              JSON.parse(part.input);
              console.warn(
                `[CHAT API] Tool input at message ${idx}, part ${partIdx} is a JSON string instead of object. ` +
                  `This may cause API errors. Tool: ${part.toolName}`
              );
            } catch (e) {
              console.error(
                `[CHAT API] Invalid tool input at message ${idx}, part ${partIdx}: ` +
                  `Tool: ${part.toolName}, Input: ${part.input
                    ?.toString()
                    .substring(0, 100)}`
              );
            }
          }
        }
      });
    }
  });

  // ── Environment details injection ──────────────────────────────────────────
  // Strip stale <environment_details> from all user messages, then inject a
  // fresh block with current server time + user timezone into the last user message.
  const envDetailsRegex =
    /\n*<environment_details>[\s\S]*?<\/environment_details>/g;

  function stripEnvDetails(userMsg: UserModelMessage): UserModelMessage {
    if (typeof userMsg.content === "string") {
      return {
        ...userMsg,
        content: userMsg.content.replace(envDetailsRegex, ""),
      };
    }
    return {
      ...userMsg,
      content: userMsg.content.map((part) =>
        part.type === "text"
          ? { ...part, text: part.text.replace(envDetailsRegex, "") }
          : part
      ),
    };
  }

  for (let i = 0; i < coreMessages.length; i++) {
    const msg = coreMessages[i];
    if (msg.role !== "user") continue;
    coreMessages[i] = stripEnvDetails(msg);
  }

  // Inject fresh environment_details into the last user message
  {
    const envNow = new Date();
    const userTz = (sessionMetadata?.userTimezone as string) || null;
    const tzOffset = userTz
      ? (() => {
          try {
            const fmt = new Intl.DateTimeFormat("en", {
              timeZone: userTz,
              timeZoneName: "shortOffset",
            });
            const offset =
              fmt
                .formatToParts(envNow)
                .find((p) => p.type === "timeZoneName")?.value || "";
            return offset.replace("GMT", "UTC");
          } catch {
            return "";
          }
        })()
      : "";
    const envBlock =
      `\n\n<environment_details>\nCurrent time: ${envNow.toISOString()}` +
      (userTz ? `\nUser timezone: ${userTz}, ${tzOffset}` : "") +
      `\n</environment_details>`;

    const lastUserIdx = coreMessages.map((m) => m.role).lastIndexOf("user");
    if (lastUserIdx !== -1) {
      const msg = coreMessages[lastUserIdx];
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          coreMessages[lastUserIdx] = {
            ...msg,
            content: msg.content + envBlock,
          };
        } else {
          coreMessages[lastUserIdx] = {
            ...msg,
            content: [
              ...msg.content,
              { type: "text" as const, text: envBlock },
            ],
          };
        }
      }
    }
  }

  return { coreMessages, enhancedMessages, droppedImagesForProvider };
}

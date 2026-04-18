import { readLocalFile } from "@/lib/storage/local-storage";
import { parseDataUrl } from "@/lib/storage/data-url";
import {
  createChannelMessage,
  getChannelConnection,
  getChannelConversation,
  getSession,
  touchChannelConversation,
  updateSession,
} from "@/lib/db/queries";
import { getCharacter } from "@/lib/characters/queries";
import type { DBContentPart } from "@/lib/messages/converter";
import { getChannelManager } from "./manager";
import type { ChannelAttachment } from "./types";
import { loadSettings } from "@/lib/settings/settings-manager";
import { isTTSAvailable, synthesizeSpeech, shouldSummarizeForTTS, summarizeForTTS, getAudioForChannel } from "@/lib/tts/manager";
import { parseTTSDirectives } from "@/lib/tts/directives";
import { INTERACTIVE_TOOL_NAME_SET } from "@/lib/interactive-tools/constants";
import { formatTextForTTS } from "@/lib/voice/format-tts-text";

export async function deliverChannelReply(params: {
  sessionId: string;
  messageId: string;
  content: DBContentPart[];
  sessionMetadata: Record<string, unknown>;
  rawMode?: boolean;
}): Promise<void> {
  const conversationId = params.sessionMetadata.channelConversationId as string | undefined;
  if (!conversationId) {
    return;
  }

  const conversation = await getChannelConversation(conversationId);
  if (!conversation) {
    return;
  }

  const connection = await getChannelConnection(conversation.connectionId);
  if (!connection) {
    return;
  }

  const { text: rawText, attachments } = await buildOutgoingPayload(params.content);
  if (!rawText && attachments.length === 0) {
    return;
  }

  // Parse [[tts:...]] directives from LLM output
  const { text, directive: ttsDirective } = parseTTSDirectives(rawText);

  // Load per-agent voice config from character metadata
  const characterId = params.sessionMetadata.characterId as string | undefined;
  let agentVoiceConfig: import("@/lib/tts/directives").TTSDirective | null = null;
  if (characterId) {
    try {
      const character = await getCharacter(characterId);
      const meta = character?.metadata as Record<string, unknown> | null;
      if (meta?.voiceConfig && typeof meta.voiceConfig === "object") {
        agentVoiceConfig = meta.voiceConfig as import("@/lib/tts/directives").TTSDirective;
      }
    } catch {
      // Ignore character lookup failures
    }
  }

  // Merge: directive overrides > agent voice config > global defaults
  const mergedDirective = agentVoiceConfig || ttsDirective
    ? { ...agentVoiceConfig, ...ttsDirective }
    : ttsDirective;

  // TTS: Convert text reply to audio attachment if enabled
  const ttsAttachment = await maybeGenerateTTSAttachment(text, connection.channelType, mergedDirective);
  const allAttachments = [...attachments];
  if (ttsAttachment) {
    allAttachments.push(ttsAttachment);
  }

  const manager = getChannelManager();
  const { text: sendText, parseMode } = params.rawMode
    ? rawModeTextTransform(text)
    : { text, parseMode: undefined };
  const result = await manager.sendMessage(connection.id, {
    peerId: conversation.peerId,
    threadId: conversation.threadId,
    text: sendText || " ",
    attachments: allAttachments.length > 0 ? allAttachments : undefined,
    parseMode,
  });

  await createChannelMessage({
    connectionId: connection.id,
    channelType: connection.channelType,
    externalMessageId: result.externalMessageId,
    sessionId: params.sessionId,
    messageId: params.messageId,
    direction: "outbound",
  });

  await touchChannelConversation(conversation.id);
}

// Interactive tool calls are delivered directly by the channel bridge.
// Text before the interactive question is suppressed to avoid duplicate noise.
const INTERACTIVE_DELIVERY_SUPPRESSIONS = INTERACTIVE_TOOL_NAME_SET;

async function buildOutgoingPayload(content: DBContentPart[]): Promise<{
  text: string;
  attachments: ChannelAttachment[];
}> {
  const textChunks: string[] = [];
  const attachments: ChannelAttachment[] = [];
  const imageUrls: string[] = [];

  // Find the last interactive tool-result to determine the text start index.
  // Text before the interactive question is suppressed; text after it (the AI's
  // follow-up once the user answered) is delivered.
  const hasInteractiveToolCall = content.some(
    (p) => p.type === "tool-call" && INTERACTIVE_DELIVERY_SUPPRESSIONS.has((p as { toolName?: string }).toolName ?? ""),
  );
  let textStartIndex = 0;
  if (hasInteractiveToolCall) {
    // Find the last tool-result for an interactive tool. Text after it is the
    // AI's continuation once the question was answered — deliver that.
    let lastInteractiveResultIndex = -1;
    for (let i = content.length - 1; i >= 0; i--) {
      const p = content[i];
      if (p.type === "tool-result" && INTERACTIVE_DELIVERY_SUPPRESSIONS.has((p as { toolName?: string }).toolName ?? "")) {
        lastInteractiveResultIndex = i;
        break;
      }
    }
    // If no result exists (question is still pending), suppress all text.
    textStartIndex = lastInteractiveResultIndex >= 0 ? lastInteractiveResultIndex + 1 : content.length;
  }

  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (part.type === "text" && part.text && i >= textStartIndex) {
      textChunks.push(part.text);
    }
    if (part.type === "image" && part.image) {
      imageUrls.push(part.image);
    }
    if (part.type === "tool-result") {
      const result = (part as { result?: unknown }).result;
      if (result) {
        imageUrls.push(...extractImageUrlsFromToolResult(result));
      }
    }
  }

  for (const imageUrl of imageUrls) {
    const attachment = await resolveImageAttachment(imageUrl);
    if (attachment) {
      attachments.push(attachment);
      break;
    }
  }

  return {
    text: textChunks.join("\n").trim(),
    attachments,
  };
}

async function resolveImageAttachment(url: string): Promise<ChannelAttachment | null> {
  if (!url) return null;

  if (url.startsWith("/api/media/")) {
    const relativePath = url.replace("/api/media/", "");
    const buffer = readLocalFile(relativePath);
    const filename = relativePath.split("/").pop() || "image.jpg";
    return {
      type: "image",
      filename,
      mimeType: "image/jpeg",
      data: buffer,
    };
  }

  if (url.startsWith("http")) {
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    const mimeType = response.headers.get("content-type") || "image/jpeg";
    return {
      type: "image",
      filename: `image-${Date.now()}.jpg`,
      mimeType,
      data: Buffer.from(arrayBuffer),
    };
  }

  if (url.startsWith("data:")) {
    const parsed = parseDataUrl(url);
    if (!parsed || !parsed.mimeType.startsWith("image/")) {
      return null;
    }
    const extension = parsed.mimeType.split("/")[1] || "png";
    return {
      type: "image",
      filename: `image-${Date.now()}.${extension}`,
      mimeType: parsed.mimeType,
      data: Buffer.from(parsed.data, "base64"),
    };
  }

  return null;
}

function extractImageUrlsFromToolResult(result: unknown): string[] {
  const urls: string[] = [];
  if (!result || typeof result !== "object") {
    return urls;
  }

  const record = result as Record<string, unknown>;

  // Ephemeral-stub format (canonical-content.ts#makeEphemeralStubResult):
  // when an ephemeralResults tool is replayed from history, only `mediaRefs`
  // survives — the original `images`/`videos`/`content` shape was dropped.
  // Channel delivery only attaches images, so we keep refs whose `mimeType`
  // either starts with `image/` or is missing entirely (missing-mimeType is
  // treated optimistically as image; the downstream loader validates the
  // actual content-type on fetch). Refs with an explicit non-image mimeType
  // are intentionally skipped here — do not remove this guard.
  const mediaRefs = record.mediaRefs;
  if (Array.isArray(mediaRefs)) {
    for (const item of mediaRefs) {
      if (!item || typeof item !== "object") continue;
      const refRecord = item as Record<string, unknown>;
      const refUrl = typeof refRecord.url === "string" ? refRecord.url : undefined;
      if (!refUrl) continue;
      const mimeType = typeof refRecord.mimeType === "string" ? refRecord.mimeType : undefined;
      if (mimeType && !mimeType.startsWith("image/")) continue;
      urls.push(refUrl);
    }
  }

  const images = record.images;
  if (Array.isArray(images)) {
    for (const item of images) {
      if (typeof item === "string") {
        urls.push(item);
      } else if (item && typeof item === "object") {
        const imageRecord = item as Record<string, unknown>;
        const nestedUrl = (imageRecord.image_url as Record<string, unknown> | undefined)?.url;
        const imageUrl =
          (typeof imageRecord.url === "string" && imageRecord.url) ||
          (typeof imageRecord.imageUrl === "string" && imageRecord.imageUrl) ||
          (typeof imageRecord.image_url === "string" && imageRecord.image_url) ||
          (typeof nestedUrl === "string" ? nestedUrl : undefined);
        if (imageUrl) {
          urls.push(imageUrl);
        }
      }
    }
  }

  const directUrl =
    (typeof record.image_url === "string" && record.image_url) ||
    (typeof record.imageUrl === "string" && record.imageUrl) ||
    (typeof record.image === "string" && record.image) ||
    (typeof record.url === "string" && record.url);
  if (directUrl) {
    urls.push(directUrl);
  }

  const content = record.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const contentRecord = item as Record<string, unknown>;
      if (contentRecord.type === "image") {
        const contentUrl = typeof contentRecord.url === "string" ? contentRecord.url : undefined;
        if (contentUrl) {
          urls.push(contentUrl);
        }
      }
    }
  }

  return urls;
}

/**
 * Generate a TTS audio attachment from text if TTS is enabled and configured.
 */
async function maybeGenerateTTSAttachment(
  text: string,
  channelType: string,
  directive?: import("@/lib/tts/directives").TTSDirective | null,
): Promise<ChannelAttachment | null> {
  // If LLM explicitly disabled TTS for this message
  if (directive?.off) return null;

  const settings = loadSettings();

  // Check if TTS is enabled (either globally or via directive)
  const hasDirective = directive && !directive.off;
  if (!hasDirective && !settings.ttsEnabled) return null;
  if (!hasDirective && settings.ttsAutoMode === "off") return null;
  if (!isTTSAvailable() && !hasDirective) return null;

  // Skip TTS for empty or very short responses
  if (!text || text.trim().length < 5) return null;

  try {
    // Summarize long text before TTS (uses LLM when available, falls back to truncation)
    let ttsText = text;
    if (shouldSummarizeForTTS(text)) {
      ttsText = await summarizeForTTS(text);
    }

    // Strip markdown formatting for cleaner speech
    ttsText = formatTextForTTS(
      ttsText,
      settings.ttsReadCodeBlocks ?? false,
      settings.ttsSpeakCodeSymbols ?? false,
    );

    const result = await synthesizeSpeech({
      text: ttsText,
      voice: directive?.voice || directive?.voiceId,
      speed: directive?.speed,
      channelHint: channelType,
    });
    const channelAudio = getAudioForChannel(result.audio, result.mimeType, channelType);

    return {
      type: "audio",
      filename: `voice-reply.${channelAudio.extension}`,
      mimeType: channelAudio.mimeType,
      data: channelAudio.audio,
    };
  } catch (error) {
    console.warn("[TTS] Failed to generate audio for channel reply:", error);
    return null;
  }
}

/**
 * Persist voice-related state to session metadata.
 * Follows the same pattern as update-plan-tool.ts session persistence.
 */
export async function persistVoiceState(
  sessionId: string,
  voiceState: {
    ttsAutoMode?: string;
    lastProvider?: string;
    lastVoice?: string;
    lastSpeed?: number;
  }
): Promise<void> {
  try {
    const session = await getSession(sessionId);
    if (!session) return;

    const metadata = (session.metadata || {}) as Record<string, unknown>;
    const existingVoice = (metadata.voice || {}) as Record<string, unknown>;

    await updateSession(sessionId, {
      metadata: {
        ...metadata,
        voice: {
          ...existingVoice,
          ...voiceState,
          updatedAt: new Date().toISOString(),
        },
      },
    });
  } catch (error) {
    console.warn("[Voice] Failed to persist voice state:", error);
  }
}

/**
 * Convert markdown code fences to Telegram HTML <pre> blocks for raw mode.
 * Non-code-block text is HTML-escaped so Telegram's HTML parse mode is safe.
 * Returns the original text and no parseMode when no code fences are present.
 */
function rawModeTextTransform(text: string): { text: string; parseMode: "HTML" | undefined } {
  if (!text || !text.includes("```")) {
    return { text, parseMode: undefined };
  }
  // Split on code fences (capturing delimiter keeps it in the array)
  const parts = text.split(/(```[^\r\n]*\r?\n[\s\S]*?```|```[\s\S]*?```)/g);
  const transformed = parts.map((part) => {
    if (part.startsWith("```")) {
      // Strip opening fence (with optional language tag like c++, objective-c) and closing fence
      const code = part.replace(/^```[^\r\n]*\r?\n?/, "").replace(/\r?\n?```$/, "");
      return `<pre>${escapeHtmlEntities(code)}</pre>`;
    }
    return escapeHtmlEntities(part);
  });
  return { text: transformed.join(""), parseMode: "HTML" };
}

function escapeHtmlEntities(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}


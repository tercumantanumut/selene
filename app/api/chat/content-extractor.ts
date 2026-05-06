import fs from "fs/promises";
import path from "path";

import { normalizeToolResultOutput } from "@/lib/ai/tool-result-utils";
import { transcribeAudio } from "@/lib/audio/transcription";
import { extractTextFromDocument } from "@/lib/documents/parser";
import { getFullPathFromMediaRef } from "@/lib/storage/local-storage";

import {
  BASE64_IMAGE_PLACEHOLDER,
  sanitizeTextContent,
  stripFakeToolCallJson,
  extractPasteBlocks,
  reinsertPasteBlocks,
} from "./content-sanitizer";
import { sanitizeInspectMessageContext } from "@/lib/design/workspace/inspect-context";
import {
  formatDesignContextPrompt,
  mergeDesignContext,
  sanitizeDesignContext,
} from "@/lib/design/workspace/design-context";
import { reconcileToolCallPairs, toModelToolResultOutput, normalizeToolCallInput } from "./tool-call-utils";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const DATA_URI_RE = /^data:([^;]+);base64,(.+)$/s;

const MAX_BASE64_BYTES = 4.5 * 1024 * 1024;
const BASE64_OVERHEAD = 1.37;
const MAX_ATTACHMENT_TEXT_CHARS = 20_000;

// --- @-mention v2 (vector-aware mentions) ---------------------------------
// Each mention contributes either (a) a single semantic chunk pulled from
// the vector index, or (b) the entire small file the user picked. The full
// list is capped per-message to stay under context-window budgets.
const MAX_VECTOR_MENTION_SNIPPET_CHARS = 4_000;
const MAX_VECTOR_MENTION_FILE_CHARS = 20_000;
const MAX_VECTOR_MENTION_TOTAL_CHARS = 60_000;

type VectorMentionSnippet = {
  text: string;
  startLine?: number;
  endLine?: number;
  score?: number;
  chunkIndex?: number;
};

type VectorMention = {
  id?: string;
  kind: "file" | "chunk";
  characterId?: string;
  folderId?: string;
  relativePath: string;
  filePath?: string;
  displayLabel?: string;
  snippet?: VectorMentionSnippet;
};

type AttachmentPathMetadata = {
  id?: string;
  name?: string;
  contentType?: string;
  url?: string;
  localPath?: string;
  filePath?: string;
  size?: number;
  kind?: string;
  inline?: boolean;
  order?: number;
};

type ModelContentPart = {
  type: string;
  text?: string;
  image?: string;
  mediaType?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
};

/**
 * Build an image content part safe for the AI SDK.
 *
 * The AI SDK's `downloadAssets` parses string values through `new URL()`.
 * A full data-URI (data:mime;base64,...) is a valid URL with protocol "data:"
 * which then fails the http/https scheme check in `validateDownloadUrl`.
 *
 * To avoid this, we split data URIs into raw base64 + mediaType so the SDK
 * treats the string as opaque base64 content and never tries to download it.
 */
function makeImagePart(imageValue: string): ModelContentPart {
  const match = imageValue.match(DATA_URI_RE);
  if (match) {
    return { type: "image", image: match[2].trim(), mediaType: match[1] };
  }
  return { type: "image", image: imageValue };
}

type MessageInput = {
  role?: string;
  content?: string | unknown;
  parts?: Array<{
    type: string;
    text?: string;
    id?: string;
    image?: string;
    displayName?: string;
    url?: string;
    localPath?: string;
    filePath?: string;
    mediaType?: string;
    filename?: string;
    toolName?: string;
    toolCallId?: string;
    input?: unknown;
    output?: unknown;
    result?: unknown;
  }>;
  experimental_attachments?: AttachmentPathMetadata[];
  metadata?: {
    custom?: {
      attachments?: AttachmentPathMetadata[];
      inlineAttachments?: AttachmentPathMetadata[];
      inspectContext?: unknown;
      designContext?: unknown;
      vectorMentions?: VectorMention[];
    };
  };
};

async function resizeImageIfNeeded(
  buffer: Buffer,
  imageUrl: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const sharp = (await import("sharp")).default;

    let resized = await sharp(buffer)
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    if (resized.length * BASE64_OVERHEAD <= MAX_BASE64_BYTES) {
      console.log(
        `[CHAT API] Resized oversized image: ${imageUrl} ` +
        `(${buffer.length} -> ${resized.length} bytes, ~${Math.round(resized.length * BASE64_OVERHEAD / 1024)}KB base64)`,
      );
      return { buffer: resized, mimeType: "image/jpeg" };
    }

    resized = await sharp(buffer)
      .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();

    console.log(
      `[CHAT API] Resized oversized image (pass 2): ${imageUrl} ` +
      `(${buffer.length} -> ${resized.length} bytes, ~${Math.round(resized.length * BASE64_OVERHEAD / 1024)}KB base64)`,
    );
    return { buffer: resized, mimeType: "image/jpeg" };
  } catch (resizeError) {
    console.warn(`[CHAT API] Failed to resize image, using original: ${imageUrl}`, resizeError);
    return null;
  }
}

async function imageUrlToBase64(imageUrl: string): Promise<string | null> {
  if (imageUrl.startsWith("data:") || imageUrl.startsWith("http")) {
    return imageUrl;
  }

  if (imageUrl.startsWith("/api/media/")) {
    try {
      const relativePath = imageUrl.replace("/api/media/", "");
      const mediaRoot = path.resolve(process.env.LOCAL_DATA_PATH || ".local-data", "media");
      const filePath = path.resolve(mediaRoot, relativePath);
      if (!filePath.startsWith(mediaRoot + path.sep) && filePath !== mediaRoot) {
        console.warn(`[CHAT API] Path traversal blocked: ${imageUrl}`);
        return null;
      }

      let fileBuffer = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      let mimeType = IMAGE_MIME_TYPES[ext] || "image/png";

      if (fileBuffer.length * BASE64_OVERHEAD > MAX_BASE64_BYTES && ext in IMAGE_MIME_TYPES) {
        const resized = await resizeImageIfNeeded(fileBuffer, imageUrl);
        if (resized) {
          fileBuffer = Buffer.from(resized.buffer);
          mimeType = resized.mimeType;
        }
      }

      const base64 = fileBuffer.toString("base64");
      console.log(`[CHAT API] Converted image to base64: ${imageUrl} (${mimeType}, ${Math.round(base64.length / 1024)}KB)`);
      return `data:${mimeType};base64,${base64}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      console.warn(`[CHAT API] Image file not accessible: ${imageUrl} (${code ?? error})`);
      return null;
    }
  }

  // Unknown URL scheme — not a valid image reference
  return null;
}

function normalizeAttachmentString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildAttachmentLookup(msg: {
  experimental_attachments?: Array<AttachmentPathMetadata>;
  metadata?: {
    custom?: {
      attachments?: Array<AttachmentPathMetadata>;
      inlineAttachments?: Array<AttachmentPathMetadata>;
    };
  };
}): Map<string, AttachmentPathMetadata> {
  const lookup = new Map<string, AttachmentPathMetadata>();

  const register = (attachment: AttachmentPathMetadata) => {
    const url = normalizeAttachmentString(attachment.url);
    if (!url) return;

    const existing = lookup.get(url);
    lookup.set(url, {
      url,
      id: normalizeAttachmentString(existing?.id) ?? normalizeAttachmentString(attachment.id),
      name: normalizeAttachmentString(existing?.name) ?? normalizeAttachmentString(attachment.name),
      contentType: normalizeAttachmentString(existing?.contentType) ?? normalizeAttachmentString(attachment.contentType),
      filePath: normalizeAttachmentString(existing?.filePath) ?? normalizeAttachmentString(attachment.filePath),
      localPath: normalizeAttachmentString(existing?.localPath) ?? normalizeAttachmentString(attachment.localPath),
      kind: normalizeAttachmentString(existing?.kind) ?? normalizeAttachmentString(attachment.kind),
      inline: existing?.inline === true || attachment.inline === true,
      order: typeof existing?.order === "number" ? existing.order : attachment.order,
    });
  };

  for (const attachment of msg.metadata?.custom?.inlineAttachments ?? []) {
    register(attachment);
  }
  for (const attachment of msg.metadata?.custom?.attachments ?? []) {
    register(attachment);
  }
  for (const attachment of msg.experimental_attachments ?? []) {
    register(attachment);
  }

  return lookup;
}

function resolveAttachmentForHelper(
  lookup: Map<string, AttachmentPathMetadata>,
  attachment: AttachmentPathMetadata,
): AttachmentPathMetadata {
  const url = normalizeAttachmentString(attachment.url);
  const fromLookup = url ? lookup.get(url) : undefined;

  return {
    id: normalizeAttachmentString(attachment.id) ?? normalizeAttachmentString(fromLookup?.id),
    name: normalizeAttachmentString(attachment.name) ?? normalizeAttachmentString(fromLookup?.name),
    contentType: normalizeAttachmentString(attachment.contentType) ?? normalizeAttachmentString(fromLookup?.contentType),
    url,
    filePath: normalizeAttachmentString(attachment.filePath) ?? normalizeAttachmentString(fromLookup?.filePath),
    localPath: normalizeAttachmentString(attachment.localPath) ?? normalizeAttachmentString(fromLookup?.localPath),
    kind: normalizeAttachmentString(attachment.kind) ?? normalizeAttachmentString(fromLookup?.kind),
    inline: attachment.inline === true || fromLookup?.inline === true,
    order: typeof attachment.order === "number" ? attachment.order : fromLookup?.order,
  };
}

function formatAttachmentHelperText(
  attachment: AttachmentPathMetadata,
  fallbackName = "uploaded file",
): string | null {
  const filePath = normalizeAttachmentString(attachment.filePath);
  const localPath = normalizeAttachmentString(attachment.localPath);
  const url = normalizeAttachmentString(attachment.url);

  const pathLabelAndValue: [label: "filePath" | "localPath" | "url", value: string] | null =
    filePath ? ["filePath", filePath]
      : localPath ? ["localPath", localPath]
        : url ? ["url", url]
          : null;

  if (!pathLabelAndValue) return null;

  const displayName = normalizeAttachmentString(attachment.name) ?? fallbackName;
  return `[Attachment: ${displayName} | ${pathLabelAndValue[0]}: ${pathLabelAndValue[1]}]`;
}

function maybePreserveImageReference(
  contentParts: ModelContentPart[],
  imageUrl: string,
  shouldConvert: boolean,
  _includeUrlHelpers: boolean,
) {
  if (!shouldConvert) {
    // Only preserve references that are actual image data or resolvable URLs.
    // The message-prep image rewrite consumes this part before provider send,
    // turning stale images into readFile refs and blind-provider images into
    // transparent notices.
    if (
      imageUrl.startsWith("data:") ||
      imageUrl.startsWith("http") ||
      imageUrl.startsWith("/api/media/") ||
      imageUrl.startsWith("local-media://")
    ) {
      contentParts.push(makeImagePart(imageUrl));
    }
  }
}

function trackAttachmentUrl(
  seenUrls: Set<string>,
  url: string | undefined,
): boolean {
  if (!url) return false;
  if (seenUrls.has(url)) return false;
  seenUrls.add(url);
  return true;
}

function inferAttachmentContentType(attachment: AttachmentPathMetadata, fallback?: string): string {
  const contentType = normalizeAttachmentString(attachment.contentType);
  if (contentType) return contentType;
  const name = normalizeAttachmentString(attachment.name) ?? normalizeAttachmentString(fallback) ?? "";
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".html":
    case ".htm":
      return "text/html";
    case ".csv":
      return "text/csv";
    case ".txt":
      return "text/plain";
    case ".vtt":
      return "text/vtt";
    case ".xml":
      return "application/xml";
    default:
      return "application/octet-stream";
  }
}

function formatDocumentAttachmentContext(
  attachment: AttachmentPathMetadata,
  extractedText: string,
): string {
  const displayName = normalizeAttachmentString(attachment.name) ?? "uploaded document";
  const helper = formatAttachmentHelperText(attachment, displayName);
  const safeText = extractedText.length > MAX_ATTACHMENT_TEXT_CHARS
    ? `${extractedText.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}\n...[truncated]`
    : extractedText;

  return [
    helper,
    `[Attachment content: ${displayName}]`,
    safeText,
  ].filter(Boolean).join("\n");
}

async function extractAttachmentContextText(
  attachment: AttachmentPathMetadata,
  sessionId?: string,
): Promise<string | null> {
  const attachmentPath = normalizeAttachmentString(attachment.filePath)
    ?? getFullPathFromMediaRef(normalizeAttachmentString(attachment.url) ?? "")
    ?? undefined;

  if (!attachmentPath) {
    return formatAttachmentHelperText(attachment);
  }

  try {
    const fileBuffer = await fs.readFile(attachmentPath);
    const contentType = inferAttachmentContentType(attachment, path.basename(attachmentPath));
    const filename = normalizeAttachmentString(attachment.name) ?? path.basename(attachmentPath);

    if (contentType.startsWith("audio/")) {
      const transcription = await transcribeAudio(fileBuffer, contentType, filename);
      const transcript = sanitizeTextContent(transcription.text.trim(), `audio attachment ${filename}`, sessionId);
      if (!transcript) {
        return formatAttachmentHelperText(attachment, filename);
      }
      return [
        formatAttachmentHelperText(attachment, filename),
        `[Audio transcript: ${filename}]`,
        transcript,
      ].filter(Boolean).join("\n");
    }

    const parsed = await extractTextFromDocument(fileBuffer, contentType, filename, "chat-attachment");
    const sanitized = sanitizeTextContent(parsed.text, `attachment ${filename}`, sessionId);
    if (!sanitized) {
      return formatAttachmentHelperText(attachment, filename);
    }

    return formatDocumentAttachmentContext(attachment, sanitized);
  } catch (error) {
    console.warn("[EXTRACT] Failed to extract attachment content", {
      name: attachment.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return formatAttachmentHelperText(attachment, attachment.name || "uploaded file");
  }
}

async function appendAttachmentByType(
  contentParts: ModelContentPart[],
  attachmentLookup: Map<string, AttachmentPathMetadata>,
  seenAttachmentUrls: Set<string>,
  attachment: AttachmentPathMetadata,
  includeUrlHelpers: boolean,
  convertUserImagesToBase64: boolean,
  isUserMessage: boolean,
  sessionId?: string,
): Promise<void> {
  if (!attachment.url) return;
  if (attachment.contentType?.startsWith("image/")) {
    await appendImagePart(
      contentParts,
      attachmentLookup,
      seenAttachmentUrls,
      attachment.url,
      attachment.name || "uploaded image",
      includeUrlHelpers,
      convertUserImagesToBase64,
      isUserMessage,
    );
  } else {
    await appendNonImageAttachment(contentParts, attachmentLookup, attachment, sessionId);
  }
}

function appendTextPartIfPresent(
  contentParts: ModelContentPart[],
  text: string | null | undefined,
) {
  if (!text) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  contentParts.push({ type: "text", text: trimmed });
}

async function appendImagePart(
  contentParts: ModelContentPart[],
  attachmentLookup: Map<string, AttachmentPathMetadata>,
  seenAttachmentUrls: Set<string>,
  url: string,
  fallbackName: string,
  includeUrlHelpers: boolean,
  convertUserImagesToBase64: boolean,
  isUserMessage: boolean,
) {
  if (!trackAttachmentUrl(seenAttachmentUrls, url)) return;

  const shouldConvert = convertUserImagesToBase64 && isUserMessage;
  const finalImageUrl = shouldConvert ? await imageUrlToBase64(url) : url;

  if (shouldConvert) {
    if (finalImageUrl) {
      contentParts.push(makeImagePart(finalImageUrl));
    } else {
      // Image file no longer available (temp file cleaned up, etc.)
      // Add a text note instead of a broken image part so the model
      // knows the image existed but can't be displayed.
      const safeName = fallbackName.replace(/[\[\]]/g, "").slice(0, 80);
      contentParts.push({ type: "text", text: `[Image previously shared: ${safeName} - file no longer available]` });
    }
  }

  if (includeUrlHelpers) {
    appendTextPartIfPresent(
      contentParts,
      formatAttachmentHelperText(
        resolveAttachmentForHelper(attachmentLookup, { url, name: fallbackName }),
        fallbackName,
      ),
    );
  }

  maybePreserveImageReference(contentParts, url, shouldConvert, includeUrlHelpers);
}

async function appendNonImageAttachment(
  contentParts: ModelContentPart[],
  attachmentLookup: Map<string, AttachmentPathMetadata>,
  attachment: AttachmentPathMetadata,
  sessionId?: string,
) {
  const resolved = resolveAttachmentForHelper(attachmentLookup, attachment);
  appendTextPartIfPresent(contentParts, await extractAttachmentContextText(resolved, sessionId));
}

function buildTextPart(text: string, role: string | undefined, sessionId?: string): string {
  const { cleanedText, pasteBlocks } = extractPasteBlocks(text);
  const strippedText = stripFakeToolCallJson(cleanedText);
  if (!strippedText.trim() && pasteBlocks.length === 0) return "";
  const sanitizedText = sanitizeTextContent(strippedText, `text part in ${role} message`, sessionId);
  return reinsertPasteBlocks(sanitizedText, pasteBlocks);
}

function getStringContent(content: unknown, sessionId?: string): string {
  if (typeof content !== "string" || !content) return "";
  const { cleanedText, pasteBlocks } = extractPasteBlocks(content);
  const stripped = stripFakeToolCallJson(cleanedText);
  if (!stripped.trim() && pasteBlocks.length === 0) return "";
  const sanitized = sanitizeTextContent(stripped, "string content", sessionId);
  return reinsertPasteBlocks(sanitized, pasteBlocks);
}

function pushToolCallAndResult(
  contentParts: ModelContentPart[],
  toolName: string,
  toolCallId: string | undefined,
  input: unknown,
  output: unknown,
  normalizedInput: Record<string, unknown> | null,
): void {
  if (toolCallId && normalizedInput) {
    contentParts.push({
      type: "tool-call",
      toolCallId,
      toolName,
      input: normalizedInput,
    });
  }

  if (toolCallId && output !== undefined) {
    const normalizedOutput = normalizeToolResultOutput(
      toolName,
      output,
      normalizedInput,
      { mode: "projection" },
    ).output;
    contentParts.push({
      type: "tool-result",
      toolCallId,
      toolName,
      output: toModelToolResultOutput(normalizedOutput),
    });
  }
}

/**
 * Format a single vector @-mention into a text content part.
 *
 * Mirrors `formatDocumentAttachmentContext` so the LLM sees the same
 * `[…]\n<text>` shape that document attachments produce. The marker line
 * doubles as a citation hint — models will routinely reference the path
 * back when summarising.
 */
function formatVectorMentionText(
  mention: VectorMention,
  resolvedText: string,
): string {
  const range =
    mention.snippet?.startLine != null && mention.snippet?.endLine != null
      ? `:L${mention.snippet.startLine}-${mention.snippet.endLine}`
      : "";
  const kindLabel = mention.kind === "file" ? "Vector file" : "Vector chunk";
  const header = `[${kindLabel}: ${mention.relativePath}${range}]`;
  return `${header}\n${resolvedText}`;
}

/**
 * Resolve a vector @-mention to the literal text the LLM should see.
 *
 * - kind="chunk": use the snippet text the picker captured at compose-time.
 * - kind="file":  read the file from disk (capped) when an absolute path is
 *                 known. If reading fails, fall back to the snippet (if any),
 *                 then to a stub line.
 *
 * Each mention is independently capped; the caller enforces a per-message
 * total budget.
 */
async function resolveVectorMentionText(mention: VectorMention): Promise<string | null> {
  if (mention.kind === "chunk") {
    const text = mention.snippet?.text?.trim();
    if (!text) return null;
    return text.length > MAX_VECTOR_MENTION_SNIPPET_CHARS
      ? `${text.slice(0, MAX_VECTOR_MENTION_SNIPPET_CHARS)}\n…[snippet truncated]`
      : text;
  }

  // kind === "file"
  if (mention.filePath) {
    try {
      const raw = await fs.readFile(mention.filePath, "utf8");
      if (raw.length > MAX_VECTOR_MENTION_FILE_CHARS) {
        return `${raw.slice(0, MAX_VECTOR_MENTION_FILE_CHARS)}\n…[file truncated at ${MAX_VECTOR_MENTION_FILE_CHARS} chars]`;
      }
      return raw;
    } catch (err) {
      console.warn(`[extractContent] vector mention file read failed: ${mention.filePath}`, err);
    }
  }

  const fallback = mention.snippet?.text?.trim();
  if (fallback) {
    return fallback.length > MAX_VECTOR_MENTION_SNIPPET_CHARS
      ? `${fallback.slice(0, MAX_VECTOR_MENTION_SNIPPET_CHARS)}\n…[snippet truncated]`
      : fallback;
  }

  return null;
}

/**
 * Append vector @-mentions to `contentParts` as text parts. Skips silently
 * when `mentions` is empty/undefined. Total injected text is capped to
 * `MAX_VECTOR_MENTION_TOTAL_CHARS`; once the budget is exhausted, the
 * remaining mentions are summarised in a single trailing marker so the LLM
 * still knows they were referenced.
 */
async function injectVectorMentions(
  contentParts: ModelContentPart[],
  mentions: VectorMention[] | undefined,
): Promise<void> {
  if (!mentions || mentions.length === 0) return;

  let used = 0;
  let dropped: VectorMention[] = [];

  for (const mention of mentions) {
    const text = await resolveVectorMentionText(mention);
    if (!text) {
      dropped.push(mention);
      continue;
    }

    const formatted = formatVectorMentionText(mention, text);
    if (used + formatted.length > MAX_VECTOR_MENTION_TOTAL_CHARS) {
      dropped.push(mention);
      continue;
    }

    contentParts.push({ type: "text", text: formatted });
    used += formatted.length;
  }

  if (dropped.length > 0) {
    const list = dropped
      .map((m) => `${m.relativePath}${m.snippet?.startLine != null ? `:L${m.snippet.startLine}-${m.snippet.endLine ?? ""}` : ""}`)
      .join(", ");
    contentParts.push({
      type: "text",
      text: `[Vector mentions skipped to stay under context budget: ${list}]`,
    });
  }
}

export async function extractContent(
  msg: MessageInput,
  includeUrlHelpers = false,
  convertUserImagesToBase64 = false,
  sessionId?: string,
): Promise<string | ModelContentPart[]> {
  // Prefer the unified `designContext` payload (which carries inspect +
  // measurements + colours) and fall back to the legacy `inspectContext` shape
  // for messages saved before the unification. When both fields co-exist we
  // merge instead of branching: a measurements-only `designContext` would
  // otherwise silently drop a populated legacy `inspectContext`.
  const sanitizedDesign = sanitizeDesignContext(msg.metadata?.custom?.designContext);
  const legacyInspect = sanitizeInspectMessageContext(msg.metadata?.custom?.inspectContext);
  const designContext = mergeDesignContext(sanitizedDesign, { inspect: legacyInspect });
  const designPromptText = formatDesignContextPrompt(designContext);
  // After merging, anything legacy carries is already inside `designContext`;
  // no separate inspect sidecar text is needed.
  const designSidecarText = designPromptText;

  const hasStructuredParts = Array.isArray(msg.parts) && msg.parts.length > 0;
  const hasMetadataAttachments = Array.isArray(msg.metadata?.custom?.attachments)
    && msg.metadata.custom.attachments.length > 0;
  const hasExperimentalAttachments = Array.isArray(msg.experimental_attachments)
    && msg.experimental_attachments.length > 0;
  const hasVectorMentions = Array.isArray(msg.metadata?.custom?.vectorMentions)
    && msg.metadata.custom.vectorMentions.length > 0;
  const hasStructuredContent =
    hasStructuredParts || hasMetadataAttachments || hasExperimentalAttachments
    || hasVectorMentions || Boolean(designSidecarText);
  if (!hasStructuredContent) {
    const directContent = getStringContent(msg.content, sessionId);
    if (directContent) {
      return directContent;
    }
  }

  if (designSidecarText && !hasStructuredParts && !hasMetadataAttachments && !hasExperimentalAttachments && !hasVectorMentions) {
    const directContent = getStringContent(msg.content, sessionId);
    return directContent ? `${designSidecarText}\n\n${directContent}` : designSidecarText;
  }

  const isUserMessage = msg.role === "user";

  if (msg.parts && Array.isArray(msg.parts)) {
    const attachmentLookup = buildAttachmentLookup(msg);
    const seenAttachmentUrls = new Set<string>();
    const explicitToolResultIds = new Set(
      msg.parts
        .filter(
          (part): part is { type: "tool-result"; toolCallId: string } =>
            part.type === "tool-result" && typeof part.toolCallId === "string",
        )
        .map((part) => part.toolCallId),
    );

    const contentParts: ModelContentPart[] = [];
    let hasExplicitTextPart = false;

    if (designSidecarText) {
      contentParts.push({ type: "text", text: designSidecarText });
    }

    for (const part of msg.parts) {
      if (part.type === "text" && part.text?.trim()) {
        hasExplicitTextPart = true;
        appendTextPartIfPresent(contentParts, buildTextPart(part.text, msg.role, sessionId));
        continue;
      }

      // Reasoning parts are only re-injected server-side for providers that
      // require `reasoning_content` on round-trip (e.g. DeepSeek thinking mode).
      // The ai-sdk `AssistantContent` type accepts `{ type: "reasoning", text }`
      // and the openai-compatible adapter serialises it to `reasoning_content`
      // on the outbound assistant message. Other providers either drop the
      // field or require an additional signature (Anthropic), so we only emit
      // it when upstream message-prep has explicitly injected it.
      if (part.type === "reasoning" && typeof part.text === "string" && part.text.length > 0) {
        contentParts.push({ type: "reasoning", text: part.text });
        continue;
      }

      if (part.type === "image" && (part.image || part.url)) {
        await appendImagePart(
          contentParts,
          attachmentLookup,
          seenAttachmentUrls,
          (part.image || part.url) as string,
          "uploaded image",
          includeUrlHelpers,
          convertUserImagesToBase64,
          isUserMessage,
        );
        continue;
      }

      if (part.type === "file" && part.url) {
        if (part.mediaType?.startsWith("image/")) {
          await appendImagePart(
            contentParts,
            attachmentLookup,
            seenAttachmentUrls,
            part.url,
            part.filename || "uploaded image",
            includeUrlHelpers,
            convertUserImagesToBase64,
            isUserMessage,
          );
        } else {
          await appendNonImageAttachment(
            contentParts,
            attachmentLookup,
            {
              name: part.filename,
              contentType: part.mediaType,
              url: part.url,
              localPath: part.localPath,
              filePath: part.filePath,
            },
            sessionId,
          );
        }
        continue;
      }

      if (part.type === "dynamic-tool" && part.toolName) {
        const toolName = part.toolName || "tool";
        const output = part.output as {
          images?: Array<{ url: string; localPath?: string; filePath?: string }>;
          videos?: Array<{ url: string; localPath?: string; filePath?: string }>;
          text?: string;
          status?: string;
        } | null;
        const toolCallId = part.toolCallId;
        const normalizedInput = toolCallId
          ? normalizeToolCallInput(part.input, toolName, toolCallId) ?? {}
          : null;

        pushToolCallAndResult(contentParts, toolName, toolCallId, part.input, output, normalizedInput);

        if (output?.images && output.images.length > 0) {
          const urlList = output.images
            .map((img, idx) => {
              let line = `  ${idx + 1}. ${img.url}`;
              if (img.filePath) line += `\n     file: ${img.filePath}`;
              return line;
            })
            .join("\n");
          contentParts.push({
            type: "text",
            text: `Previously generated ${output.images.length} image(s) using ${toolName}:\n${urlList}\n/api/media/ URLs work directly as source_image_url, reference_image_url, or image_url in any image/video tool. File paths are for CLI tools like ffmpeg.`,
          });
        } else if (output?.videos && output.videos.length > 0) {
          const urlList = output.videos
            .map((vid, idx) => {
              let line = `  ${idx + 1}. ${vid.url}`;
              if (vid.filePath) line += `\n     file: ${vid.filePath}`;
              return line;
            })
            .join("\n");
          contentParts.push({
            type: "text",
            text: `Previously generated ${output.videos.length} video(s) using ${toolName}:\n${urlList}\nTo extract a frame: use ffmpeg via executeCommand with the file path, save output alongside it, then pass the corresponding /api/media/ URL to image/video tools.`,
          });
        } else {
          const resultObj = output as { truncated?: boolean; truncatedContentId?: string } | null;
          if (resultObj?.truncated && resultObj?.truncatedContentId) {
            contentParts.push({
              type: "text",
              text: `\n---\n⚠️ CONTENT TRUNCATED: Full content available via retrieveFullContent with contentId="${resultObj.truncatedContentId}"\n---`,
            });
          }
        }
        continue;
      }

      if (part.type === "tool-call" && part.toolCallId && part.toolName) {
        const normalizedInput = normalizeToolCallInput(part.input, part.toolName, part.toolCallId) ?? {};
        contentParts.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: normalizedInput,
        });

        const rawOutput = part.output ?? part.result;
        if (rawOutput !== undefined && !explicitToolResultIds.has(part.toolCallId)) {
          const normalizedOutput = normalizeToolResultOutput(
            part.toolName,
            rawOutput,
            normalizedInput,
            { mode: "projection" },
          ).output;
          contentParts.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: toModelToolResultOutput(normalizedOutput),
          });
        }
        continue;
      }

      if (part.type === "tool-result" && part.toolCallId && part.toolName) {
        const normalizedInput = normalizeToolCallInput(part.input, part.toolName, part.toolCallId) ?? {};
        const rawOutput = part.output ?? part.result;
        const normalizedOutput = normalizeToolResultOutput(
          part.toolName,
          rawOutput,
          normalizedInput,
          { mode: "projection" },
        ).output;
        contentParts.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: toModelToolResultOutput(normalizedOutput),
        });
        continue;
      }

      if (part.type.startsWith("tool-") && part.type !== "tool-call" && part.type !== "tool-result") {
        const toolName = part.type.replace("tool-", "");
        const toolCallId = part.toolCallId;
        const normalizedInput = toolCallId
          ? normalizeToolCallInput(part.input, toolName, toolCallId) ?? {}
          : null;
        const toolOutput = part.output ?? part.result;
        pushToolCallAndResult(contentParts, toolName, toolCallId, part.input, toolOutput, normalizedInput);
      }
    }

    if (!hasExplicitTextPart) {
      const directContent = getStringContent(msg.content, sessionId);
      const trimmedDirectContent = directContent.trim();
      // When msg.content was raw base64 image data, sanitizeTextContent replaces it
      // with a placeholder. Drop it when we already have image/file parts — the actual
      // image is already in contentParts from the structured parts/attachments.
      const isBase64Placeholder = trimmedDirectContent === BASE64_IMAGE_PLACEHOLDER;
      if (trimmedDirectContent && !isBase64Placeholder) {
        const directTextPart = { type: "text", text: trimmedDirectContent } satisfies ModelContentPart;
        if (designSidecarText && contentParts.length > 0) {
          contentParts.splice(1, 0, directTextPart);
        } else {
          contentParts.unshift(directTextPart);
        }
      }
    }

    if (msg.experimental_attachments && Array.isArray(msg.experimental_attachments)) {
      for (const attachment of msg.experimental_attachments) {
        await appendAttachmentByType(contentParts, attachmentLookup, seenAttachmentUrls, attachment, includeUrlHelpers, convertUserImagesToBase64, isUserMessage, sessionId);
      }
    }

    const metadataAttachments = msg.metadata?.custom?.attachments;
    if (metadataAttachments && Array.isArray(metadataAttachments)) {
      for (const attachment of metadataAttachments) {
        await appendAttachmentByType(contentParts, attachmentLookup, seenAttachmentUrls, attachment, includeUrlHelpers, convertUserImagesToBase64, isUserMessage, sessionId);
      }
    }

    // v2 @-mention vector chunks: inject after attachments so file content
    // is grouped together and the user's typed prompt comes first.
    await injectVectorMentions(contentParts, msg.metadata?.custom?.vectorMentions);

    const normalizedParts = reconcileToolCallPairs(contentParts);
    if (normalizedParts.length === 0) {
      return "[Message content not available]";
    }
    if (normalizedParts.length === 1 && normalizedParts[0].type === "text") {
      return normalizedParts[0].text || "";
    }
    return normalizedParts;
  }

  if (
    (msg.experimental_attachments && Array.isArray(msg.experimental_attachments)) ||
    (msg.metadata?.custom?.attachments && Array.isArray(msg.metadata.custom.attachments)) ||
    hasVectorMentions
  ) {
    const attachmentLookup = buildAttachmentLookup(msg);
    const seenAttachmentUrls = new Set<string>();
    const contentParts: ModelContentPart[] = [];

    if (designSidecarText) {
      contentParts.push({ type: "text", text: designSidecarText });
    }

    if (typeof msg.content === "string" && msg.content) {
      appendTextPartIfPresent(
        contentParts,
        sanitizeTextContent(msg.content, "string content with attachments", sessionId),
      );
    }

    async function processAttachment(attachment: AttachmentPathMetadata): Promise<void> {
      const contentType = inferAttachmentContentType(attachment, attachment.name);
      if (!attachment.url) {
        if (contentType.startsWith("image/")) {
          appendTextPartIfPresent(
            contentParts,
            includeUrlHelpers
              ? formatAttachmentHelperText(resolveAttachmentForHelper(attachmentLookup, attachment), attachment.name || "uploaded image")
              : null,
          );
        }
        return;
      }
      if (contentType.startsWith("image/")) {
        await appendImagePart(
          contentParts,
          attachmentLookup,
          seenAttachmentUrls,
          attachment.url,
          attachment.name || "uploaded image",
          includeUrlHelpers,
          convertUserImagesToBase64,
          isUserMessage,
        );
      } else {
        if (!trackAttachmentUrl(seenAttachmentUrls, attachment.url)) return;
        await appendNonImageAttachment(contentParts, attachmentLookup, attachment, sessionId);
      }
    }

    for (const attachment of msg.metadata?.custom?.attachments ?? []) {
      await processAttachment(attachment);
    }

    for (const attachment of msg.experimental_attachments ?? []) {
      await processAttachment(attachment);
    }

    // v2 @-mention vector chunks: same as the parts-path injection above.
    await injectVectorMentions(contentParts, msg.metadata?.custom?.vectorMentions);

    if (contentParts.length > 0) {
      if (contentParts.length === 1 && contentParts[0].type === "text") {
        return contentParts[0].text || "";
      }
      return contentParts;
    }
  }

  if (Array.isArray(msg.content)) {
    return msg.content as ModelContentPart[];
  }

  return "[Message content not available]";
}

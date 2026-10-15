export const MAX_PROMPT_ENHANCEMENT_HISTORY_MESSAGES = 6;
export const MAX_PROMPT_ENHANCEMENT_MESSAGE_CHARS = 25_000;
export const MAX_PROMPT_ENHANCEMENT_ATTACHMENT_ITEMS = 20;
export const MAX_PROMPT_ENHANCEMENT_REFERENCE_CHARS = 500;

export interface PromptEnhancementAttachmentContext {
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
  status?: string;
}

export type PromptEnhancementConversationRole = "user" | "assistant";

export interface PromptEnhancementConversationMessage {
  role: PromptEnhancementConversationRole;
  content: string;
}

export interface PromptEnhancementHistoryInput {
  role?: unknown;
  content?: unknown;
  parts?: unknown;
  metadata?: unknown;
  orderingIndex?: unknown;
}

interface PromptEnhancementHistoryOptions {
  maxMessages?: number;
  maxMessageChars?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseMetadataObject(metadata: unknown): Record<string, unknown> | null {
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(metadata) ? metadata : null;
}

function metadataIndicatesNonConversationalMessage(metadata: unknown): boolean {
  const meta = parseMetadataObject(metadata);
  if (!meta) return false;

  if (meta.livePromptInjected === true) return true;
  if (meta.syntheticToolResult === true) return true;
  if (meta.isScheduledPrompt === true) return true;
  if (meta.isBackgroundLifecycle === true) return true;
  if (meta.backgroundLifecycle === true) return true;
  if (meta.taskLifecycle === true) return true;
  if (meta.isTaskLifecycle === true) return true;

  const kind = stringValue(meta.kind) ?? stringValue(meta.type);
  if (
    kind === "delegation_completion" ||
    kind === "task_progress" ||
    kind === "task_lifecycle" ||
    kind === "background_lifecycle" ||
    kind === "background_task"
  ) {
    return true;
  }

  const custom = isRecord(meta.custom) ? meta.custom : null;
  if (!custom) return false;

  const customKind = stringValue(custom.kind) ?? stringValue(custom.type);
  return customKind === "delegation_completion" ||
    customKind === "task_progress" ||
    customKind === "task_lifecycle" ||
    customKind === "background_lifecycle" ||
    customKind === "background_task";
}

export function isPromptEnhancementConversationRole(
  role: unknown,
): role is PromptEnhancementConversationRole {
  return role === "user" || role === "assistant";
}

export function normalizePromptEnhancementAttachment(
  value: unknown,
): PromptEnhancementAttachmentContext | null {
  if (!isRecord(value)) return null;

  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const firstContent = Array.isArray(value.content) && isRecord(value.content[0])
    ? value.content[0]
    : {};
  const status = isRecord(value.status)
    ? [stringValue(value.status.type), stringValue(value.status.reason)].filter(Boolean).join(":")
    : stringValue(value.status);

  const attachment: PromptEnhancementAttachmentContext = {
    id: stringValue(value.id) ?? stringValue(metadata.id),
    name: stringValue(value.name)
      ?? stringValue(metadata.name)
      ?? stringValue(value.filename)
      ?? stringValue(value.displayName)
      ?? stringValue(firstContent.filename)
      ?? stringValue(firstContent.displayName),
    contentType: stringValue(value.contentType)
      ?? stringValue(value.mediaType)
      ?? stringValue(value.mimeType)
      ?? stringValue(metadata.contentType)
      ?? stringValue(metadata.mediaType)
      ?? stringValue(metadata.mimeType)
      ?? stringValue(firstContent.mediaType)
      ?? stringValue(firstContent.mimeType)
      ?? stringValue(firstContent.contentType),
    url: stringValue(metadata.url)
      ?? stringValue(firstContent.image)
      ?? stringValue(firstContent.url)
      ?? stringValue(firstContent.data)
      ?? stringValue(value.image)
      ?? stringValue(value.url)
      ?? stringValue(value.data),
    localPath: stringValue(metadata.localPath)
      ?? stringValue(firstContent.localPath)
      ?? stringValue(value.localPath),
    filePath: stringValue(metadata.filePath)
      ?? stringValue(firstContent.filePath)
      ?? stringValue(value.filePath),
    size: numberValue(metadata.size) ?? numberValue(value.size) ?? numberValue(firstContent.size),
    kind: stringValue(metadata.kind)
      ?? stringValue(value.kind)
      ?? stringValue(value.type)
      ?? stringValue(firstContent.type),
    inline: booleanValue(metadata.inline) ?? booleanValue(value.inline) ?? booleanValue(firstContent.inline),
    order: numberValue(metadata.order) ?? numberValue(value.order) ?? numberValue(firstContent.order),
    status: status || undefined,
  };

  return Object.values(attachment).some((entry) => entry !== undefined) ? attachment : null;
}

function metadataAttachmentsForEnhancement(metadata: unknown): PromptEnhancementAttachmentContext[] {
  const parsed = parseMetadataObject(metadata);
  const custom = isRecord(parsed?.custom) ? parsed.custom : null;
  if (!custom) return [];

  return [custom.inlineAttachments, custom.attachments]
    .flatMap((attachments) => Array.isArray(attachments) ? attachments : [])
    .map(normalizePromptEnhancementAttachment)
    .filter((attachment): attachment is PromptEnhancementAttachmentContext => attachment !== null);
}

function attachmentReferenceKey(attachment: PromptEnhancementAttachmentContext): string | null {
  return attachment.url
    ?? attachment.filePath
    ?? attachment.localPath
    ?? attachment.id
    ?? attachment.name
    ?? null;
}

function shortenReferenceValue(value: string): string {
  if (value.startsWith("data:")) {
    const commaIndex = value.indexOf(",");
    return commaIndex >= 0
      ? `${value.slice(0, commaIndex + 1)}[base64 omitted]`
      : "data:[inline data omitted]";
  }
  if (value.length <= MAX_PROMPT_ENHANCEMENT_REFERENCE_CHARS) return value;
  return `${value.slice(0, MAX_PROMPT_ENHANCEMENT_REFERENCE_CHARS - 1)}…`;
}

export function formatPromptEnhancementAttachmentReference(
  attachment: PromptEnhancementAttachmentContext,
): string {
  const isImage = attachment.contentType?.toLowerCase().startsWith("image/") === true
    || attachment.kind?.toLowerCase().includes("image") === true;
  const label = isImage ? "Image" : "Attachment";
  const displayName = attachment.name ?? (isImage ? "uploaded image" : "uploaded file");
  const details = [displayName];

  if (attachment.contentType) details.push(attachment.contentType);
  if (attachment.kind && attachment.kind !== attachment.contentType) details.push(`kind: ${attachment.kind}`);
  if (attachment.status) details.push(`status: ${attachment.status}`);
  if (typeof attachment.size === "number") details.push(`size: ${attachment.size} bytes`);
  if (attachment.url) details.push(`url: ${shortenReferenceValue(attachment.url)}`);
  if (attachment.filePath) details.push(`filePath: ${shortenReferenceValue(attachment.filePath)}`);
  if (attachment.localPath) details.push(`localPath: ${shortenReferenceValue(attachment.localPath)}`);

  return `[${label}: ${details.join(" | ")}]`;
}

export function formatPromptEnhancementMessageContent(
  message: Pick<PromptEnhancementHistoryInput, "content" | "parts" | "metadata">,
): string {
  const lines: string[] = [];
  const seenAttachments = new Set<string>();
  const pushAttachment = (attachment: PromptEnhancementAttachmentContext) => {
    const key = attachmentReferenceKey(attachment);
    if (key) {
      if (seenAttachments.has(key)) return;
      seenAttachments.add(key);
    }
    lines.push(formatPromptEnhancementAttachmentReference(attachment));
  };

  const content = Array.isArray(message.content)
    ? message.content
    : Array.isArray(message.parts)
      ? message.parts
      : message.content;

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "text") {
        const text = stringValue(part.text);
        if (text) lines.push(text);
        continue;
      }
      if (part.type === "image" || part.type === "file") {
        const attachment = normalizePromptEnhancementAttachment(part);
        if (attachment) pushAttachment(attachment);
      }
    }
  } else {
    const text = stringValue(content);
    if (text) lines.push(text);
  }

  for (const attachment of metadataAttachmentsForEnhancement(message.metadata)) {
    pushAttachment(attachment);
  }

  return lines.join("\n").trim();
}

export function buildPromptEnhancementHistory(
  messages: PromptEnhancementHistoryInput[] | readonly PromptEnhancementHistoryInput[] | undefined | null,
  options: PromptEnhancementHistoryOptions = {},
): PromptEnhancementConversationMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const maxMessages = options.maxMessages ?? MAX_PROMPT_ENHANCEMENT_HISTORY_MESSAGES;
  const maxMessageChars = options.maxMessageChars ?? MAX_PROMPT_ENHANCEMENT_MESSAGE_CHARS;

  if (maxMessages <= 0) return [];

  const chronologicalMessages = messages
    .map((message, originalIndex) => ({ message, originalIndex }))
    .sort((a, b) => {
      const ai = typeof a.message.orderingIndex === "number"
        ? a.message.orderingIndex
        : Number.MAX_SAFE_INTEGER;
      const bi = typeof b.message.orderingIndex === "number"
        ? b.message.orderingIndex
        : Number.MAX_SAFE_INTEGER;
      const orderingDelta = ai - bi;
      return orderingDelta !== 0 ? orderingDelta : a.originalIndex - b.originalIndex;
    });

  const conversationMessages: PromptEnhancementConversationMessage[] = [];

  for (const { message } of chronologicalMessages) {
    if (!isPromptEnhancementConversationRole(message.role)) continue;
    if (metadataIndicatesNonConversationalMessage(message.metadata)) continue;

    const content = formatPromptEnhancementMessageContent(message);
    if (!content) continue;

    conversationMessages.push({
      role: message.role,
      content: content.slice(0, maxMessageChars),
    });
  }

  return conversationMessages.slice(-maxMessages);
}

export function formatPromptEnhancementAttachmentList(
  attachments: unknown,
  options: { heading?: string; maxItems?: number } = {},
): string | undefined {
  if (!Array.isArray(attachments)) return undefined;

  const normalized = attachments
    .map(normalizePromptEnhancementAttachment)
    .filter((attachment): attachment is PromptEnhancementAttachmentContext => attachment !== null);

  if (normalized.length === 0) return undefined;

  const maxItems = options.maxItems ?? MAX_PROMPT_ENHANCEMENT_ATTACHMENT_ITEMS;
  const heading = options.heading ?? "### Current composer attachments";
  const rendered = normalized
    .slice(0, maxItems)
    .map((attachment, index) => `${index + 1}. ${formatPromptEnhancementAttachmentReference(attachment)}`);

  if (normalized.length > maxItems) {
    rendered.push(`…${normalized.length - maxItems} more attachment(s) omitted from enhancement context.`);
  }

  return [heading, ...rendered].join("\n");
}

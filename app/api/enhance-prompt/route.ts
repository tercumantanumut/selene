/**
 * Prompt Enhancement API
 *
 * Endpoint for manually enhancing prompts with context from synced folders.
 * Called by the "Enhance" button in the chat composer.
 *
 * Supports two modes:
 * - LLM-driven (useLLM: true): Uses secondary LLM to synthesize context
 * - Heuristic (useLLM: false): Uses rule-based enhancement
 */

import { NextRequest, NextResponse } from "next/server";
import { enhancePrompt, type PromptEnhancementResult, type EnhancedPromptOptions } from "@/lib/ai/prompt-enhancement";
import { enhancePromptWithLLM, type LLMEnhancementOptions, type LLMEnhancementResult } from "@/lib/ai/prompt-enhancement-v2";
import { requireAuth, getLocalUser } from "@/lib/auth/local-auth";
import {
  createAgentRun,
  completeAgentRun,
  withRunContext,
} from "@/lib/observability";
import {
  getOrCreateCharacterSession,
  createSession,
  getSessionByMetadataKey,
  getSession,
} from "@/lib/db/queries";
import { getMessages } from "@/lib/db/queries-messages";
import { getCharacter } from "@/lib/characters/queries";

interface ChatAttachmentContext {
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

interface EnhancePromptRequestBody {
  input?: string;
  characterId?: string;
  sessionId?: string;
  /** Use LLM-driven enhancement (default: true) */
  useLLM?: boolean;
  /** Recent conversation messages for context */
  conversationContext?: Array<{ role: string; content: string }>;
  /** Current unsent composer attachments/images */
  currentAttachments?: ChatAttachmentContext[];
  /** Options for heuristic enhancement (legacy) */
  options?: EnhancedPromptOptions;
}

const MAX_ATTACHMENT_CONTEXT_ITEMS = 20;
const MAX_REFERENCE_VALUE_CHARS = 500;

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

function normalizeAttachmentContext(value: unknown): ChatAttachmentContext | null {
  if (!isRecord(value)) return null;

  const attachment: ChatAttachmentContext = {
    id: stringValue(value.id),
    name: stringValue(value.name) ?? stringValue(value.filename) ?? stringValue(value.displayName),
    contentType: stringValue(value.contentType) ?? stringValue(value.mediaType) ?? stringValue(value.mimeType),
    url: stringValue(value.url) ?? stringValue(value.image) ?? stringValue(value.data),
    localPath: stringValue(value.localPath),
    filePath: stringValue(value.filePath),
    size: numberValue(value.size),
    kind: stringValue(value.kind) ?? stringValue(value.type),
    inline: booleanValue(value.inline),
    order: numberValue(value.order),
    status: stringValue(value.status),
  };

  return Object.values(attachment).some((entry) => entry !== undefined) ? attachment : null;
}

function normalizeAttachmentArray(value: unknown): ChatAttachmentContext[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeAttachmentContext)
    .filter((attachment): attachment is ChatAttachmentContext => attachment !== null);
}

function getMetadataAttachments(metadata: unknown): ChatAttachmentContext[] {
  const parsed = parseMetadataObject(metadata);
  const custom = isRecord(parsed?.custom) ? parsed.custom : null;
  if (!custom) return [];

  return [
    ...normalizeAttachmentArray(custom.inlineAttachments),
    ...normalizeAttachmentArray(custom.attachments),
  ];
}

function isImageAttachment(attachment: ChatAttachmentContext): boolean {
  const contentType = attachment.contentType?.toLowerCase();
  const kind = attachment.kind?.toLowerCase();
  return contentType?.startsWith("image/") === true || kind?.includes("image") === true;
}

function shortenReferenceValue(value: string): string {
  if (value.startsWith("data:")) {
    const commaIndex = value.indexOf(",");
    return commaIndex >= 0
      ? `${value.slice(0, commaIndex + 1)}[base64 omitted]`
      : "data:[inline data omitted]";
  }
  if (value.length <= MAX_REFERENCE_VALUE_CHARS) return value;
  return `${value.slice(0, MAX_REFERENCE_VALUE_CHARS - 1)}…`;
}

function formatAttachmentReference(attachment: ChatAttachmentContext): string {
  const label = isImageAttachment(attachment) ? "Image" : "Attachment";
  const displayName = attachment.name ?? (label === "Image" ? "uploaded image" : "uploaded file");
  const details: string[] = [displayName];

  if (attachment.contentType) details.push(attachment.contentType);
  if (attachment.kind && attachment.kind !== attachment.contentType) details.push(`kind: ${attachment.kind}`);
  if (attachment.status) details.push(`status: ${attachment.status}`);
  if (typeof attachment.size === "number") details.push(`size: ${attachment.size} bytes`);
  if (attachment.url) details.push(`url: ${shortenReferenceValue(attachment.url)}`);
  if (attachment.filePath) details.push(`filePath: ${shortenReferenceValue(attachment.filePath)}`);
  if (attachment.localPath) details.push(`localPath: ${shortenReferenceValue(attachment.localPath)}`);

  return `[${label}: ${details.join(" | ")}]`;
}

function attachmentKey(attachment: ChatAttachmentContext): string | null {
  return attachment.url
    ?? attachment.filePath
    ?? attachment.localPath
    ?? attachment.id
    ?? attachment.name
    ?? null;
}

function pushAttachmentReference(
  lines: string[],
  seenAttachmentKeys: Set<string>,
  attachment: ChatAttachmentContext,
): void {
  const key = attachmentKey(attachment);
  if (key) {
    if (seenAttachmentKeys.has(key)) return;
    seenAttachmentKeys.add(key);
  }
  lines.push(formatAttachmentReference(attachment));
}

function attachmentFromContentPart(part: Record<string, unknown>): ChatAttachmentContext | null {
  const type = stringValue(part.type);
  if (type !== "image" && type !== "file") return null;

  return normalizeAttachmentContext({
    id: part.id,
    name: part.displayName ?? part.filename ?? part.name,
    contentType: part.mediaType ?? part.mimeType ?? part.contentType,
    url: part.image ?? part.url ?? part.data,
    localPath: part.localPath,
    filePath: part.filePath,
    size: part.size,
    kind: type === "image" ? "image" : part.kind ?? type,
    inline: part.inline,
    order: part.order,
  });
}

function formatMessageContentForEnhancement(content: unknown, metadata: unknown): string {
  const lines: string[] = [];
  const seenAttachmentKeys = new Set<string>();

  if (typeof content === "string") {
    const text = content.trim();
    if (text) lines.push(text);
  } else if (Array.isArray(content)) {
    for (const rawPart of content) {
      if (!isRecord(rawPart)) continue;
      const type = stringValue(rawPart.type);
      if (type === "text") {
        const text = stringValue(rawPart.text);
        if (text) lines.push(text);
        continue;
      }

      const attachment = attachmentFromContentPart(rawPart);
      if (attachment) {
        pushAttachmentReference(lines, seenAttachmentKeys, attachment);
      }
    }
  }

  for (const attachment of getMetadataAttachments(metadata)) {
    pushAttachmentReference(lines, seenAttachmentKeys, attachment);
  }

  return lines.join("\n").trim();
}

function formatCurrentAttachmentsForEnhancement(attachments: unknown): string | undefined {
  const normalized = normalizeAttachmentArray(attachments);
  if (normalized.length === 0) return undefined;

  const rendered = normalized
    .slice(0, MAX_ATTACHMENT_CONTEXT_ITEMS)
    .map((attachment, index) => `${index + 1}. ${formatAttachmentReference(attachment)}`);

  if (normalized.length > MAX_ATTACHMENT_CONTEXT_ITEMS) {
    rendered.push(`…${normalized.length - MAX_ATTACHMENT_CONTEXT_ITEMS} more attachment(s) omitted from enhancement context.`);
  }

  return ["### Current composer attachments", ...rendered].join("\n");
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // Authenticate the request
    await requireAuth(req);
    const user = await getLocalUser();
    const userId = user.id;

    const body = await req.json() as EnhancePromptRequestBody;
    const {
      input,
      characterId,
      sessionId: providedSessionId,
      useLLM = true,
      conversationContext,
      currentAttachments,
      options,
    } = body;

    // Validate required fields
    if (!input || typeof input !== "string") {
      return NextResponse.json(
        { error: "Input text is required" },
        { status: 400 }
      );
    }

    // characterId is now optional - we can enhance prompts without agent context
    const validCharacterId = characterId && typeof characterId === "string" ? characterId : null;

    // Prefer the current chat session when provided so enhancement uses the same session model overrides.
    // If the session doesn't exist yet (e.g. enhance triggered before first chat message),
    // fall through to character-based or anonymous session creation.
    let sessionRecord!: Awaited<ReturnType<typeof createSession>>;
    let resolvedFromProvidedSession = false;
    if (typeof providedSessionId === "string" && providedSessionId.trim().length > 0) {
      const existingSession = await getSession(providedSessionId);
      if (existingSession && existingSession.userId === userId) {
        sessionRecord = existingSession;
        resolvedFromProvidedSession = true;
      }
      // If session not found or belongs to another user, fall through to create one
    }

    if (!resolvedFromProvidedSession && validCharacterId) {
      const { session } = await getOrCreateCharacterSession(userId, validCharacterId, "Prompt Enhancement");
      sessionRecord = session;
    } else if (!resolvedFromProvidedSession) {
      const metadataKey = `prompt-enhancement:${userId}`;
      const existingSession = await getSessionByMetadataKey(
        userId,
        "prompt-enhancement",
        metadataKey
      );

      sessionRecord =
        existingSession ??
        (await createSession({
          title: "Prompt Enhancement",
          userId,
          metadata: { type: "prompt-enhancement", key: metadataKey },
        }));
    }

    const sessionId = sessionRecord.id;

    // Create agent run for observability
    const agentRun = await createAgentRun({
      sessionId,
      userId,
      pipelineName: "enhance-prompt",
      triggerType: "api",
      characterId: validCharacterId || undefined,
      metadata: {
        inputLength: input.length,
        useLLM,
        hasConversationContext: !!conversationContext?.length,
        hasCurrentAttachments: Array.isArray(currentAttachments) && currentAttachments.length > 0,
        hasAgentContext: !!validCharacterId,
      },
    });

    try {
      // Use LLM-driven enhancement by default
      if (useLLM) {
        // Fetch authoritative chat history from DB (server-side, not client-dependent)
        let dbMessages: Array<{ role: string; content: string }> | undefined;
        if (resolvedFromProvidedSession && sessionRecord?.id) {
          try {
            const allMessages = await getMessages(sessionRecord.id);
            // Filter: only user/assistant messages with actual text, no tool results, no injected prompts
            const visibleMessages = allMessages.filter((m) => {
              if (m.role !== "user" && m.role !== "assistant") return false;
              // Exclude livePromptInjected messages
              const meta = parseMetadataObject(m.metadata);
              if (meta?.livePromptInjected === true) return false;
              return true;
            });

            // Defensive chronological sort by `orderingIndex` (ascending: oldest → newest).
            // `getMessages` already sorts by orderingIndex asc, but we enforce it locally so
            // the enhancer's history contract doesn't silently depend on that default.
            // Canonical ordering source: `nextOrderingIndex(sessionId)` in `app/api/chat/route.ts`.
            visibleMessages.sort((a, b) => {
              const ai = typeof a.orderingIndex === "number" ? a.orderingIndex : Number.MAX_SAFE_INTEGER;
              const bi = typeof b.orderingIndex === "number" ? b.orderingIndex : Number.MAX_SAFE_INTEGER;
              return ai - bi;
            });

            // Take last 3 user-assistant pairs (up to 6 messages) for full conversational context.
            // Walk backwards to collect up to 3 pairs, then `unshift` preserves ascending order.
            const pairs: typeof visibleMessages = [];
            let pairsFound = 0;
            for (let i = visibleMessages.length - 1; i >= 0 && pairsFound < 3; i--) {
              pairs.unshift(visibleMessages[i]);
              // A pair is complete when we hit a user message (user→assistant)
              if (visibleMessages[i].role === "user") pairsFound++;
            }
            dbMessages = pairs.map((m) => {
              const text = formatMessageContentForEnhancement(m.content, m.metadata);
              return { role: m.role, content: text.slice(0, 25000) };
            }).filter((m) => m.content.length > 0);
          } catch (err) {
            console.warn("[enhance-prompt] Failed to fetch DB messages, falling back to client context:", err);
          }
        }

        const currentAttachmentContext = formatCurrentAttachmentsForEnhancement(currentAttachments);

        // Fetch agent identity for enhancement context
        let agentName: string | undefined;
        let agentPurpose: string | undefined;
        let agentTagline: string | undefined;
        if (validCharacterId) {
          try {
            const character = await getCharacter(validCharacterId);
            if (character) {
              agentName = character.name || undefined;
              agentTagline = character.tagline || undefined;
              const charMeta = typeof character.metadata === "string"
                ? (() => { try { return JSON.parse(character.metadata); } catch { return null; } })()
                : character.metadata;
              agentPurpose = charMeta?.purpose || undefined;
            }
          } catch (err) {
            console.warn("[enhance-prompt] Failed to fetch character:", err);
          }
        }

        const result = await withRunContext(
          { runId: agentRun.id, sessionId, pipelineName: "enhance-prompt" },
          async () => {
            const llmOptions: LLMEnhancementOptions = {
              timeoutMs: 135000, // 135s — search + LLM synthesis pipeline needs headroom
              conversationContext,
              dbMessages,
              currentAttachmentContext,
              userId,
              sessionId,
              sessionMetadata: sessionRecord.metadata as Record<string, unknown> | null,
              includeFileTree: true,
              includeMemories: true,
              agentName,
              agentPurpose,
              agentTagline,
              sessionTitle: sessionRecord.title || undefined,
            };
            return enhancePromptWithLLM(input, validCharacterId, llmOptions);
          }
        );

        await completeAgentRun(agentRun.id, "succeeded", {
          enhanced: result.enhanced,
          filesFound: result.filesFound,
          chunksRetrieved: result.chunksRetrieved,
          usedLLM: result.usedLLM,
        });

        return NextResponse.json({
          success: result.enhanced,
          enhancedPrompt: result.prompt,
          originalQuery: result.originalQuery,
          filesFound: result.filesFound,
          chunksRetrieved: result.chunksRetrieved,
          usedLLM: result.usedLLM,
          skipReason: result.skipReason,
          error: result.error,
        });
      }

      // Fallback to heuristic enhancement
      const result = await withRunContext(
        { runId: agentRun.id, sessionId, pipelineName: "enhance-prompt" },
        async () => enhancePrompt(input, validCharacterId, options)
      );

      await completeAgentRun(agentRun.id, "succeeded", {
        enhanced: result.enhanced,
        filesFound: result.filesFound,
        chunksRetrieved: result.chunksRetrieved,
        usedLLM: false,
      });

      return NextResponse.json({
        success: result.enhanced,
        enhancedPrompt: result.prompt,
        originalQuery: result.originalQuery,
        filesFound: result.filesFound,
        chunksRetrieved: result.chunksRetrieved,
        expandedConcepts: result.expandedConcepts,
        dependenciesResolved: result.dependenciesResolved,
        skipReason: result.skipReason,
        usedLLM: false,
      });
    } catch (enhanceError) {
      await completeAgentRun(agentRun.id, "failed", {
        error: enhanceError instanceof Error ? enhanceError.message : "Unknown error",
      });
      throw enhanceError;
    }
  } catch (error) {
    console.error("[EnhancePrompt API] Error:", error);

    // Handle authentication errors
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to enhance prompt" },
      { status: 500 }
    );
  }
}


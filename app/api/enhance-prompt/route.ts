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
import {
  buildPromptEnhancementHistory,
  formatPromptEnhancementAttachmentList,
  type PromptEnhancementAttachmentContext,
} from "@/lib/ai/prompt-enhancement-history";

interface EnhancePromptRequestBody {
  input?: string;
  characterId?: string;
  sessionId?: string;
  /** Use LLM-driven enhancement (default: true) */
  useLLM?: boolean;
  /** Recent conversation messages for context */
  conversationContext?: Array<{ role: string; content: string }>;
  /** Current unsent composer attachments/images */
  currentAttachments?: PromptEnhancementAttachmentContext[];
  /** Options for heuristic enhancement (legacy) */
  options?: EnhancedPromptOptions;
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
        // Fetch authoritative chat history from DB (server-side, not client-dependent).
        // The history builder filters to chronological user/assistant messages,
        // removes lifecycle/task rows (for example live prompt injections), drops
        // empty/tool-only messages, and caps the result at the latest 6 messages.
        let dbMessages: Array<{ role: "user" | "assistant"; content: string }> | undefined;
        if (resolvedFromProvidedSession && sessionRecord?.id) {
          try {
            dbMessages = buildPromptEnhancementHistory(await getMessages(sessionRecord.id));
          } catch (err) {
            console.warn("[enhance-prompt] Failed to fetch DB messages, falling back to client context:", err);
          }
        }

        const currentAttachmentContext = formatPromptEnhancementAttachmentList(currentAttachments);

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


import { stat } from "node:fs/promises";
import {
  createUIMessageStreamResponse,
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type Tool,
  type UIMessageChunk,
  type UserModelMessage,
} from "ai";
import { ensureAntigravityTokenValid, ensureClaudeCodeTokenValid, ensureCodexTokenValid, ensureKimiTokenValid, providerSupportsFeature } from "@/lib/ai/providers";
import { registerAllTools } from "@/lib/ai/tool-registry";
import { AI_CONFIG } from "@/lib/ai/config";
import { getPrimarySyncFolder } from "@/lib/vectordb/sync-folder-crud";
import { shouldUseCache } from "@/lib/ai/cache/config";
import { applyCacheToMessages, estimateCacheSavings } from "@/lib/ai/cache/message-cache";
import { ContextWindowManager, isDelegatedToolName } from "@/lib/context-window";
import {
  getSessionDisplayNameForSession,
  getSessionProviderTemperatureForSession,
  resolveSessionLanguageModelForSession,
  resolveSessionModelScopeForSession,
  resolveSessionVisionModelForSession,
} from "@/lib/ai/session-model-resolver";
import { generateSessionTitle } from "@/lib/ai/title-generator";
import { createSession, createMessage, updateMessage, getSession, getOrCreateLocalUser, updateSession, deleteMessagesNotIn, getInjectedMessageIds, getSessionWithMessages } from "@/lib/db/queries";
import { requireAuth } from "@/lib/auth/local-auth";
import { loadSettings } from "@/lib/settings/settings-manager";
import { sessionHasTruncatedContent } from "@/lib/ai/truncated-content-store";
import { taskRegistry } from "@/lib/background-tasks/registry";
import { registerChatAbortController, removeChatAbortController } from "@/lib/background-tasks/chat-abort-registry";
import {
  createLivePromptQueue,
  drainLivePromptQueue,
  removeLivePromptQueue,
  waitForQueueMessage,
  reserveLivePromptQueueBySession,
  promoteLivePromptQueueToRunId,
  clearLivePromptQueueBySession,
  getLivePromptQueueKeyBySession,
} from "@/lib/background-tasks/live-prompt-queue-registry";
import {
  buildUserInjectionContent,
  buildStopSystemMessage,
} from "@/lib/background-tasks/live-prompt-helpers";
import {
  drainDelegationCompletions,
} from "@/lib/ai/tools/delegation-completion-store";
import { createHeartbeatStream } from "@/lib/utils/heartbeat-stream";
import {
    classifyRecoverability,
    getBackoffDelayMs,
    normalizeStreamError,
    shouldRetry,
    sleepWithAbort,
} from "@/lib/ai/retry/stream-recovery";
import type { ChatTask } from "@/lib/background-tasks/types";
import { nowISO } from "@/lib/utils/timestamp";
import { convertDBMessagesToUIMessages, type DBToolCallPart } from "@/lib/messages/converter";
import type { FrontendMessage } from "@/lib/messages/tool-enhancement";
import { MAX_STREAM_TOOL_RESULT_TOKENS } from "@/lib/ai/tool-result-stream-guard";
import {
  withRunContext,
  createAgentRun,
  completeAgentRun,
  appendRunEvent,
  initializeToolEventHandler,
} from "@/lib/observability";
import { nextOrderingIndex } from "@/lib/session/message-ordering";
import { getEnabledPluginsForAgent, getInstalledPlugins, loadPluginHooks } from "@/lib/plugins/registry";
import { getWorkflowByAgentId } from "@/lib/agents/workflows";
import { getWorkflowResources } from "@/lib/agents/workflow-resource-context";
import { INTERNAL_API_SECRET } from "@/lib/config/internal-api-secret";
import {
  handleInjectedPromptsCC,
  handleInjectedPromptsNonCC,
  type InjectionStreamingState,
} from "@/lib/ai/streaming/injection-handler";
import type { InjectionStreamWriter } from "@/lib/ai/streaming/injection-stream-emitter";
import { generateNextAssistantMessageId } from "@/lib/ai/streaming/injection-stream-emitter";
import {
  findOrphanToolCalls,
  buildSyntheticModelToolResults,
} from "@/lib/ai/providers/message-shaping";

// ── Extracted utility modules ─────────────────────────────────────────────────
import {
  shouldInjectContext,
  getContextInjectionTracking,
  getDiscoveredToolsFromMessages,
  getDiscoveredToolsFromMetadata,
  isValidIanaTimezone,
  resolvePluginRootMap,
} from "./context-injection";
import { extractContent } from "./content-extractor";
import { stripPasteDelimitersFromMessage } from "./content-sanitizer";
import {
  type StreamingMessageState,
  appendTextPartToState,
  recordToolInputStart,
  recordToolInputDelta,
  recordStructuredToolCall,
  recordToolResultChunk,
  finalizeStreamingToolCalls,
  sealDanglingToolCalls,
} from "./streaming-state";
import {
  shouldTreatStreamErrorAsCancellation,
} from "./canonical-content";
import { buildToolsForRequest } from "./tools-builder";
import { prepareMessagesForRequest } from "./message-prep";
import { createOnFinishCallback, createOnAbortCallback, handleUndrainedQueueMessages } from "./stream-callbacks";
import { createSyncStreamingMessage } from "./streaming-progress";
import { buildSystemPromptForRequest } from "./system-prompt-builder";
import { mcpContextStore, type SeleneMcpContext } from "@/lib/ai/providers/mcp-context-store";
import { createSdkToolResultBridge } from "./sdk-tool-result-bridge";
import {
  disableToolForSchemaRecovery,
  parseInvalidToolSchemaError,
} from "./tool-schema-recovery";
import { tagIntermediateDelegationParts } from "./delegation-scope-tagging";
import { shouldStopTurn, hasRunningDelegationsForSession, hasRunningBackgroundTasksForSession, hasActiveAsyncWork } from "./delegation-waiting";
import { createThinkTagFilter, shouldFilterThinkTags } from "@/lib/ai/streaming/think-tag-filter";
import { thinkTagMiddleware, hasThinkTags } from "@/lib/ai/utils/think-tag-stream";
import { ollamaModelSupportsThinking } from "@/lib/ai/providers/ollama-capabilities";
import { detectEmotion } from "@/lib/emotion";
import {
  isUiChunkCommittable,
  shouldAttemptPrecommitRecovery,
} from "./ui-stream-recovery";

// Initialize tool event handler for observability (once per runtime)
initializeToolEventHandler();

// Maximum request duration in seconds
export const maxDuration = 36000; // 10 hours

// Ensure settings are loaded (syncs provider selection to process.env)
loadSettings();

// Initialize tool registry once per runtime
registerAllTools();

// Check if Styly AI API is configured (for tool discovery instructions)
const hasStylyApiKey = () => !!process.env.STYLY_AI_API_KEY;

export async function POST(req: Request) {
  let agentRun: { id: string } | null = null;
  let chatTaskRegistered = false;
  let configuredProvider: string | undefined;
  let activeSessionId: string | undefined;
  let sessionId = "";
  let runId = "";
  let latestUserPromptText = "";
  let sdkToolResultBridge: ReturnType<typeof createSdkToolResultBridge> | null = null;
  let streamAbortSignal: AbortSignal = req.signal;
  let clientDisconnected = false;
  try {
    const isScheduledRun = req.headers.get("X-Scheduled-Run") === "true";
    const isInternalAuth = req.headers.get("X-Internal-Auth") === INTERNAL_API_SECRET;
    let userId: string;

    const scheduledRunId = isScheduledRun ? req.headers.get("X-Scheduled-Run-Id") : null;
    const scheduledTaskId = isScheduledRun ? req.headers.get("X-Scheduled-Task-Id") : null;
    const scheduledTaskName = isScheduledRun ? req.headers.get("X-Scheduled-Task-Name") : null;

    if (isInternalAuth) {
      const headerSessionId = req.headers.get("X-Session-Id");
      if (headerSessionId) {
        const session = await getSession(headerSessionId);
        if (session?.userId) {
          userId = session.userId;
          console.debug(`[CHAT API] Internal auth bypass for user ${userId}`);
        } else {
          return new Response(
            JSON.stringify({ error: "Invalid session for scheduled task" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
      } else {
        return new Response(
          JSON.stringify({ error: "Session ID required for scheduled task" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    } else {
      userId = await requireAuth(req);
    }

    const settings = loadSettings();
    const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);

    const selectedProvider = (settings.llmProvider || process.env.LLM_PROVIDER || "").toLowerCase();

    // Best-effort OAuth token refresh for ALL providers that have stored
    // tokens.  This runs regardless of which provider `selectedProvider`
    // points to, because the session-model-resolver may pick a *different*
    // provider from the agent or session config.  Running them in parallel
    // keeps latency minimal; failures are non-fatal — the resolver will
    // gracefully fall back if a provider remains unavailable.
    if (!isInternalAuth) {
      const refreshResults = await Promise.allSettled([
        selectedProvider === "antigravity" || settings.antigravityAuth?.isAuthenticated
          ? ensureAntigravityTokenValid()
          : Promise.resolve(true),
        selectedProvider === "claudecode"
          ? ensureClaudeCodeTokenValid()
          : Promise.resolve(true),
        selectedProvider === "codex" || settings.codexAuth?.isAuthenticated
          ? ensureCodexTokenValid()
          : Promise.resolve(true),
        selectedProvider === "kimi" || settings.kimiAuth?.isAuthenticated
          ? ensureKimiTokenValid()
          : Promise.resolve(true),
      ]);

      // Log failures but don't hard-fail — let the session resolver fall back.
      const labels = ["antigravity", "claudecode", "codex", "kimi"] as const;
      for (let i = 0; i < refreshResults.length; i++) {
        const r = refreshResults[i];
        if (r.status === "fulfilled" && !r.value && labels[i] === selectedProvider) {
          console.warn(`[CHAT API] ${labels[i]} token refresh failed; resolver will handle fallback`);
        }
      }
    }

    const body = await req.json();
    const { messages, sessionId: bodySessionId } = body as {
      messages: Array<{
        id?: string;
        role: string;
        content?: string | unknown;
        parts?: Array<{ type: string; text?: string; image?: string; url?: string }>;
        experimental_attachments?: Array<{
          name?: string;
          contentType?: string;
          url?: string;
          localPath?: string;
          filePath?: string;
          size?: number;
          kind?: string;
        }>;
        metadata?: {
          custom?: {
            attachments?: Array<{
              name?: string;
              contentType?: string;
              url?: string;
              localPath?: string;
              filePath?: string;
              size?: number;
              kind?: string;
            }>;
          };
        };
      }>;
      sessionId?: string;
    };

    const headerSessionId = req.headers.get("X-Session-Id");
    const providedSessionId = headerSessionId || bodySessionId;

    const characterId = req.headers.get("X-Character-Id");
    const userTimezoneHeader = req.headers.get("X-User-Timezone")?.trim() || null;
    const taskSource = req.headers.get("X-Task-Source")?.toLowerCase();
    const isChannelSource = taskSource === "channel";

    console.debug(`[CHAT API] Session ID: header=${headerSessionId}, body=${bodySessionId}, using=${providedSessionId}, characterId=${characterId}, source=${taskSource || "chat"}`);

    const lastMsg = messages[messages.length - 1];
    console.debug(`[CHAT API] Last message: role=${lastMsg?.role}, hasParts=${!!lastMsg?.parts}, partsCount=${lastMsg?.parts?.length}, hasAttachments=${!!(lastMsg as any)?.experimental_attachments}`);
    console.debug("[CHAT API] Last message detail", {
      metadata: lastMsg?.metadata,
      parts: lastMsg?.parts,
      experimental_attachments: (lastMsg as { experimental_attachments?: unknown })?.experimental_attachments,
    });

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: "Messages array is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    sessionId = providedSessionId ?? "";
    let isNewSession = false;
    let sessionMetadata: Record<string, unknown> = {};

    if (!sessionId) {
      const session = await createSession({
        title: "New Design Session",
        userId: dbUser.id,
        metadata: isValidIanaTimezone(userTimezoneHeader)
          ? { userTimezone: userTimezoneHeader }
          : {},
      });
      sessionId = session.id;
      isNewSession = true;
      sessionMetadata = (session.metadata as Record<string, unknown>) || {};
    } else {
      activeSessionId = sessionId;
    const session = await getSession(sessionId);
      if (!session) {
        const newSession = await createSession({
          id: sessionId,
          title: "New Design Session",
          userId: dbUser.id,
          metadata: isValidIanaTimezone(userTimezoneHeader)
            ? { userTimezone: userTimezoneHeader }
            : {},
        });
        sessionId = newSession.id;
        isNewSession = true;
        sessionMetadata = (newSession.metadata as Record<string, unknown>) || {};
      } else if (session.userId !== dbUser.id) {
        return new Response(
          JSON.stringify({ error: "Forbidden" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      } else {
        sessionMetadata = (session.metadata as Record<string, unknown>) || {};
      }
    }

    // Reserve the live-prompt queue as early as possible — before the slow
    // awaits (preflight check, createAgentRun) run. Injections POSTed to
    // /api/sessions/[id]/live-prompt-queue during the warmup window would
    // otherwise land before the queue is registered and come back as 409
    // `no_active_run`. The reservation is rekeyed to the real agentRun.id
    // below via `promoteLivePromptQueueToRunId`.
    activeSessionId = sessionId;
    reserveLivePromptQueueBySession(sessionId);

    // Keep session timezone fresh so tools in this same request can rely on it.
    if (isValidIanaTimezone(userTimezoneHeader) && sessionMetadata.userTimezone !== userTimezoneHeader) {
      sessionMetadata = { ...sessionMetadata, userTimezone: userTimezoneHeader };
      await updateSession(sessionId, { metadata: sessionMetadata });
    }

    const appSettings = loadSettings();
    const toolLoadingMode = appSettings.toolLoadingMode ?? "deferred";
    const eventCharacterId = characterId || ((sessionMetadata?.characterId as string | undefined) ?? "");
    const shouldEmitProgress = Boolean(sessionId);
    const streamingState: StreamingMessageState | null = shouldEmitProgress
      ? {
        parts: [],
        toolCallParts: new Map<string, DBToolCallPart>(),
        loggedIncompleteToolCalls: new Set<string>(),
        messageId: undefined,
        lastBroadcastAt: 0,
        lastBroadcastSignature: "",
        provenance: {
          contextScope: sessionMetadata?.isDelegation === true ? "delegated" : "main",
          provenanceVersion: 1,
        },
      }
      : null;

    // Pre-generate the assistant message ID so frontend stream and DB share
    // the same UUID. When a live prompt splits the run, we rotate this ID so
    // each assistant segment keeps a stable, unique frontend/DB identity.
    let assistantMessageId = crypto.randomUUID();

    const syncStreamingMessage = shouldEmitProgress && streamingState
      ? createSyncStreamingMessage({
          sessionId,
          userId: dbUser.id,
          eventCharacterId,
          scheduledRunId,
          scheduledTaskId,
          scheduledTaskName,
          getAgentRunId: () => agentRun?.id,
          streamingState,
          getAssistantMessageId: () => assistantMessageId,
        })
      : undefined;

    const handleExecuteCommandProgress = shouldEmitProgress && streamingState && syncStreamingMessage
      ? (update: import("@/lib/command-execution/types").ExecuteCommandProgressUpdate) => {
          if (!update.toolCallId) return;

          const commandLabel = [update.command, ...(update.args ?? [])].join(" ").trim();
          const progressMessage = update.message?.trim()
            || (commandLabel ? `Running ${commandLabel}...` : "Running command...");

          const normalizedResult = {
            status: update.status,
            stdout: update.stdout,
            stderr: update.stderr,
            exitCode: update.exitCode,
            executionTime: update.executionTime,
            error: update.error,
            logId: update.logId,
            isTruncated: update.isTruncated,
            startedAt: update.startedAt,
            message: progressMessage,
          };

          if (!streamingState.toolCallParts.has(update.toolCallId)) {
            recordStructuredToolCall(streamingState, update.toolCallId, "executeCommand", {
              command: update.command,
              args: update.args,
              cwd: update.cwd,
            });
          }

          recordToolResultChunk(
            streamingState,
            update.toolCallId,
            "executeCommand",
            normalizedResult,
            update.status === "running"
          );
          void syncStreamingMessage();
        }
      : undefined;

    const contextTracking = getContextInjectionTracking(sessionMetadata);
    const injectContext = shouldInjectContext(contextTracking, isNewSession, toolLoadingMode);
    console.debug(`[CHAT API] Context injection: isNew=${isNewSession}, tracking=${JSON.stringify(contextTracking)}, inject=${injectContext}`);

    // ── Context window pre-flight check ───────────────────────────────────────
    const resolvedSessionModels = await resolveSessionModelScopeForSession(sessionMetadata, {
      characterId,
      settings: appSettings,
    });
    const currentModelId = resolvedSessionModels.effectiveConfig.chatModel;
    const currentProvider = resolvedSessionModels.effectiveConfig.provider;
    const contextCheck = await ContextWindowManager.preFlightCheck(
      sessionId,
      currentModelId,
      5000, // Conservative system prompt estimate
      currentProvider
    );

    if (!contextCheck.canProceed) {
      console.error(`[CHAT API] Context window check failed: ${contextCheck.error}`, contextCheck.status);
      // Release the reservation — no agentRun will be created, so the normal
      // onFinish/onAbort cleanup paths won't run.
      clearLivePromptQueueBySession(sessionId);
      return new Response(
        JSON.stringify({
          error: "Context window limit exceeded",
          details: ContextWindowManager.getStatusMessage(contextCheck.status),
          status: contextCheck.status.status,
          recovery: contextCheck.recovery,
          compactionResult: contextCheck.compactionResult
            ? { success: contextCheck.compactionResult.success, tokensFreed: contextCheck.compactionResult.tokensFreed, messagesCompacted: contextCheck.compactionResult.messagesCompacted }
            : undefined,
        }),
        { status: 413, headers: { "Content-Type": "application/json" } }
      );
    }

    const streamToolResultBudgetTokens = MAX_STREAM_TOOL_RESULT_TOKENS;
    console.debug(`[CHAT API] Context window: ${contextCheck.status.status} (${contextCheck.status.formatted.current}/${contextCheck.status.formatted.max}), tool budget: ${streamToolResultBudgetTokens.toLocaleString()} tokens`);
    if (contextCheck.compactionResult?.success) {
      console.debug(`[CHAT API] Compaction completed: ${contextCheck.compactionResult.messagesCompacted} msgs, ${contextCheck.compactionResult.tokensFreed} tokens freed`);
    }

    // ── Create agent run ───────────────────────────────────────────────────────
    const resolvedCharacterId =
      characterId || ((sessionMetadata?.characterId as string | undefined) ?? undefined);

    agentRun = await createAgentRun({
      sessionId,
      userId: dbUser.id,
      pipelineName: "chat",
      triggerType: isScheduledRun ? "cron" : isChannelSource ? "webhook" : "chat",
      metadata: { characterId: resolvedCharacterId || null, messageCount: messages.length, taskSource: taskSource || "chat" },
    });
    const chatAbortController = new AbortController();
    registerChatAbortController(agentRun.id, chatAbortController);
    // Promote the earlier reservation (or create afresh if the reservation
    // path was somehow bypassed). Any injections that raced to the queue
    // during warmup are preserved and carried into the real runId key.
    promoteLivePromptQueueToRunId(sessionId, agentRun.id);

    const isDelegation = sessionMetadata?.isDelegation === true;
    const chatTask: ChatTask = {
      type: "chat",
      runId: agentRun.id,
      userId: dbUser.id,
      characterId: resolvedCharacterId,
      sessionId,
      status: "running",
      startedAt: nowISO(),
      pipelineName: "chat",
      triggerType: isScheduledRun ? "cron" : isChannelSource ? "webhook" : isDelegation ? "delegation" : "chat",
      messageCount: messages.length,
      metadata: isScheduledRun || isChannelSource || isDelegation
        ? {
            ...(isScheduledRun ? { scheduledRunId: scheduledRunId ?? undefined, scheduledTaskId: scheduledTaskId ?? undefined } : {}),
            ...(isChannelSource ? { suppressFromUI: true, taskSource: "channel" } : {}),
            ...(isDelegation ? {
              isDelegation: true,
              parentAgentId: sessionMetadata.parentAgentId,
              workflowId: sessionMetadata.workflowId,
              characterName: sessionMetadata.characterName,
              delegationTask: sessionMetadata.delegationTask,
            } : {}),
          }
        : undefined,
    };
    const existingTask = taskRegistry.get(agentRun.id);
    if (existingTask) {
      taskRegistry.updateStatus(agentRun.id, "running", chatTask);
    } else {
      taskRegistry.register(chatTask);
    }
    chatTaskRegistered = true;

    runId = agentRun.id;

    // ── Edit/Reload truncation cleanup ──────────────────────────────────────
    // IMPORTANT: This must run BEFORE saving the new user message. When a user
    // edits a message, assistant-ui sends a truncated list (everything up to the
    // edit point + the new version). If we created the new message first, it
    // would be appended at the end with the highest orderingIndex, making it the
    // maxKeptPosition in deleteMessagesNotIn — which would prevent deletion of
    // the old messages between the edit point and the new message.
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!isNewSession && !isScheduledRun) {
      const frontendIds = new Set(
        messages
          .filter(m => m.id && uuidRegex.test(m.id))
          .map(m => m.id!)
      );
      if (frontendIds.size > 0) {
        const injectedIds = await getInjectedMessageIds(sessionId);
        for (const id of injectedIds) {
          frontendIds.add(id);
        }
        const deleted = await deleteMessagesNotIn(sessionId, frontendIds);
        if (deleted > 0) {
          console.debug(`[CHAT API] Edit/reload truncation: removed ${deleted} stale message(s)`);
        }
      }
    }

    // ── Save new user message ──────────────────────────────────────────────────
    const lastMessage = messages[messages.length - 1];
    let persistedUserMessageId: string | undefined;
    const userMessageCount = messages.filter((msg) => msg.role === "user").length;

    if (!isScheduledRun && lastMessage && lastMessage.role === 'user') {
      // Strip [PASTE_CONTENT:N:M]...[/PASTE_CONTENT:N] delimiter tags but keep the pasted content.
      // This ensures full content is preserved in DB for reload, without tag clutter in the UI.
      const messageForDB = stripPasteDelimitersFromMessage(lastMessage);
      const persistedAttachments = [
        ...((lastMessage.metadata?.custom?.attachments ?? []).filter((attachment): attachment is NonNullable<typeof attachment> => !!attachment)),
        ...((lastMessage.experimental_attachments ?? []).filter((attachment): attachment is NonNullable<typeof attachment> => !!attachment)),
      ];
      const persistedInspectContext = (lastMessage.metadata?.custom as Record<string, unknown> | undefined)?.inspectContext ?? null;
      const extractedContent = await extractContent(messageForDB);
      const normalizedContent: unknown[] = Array.isArray(extractedContent)
        ? extractedContent
        : [{ type: "text", text: typeof extractedContent === "string" ? extractedContent : "" }];

      const isValidUUID = lastMessage.id && uuidRegex.test(lastMessage.id);
      const userMessageIndex = await nextOrderingIndex(sessionId);
      const customMetadata: Record<string, unknown> = {};
      if (persistedAttachments.length > 0) customMetadata.attachments = persistedAttachments;
      if (persistedInspectContext) customMetadata.inspectContext = persistedInspectContext;
      const result = await createMessage({
        ...(isValidUUID && { id: lastMessage.id }),
        sessionId,
        role: 'user',
        content: normalizedContent,
        orderingIndex: userMessageIndex,
        metadata: Object.keys(customMetadata).length > 0
          ? { custom: customMetadata }
          : {},
      });
      let savedUserMessageId = result?.id;

      // Handle same-UUID edit: if createMessage hit a UNIQUE constraint (the user
      // edited a message and assistant-ui preserved the original message ID),
      // update the existing message's content and ordering instead.
      if (!savedUserMessageId && isValidUUID && lastMessage.id) {
        await updateMessage(lastMessage.id, {
          content: normalizedContent,
        });
        savedUserMessageId = lastMessage.id;
        console.debug(`[CHAT API] Updated existing user message (edit): ${lastMessage.id}`);
      }

      persistedUserMessageId = savedUserMessageId;
      if (!isValidUUID || result) {
        console.debug(`[CHAT API] Saved new user message: ${lastMessage.id} -> ${savedUserMessageId || 'SKIPPED (conflict)'}`);
      }

      const plainTextContent = getPlainTextFromContent(extractedContent);
      latestUserPromptText = plainTextContent;
      if ((isNewSession || userMessageCount === 1) && plainTextContent.length > 0) {
        void generateSessionTitle(sessionId, plainTextContent);
      }

      // Fire-and-forget emotion detection (gated behind Selene Fun setting)
      if (appSettings.emotionDetectionEnabled) {
        detectEmotion(plainTextContent, [], { conversationId: sessionId }).catch(() => {});
      }
    }

    // ── Prepare messages (HYBRID approach) ────────────────────────────────────
    let requestMessages = messages as FrontendMessage[];
    let sessionSummaryForRequest: string | null | undefined;

    if (contextCheck.compactionResult?.success) {
      const refreshedSession = await getSessionWithMessages(sessionId);
      if (refreshedSession) {
        requestMessages = convertDBMessagesToUIMessages(
          refreshedSession.messages.filter((message) => !message.isCompacted) as any,
        ) as FrontendMessage[];
        sessionSummaryForRequest = refreshedSession.session.summary;
        console.debug(
          `[CHAT API] Rebuilt request messages from compacted DB state: ${requestMessages.length} active messages`,
        );
      }
    }

    console.debug(`[CHAT API] Using HYBRID approach: ${requestMessages.length} frontend messages`);
    const { coreMessages, enhancedMessages } = await prepareMessagesForRequest({
      messages: requestMessages,
      sessionId,
      userId: dbUser.id,
      characterId,
      sessionMetadata,
      currentModelId,
      currentProvider,
      sessionSummary: sessionSummaryForRequest,
    });

    // ── Plugin / workflow scope ────────────────────────────────────────────────
    const useCaching = shouldUseCache(currentProvider);

    let scopedPlugins = await getInstalledPlugins(dbUser.id, { status: "active" });
    if (characterId) {
      scopedPlugins = await getEnabledPluginsForAgent(dbUser.id, characterId, characterId);
    }

    let workflowPromptContext: string | null = null;
    let workflowPromptContextInput: import("@/lib/agents/workflows").WorkflowPromptContextInput | null = null;
    if (characterId) {
      try {
        const workflowCtx = await getWorkflowByAgentId(characterId);
        if (workflowCtx) {
          const resources = await getWorkflowResources(workflowCtx.workflow.id, characterId, sessionId);
          if (resources) {
            if (resources.sharedResources.pluginIds.length > 0) {
              const existingIds = new Set(scopedPlugins.map((p) => p.id));
              const allPlugins = await getInstalledPlugins(dbUser.id, { status: "active" });
              for (const plugin of allPlugins) {
                if (resources.sharedResources.pluginIds.includes(plugin.id) && !existingIds.has(plugin.id)) {
                  scopedPlugins.push(plugin);
                  existingIds.add(plugin.id);
                }
              }
            }
            workflowPromptContext = resources.promptContext;
            workflowPromptContextInput = resources.promptContextInput;
            console.debug(`[CHAT API] Resolved workflow ${workflowCtx.workflow.id} (role: ${resources.role}, shared plugins: ${resources.sharedResources.pluginIds.length}, shared folders: ${resources.sharedResources.syncFolderIds.length})`);
          }
        }
      } catch (workflowError) {
        console.warn("[CHAT API] Failed to resolve workflow context (non-fatal):", workflowError);
      }
    }

    try {
      const hookCount = loadPluginHooks(scopedPlugins);
      if (hookCount > 0) console.debug(`[CHAT API] Loaded hooks from ${hookCount} scoped plugin(s)`);
    } catch (pluginHookError) {
      console.warn("[CHAT API] Failed to load scoped plugin hooks (non-fatal):", pluginHookError);
    }

    const pluginRoots = await resolvePluginRootMap(scopedPlugins);

    // ── Build system prompt ────────────────────────────────────────────────────
    const {
      systemPromptValue,
      characterAvatarUrl,
      characterAppearanceDescription,
      enabledTools,
    } = await buildSystemPromptForRequest({
      characterId,
      userId: dbUser.id,
      sessionId,
      toolLoadingMode,
      useCaching,
      sessionMetadata,
      contextWindowStatus: contextCheck.status,
      workflowPromptContext,
      devWorkspaceEnabled: appSettings.devWorkspaceEnabled ?? false,
      provider: currentProvider,
    });

    // ── Build tools ────────────────────────────────────────────────────────────
    const historicallyDiscoveredTools = getDiscoveredToolsFromMessages(enhancedMessages);
    const metadataDiscoveredTools = getDiscoveredToolsFromMetadata(sessionMetadata);
    const previouslyDiscoveredTools = new Set([...historicallyDiscoveredTools, ...metadataDiscoveredTools]);
    const allowedPluginNames = new Set(scopedPlugins.map((plugin) => plugin.name));

    const toolsResult = await buildToolsForRequest({
      sessionId,
      userId: dbUser.id,
      characterId,
      characterAvatarUrl,
      characterAppearanceDescription,
      sessionMetadata,
      enabledTools,
      previouslyDiscoveredTools,
      toolLoadingMode,
      devWorkspaceEnabled: appSettings.devWorkspaceEnabled ?? false,
      streamToolResultBudgetTokens,
      onExecuteCommandProgress: handleExecuteCommandProgress,
      pluginRoots,
      allowedPluginNames,
      workflowPromptContextInput,
      provider: currentProvider,
    });

    const {
      allToolsWithMCP,
      initialActiveToolNames,
      hasStopHooks,
      discoveredTools,
      initialActiveTools,
      enabledMcpServers,
      enabledMcpTools,
      alwaysLoadMcpToolIds,
    } = toolsResult;

    const useDeferredLoading = toolLoadingMode !== "always";

    // ── Selene MCP context for SDK agent tool exposure ─────────────────────────
    // Stored in AsyncLocalStorage so the Claude Agent SDK fetch interceptor can
    // read it without needing changes to every function signature in between.
    // Must be set AFTER buildToolsForRequest() so MCP servers are already
    // connected and their tools are registered in ToolRegistry.
    // Resolve agent's primary sync folder as the working directory for SDK agents
    let agentCwd: string | undefined;
    if (characterId) {
      const primaryFolder = await getPrimarySyncFolder(characterId);
      if (primaryFolder?.folderPath) {
        try {
          const stats = await stat(primaryFolder.folderPath);
          if (stats.isDirectory()) {
            agentCwd = primaryFolder.folderPath;
          } else {
            console.warn(`[CHAT API] Primary sync folder is not a directory: ${primaryFolder.folderPath}`);
          }
        } catch {
          console.warn(`[CHAT API] Primary sync folder path does not exist, falling back to process.cwd(): ${primaryFolder.folderPath}`);
        }
      }
    }

    const pluginPaths = scopedPlugins
      .map((p) => p.cachePath)
      .filter((p): p is string => Boolean(p));

    // Claude Agent SDK tool-result bridge:
    // - Provider adapter publishes SDK `tool_use_result` payloads keyed by tool_use_id
    // - Passthrough tool executors await the keyed payload and return it to AI SDK
    // This preserves real tool output in streaming + DB instead of placeholder stubs.
    sdkToolResultBridge = createSdkToolResultBridge();

    // Mutable ref wiring mid-stream injection (fired from `prepareStep` on
    // the non-CC path and `onQueueMessages` on the Claude Code path) to the
    // outer UIMessageChunk controller, which is created later inside the
    // ReadableStream `start()` closure. By the time either injection site
    // actually fires, the pump has set this ref to a live writer backed by
    // `emitChunk`. This is what lets both paths push a
    // `data-injected-user-message` chunk onto the wire without restructuring
    // the entire buffering/retry/disconnect pipeline.
    const injectionWriterRef: { current: InjectionStreamWriter | null } = {
      current: null,
    };

    const mcpCtx: SeleneMcpContext = {
      userId: dbUser.id,
      sessionId,
      runId,
      characterId: characterId ?? null,
      enabledTools: enabledTools ?? undefined,
      cwd: agentCwd,
      pluginPaths: pluginPaths.length > 0 ? pluginPaths : undefined,
      hookContext: scopedPlugins.length > 0
        ? { allowedPluginNames, pluginRoots }
        : undefined,
      // SDK tool-loading isolation fields
      toolLoadingMode: toolLoadingMode === "always" ? "always" : "deferred",
      previouslyDiscoveredTools: previouslyDiscoveredTools.size > 0
        ? [...previouslyDiscoveredTools]
        : undefined,
      enabledMcpServers,
      enabledMcpTools,
      alwaysLoadMcpToolIds,
      // Rich output callback: fires when an SDK MCP tool produces an image/video/etc.
      // Wires the result into Selene's streaming state so the UI renders media chips.
      // Capture non-null references in locals so the closure has definite types.
      onRichOutput: (() => {
        const _state = streamingState;
        const _sync = syncStreamingMessage;
        if (!_state || !_sync) return undefined;
        return (toolCallId: string, toolName: string, output: unknown) => {
          recordToolResultChunk(_state, toolCallId, toolName, output, false);
          void _sync();
        };
      })(),
      onExecuteCommandProgress: handleExecuteCommandProgress,
      sdkToolResultBridge,
      onQueueMessages: (() => {
        const _state = streamingState;
        const _sync = syncStreamingMessage;
        return async (entries) => {
          if (entries.length === 0) return;

          // Capture orphan tool-calls before seal (handler wipes state.parts).
          const orphanToolCalls = _state
            ? findOrphanToolCalls(
                _state.parts as unknown as Array<{
                  type?: string;
                  toolCallId?: string;
                  toolName?: string;
                }>,
              )
            : [];

          // Pre-generate the post-injection assistant id so the client splice
          // rotates to the matching id. See the non-CC primary injection
          // branch for the full branch-picker-fix rationale — same shape here.
          const nextAssistantMessageId = generateNextAssistantMessageId();

          // Shared seal + persist + emit-frame path. `handleInjectedPromptsCC`
          // writes one `data-injected-user-message` chunk per entry onto the
          // active UIMessageStream writer (via injectionWriterRef), so the
          // client can render the user turn mid-stream instead of waiting
          // for a full reload-on-finish.
          await handleInjectedPromptsCC({
            sessionId,
            prompts: entries,
            streamingState:
              _state as unknown as InjectionStreamingState | null,
            syncStreamingMessage: _sync ?? null,
            writer: injectionWriterRef.current,
            orphanToolCalls,
            nextAssistantMessageId,
          });

          if (_state && _sync) {
            assistantMessageId = nextAssistantMessageId;
            // Claude Code runs entirely inside streamText step 0, so any
            // injected follow-up content must ignore canonical step
            // reconciliation.
            _state.stepOffset = 1;
          }
        };
      })(),
    };

    // ── Apply caching to messages ──────────────────────────────────────────────
    const cachedMessages = useCaching ? applyCacheToMessages(coreMessages) : coreMessages;
    const hasUserImageInput = cachedMessages.some((message) => {
      if (message.role !== "user" || !Array.isArray(message.content)) return false;
      return message.content.some((part) =>
        part.type === "image"
        || (part.type === "file" && typeof part.mediaType === "string" && part.mediaType.startsWith("image/"))
      );
    });

    if (useCaching && injectContext) {
      const estimatedSavings = estimateCacheSavings(
        Array.isArray(systemPromptValue) ? systemPromptValue : [],
        cachedMessages
      );
      console.debug(`[CACHE] Estimated savings: ${estimatedSavings.totalCacheableTokens} tokens cacheable, ~$${estimatedSavings.estimatedSavings.toFixed(4)} saved per hit`);
    }

    // ── Stream setup ───────────────────────────────────────────────────────────
    const provider = currentProvider;
    configuredProvider = provider;
    const sessionDisplayName = await getSessionDisplayNameForSession(sessionMetadata, {
      characterId,
      settings: appSettings,
    });
    console.debug(
      `[CHAT API] Using LLM: ${sessionDisplayName}, inject=${injectContext}, caching=${useCaching ? "on" : "off"}, imageInput=${hasUserImageInput ? "yes" : "no"}`,
    );

    // ── Ollama capability detection ─────────────────────────────────────────
    // Query Ollama's /api/show to check if the model supports native thinking.
    // When supported, Ollama parses model-specific tags (DeepSeek <think>,
    // Gemma4 <|channel>thought, etc.) server-side and sends structured
    // delta.reasoning — no client-side middleware or filtering needed.
    let ollamaNativeThinking = false;
    if (provider === "ollama" && currentModelId) {
      try {
        ollamaNativeThinking = await ollamaModelSupportsThinking(currentModelId);
        if (ollamaNativeThinking) {
          console.debug(
            `[CHAT API] Ollama native thinking detected for model=${currentModelId} — skipping client-side think-tag handling`,
          );
        }
      } catch {
        // Capability check failed — fall back to client-side filtering
        console.debug(`[CHAT API] Ollama capability check failed for model=${currentModelId}, using fallback filtering`);
      }
    }

    // Think-tag filter: strip <think>...</think> blocks from non-Anthropic providers.
    // NOTE: This filter currently operates on text deltas as they are persisted to
    // the DB-backed message state (via onChunk). It does NOT transform the live SSE
    // stream sent to the client — the client receives raw text deltas and relies on
    // the DB-persisted (already-filtered) content when it re-fetches.
    // TODO: For true real-time filtering on the client, consider applying the filter
    // as a TransformStream on the SSE response, or filtering client-side.
    let thinkTagFilter: ReturnType<typeof createThinkTagFilter> | null = null;
    const recreateThinkTagFilter = () => {
      thinkTagFilter = shouldFilterThinkTags({ provider, modelId: currentModelId, ollamaSupportsThinking: ollamaNativeThinking })
        ? createThinkTagFilter()
        : null;
      if (thinkTagFilter) {
        console.debug(`[CHAT API] Think-tag filtering enabled for provider=${provider}, model=${currentModelId}`);
      }
    };
    recreateThinkTagFilter();

    const runFinalized = { value: false };

    const finalizeFailedRun = async (
      errorMessage: string,
      isCreditError: boolean,
      options?: { sourceError?: unknown; streamAborted?: boolean }
    ) => {
      if (runFinalized.value) return;
      runFinalized.value = true;

      // Flush any pending streaming state (tool-result parts) to DB before
      // marking the run as failed — syncStreamingMessage is throttled, so
      // a final forced sync ensures error results are persisted.
      if (streamingState) {
        finalizeStreamingToolCalls(streamingState);
        sealDanglingToolCalls(
          streamingState,
          options?.streamAborted
            ? "Tool execution was interrupted before completion."
            : "Tool execution ended before a final result was persisted."
        );
      }
      if (streamingState && syncStreamingMessage) {
        try {
          await syncStreamingMessage(true);
        } catch (syncError) {
          console.error("[CHAT API] Failed to sync streaming message during error finalization:", syncError);
        }
      }

      if (chatTaskRegistered && agentRun?.id) {
        try {
          const classification = classifyRecoverability({ provider, error: options?.sourceError, message: errorMessage });
          const shouldCancel = shouldTreatStreamErrorAsCancellation({
            errorMessage,
            isCreditError,
            streamAborted: options?.streamAborted ?? streamAbortSignal.aborted,
            classificationRecoverable: classification.recoverable,
            classificationReason: classification.reason,
          });
          const runStatus = shouldCancel ? "cancelled" : "failed";
          removeChatAbortController(agentRun.id);
          if (activeSessionId) {
            await handleUndrainedQueueMessages(agentRun.id, activeSessionId);
            removeLivePromptQueue(agentRun.id, activeSessionId);
          }
          await completeAgentRun(agentRun.id, runStatus, shouldCancel
            ? { reason: "stream_interrupted" }
            : { error: isCreditError ? "Insufficient credits" : errorMessage });
          const registryTask = taskRegistry.get(agentRun.id);
          const registryDurationMs = registryTask ? Date.now() - new Date(registryTask.startedAt).getTime() : undefined;
          taskRegistry.updateStatus(agentRun.id, runStatus, shouldCancel
            ? { durationMs: registryDurationMs }
            : { durationMs: registryDurationMs, error: isCreditError ? "Task interrupted - insufficient credits" : errorMessage });
        } catch (failureError) {
          console.error("[CHAT API] Failed to finalize agent run after stream error:", failureError);
        }
      }
      if (hasStopHooks) {
        try {
          const { runStopHooks } = await import("@/lib/plugins/hook-integration");
          runStopHooks(sessionId, options?.streamAborted ? "aborted" : "error", allowedPluginNames, pluginRoots);
        } catch (hookError) {
          console.error("[Hooks] Stop hook dispatch failed:", hookError);
        }
      }
    };

    // Decouple run lifetime from client connection. Previously req.signal was
    // combined here, meaning a renderer crash/reload (which closes the HTTP
    // connection) would abort the LLM call and cancel the run. Now only the
    // explicit user-stop controller can abort the computation. The onFinish
    // callback still fires and persists results to DB even if the client is gone.
    streamAbortSignal = chatAbortController.signal;

    // Track client disconnect separately for graceful transport teardown.
    // When this fires, we stop piping chunks but let the LLM call finish.
    const markClientDisconnected = () => {
      if (clientDisconnected) return;
      clientDisconnected = true;
      const abortReason = (() => {
        try {
          return req.signal.reason instanceof Error
            ? `${req.signal.reason.name}: ${req.signal.reason.message}`
            : String(req.signal.reason ?? "unknown");
        } catch {
          return "unavailable";
        }
      })();

      console.warn(
        `[CHAT API] Request abort observed (session=${sessionId}, run=${runId}, req.signal.aborted=${req.signal.aborted}, streamAbortSignal.aborted=${streamAbortSignal.aborted}, reason=${abortReason}) — client disconnected, LLM call continues and onFinish will persist results`
      );
    };
    // Check if already aborted before attaching listener (AbortSignal doesn't
    // replay past aborts to late listeners).
    if (req.signal.aborted) {
      console.warn(
        `[CHAT API] Request already aborted before listener attach (session=${sessionId}, run=${runId}, req.signal.aborted=${req.signal.aborted})`
      );
      markClientDisconnected();
    } else {
      req.signal.addEventListener("abort", markClientDisconnected, { once: true });
    }

    // Build shared callback context
    const callbackCtx = {
      sessionId,
      characterId,
      sessionMetadata,
      agentRun,
      streamingState,
      syncStreamingMessage,
      shouldEmitProgress,
      useCaching,
      systemPromptValue,
      cachedMessages,
      discoveredTools,
      previouslyDiscoveredTools,
      initialActiveToolNames,
      getAssistantMessageId: () => assistantMessageId,
      contextTracking,
      injectContext,
      toolLoadingMode,
      allowedPluginNames,
      pluginRoots,
      hasStopHooks,
      chatTaskRegistered,
      runFinalized,
      provider,
      streamAbortSignal,
      disposeSdkToolResultBridge: sdkToolResultBridge.dispose,
      latestUserPromptText,
      persistedUserMessageId,
    };

    const createStreamResult = () =>
      mcpContextStore.run(
        mcpCtx,
        () => withRunContext(
        { runId, sessionId, pipelineName: "chat", characterId: characterId || undefined },
        async () => {
          // Resolve the model, then conditionally wrap with think-tag middleware
          // for providers that emit raw <think>...</think> tags (vLLM, Ollama).
          // The middleware transforms think tags into proper reasoning stream parts.
          let resolvedModel = hasUserImageInput
            ? await resolveSessionVisionModelForSession(sessionMetadata, {
                characterId,
                settings: appSettings,
              })
            : await resolveSessionLanguageModelForSession(sessionMetadata, {
                characterId,
                settings: appSettings,
              });

          if (hasThinkTags({ provider, modelId: currentModelId, ollamaSupportsThinking: ollamaNativeThinking })) {
            // Cast needed: resolvers return LanguageModel (union), wrapLanguageModel expects LanguageModelV3.
            // Safe because resolvers always return actual model objects, never string IDs.
            resolvedModel = wrapLanguageModel({
              model: resolvedModel as Parameters<typeof wrapLanguageModel>[0]["model"],
              middleware: thinkTagMiddleware,
            });
          }

          // OpenRouter forwards to providers like Qwen/Alibaba that reject
          // multiple system messages. Flatten CacheableSystemBlock[] into a
          // single string so only one {role:"system"} is sent upstream.
          // Also absorb any session-summary system message from cachedMessages
          // so the final request has exactly one system message total.
          // Cache control markers are Anthropic-specific anyway, so no loss.
          let finalSystemPrompt: typeof systemPromptValue = systemPromptValue;
          let finalMessages = cachedMessages;
          if (provider === "openrouter") {
            if (Array.isArray(systemPromptValue)) {
              const parts = systemPromptValue.map((block) => block.content);
              // Absorb leading system messages from cachedMessages into the prompt
              const msgs = [...cachedMessages];
              while (msgs.length > 0 && msgs[0].role === "system") {
                parts.push(msgs[0].content as string);
                msgs.shift();
              }
              finalSystemPrompt = parts.join("\n\n");
              finalMessages = msgs;
            } else if (typeof systemPromptValue === "string") {
              // Even when not cached, absorb leading system messages
              const parts = [systemPromptValue];
              const msgs = [...cachedMessages];
              while (msgs.length > 0 && msgs[0].role === "system") {
                parts.push(msgs[0].content as string);
                msgs.shift();
              }
              finalSystemPrompt = parts.join("\n\n");
              finalMessages = msgs;
            }
          }

          return streamText({
            model: resolvedModel,
            ...(injectContext && { system: finalSystemPrompt }),
          messages: finalMessages,
          ...(providerSupportsFeature("tools", provider) ? {
            tools: allToolsWithMCP,
            activeTools: initialActiveToolNames as (keyof typeof allToolsWithMCP)[],
            toolChoice: AI_CONFIG.toolChoice,
          } : {}),
          abortSignal: streamAbortSignal,
          // Provider-aware step control. Claude Code SDK handles tool execution
          // internally, so we stop after the initial step unless async work
          // (delegations/background tasks) needs observation. Other providers
          // run Selene tools natively and can loop freely up to maxSteps.
          stopWhen: ({ steps }) => shouldStopTurn({
            characterId,
            initiatorSessionId: sessionId,
            stepCount: steps.length,
            maxSteps: AI_CONFIG.maxSteps,
            provider,
          }),
          temperature: await getSessionProviderTemperatureForSession(
            sessionMetadata,
            providerSupportsFeature("tools", provider) && initialActiveToolNames.length > 0 ? AI_CONFIG.toolTemperature : AI_CONFIG.temperature,
            { characterId, settings: appSettings },
          ),
          prepareStep: async ({ stepNumber, messages: stepMessages }) => {
            let activeToolSet: Set<string>;
            if (useDeferredLoading) {
              activeToolSet = new Set<string>([
                ...initialActiveTools,
                ...previouslyDiscoveredTools,
                ...discoveredTools,
              ]);
            } else {
              activeToolSet = new Set<string>(Object.keys(allToolsWithMCP));
            }

            if (sessionHasTruncatedContent(sessionId) && !activeToolSet.has("retrieveFullContent")) {
              activeToolSet.add("retrieveFullContent");
            }

            const currentActiveTools = [...activeToolSet];
            if (stepNumber === 0) {
              console.debug(`[CHAT API] Step 0: Starting with ${currentActiveTools.length} active tools (mode: ${useDeferredLoading ? "deferred" : "always-include"})`);
            } else if (useDeferredLoading && discoveredTools.size > previouslyDiscoveredTools.size) {
              const newlyDiscovered = [...discoveredTools].filter(t => !previouslyDiscoveredTools.has(t));
              if (newlyDiscovered.length > 0) {
                console.debug(`[CHAT API] Step ${stepNumber}: Active tools now include newly discovered: ${newlyDiscovered.join(", ")}`);
              }
            }

            // Drain any mid-run user messages from the in-memory queue.
            // drainLivePromptQueue is atomic (splice-based) — no seenIds tracking needed.
            const queuedPrompts = drainLivePromptQueue(runId);

            // At step 0, also drain delegation completions from the persistent
            // store. These are results that arrived while no run was active
            // (between turns) — e.g. after an auto-resumed continuation.
            let pendingPrompts = queuedPrompts;
            if (stepNumber === 0) {
              const storeCompletions = drainDelegationCompletions(sessionId);
              if (storeCompletions.length > 0) {
                const completionEntries = storeCompletions.map((c) => ({
                  id: `deleg-store-${c.delegationId}`,
                  content: c.resultContent || [
                    `<delegation-result delegationId="${c.delegationId}" delegate="${c.delegateName}" status="${c.error ? "failed" : "completed"}">`,
                    c.error || "Result content not available — use observe to read full response.",
                    `</delegation-result>`,
                  ].join("\n"),
                  stopIntent: false,
                  timestamp: c.completedAt,
                  metadata: {
                    kind: "delegation_completion" as const,
                    delegationId: c.delegationId,
                    delegateName: c.delegateName,
                  },
                }));
                pendingPrompts = [...completionEntries, ...queuedPrompts];
                console.debug(
                  `[CHAT API] Step 0: Injecting ${completionEntries.length} delegation completion(s) from store`,
                );
              }
            }

            if (pendingPrompts.length > 0) {
              const stopRequested = pendingPrompts.some(e => e.stopIntent);
              console.debug(
                `[CHAT API] Step ${stepNumber}: Injecting ${pendingPrompts.length} live prompt(s) (stopIntent=${stopRequested})`
              );

              // Compute orphan tool-calls BEFORE sealing — sealPreInjectionAssistant
              // wipes state.parts, so we must capture them first so the metadata
              // tag and the synthetic shim have the right ids.
              const orphanToolCalls = streamingState
                ? findOrphanToolCalls(streamingState.parts as unknown as Array<{ type?: string; toolCallId?: string; toolName?: string }>)
                : [];

              // Pre-generate the post-injection assistant id BEFORE emitting
              // the wire frame so we can ship it to the client on the same
              // frame. The client splice (`computeInjectionSplice`) then
              // rotates `activeState.message.id` to this value — matching the
              // id the streaming→DB sync will use for the post-injection row.
              //
              // Branch-picker fix: without this, client and server rotate to
              // independent random UUIDs, and reloadSessionMessages on
              // stream-finish replaces chat.messages with DB-id rows,
              // producing a duplicate sibling under the injected user message
              // in MessageRepository (→ `← 2 / 2 →`).
              const nextAssistantMessageId = generateNextAssistantMessageId();

              // Seal + persist + emit data-injected-user-message chunks via the
              // shared handler. It tags the sealed assistant row with
              // livePromptInjected (and orphanToolCalls, when any), allocates
              // fresh ordering indices after the seal (edit/reload truncation
              // invariant), and writes one wire frame per persisted row so the
              // client can splice the user message into the thread mid-stream.
              const injectionResult = await handleInjectedPromptsNonCC({
                sessionId,
                prompts: pendingPrompts,
                streamingState: streamingState as unknown as InjectionStreamingState | null,
                syncStreamingMessage: syncStreamingMessage ?? null,
                writer: injectionWriterRef.current,
                orphanToolCalls,
                nextAssistantMessageId,
              });

              // Rotate assistant UUID + set stepOffset only if the handler
              // actually resealed state (background mode might have pre-split
              // the row; reusing the same id would collapse the continuation).
              // MUST match the id we shipped on the wire frame above so the
              // server-persisted post-injection DB row id equals the id the
              // client rotated `activeState.message` to.
              if (syncStreamingMessage && streamingState) {
                assistantMessageId = nextAssistantMessageId;
                streamingState.stepOffset = stepNumber;
              }

              if (stopRequested || injectionResult.abort) {
                // Graceful stop: disable tools + inject system-level stop instruction
                // so the model acknowledges the user's abort request before the
                // turn ends naturally. Persistence + wire-frame emit already
                // happened above via the handler, so the injected user message
                // will render in the UI regardless of this graceful-stop path.
                return {
                  activeTools: [] as string[],
                  system: buildStopSystemMessage(pendingPrompts),
                };
              }

              // Inject as real user messages — correct conversation semantics vs system hacks.
              // The SDK's prepareStep `messages` return overrides the full message list for this step.
              const injectedUserMessage: UserModelMessage = {
                role: "user",
                content: buildUserInjectionContent(pendingPrompts),
              };

              // When the sealed pre-injection assistant row left orphan tool_use
              // ids behind, prepend synthetic tool_result parts so the provider
              // doesn't 400 on "tool_use without tool_result". The shape mirrors
              // what `splitToolResultsFromAssistantMessages` synthesizes on later
              // DB rehydration, so replay stays stable across edit/reload.
              //
              // i18n note: this string is the model-facing content of a synthetic
              // tool-result, NOT a user-rendered label. The model reads it to
              // understand why the prior tool call has no real result, and then
              // narrates back to the user in the user's own language. Threading
              // the request locale through `prepareStep` here would mean
              // resolving session locale at every hop in the streaming pipeline
              // for zero user-visible benefit, so we keep this English (matching
              // every other model-facing system/replay string in this file —
              // see `canonical-content.ts#makeEphemeralStubResult` for the same
              // rationale).
              const syntheticShim: ModelMessage[] =
                orphanToolCalls.length > 0
                  ? [
                      {
                        role: "tool",
                        content: buildSyntheticModelToolResults(
                          orphanToolCalls,
                          "Cancelled — user interjected with a new message",
                        ),
                      } as unknown as ModelMessage,
                    ]
                  : [];

              return {
                activeTools: currentActiveTools as string[],
                messages: [...stepMessages, ...syntheticShim, injectedUserMessage],
              };
            }

            // Force the model to keep calling tools while async work is in-flight.
            // Without this, the model outputs text ("Both are running...") and the
            // AI SDK loop ends — nobody observes the results.
            if (stepNumber > 0 && hasActiveAsyncWork(characterId, sessionId)) {
              const hasDelegations = hasRunningDelegationsForSession(characterId, sessionId);
              const hasBgTasks = hasRunningBackgroundTasksForSession(characterId, sessionId);

              // When only delegations are running (no background bash tasks),
              // BLOCK here until a delegation result arrives via the live prompt
              // queue. This keeps the SSE stream alive (UI shows "Responding...")
              // and avoids the need for observe() calls or SSE auto-resume hacks.
              if (hasDelegations && !hasBgTasks) {
                console.debug(
                  `[CHAT API] Step ${stepNumber}: Blocking prepareStep — waiting for delegation result(s)...`
                );
                try {
                  await waitForQueueMessage(runId, streamAbortSignal);
                } catch {
                  // Aborted or queue removed — let the turn end naturally
                  return { activeTools: currentActiveTools as string[] };
                }
                // Delegation result(s) arrived — drain and inject them.
                // The queue was populated by notifyInitiatorSessionOfCompletion.
                const delegationPrompts = drainLivePromptQueue(runId);
                if (delegationPrompts.length > 0) {
                  console.debug(
                    `[CHAT API] Step ${stepNumber}: Injecting ${delegationPrompts.length} delegation result(s) after blocking wait`
                  );

                  // Same seal-and-split flow as the primary injection branch —
                  // delegation results are modeled as injected user messages so
                  // they share the mid-stream wire protocol.
                  const orphanToolCalls = streamingState
                    ? findOrphanToolCalls(streamingState.parts as unknown as Array<{ type?: string; toolCallId?: string; toolName?: string }>)
                    : [];

                  // Pre-generate the post-injection assistant id and ship it
                  // on the wire frame so the client splice rotates to the
                  // matching id. See the primary injection branch above for
                  // the full branch-picker-fix rationale.
                  const nextAssistantMessageId = generateNextAssistantMessageId();

                  await handleInjectedPromptsNonCC({
                    sessionId,
                    prompts: delegationPrompts,
                    streamingState: streamingState as unknown as InjectionStreamingState | null,
                    syncStreamingMessage: syncStreamingMessage ?? null,
                    writer: injectionWriterRef.current,
                    orphanToolCalls,
                    nextAssistantMessageId,
                  });

                  if (syncStreamingMessage && streamingState) {
                    assistantMessageId = nextAssistantMessageId;
                    streamingState.stepOffset = stepNumber;
                  }

                  const injectedUserMessage: UserModelMessage = {
                    role: "user",
                    content: buildUserInjectionContent(delegationPrompts),
                  };

                  const syntheticShim: ModelMessage[] =
                    orphanToolCalls.length > 0
                      ? [
                          {
                            role: "tool",
                            content: buildSyntheticModelToolResults(
                              orphanToolCalls,
                              "Cancelled — delegation result arrived while tool call was in flight",
                            ),
                          } as unknown as ModelMessage,
                        ]
                      : [];

                  // If more delegations are still running, force the model to
                  // call a tool (even a no-op) so the loop continues to the next
                  // step where prepareStep will block again waiting for the next
                  // delegation result. Without this, the model outputs text and
                  // the AI SDK loop ends — remaining delegations never get injected.
                  const stillHasRunning = hasRunningDelegationsForSession(characterId, sessionId);
                  const result: Record<string, unknown> = {
                    activeTools: currentActiveTools as string[],
                    messages: [...stepMessages, ...syntheticShim, injectedUserMessage],
                  };
                  if (stillHasRunning) {
                    result.toolChoice = "required" as const;
                    result.system = "More delegations are still running. Acknowledge the result(s) you just received, then call any tool (e.g. delegateToSubagent action=\"observe\" or any lightweight tool) to keep the turn alive while waiting for remaining delegations.";
                  }
                  return result;
                }
                // Queue was drained by something else or empty — fall through
                // Check if delegations are still running and need to keep blocking
                if (hasRunningDelegationsForSession(characterId, sessionId)) {
                  return {
                    activeTools: currentActiveTools as string[],
                    toolChoice: "required" as const,
                    system: "Delegations are still running. Call delegateToSubagent action=\"observe\" or wait for results to arrive.",
                  };
                }
                return { activeTools: currentActiveTools as string[] };
              }

              // Background processes (bash/executeCommand) still need forced
              // tool calls to check their status.
              const systemMsg = hasDelegations
                ? "You have active delegations and background processes still running. Check on the background processes using bash or executeCommand. Delegation results will be delivered automatically — do not call observe for them."
                : "You have background processes still running. You MUST call bash or executeCommand with the processId to check their status, or wait for them to complete. Do NOT respond to the user until you have checked on all running processes.";
              return {
                activeTools: currentActiveTools as string[],
                toolChoice: "required" as const,
                system: systemMsg,
              };
            }

            return { activeTools: currentActiveTools as (keyof typeof allToolsWithMCP)[] };
          },
          experimental_repairToolCall: async ({ error, toolCall, tools }) => {
            console.warn(`[CHAT API] Tool call repair triggered for "${toolCall.toolName}": ${error.message}`);

            // Common model hallucination: "ToolSearch" instead of "searchTools"
            // (caused by schema title leaking into model's tool name guess)
            const TOOL_NAME_ALIASES: Record<string, string> = {
              ToolSearch: "searchTools",
              toolSearch: "searchTools",
              tool_search: "searchTools",
            };

            const normalizedName = normalizeMalformedToolName(toolCall.toolName);
            const candidateNames = Array.from(
              new Set(
                [
                  TOOL_NAME_ALIASES[toolCall.toolName],
                  normalizedName,
                  TOOL_NAME_ALIASES[normalizedName],
                ].filter((name): name is string => typeof name === "string" && name.length > 0)
              )
            );

            for (const candidate of candidateNames) {
              if (candidate in tools) {
                console.warn(`[CHAT API] Remapping tool call "${toolCall.toolName}" -> "${candidate}"`);
                return { ...toolCall, toolName: candidate };
              }
            }

            // For anything else, return null to inject error as tool result so the model can self-correct
            return null;
          },
          onError: async ({ error }) => {
            const errorMessage = normalizeStreamError(error).message;
            // Always log the full error so it's visible in debug.log — prevents
            // silent swallowing that previously made failures impossible to diagnose.
            console.error(`[CHAT API] Stream onError: ${errorMessage}`, {
              provider,
              sessionId,
              runId,
              errorType: error?.constructor?.name,
              stack: error instanceof Error ? error.stack?.split("\n").slice(0, 5).join("\n") : undefined,
              // Always log raw error details — for OpenRouter and other providers that
              // wrap upstream rejections (e.g. image too large) in Error instances,
              // the cause chain / response body is the only way to diagnose.
              raw: {
                cause: error instanceof Error && (error as Error).cause ? JSON.stringify((error as Error).cause, null, 2).slice(0, 2000) : undefined,
                responseBody: (error as any)?.responseBody ? String((error as any).responseBody).slice(0, 2000) : undefined,
                message: error instanceof Error ? error.message : undefined,
              },
            });
            // When the Kimi API rejects the access token mid-stream (server-side
            // revocation or early expiry), force-expire the local copy so the next
            // request triggers a proactive refresh instead of repeatedly failing.
            if (provider === "kimi" && /invalid.*(?:auth|api.?key|credential)|expired|unauthorized/i.test(errorMessage)) {
              try {
                const { forceExpireKimiToken, invalidateKimiAuthCache } = await import("@/lib/auth/kimi-auth");
                invalidateKimiAuthCache();
                forceExpireKimiToken();
              } catch { /* non-fatal */ }
            }
            // Claude Code SDK agents self-correct after tool validation failures —
            // the stream stays open and onFinish will finalize the run properly.
            if (provider === "claudecode" && isNonFatalToolError(error)) {
              console.warn(`[CHAT API] Non-fatal tool error in Claude Code run (skipping finalization): ${errorMessage}`);
              return;
            }
            // Let the UI stream wrapper decide whether this is eligible for
            // pre-commit recovery. It will finalize the run if recovery is not possible.
          },
          onChunk: shouldEmitProgress
            ? async ({ chunk }) => {
              if (!streamingState || !syncStreamingMessage) return;
              let changed = false;
              if (chunk.type === "text-delta") {
                const rawText = chunk.text ?? "";
                const filteredText = thinkTagFilter ? thinkTagFilter.process(rawText) : rawText;
                changed = appendTextPartToState(streamingState, filteredText) || changed;
              } else if (chunk.type === "tool-input-start") {
                changed = recordToolInputStart(streamingState, chunk.id, chunk.toolName) || changed;
              } else if (chunk.type === "tool-input-delta") {
                changed = recordToolInputDelta(streamingState, chunk.id, chunk.delta) || changed;
              } else if (chunk.type === "tool-call") {
                // Detect argsText conflict: streaming deltas already accumulated
                // but a complete tool-call event arrived (e.g. from repairToolCall).
                const existingPart = streamingState.toolCallParts.get(chunk.toolCallId);
                if (existingPart?.argsText && existingPart.argsText.length > 0) {
                  const newArgsText = JSON.stringify(chunk.input ?? {});
                  // ExitPlanMode uses synthetic argsText (plan approval data) — skip conflict warning
                  if (chunk.toolName !== "ExitPlanMode" && !newArgsText.startsWith(existingPart.argsText)) {
                    console.warn(
                      `[CHAT API] argsText conflict for ${chunk.toolName} (${chunk.toolCallId}): ` +
                        `streaming argsText (${existingPart.argsText.length} chars) replaced by structured input. ` +
                        `Client error boundary will handle recovery.`
                    );
                  }
                }
                if (provider === "claudecode" && chunk.toolName && isDelegatedToolName(chunk.toolName)) {
                  streamingState.provenance = {
                    ...(streamingState.provenance ?? {}),
                    contextScope: "delegated",
                    provenanceVersion: 1,
                  };
                }
                // For ExitPlanMode, preserve the synthetic plan approval data
                // that was injected during streaming. The SDK's raw input ({})
                // would overwrite the plan content needed by the approval UI.
                let effectiveInput = chunk.input;
                if (chunk.toolName === "ExitPlanMode" && existingPart?.argsText && existingPart.argsText.length > 10) {
                  try {
                    effectiveInput = JSON.parse(existingPart.argsText);
                  } catch { /* fall through to original input */ }
                }
                changed = recordStructuredToolCall(streamingState, chunk.toolCallId, chunk.toolName, effectiveInput) || changed;
              } else if (chunk.type === "tool-result") {
                changed = recordToolResultChunk(streamingState, chunk.toolCallId, chunk.toolName, chunk.output, chunk.preliminary) || changed;
                changed = tagIntermediateDelegationParts(streamingState, chunk.toolCallId) || changed;
                if (provider === "claudecode" && chunk.toolName && isDelegatedToolName(chunk.toolName)) {
                  streamingState.provenance = {
                    ...(streamingState.provenance ?? {}),
                    contextScope: "main",
                    provenanceVersion: 1,
                  };
                }
              }
              if (changed) await syncStreamingMessage();
            }
            : undefined,
          onFinish: async (event) => {
            // Flush any trailing buffered content from the think-tag filter
            if (thinkTagFilter && streamingState) {
              const flushed = thinkTagFilter.flush();
              if (flushed) {
                appendTextPartToState(streamingState, flushed);
              }
            }
            return createOnFinishCallback(callbackCtx)(event);
          },
          onAbort: createOnAbortCallback(callbackCtx) as any,
        });
        }
      )
    );

    const STREAM_RECOVERY_MAX_ATTEMPTS = 7;
    let result: Awaited<ReturnType<typeof createStreamResult>>;

    const createStreamResultWithRecovery = async (startAttempt = 0) => {
      const schemaRecoveredTools = new Set<string>();
      for (let attempt = startAttempt; ; attempt += 1) {
        try {
          const created = await createStreamResult();
          if (attempt > 0) {
            await appendRunEvent({ runId, eventType: "llm_request_completed", level: "info", pipelineName: "chat", data: { attempt, reason: "stream_recovered", outcome: "recovered" } });
          }
          return { result: created, attempt };
        } catch (error) {
          const schemaError = parseInvalidToolSchemaError(error);
          if (schemaError && !schemaRecoveredTools.has(schemaError.toolName)) {
            const recovered = disableToolForSchemaRecovery(
              {
                allToolsWithMCP,
                initialActiveToolNames,
                initialActiveTools,
                discoveredTools,
                previouslyDiscoveredTools,
              },
              schemaError.toolName
            );

            if (recovered) {
              schemaRecoveredTools.add(schemaError.toolName);
              console.warn(
                `[CHAT API] Recovered from invalid schema for tool "${schemaError.toolName}" by disabling it for this run: ${schemaError.reason}`
              );
              if (runId) {
                await appendRunEvent({
                  runId,
                  eventType: "tool_failed",
                  level: "warn",
                  pipelineName: "chat",
                  data: {
                    attempt: attempt + 1,
                    toolName: schemaError.toolName,
                    reason: schemaError.reason,
                    outcome: "tool_disabled_retrying",
                  },
                });
              }
              continue;
            }
          }

          const classification = classifyRecoverability({ provider, error, message: error instanceof Error ? error.message : String(error) });
          const retry = shouldRetry({ classification, attempt, maxAttempts: STREAM_RECOVERY_MAX_ATTEMPTS, aborted: streamAbortSignal.aborted });

          if (runId) {
            const delay = retry ? getBackoffDelayMs(attempt) : 0;
            await appendRunEvent({ runId, eventType: "llm_request_failed", level: retry ? "info" : "warn", pipelineName: "chat", data: { attempt: attempt + 1, reason: classification.reason, recoverable: classification.recoverable, delayMs: delay, outcome: retry ? "retrying" : "exhausted" } });
          }

          if (!retry) throw error;

          const delay = getBackoffDelayMs(attempt);
          console.debug("[CHAT API] Retrying stream creation", { attempt: attempt + 1, reason: classification.reason, delayMs: delay, provider });
          await sleepWithAbort(delay, streamAbortSignal);
        }
      }
    };

    let requestAttempt = 0;
    ({ result, attempt: requestAttempt } = await createStreamResultWithRecovery());

    const resetStreamingStateForRetry = () => {
      if (!streamingState) return;
      streamingState.parts = [];
      streamingState.toolCallParts = new Map();
      streamingState.loggedIncompleteToolCalls = new Set();
      streamingState.messageId = undefined;
      streamingState.isCreating = false;
      streamingState.lastBroadcastAt = 0;
      streamingState.lastBroadcastSignature = "";
      streamingState.pendingBroadcast = false;
      streamingState.stepOffset = undefined;
      streamingState.provenance = undefined;
      // Rotate message ID to avoid UNIQUE constraint if prior attempt persisted a row
      assistantMessageId = crypto.randomUUID();
    };

    const buildUiMessageStream = () =>
      result!.toUIMessageStream({
        generateMessageId: () => assistantMessageId,
        messageMetadata: ({ part }) => {
          if (part.type === "finish-step" && part.usage) {
            const anthropicMeta = (part as any).providerMetadata?.anthropic || {};
            const cacheRead = anthropicMeta.cacheReadInputTokens || (part.usage as any).cache_read_input_tokens || 0;
            const cacheWrite = anthropicMeta.cacheCreationInputTokens || (part.usage as any).cache_creation_input_tokens || 0;
            const basePricePerToken = 3 / 1_000_000;
            const estimatedSavingsUsd = cacheRead > 0 ? 0.9 * basePricePerToken * cacheRead : 0;
            return {
              custom: {
                usage: { inputTokens: part.usage.inputTokens, outputTokens: part.usage.outputTokens, totalTokens: part.usage.totalTokens },
                ...(cacheRead > 0 || cacheWrite > 0 ? { cache: { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, estimatedSavingsUsd } } : {}),
              },
            };
          }
          return undefined;
        },
        onError: (error) => normalizeStreamError(error).message,
      });

    let activeUiReader: ReadableStreamDefaultReader<UIMessageChunk> | null = null;
    const uiStream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        let closed = false;
        let clientCommitted = false;
        let bufferedChunks: UIMessageChunk[] = [];

        const emitChunk = (chunk: UIMessageChunk) => {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            if (clientDisconnected) {
              // Client gone — silently discard but DON'T set closed. The pump
              // must keep reading from the AI SDK pipeline so the internal
              // TransformStream chain stays alive, onChunk keeps firing
              // (→ syncStreamingMessage persists to DB), and onFinish fires
              // when the provider completes (→ run finalizes properly).
              return;
            }
            // Non-disconnect error — stop the pump.
            closed = true;
          }
        };

        // Bind the injection writer ref to the outer controller. `prepareStep`
        // (scheduled inside streamText) uses this ref to emit
        // `data-injected-user-message` chunks onto the wire mid-stream. By the
        // time prepareStep fires, the pump has already started reading, so the
        // ref is always populated when needed.
        injectionWriterRef.current = {
          write(chunk: unknown) {
            // Buffer alongside normal chunks — if the client hasn't committed
            // to the UI stream yet, the main pump already handles buffering
            // via `bufferedChunks`; for injection frames we bypass that because
            // the data-* chunk is idempotent (id = DB row id) and the client
            // transport dedupes on re-delivery.
            emitChunk(chunk as UIMessageChunk);
          },
        };

        const closeStream = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* already closed/cancelled */ }
        };

        const finalizeAndEmitError = async (errorMessage: string, sourceError?: unknown) => {
          // Always finalize the run on provider error — even if client is gone.
          // Previously we skipped finalizeFailedRun when clientDisconnected, but
          // onFinish only fires on successful completion. If the provider errors
          // after disconnect, nothing else would finalize the run, leaving it
          // stuck in "in_progress" forever.
          await finalizeFailedRun(errorMessage, detectCreditError(errorMessage), { sourceError, streamAborted: streamAbortSignal.aborted });
          if (!closed && !clientDisconnected) {
            emitChunk({ type: "error", errorText: `Streaming interrupted: ${errorMessage}` } as UIMessageChunk);
          }
          closeStream();
        };

        const preparePrecommitRetry = async (errorMessage: string, sourceError?: unknown) => {
          // No point retrying if client is gone — the LLM call continues in
          // background and onFinish will persist results when it completes.
          if (clientDisconnected) return false;

          const { retry, classification } = shouldAttemptPrecommitRecovery({
            provider,
            error: sourceError,
            errorMessage,
            attempt: requestAttempt,
            maxAttempts: STREAM_RECOVERY_MAX_ATTEMPTS,
            aborted: streamAbortSignal.aborted,
            clientCommitted,
            streamingState,
          });

          if (!retry) return false;

          const delay = getBackoffDelayMs(requestAttempt);
          if (runId) {
            await appendRunEvent({ runId, eventType: "llm_request_failed", level: "info", pipelineName: "chat", data: { attempt: requestAttempt + 1, reason: classification.reason, recoverable: classification.recoverable, delayMs: delay, outcome: "retrying_precommit" } });
          }
          console.warn("[CHAT API] Retrying recoverable pre-commit UI stream failure", { attempt: requestAttempt + 1, reason: classification.reason, delayMs: delay, provider });
          resetStreamingStateForRetry();
          recreateThinkTagFilter();
          bufferedChunks = [];
          clientCommitted = false;
          await sleepWithAbort(delay, streamAbortSignal);
          ({ result, attempt: requestAttempt } = await createStreamResultWithRecovery(requestAttempt + 1));
          return true;
        };

        const pump = async () => {
          while (!closed) {
            let shouldRestart = false;
            activeUiReader = buildUiMessageStream().getReader();
            try {
              while (!closed) {
                const { done, value } = await activeUiReader.read();
                if (done) {
                  if (!clientCommitted && bufferedChunks.length > 0) {
                    for (const pendingChunk of bufferedChunks) {
                      emitChunk(pendingChunk);
                    }
                    bufferedChunks = [];
                    clientCommitted = true;
                  }
                  closeStream();
                  return;
                }

                if (value.type === "error") {
                  shouldRestart = await preparePrecommitRetry(value.errorText ?? "Unknown stream error");
                  if (shouldRestart) break;
                  await finalizeAndEmitError(value.errorText ?? "Unknown stream error");
                  return;
                }

                if (!clientCommitted && !isUiChunkCommittable(value)) {
                  bufferedChunks.push(value);
                  continue;
                }

                if (!clientCommitted) {
                  for (const pendingChunk of bufferedChunks) {
                    emitChunk(pendingChunk);
                  }
                  bufferedChunks = [];
                  clientCommitted = true;
                }

                emitChunk(value);
              }
            } catch (error) {
              const errorMessage = normalizeStreamError(error).message;
              shouldRestart = await preparePrecommitRetry(errorMessage, error);
              if (!shouldRestart) {
                await finalizeAndEmitError(errorMessage, error);
                return;
              }
            } finally {
              try {
                activeUiReader?.releaseLock();
              } catch {
                // no-op
              }
            }

            if (!shouldRestart) {
              closeStream();
              return;
            }
          }
        };

        void pump();
      },
      async cancel(_reason) {
        // Mark client as gone so emitChunk silently discards instead of setting
        // closed=true. The pump KEEPS consuming the AI SDK pipeline in the
        // background — this is critical because onChunk (syncStreamingMessage)
        // and onFinish (run finalization) live inside TransformStream.flush()
        // and only fire when the pipeline is fully consumed.
        markClientDisconnected();
        // Do NOT cancel activeUiReader — cancellation propagates upstream through
        // the AI SDK stream and can abort the LLM call, defeating the signal
        // decoupling. Instead, let the pump detect the closed controller naturally
        // (emitChunk/closeStream catch the error) and exit gracefully while the
        // LLM computation continues in the background.
      },
    });

    const response = createUIMessageStreamResponse({
      stream: uiStream,
    });
    response.headers.set("X-Session-Id", sessionId);

    // Pipe through a heartbeat stream that sends SSE comments every 30s
    // during silence to prevent TCP timeouts on long-running models (e.g. codex-high).
    const heartbeatBody = response.body!.pipeThrough(createHeartbeatStream(30_000));
    return new Response(heartbeatBody, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    if (sdkToolResultBridge) {
      sdkToolResultBridge.dispose?.();
    }
    console.error("[CHAT API] Unhandled error in POST handler:", {
      message: error instanceof Error ? error.message : String(error),
      type: error?.constructor?.name,
      stack: error instanceof Error ? error.stack?.split("\n").slice(0, 8).join("\n") : undefined,
      provider: configuredProvider,
      sessionId,
      reqSignalAborted: req.signal.aborted,
      reqSignalReason: (() => {
        try {
          return req.signal.reason instanceof Error
            ? `${req.signal.reason.name}: ${req.signal.reason.message}`
            : String(req.signal.reason ?? "unknown");
        } catch {
          return "unavailable";
        }
      })(),
      streamAbortSignalAborted: streamAbortSignal?.aborted ?? false,
      clientDisconnected,
    });

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const isCreditError = detectCreditError(errorMessage);

    // Unified live-prompt queue cleanup on the error path.
    //
    // This must run regardless of whether `agentRun.id` was assigned or
    // `chatTaskRegistered` has flipped — otherwise injections that landed on
    // the reservation during warmup (or mid-flight, before the stream
    // settled) are silently dropped.
    //
    //   agentRun.id present → drain into persistence, then release by runId.
    //   reservation only    → resolve the placeholder key, drain, then clear
    //                         by session.
    //
    // Both branches end in the same invariant: no queue entry for this
    // session survives into the next request.
    let livePromptQueueCleanedUp = false;
    if (activeSessionId) {
      try {
        if (agentRun?.id) {
          await handleUndrainedQueueMessages(agentRun.id, activeSessionId);
          removeLivePromptQueue(agentRun.id, activeSessionId);
        } else {
          const pendingKey = getLivePromptQueueKeyBySession(activeSessionId);
          if (pendingKey) {
            // handleUndrainedQueueMessages only uses its first arg as a map
            // lookup key — passing the pending placeholder key is safe and
            // drains any entries that raced in during reservation warmup.
            await handleUndrainedQueueMessages(pendingKey, activeSessionId);
          }
          clearLivePromptQueueBySession(activeSessionId);
        }
        livePromptQueueCleanedUp = true;
      } catch (cleanupErr) {
        console.error(
          "[CHAT API] Failed to drain/clear live-prompt queue on error:",
          cleanupErr,
        );
      }
    }

    if (chatTaskRegistered && agentRun?.id) {
      try {
        const classification = classifyRecoverability({ provider: configuredProvider, error, message: errorMessage });
        console.warn("[CHAT API] Finalizing chat error", {
          sessionId,
          runId,
          reqSignalAborted: req.signal.aborted,
          reqSignalReason: (() => {
            try {
              return req.signal.reason instanceof Error
                ? `${req.signal.reason.name}: ${req.signal.reason.message}`
                : String(req.signal.reason ?? "unknown");
            } catch {
              return "unavailable";
            }
          })(),
          streamAbortSignalAborted: streamAbortSignal?.aborted ?? false,
          clientDisconnected,
          errorMessage,
          classificationReason: classification.reason,
          classificationRecoverable: classification.recoverable,
        });
        const shouldCancel = shouldTreatStreamErrorAsCancellation({
          errorMessage,
          isCreditError,
          streamAborted: req.signal.aborted,
          classificationRecoverable: classification.recoverable,
          classificationReason: classification.reason,
        });
        const runStatus = shouldCancel ? "cancelled" : "failed";
        removeChatAbortController(agentRun.id);
        // Live-prompt queue removal is handled by the unified
        // drain-before-remove block at the top of this catch handler
        // (`livePromptQueueCleanedUp`). Only fall back here if that block
        // itself threw — otherwise we'd double-remove.
        if (activeSessionId && !livePromptQueueCleanedUp) {
          removeLivePromptQueue(agentRun.id, activeSessionId);
        }
        await completeAgentRun(agentRun.id, runStatus, shouldCancel
          ? { reason: "stream_interrupted" }
          : { error: isCreditError ? "Insufficient credits" : errorMessage });
        const registryTask = taskRegistry.get(agentRun.id);
        const registryDurationMs = registryTask ? Date.now() - new Date(registryTask.startedAt).getTime() : undefined;
        taskRegistry.updateStatus(agentRun.id, runStatus, shouldCancel
          ? { durationMs: registryDurationMs }
          : { durationMs: registryDurationMs, error: isCreditError ? "Task interrupted - insufficient credits" : errorMessage });
      } catch (e) {
        console.error("[CHAT API] Failed to finalize run status in chat error handler:", e);
      }
    }

    return new Response(
      JSON.stringify({
        error: isCreditError
          ? "Insufficient credits. Please add credits to continue."
          : errorMessage,
      }),
      {
        status: isCreditError ? 402 : 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * Detect non-fatal tool validation errors that Claude Code SDK agents
 * can self-correct from. These should NOT trigger run finalization.
 */
function isNonFatalToolError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();

  // Vercel AI SDK error class markers (duck-typed)
  const marker = (error as any)[Symbol.for("vercel.ai.error")];
  if (
    marker === "AI_InvalidToolInputError" ||
    marker === "AI_NoSuchToolError" ||
    marker === "AI_ToolCallRepairError"
  ) {
    return true;
  }

  // Fallback: message-based detection
  return (
    msg.includes("invalid input for tool") ||
    msg.includes("json parsing failed") ||
    msg.includes("tool not found") ||
    (msg.includes("tool") && msg.includes("does not exist"))
  );
}

function detectCreditError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return lower.includes("insufficient") || lower.includes("quota") || lower.includes("credit") || lower.includes("429");
}

function normalizeMalformedToolName(toolName: string): string {
  const trimmed = toolName.trim();
  if (!trimmed) return "";

  const nameAttrMatch = /(?:^|[\s<])name\s*=\s*["']?([A-Za-z0-9_.:-]+)/i.exec(trimmed);
  if (nameAttrMatch?.[1]) return nameAttrMatch[1];

  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  if (!firstToken) return "";

  const unwrapped = firstToken
    .replace(/^["'`<]+/, "")
    .replace(/[>"'`,;]+$/g, "");

  if (!unwrapped) return "";
  const quoteIndex = unwrapped.search(/["']/);
  return (quoteIndex >= 0 ? unwrapped.slice(0, quoteIndex) : unwrapped).trim();
}

function getPlainTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
        return "";
      })
      .join(" ")
      .trim();
  }

  return "";
}

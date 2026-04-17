"use client";

// Suppress noisy dev warning from @assistant-ui/react useToolInvocations
if (process.env.NODE_ENV !== "production") {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (
      typeof args[0] === "string" &&
      args[0].includes("argsText updated after controller was closed")
    )
      return;
    originalWarn.apply(console, args);
  };
}

import { Component, createContext, type ErrorInfo, type FC, type MutableRefObject, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  type AttachmentAdapter,
  type PendingAttachment,
  type CompleteAttachment,
  type AppendMessage,
} from "@assistant-ui/react";
import {
  useAISDKRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import { useChat } from "@ai-sdk/react";
import type { CreateUIMessage, UIMessage, UIMessageChunk } from "ai";
import { DeepResearchProvider } from "./assistant-ui/deep-research-context";
import { VoiceProvider } from "./assistant-ui/voice-context";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { classifyRecoverability } from "@/lib/ai/retry/stream-recovery";
import {
  type ChatTransportErrorPayload,
  parseTransportErrorResponse,
  shouldIgnoreUseChatError,
} from "@/lib/chat/transport-errors";
import { buildRetryMessage, getLastUserMessageId, shouldAutoRetryClientChat } from "@/lib/chat/client-retry";
import { parseChatPreflightResponse } from "@/lib/chat/preflight";
import {
  CHAT_ATTACHMENT_ACCEPT,
  getDocumentTypeLabel,
  isImageAttachment,
} from "@/lib/documents/file-types";
import { INTERACTIVE_TOOL_NAME_SET } from "@/lib/interactive-tools/constants";
import {
  INJECTED_USER_MESSAGE_CHUNK_TYPE,
  type InjectedUserMessageData,
} from "@/lib/ai/streaming/injection-stream-emitter";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isClientRetryStateError(error: Error): boolean {
  const message = (error.message || "").toLowerCase();
  // @assistant-ui/store currently throws these exact tapClientLookup errors when
  // its client-side message index gets out of sync during retries.
  return (
    message.includes("index out of bounds")
    || message.includes("tapclientlookup")
    || message.includes("message not found")
  );
}

function hasUserMessage(messages: UIMessage[]): boolean {
  return messages.some((message) => message.role === "user");
}

function cloneMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: Array.isArray(message.parts)
      ? message.parts.map((part) => ({ ...part }))
      : message.parts,
  }));
}

function isRecoverableStreamingError(error: Error): boolean {
  if (error.name === "AbortError") return true;
  if (isClientRetryStateError(error)) return true;
  const msg = error.message || "";
  if (msg.includes("aborted")) return true;
  const classification = classifyRecoverability({
    provider: "client-ui",
    error,
    message: msg,
    phase: "streaming",
  });
  return classification.recoverable;
}

class ChatErrorBoundary extends Component<{
  children: ReactNode;
  processingText: string;
  genericError: string;
  recoveryRef?: MutableRefObject<(() => void) | null>;
  lastStreamingRef?: MutableRefObject<number>;
}, ErrorBoundaryState> {
  constructor(props: {
    children: ReactNode;
    processingText: string;
    genericError: string;
    recoveryRef?: MutableRefObject<(() => void) | null>;
    lastStreamingRef?: MutableRefObject<number>;
  }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const recentlyStreaming = this.props.lastStreamingRef
      ? Date.now() - this.props.lastStreamingRef.current < 5000
      : false;

    if (recentlyStreaming && isRecoverableStreamingError(error)) {
      console.warn("[ChatProvider] Recoverable render/stream error caught by boundary:", error.message);
      setTimeout(() => {
        try {
          this.props.recoveryRef?.current?.();
        } finally {
          this.setState({ hasError: false, error: null });
        }
      }, 0);
      return;
    }

    console.error("[ChatProvider] UI Error:", error, errorInfo);
  }

  private handleRetry = () => {
    try {
      this.props.recoveryRef?.current?.();
    } finally {
      this.setState({ hasError: false, error: null });
    }
  };

  render() {
    if (this.state.hasError) {
      const message = this.state.error?.message ?? this.props.genericError;
      const lowered = message.toLowerCase();
      const isProcessing =
        lowered.includes("args") ||
        lowered.includes("tool") ||
        lowered.includes("invalid") ||
        lowered.includes("stream") ||
        lowered.includes("parse");

      return (
        <div className="flex h-full min-h-[240px] items-center justify-center p-6">
          <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-terminal-border bg-terminal-cream p-6 text-center shadow-sm">
            <Loader2 className="h-5 w-5 animate-spin text-terminal-muted" />
            <div className="space-y-1">
              <p className="font-mono text-sm text-terminal-dark">
                {isProcessing ? this.props.processingText : this.props.genericError}
              </p>
              <p className="text-xs text-terminal-muted font-mono break-all">
                {message}
              </p>
            </div>
            <button
              type="button"
              onClick={this.handleRetry}
              className="rounded border border-terminal-border px-3 py-1.5 text-xs font-mono text-terminal-dark hover:bg-terminal-dark/5"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

interface ChatProviderProps {
  children: ReactNode;
  sessionId?: string;
  characterId?: string;
  initialMessages?: UIMessage[];
}

const ChatSessionIdContext = createContext<string | undefined>(undefined);
const ChatTransportErrorContext = createContext<{
  error: ChatTransportErrorPayload | null;
  clearError: () => void;
}>({ error: null, clearError: () => {} });
const ChatSetMessagesContext = createContext<((updater: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])) => void) | null>(null);

/**
 * Live `useChat` status. Consumed by `onLivePromptInjected` so the
 * force-reload (`reloadSessionMessages({ force: true })`) only fires when
 * the stream is idle — mid-stream, the transport interceptor has already
 * spliced the injected user UIMessage in place and a hard reload would
 * destroy the in-flight assistant message.
 *
 * See `components/chat/chat-interface.tsx` ~1743.
 */
export type ChatLifecycleStatus = "submitted" | "streaming" | "ready" | "error";
const ChatStatusContext = createContext<ChatLifecycleStatus>("ready");

export function useChatSessionId() {
  return useContext(ChatSessionIdContext);
}

export function useChatTransportError() {
  return useContext(ChatTransportErrorContext);
}

export function useChatSetMessages() {
  const value = useContext(ChatSetMessagesContext);
  if (!value) {
    throw new Error("useChatSetMessages must be used within ChatProvider");
  }
  return value;
}

export function useChatLifecycleStatus(): ChatLifecycleStatus {
  return useContext(ChatStatusContext);
}

function useDynamicChatTransport<T extends AssistantChatTransport<UIMessage>>(transport: T): T {
  const transportRef = useRef(transport);
  useEffect(() => {
    transportRef.current = transport;
  }, [transport]);

  return useMemo(
    () =>
      new Proxy(transportRef.current, {
        get(_, prop) {
          const value = (transportRef.current as Record<PropertyKey, unknown>)[prop];
          return typeof value === "function" ? value.bind(transportRef.current) : value;
        },
      }) as T,
    [],
  );
}

function isInteractiveToolPart(part: { type?: string }): boolean {
  const partToolName = typeof part.type === "string" ? part.type.replace("tool-", "") : "";
  return INTERACTIVE_TOOL_NAME_SET.has(partToolName);
}

function isPendingToolPart(part: {
  state?: string;
  output?: unknown;
  result?: unknown;
  active?: boolean;
}): boolean {
  return (
    part.state === "input-available" &&
    part.output === undefined &&
    part.result === undefined &&
    part.active === true
  );
}

export function sanitizeMessagesForInit(messages: UIMessage[]): UIMessage[] {
  return messages.map((msg) => {
    if (!msg.parts || !Array.isArray(msg.parts)) return msg;

    const seenToolCalls = new Set<string>();
    const toolCallsWithOutput = new Set<string>();

    msg.parts.forEach((part: any) => {
      if (part.type?.startsWith("tool-") && part.toolCallId) {
        if (
          part.state === "output-available" ||
          part.state === "output-error" ||
          part.output !== undefined ||
          part.result !== undefined
        ) {
          toolCallsWithOutput.add(part.toolCallId);
        }
      }
    });

    const sanitizedParts = msg.parts.filter((part: any) => {
      // Defense-in-depth: `data-injected-user-message` is a transient wire
      // event consumed by `BufferedAssistantChatTransport`'s chunk-intercept
      // (see :transform handler below). It must never reach the reducer and
      // should NEVER appear on a persisted UIMessage. Strip defensively so a
      // stale replay / DB-rehydrated row can't accidentally render an
      // injected-user-message frame as visible content.
      if (part.type === INJECTED_USER_MESSAGE_CHUNK_TYPE) {
        return false;
      }

      if (part.type?.startsWith("tool-") && part.toolCallId) {
        const toolCallId = part.toolCallId;
        const key = `${msg.id}:${toolCallId}`;
        const keepPendingPart = isPendingToolPart(part) || isInteractiveToolPart(part);

        if (seenToolCalls.has(toolCallId)) {
          if (!loggedSanitizerToolCallIds.has(key)) {
            loggedSanitizerToolCallIds.add(key);
            console.warn("[ChatProvider] Removing duplicate tool part:", toolCallId);
          }
          return false;
        }
        seenToolCalls.add(toolCallId);

        if (
          part.state === "input-streaming" &&
          part.output === undefined &&
          part.result === undefined &&
          !(part as { active?: boolean }).active
        ) {
          if (!loggedSanitizerToolCallIds.has(key)) {
            loggedSanitizerToolCallIds.add(key);
            console.warn("[ChatProvider] Removing dangling input-streaming tool part:", toolCallId);
          }
          return false;
        }

        if (
          part.state === "input-available" &&
          part.output === undefined &&
          part.result === undefined &&
          !toolCallsWithOutput.has(toolCallId) &&
          !keepPendingPart
        ) {
          if (!loggedSanitizerToolCallIds.has(key)) {
            loggedSanitizerToolCallIds.add(key);
            console.warn("[ChatProvider] Removing dangling input-available tool part:", toolCallId);
          }
          return false;
        }
      }

      return true;
    });

    if (sanitizedParts.length === 0) {
      return {
        ...msg,
        parts: [{ type: "text" as const, text: "" }],
      };
    }

    return sanitizedParts.length !== msg.parts.length
      ? { ...msg, parts: sanitizedParts as UIMessage["parts"] }
      : msg;
  });
}

const STREAM_BATCH_ENABLED =
  process.env.NEXT_PUBLIC_STREAM_BATCH_ENABLED !== "false";

const envInterval = Number(process.env.NEXT_PUBLIC_STREAM_BATCH_INTERVAL_MS);
const STREAM_BATCH_INTERVAL_MS = Number.isFinite(envInterval)
  ? envInterval
  : 50;

const envMax = Number(process.env.NEXT_PUBLIC_STREAM_BATCH_MAX_CHARS);
const STREAM_BATCH_MAX_CHARS = Number.isFinite(envMax) ? envMax : 4000;
const TOOL_INPUT_BATCH_ENABLED =
  process.env.NEXT_PUBLIC_TOOL_INPUT_BATCH_ENABLED !== "false";
const envToolInputInterval = Number(process.env.NEXT_PUBLIC_TOOL_INPUT_BATCH_INTERVAL_MS);
const TOOL_INPUT_BATCH_INTERVAL_MS = Number.isFinite(envToolInputInterval)
  ? envToolInputInterval
  : 50;
const envToolInputMax = Number(process.env.NEXT_PUBLIC_TOOL_INPUT_BATCH_MAX_CHARS);
const TOOL_INPUT_BATCH_MAX_CHARS = Number.isFinite(envToolInputMax)
  ? envToolInputMax
  : 8192;
const loggedSanitizerToolCallIds = new Set<string>();
const DEBUG_CHAT = process.env.NEXT_PUBLIC_DEBUG_CHAT === "true";

type AttachmentMetadata = {
  url?: string;
  localPath?: string;
  filePath?: string;
  contentType?: string;
  size?: number;
  kind?: string;
};

interface InspectContextMetadata {
  version: number;
  source: string;
  sessionId?: string;
  userId?: string;
  componentId?: string;
  componentName?: string;
  userIntent?: string;
  selectedAt: string;
  elements: Array<{
    tagName: string;
    id?: string;
    selector: string;
    textContent?: string;
    className?: string;
    classes?: string[];
    bounds?: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    };
    hierarchy?: string[];
  }>;
}

function isInspectContextMetadata(value: unknown): value is InspectContextMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<InspectContextMetadata>;
  return Array.isArray(candidate.elements) && candidate.elements.length > 0;
}

type AttachmentAwarePending = PendingAttachment & {
  metadata?: AttachmentMetadata;
};

type AttachmentAwareComplete = CompleteAttachment & {
  metadata?: AttachmentMetadata;
};

type CustomToCreateMessageFunction = <UI_MESSAGE extends UIMessage = UIMessage>(
  message: AppendMessage,
) => CreateUIMessage<UI_MESSAGE>;

export const toCreateMessageWithAttachmentMetadata: CustomToCreateMessageFunction = <
  UI_MESSAGE extends UIMessage = UIMessage,
>(message: AppendMessage): CreateUIMessage<UI_MESSAGE> => {
  const attachmentDetailsByUrl = new Map<
    string,
    { filename?: string; contentType?: string }
  >();
  for (const attachment of message.attachments ?? []) {
    const contentPart = attachment.content[0] as
      | { type?: string; image?: string; data?: string }
      | undefined;
    const url = contentPart?.type === "image"
      ? contentPart.image
      : contentPart?.type === "file"
        ? contentPart.data
        : undefined;
    if (!url) continue;
    attachmentDetailsByUrl.set(url, {
      filename: attachment.name,
      contentType: attachment.contentType,
    });
  }

  const rawInputParts = [
    ...message.content.filter((part) => part.type !== "file"),
    ...(message.attachments?.flatMap((attachment) =>
      attachment.content.map((contentPart) => ({
        ...contentPart,
        filename: attachment.name,
      })),
    ) ?? []),
  ];
  const seenStructuredParts = new Set<string>();
  const inputParts = rawInputParts.filter((part) => {
    if (part.type === "text") {
      return true;
    }

    if (part.type === "image" || part.type === "file") {
      const assetUrl = part.type === "image" ? part.image : part.data;
      const mediaType =
        part.type === "image"
          ? ("contentType" in part && typeof part.contentType === "string" ? part.contentType : "image/png")
          : part.mimeType;
      const key = `asset:${assetUrl}:${mediaType ?? ""}`;
      if (seenStructuredParts.has(key)) {
        return false;
      }
      seenStructuredParts.add(key);
      return true;
    }

    return true;
  });

  const parts = inputParts.map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text" as const, text: part.text };
      case "image":
        {
          const attachmentDetails = attachmentDetailsByUrl.get(part.image);
        return {
          type: "file" as const,
          url: part.image,
          ...((part.filename || attachmentDetails?.filename) && {
            filename: part.filename || attachmentDetails?.filename,
          }),
          mediaType:
            ("contentType" in part && typeof part.contentType === "string"
              ? part.contentType
              : attachmentDetails?.contentType) || "image/png",
        };
        }
      case "file":
        {
          const attachmentDetails = attachmentDetailsByUrl.get(part.data);
        return {
          type: "file" as const,
          url: part.data,
          mediaType: part.mimeType || attachmentDetails?.contentType || "application/octet-stream",
          ...((part.filename || attachmentDetails?.filename) && {
            filename: part.filename || attachmentDetails?.filename,
          }),
        };
        }
      default:
        throw new Error(`Unsupported part type: ${part.type}`);
    }
  });

  const attachmentMetadata = (message.attachments ?? [])
    .map((attachment) => {
      const contentPart = attachment.content[0] as
        | { type?: string; image?: string; data?: string }
        | undefined;
      const metadata = ((attachment as AttachmentAwareComplete).metadata ?? {}) as AttachmentMetadata;
      const url = metadata.url
        ?? (contentPart?.type === "image" ? contentPart.image : undefined)
        ?? (contentPart?.type === "file" ? contentPart.data : undefined);

      if (!url) return null;
      const inferredLocalPath = metadata.localPath
        ?? (url.startsWith("/api/media/") ? url.replace("/api/media/", "") : undefined);

      return {
        name: attachment.name,
        contentType: attachment.contentType,
        url,
        localPath: inferredLocalPath,
        filePath: metadata.filePath,
        size: metadata.size,
        kind: metadata.kind ?? attachment.type,
      };
    })
    .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null);

  const existingCustom =
    ((message.metadata as { custom?: Record<string, unknown> } | undefined)?.custom) ?? {};
  const inspectContext = isInspectContextMetadata(existingCustom.inspectContext)
    ? existingCustom.inspectContext
    : undefined;

  return {
    role: message.role,
    parts,
    metadata: {
      ...(message.metadata ?? {}),
      ...((attachmentMetadata.length > 0 || inspectContext)
        ? {
            custom: {
              ...existingCustom,
              ...(attachmentMetadata.length > 0 ? { attachments: attachmentMetadata } : {}),
              ...(inspectContext ? { inspectContext } : {}),
            },
          }
        : {}),
    },
  } satisfies CreateUIMessage<UIMessage> as CreateUIMessage<UI_MESSAGE>;
};

/**
 * Chat helpers that the transport needs access to in order to intercept
 * out-of-band mid-stream events (currently: `data-injected-user-message`
 * data parts emitted when a user message is injected while an assistant
 * stream is live).
 *
 * We keep this shape narrow on purpose — widening it later should be a
 * conscious decision rather than an accidental coupling of transport
 * internals to `useChat` internals.
 */
interface TransportChatHelpers {
  setMessages: (updater: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void;
}

class BufferedAssistantChatTransport extends AssistantChatTransport<UIMessage> {
  /**
   * Reference to the active `useChat` helpers. The provider sets this in an
   * effect after `useChat()` resolves, so by the time any response stream
   * reaches `processResponseStream` the ref is populated. We keep it on the
   * instance instead of closing over it so re-renders of the provider don't
   * create new transports — `chat.setMessages` is stable for the lifetime of
   * the hook, so a single ref assignment is sufficient.
   */
  private chatHelpers: TransportChatHelpers | null = null;

  /**
   * Deduplication set: we receive the same `data-injected-user-message`
   * chunk potentially twice (live stream + reconnect re-delivery). Since
   * the chunk `id` equals the DB messageId, we can idempotently track which
   * ids we've already spliced into `chat.messages`.
   */
  private injectedMessageIds: Set<string> = new Set();

  setChatHelpers(helpers: TransportChatHelpers | null): void {
    this.chatHelpers = helpers;
  }

  /**
   * Splice an injected user UIMessage into `chat.messages` immediately
   * BEFORE the in-flight assistant message (always the last item during a
   * live stream). This preserves the assistant-message identity that the
   * AI SDK reducer appends deltas to, while making the injected user turn
   * visible to the thread renderer.
   *
   * Idempotent on `messageId` — safe to call multiple times on reconnect.
   */
  private spliceInjectedUserMessage(data: InjectedUserMessageData): void {
    if (!data || typeof data.messageId !== "string" || data.messageId.length === 0) {
      return;
    }
    if (this.injectedMessageIds.has(data.messageId)) {
      return;
    }
    this.injectedMessageIds.add(data.messageId);

    const helpers = this.chatHelpers;
    if (!helpers) return;

    const injectedMessage: UIMessage = {
      id: data.messageId,
      role: "user",
      parts: [{ type: "text", text: data.text ?? "" }],
      metadata: {
        livePromptInjected: true,
        orderingIndex: data.orderingIndex,
        sessionId: data.sessionId,
        source: data.source,
        stopIntent: data.stopIntent,
        createdAt: data.createdAt,
        ...(data.syntheticToolResults && data.syntheticToolResults.length > 0
          ? { syntheticToolResults: data.syntheticToolResults }
          : {}),
      },
    } as UIMessage;

    helpers.setMessages((prev) => {
      // Second-chance dedupe on array contents (set tracking is instance-
      // scoped and a transport swap across renders would lose it).
      if (prev.some((m) => m.id === data.messageId)) return prev;

      if (prev.length === 0) return [injectedMessage];

      const lastIdx = prev.length - 1;
      const tail = prev[lastIdx];
      // Insert BEFORE the last message (the in-flight assistant) so the
      // reducer keeps appending deltas to the same assistant identity.
      // If the last message isn't an assistant (edge case: pre-step-0), we
      // still splice before it for consistent ordering.
      void tail;
      const next = prev.slice();
      next.splice(lastIdx, 0, injectedMessage);
      return next;
    });
  }

  private wrapStreamWithRecovery(
    source: ReadableStream<UIMessageChunk>,
  ): ReadableStream<UIMessageChunk> {
    let reader: ReadableStreamDefaultReader<UIMessageChunk> | null = null;
    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        reader = source.getReader();
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader!.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          } catch (error) {
            const normalized = toError(error);
            if (isRecoverableStreamingError(normalized)) {
              console.warn("[ChatTransport] Recoverable stream reader error:", normalized.message);
              try {
                controller.close();
              } catch {
                // no-op
              }
            } else {
              controller.error(error);
            }
          } finally {
            try {
              reader?.releaseLock();
            } catch {
              // no-op
            }
          }
        };
        void pump();
      },
      async cancel(reason) {
        try {
          await reader?.cancel(reason);
        } catch {
          // no-op
        }
      },
    });
  }

  protected override processResponseStream(
    stream: ReadableStream<Uint8Array>,
  ): ReadableStream<UIMessageChunk> {
    const baseStream = super.processResponseStream(stream);

    if (!STREAM_BATCH_ENABLED) {
      return this.wrapStreamWithRecovery(baseStream);
    }

    let bufferedDelta = "";
    let lastTextId: string | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let streamErrored = false;
    const toolInputBuffers = new Map<
      string,
      { delta: string; timer: ReturnType<typeof setTimeout> | null }
    >();
    let rawToolInputDeltaChunks = 0;
    let emittedToolInputDeltaChunks = 0;

    const clearTimer = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    };

    const safeEnqueue = (
      controller: TransformStreamDefaultController<UIMessageChunk>,
      chunk: UIMessageChunk,
    ) => {
      if (streamErrored) return false;
      try {
        controller.enqueue(chunk);
        return true;
      } catch {
        streamErrored = true;
        clearTimer();
        bufferedDelta = "";
        return false;
      }
    };

    const flushBuffer = (
      controller: TransformStreamDefaultController<UIMessageChunk>,
    ) => {
      if (!bufferedDelta || !lastTextId) return;
      if (!safeEnqueue(controller, {
        type: "text-delta",
        id: lastTextId,
        delta: bufferedDelta,
      } as UIMessageChunk)) {
        bufferedDelta = "";
        return;
      }
      bufferedDelta = "";
    };

    const getToolInputBuffer = (toolCallId: string) => {
      const existing = toolInputBuffers.get(toolCallId);
      if (existing) return existing;
      const created = { delta: "", timer: null as ReturnType<typeof setTimeout> | null };
      toolInputBuffers.set(toolCallId, created);
      return created;
    };

    const clearToolInputTimer = (toolCallId: string) => {
      const buffered = toolInputBuffers.get(toolCallId);
      if (!buffered?.timer) return;
      clearTimeout(buffered.timer);
      buffered.timer = null;
    };

    const flushToolInputBuffer = (
      toolCallId: string,
      controller: TransformStreamDefaultController<UIMessageChunk>,
    ) => {
      const buffered = toolInputBuffers.get(toolCallId);
      if (!buffered || buffered.delta.length === 0) return;
      clearToolInputTimer(toolCallId);
      if (!safeEnqueue(controller, {
        type: "tool-input-delta",
        toolCallId,
        inputTextDelta: buffered.delta,
      } as UIMessageChunk)) {
        buffered.delta = "";
        return;
      }
      emittedToolInputDeltaChunks += 1;
      buffered.delta = "";
    };

    const flushAllToolInputBuffers = (
      controller: TransformStreamDefaultController<UIMessageChunk>,
    ) => {
      for (const toolCallId of toolInputBuffers.keys()) {
        flushToolInputBuffer(toolCallId, controller);
      }
    };

    const clearAllToolInputBuffers = () => {
      for (const [toolCallId, buffered] of toolInputBuffers.entries()) {
        if (buffered.timer) {
          clearTimeout(buffered.timer);
        }
        toolInputBuffers.delete(toolCallId);
      }
    };

    const bufferToolInputDelta = (
      toolCallId: string,
      delta: string,
      controller: TransformStreamDefaultController<UIMessageChunk>,
    ) => {
      rawToolInputDeltaChunks += 1;
      if (!TOOL_INPUT_BATCH_ENABLED) {
        safeEnqueue(controller, {
          type: "tool-input-delta",
          toolCallId,
          inputTextDelta: delta,
        } as UIMessageChunk);
        emittedToolInputDeltaChunks += 1;
        return;
      }

      const buffered = getToolInputBuffer(toolCallId);
      buffered.delta += delta;

      if (buffered.delta.length >= TOOL_INPUT_BATCH_MAX_CHARS) {
        flushToolInputBuffer(toolCallId, controller);
        return;
      }

      if (!buffered.timer) {
        buffered.timer = setTimeout(() => {
          const state = toolInputBuffers.get(toolCallId);
          if (!state) return;
          state.timer = null;
          flushToolInputBuffer(toolCallId, controller);
        }, TOOL_INPUT_BATCH_INTERVAL_MS);
      }
    };

    const scheduleFlush = (
      controller: TransformStreamDefaultController<UIMessageChunk>,
    ) => {
      if (streamErrored) return;
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushBuffer(controller);
      }, STREAM_BATCH_INTERVAL_MS);
    };

    const toolCallsWithDeltas = new Set<string>();

    const transformed = baseStream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform: (chunk, controller) => {
          // Mid-stream user-message injection protocol. Swallow the chunk so
          // the AI SDK's useChat reducer never appends it to the in-flight
          // assistant message; splice a synthesized user UIMessage into
          // `chat.messages` instead. Idempotent on `data.messageId` so a
          // reconnect re-delivery doesn't double-render the row.
          if (chunk.type === INJECTED_USER_MESSAGE_CHUNK_TYPE) {
            const raw = (chunk as unknown as { data?: InjectedUserMessageData })
              .data;
            if (raw) {
              // Flush any pending text-delta BEFORE the splice so the
              // rendered timeline stays [text-so-far][user-inject][…]
              // instead of [partial-before-inject][user-inject][finish-partial].
              flushBuffer(controller);
              this.spliceInjectedUserMessage(raw);
            }
            return; // swallow — do NOT enqueue
          }

          if (chunk.type === "text-delta") {
            const textChunk = chunk as UIMessageChunk & { id: string; delta: string };
            if (lastTextId && textChunk.id !== lastTextId) {
              flushBuffer(controller);
            }
            lastTextId = textChunk.id;
            bufferedDelta += textChunk.delta;

            if (bufferedDelta.length >= STREAM_BATCH_MAX_CHARS) {
              flushBuffer(controller);
            } else {
              scheduleFlush(controller);
            }
            return;
          }

          flushBuffer(controller);

          if (chunk.type === "tool-input-delta") {
            const inputChunk = chunk as UIMessageChunk & { toolCallId: string; inputTextDelta: string };
            if (inputChunk.toolCallId) {
              toolCallsWithDeltas.add(inputChunk.toolCallId);
              bufferToolInputDelta(
                inputChunk.toolCallId,
                inputChunk.inputTextDelta,
                controller,
              );
              return;
            }
          }

          if (TOOL_INPUT_BATCH_ENABLED && toolCallsWithDeltas.size > 0) {
            if (chunk.type === "tool-input-available") {
              const availChunk = chunk as UIMessageChunk & { toolCallId: string };
              if (availChunk.toolCallId && toolCallsWithDeltas.has(availChunk.toolCallId)) {
                flushToolInputBuffer(availChunk.toolCallId, controller);
                toolCallsWithDeltas.delete(availChunk.toolCallId);
                if (DEBUG_CHAT) {
                  console.debug("[ChatTransport] Flushed batched tool input before input-available", {
                    toolCallId: availChunk.toolCallId,
                    rawToolInputDeltaChunks,
                    emittedToolInputDeltaChunks,
                  });
                }
              }
            } else if (chunk.type === "tool-output-available") {
              const outputChunk = chunk as UIMessageChunk & { toolCallId: string };
              if (outputChunk.toolCallId && toolCallsWithDeltas.has(outputChunk.toolCallId)) {
                flushToolInputBuffer(outputChunk.toolCallId, controller);
                toolCallsWithDeltas.delete(outputChunk.toolCallId);
              }
            } else if (chunk.type === "tool-output-error") {
              const errChunk = chunk as UIMessageChunk & { toolCallId: string };
              if (errChunk.toolCallId && toolCallsWithDeltas.has(errChunk.toolCallId)) {
                flushToolInputBuffer(errChunk.toolCallId, controller);
                toolCallsWithDeltas.delete(errChunk.toolCallId);
                if (DEBUG_CHAT) {
                  console.debug("[ChatTransport] Flushed batched tool input before tool-output-error", {
                    toolCallId: errChunk.toolCallId,
                    rawToolInputDeltaChunks,
                    emittedToolInputDeltaChunks,
                  });
                }
              }
            }
          }

          safeEnqueue(controller, chunk);
        },
        flush: (controller) => {
          clearTimer();
          flushBuffer(controller);
          flushAllToolInputBuffers(controller);
          if (
            TOOL_INPUT_BATCH_ENABLED &&
            rawToolInputDeltaChunks > 0 &&
            DEBUG_CHAT
          ) {
            console.debug("[ChatTransport] Tool input batching stats", {
              rawToolInputDeltaChunks,
              emittedToolInputDeltaChunks,
            });
          }
          clearAllToolInputBuffers();
        },
      }),
    );

    return this.wrapStreamWithRecovery(transformed);
  }
}

function buildPendingAttachment(file: File, previewUrl: string): AttachmentAwarePending {
  if (isImageAttachment(file.type)) {
    return {
      id: `${file.name}-${Date.now()}`,
      type: "image",
      name: file.name,
      contentType: file.type,
      file,
      content: [{ type: "image", image: previewUrl }],
      status: { type: "running", reason: "uploading", progress: 0 },
      metadata: {
        contentType: file.type,
        size: file.size,
        kind: "image",
      },
    } as AttachmentAwarePending;
  }

  return {
    id: `${file.name}-${Date.now()}`,
    type: "file",
    name: file.name,
    contentType: file.type || "application/octet-stream",
    file,
    content: [{ type: "file", data: previewUrl, mimeType: file.type || "application/octet-stream" }],
    status: { type: "running", reason: "uploading", progress: 0 },
    metadata: {
      contentType: file.type || "application/octet-stream",
      size: file.size,
      kind: "document",
    },
  } as AttachmentAwarePending;
}

function buildCompleteAttachment(
  pending: AttachmentAwarePending,
  upload: {
    url: string;
    localPath: string;
    filePath: string;
    contentType: string;
    size: number;
  },
): AttachmentAwarePending {
  const isImage = isImageAttachment(upload.contentType || pending.contentType);

  return {
    ...pending,
    type: isImage ? "image" : "file",
    contentType: upload.contentType || pending.contentType,
    content: isImage
      ? [{ type: "image", image: upload.url }]
      : [{ type: "file", data: upload.url, mimeType: upload.contentType || pending.contentType || "application/octet-stream" }],
    status: { type: "requires-action" as const, reason: "composer-send" as const },
    metadata: {
      url: upload.url,
      localPath: upload.localPath,
      filePath: upload.filePath,
      contentType: upload.contentType,
      size: upload.size,
      kind: isImage ? "image" : "document",
    },
  } as AttachmentAwarePending;
}

export const ChatProvider: FC<ChatProviderProps> = ({
  children,
  sessionId,
  characterId,
  initialMessages,
}) => {
  const tAssistant = useTranslations("assistant");
  const tErrors = useTranslations("errors");
  const attachmentAdapter: AttachmentAdapter = useMemo(
    () => ({
      accept: CHAT_ATTACHMENT_ACCEPT,

      async *add({ file }): AsyncGenerator<PendingAttachment, void> {
        const previewUrl = URL.createObjectURL(file);
        const pendingAttachment = buildPendingAttachment(file, previewUrl);
        yield pendingAttachment;

        const formData = new FormData();
        formData.append("file", file);
        if (sessionId) {
          formData.append("sessionId", sessionId);
        }
        formData.append("role", "upload");

        const response = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          URL.revokeObjectURL(previewUrl);
          throw new Error(tAssistant("uploadError"));
        }

        const data = await response.json();

        if (DEBUG_CHAT) {
          console.debug("[ChatProvider] Upload complete", {
            name: file.name,
            contentType: file.type,
            size: file.size,
            url: data.url,
            localPath: data.localPath,
            filePath: data.filePath,
          });
        }

        URL.revokeObjectURL(previewUrl);
        yield buildCompleteAttachment(pendingAttachment, data);
      },

      async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
        const typedAttachment = attachment as AttachmentAwarePending;
        if (DEBUG_CHAT) {
          console.debug("[ChatProvider] Finalizing attachment for send", {
            id: typedAttachment.id,
            name: typedAttachment.name,
            status: typedAttachment.status,
            metadata: typedAttachment.metadata,
          });
        }
        return {
          ...typedAttachment,
          content: typedAttachment.content || [],
          status: { type: "complete" },
        } as AttachmentAwareComplete;
      },

      async remove(): Promise<void> {
        // No cleanup needed - could delete from storage if desired
      },
    }),
    [sessionId, tAssistant]
  );

  const headers: Record<string, string> = {};
  if (sessionId) {
    headers["X-Session-Id"] = sessionId;
  }
  if (characterId) {
    headers["X-Character-Id"] = characterId;
  }
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone) {
      headers["X-User-Timezone"] = timezone;
    }
  } catch {
    // Ignore timezone detection failures in constrained runtimes.
  }

  const [transportError, setTransportError] = useState<ChatTransportErrorPayload | null>(null);
  const clearTransportError = () => setTransportError(null);

  const transportFetch = useMemo(
    () =>
      async (input: RequestInfo | URL, init?: RequestInit) => {
        setTransportError(null);

        if (typeof input === "string" && input === "/api/chat") {
          const preflightResponse = await fetch("/api/chat/preflight", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {}),
            },
            body: init?.body,
            signal: init?.signal,
          });
          const preflightResult = parseChatPreflightResponse(await preflightResponse.text());
          if (!preflightResult.ok) {
            setTransportError({
              httpStatus: preflightResult.httpStatus,
              message: preflightResult.error,
              details: preflightResult.details,
              status: preflightResult.status,
              recovery: preflightResult.recovery,
              compactionResult: preflightResult.compactionResult,
            });
            return new Response(JSON.stringify({
              error: preflightResult.error,
              details: preflightResult.details,
              status: preflightResult.status,
              recovery: preflightResult.recovery,
              compactionResult: preflightResult.compactionResult,
            }), {
              status: preflightResult.httpStatus ?? 500,
              headers: { "Content-Type": "application/json" },
            });
          }
        }

        try {
          if (DEBUG_CHAT && typeof input === "string" && input === "/api/chat" && init?.body) {
            try {
              const parsedBody = JSON.parse(String(init.body)) as {
                messages?: Array<{ role?: string; parts?: unknown[]; metadata?: unknown }>;
              };
              const lastMessage = parsedBody.messages?.[parsedBody.messages.length - 1];
              console.debug("[ChatProvider] Outbound /api/chat payload", {
                messageCount: parsedBody.messages?.length ?? 0,
                lastMessage,
              });
            } catch (parseError) {
              console.warn("[ChatProvider] Failed to parse outbound chat payload", parseError);
            }
          }
          const response = await fetch(input, init);
          if (!response.ok) {
            setTransportError(await parseTransportErrorResponse(response));
          }
          return response;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Request failed";
          setTransportError({ message });
          throw error;
        }
      },
    [],
  );

  const transport = useDynamicChatTransport(
    useMemo(
      () =>
        new BufferedAssistantChatTransport({
          api: "/api/chat",
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          fetch: transportFetch,
        }),
      [sessionId, characterId, transportFetch],
    ),
  );

  const safeMessages = useMemo(() => sanitizeMessagesForInit(initialMessages ?? []), [initialMessages]);

  const chatStatusRef = useRef("ready");
  const autoRetryAttemptRef = useRef(0);
  const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTrackedUserMessageIdRef = useRef<string | undefined>(undefined);
  const MAX_CLIENT_AUTO_RETRIES = 2;
  const recoverRetryStateRef = useRef<() => void>(() => {});
  const scheduleRetryFromErrorRef = useRef<(error: Error, source: string) => boolean>(() => false);

  const chat = useChat({
    id: sessionId,
    transport,
    messages: safeMessages,
    generateId: () => crypto.randomUUID(),
    onFinish: ({ isError }) => {
      if (!isError) {
        autoRetryAttemptRef.current = 0;
      }
    },
    onError: (error) => {
      if (shouldIgnoreUseChatError(error, chatStatusRef.current)) {
        return;
      }

      if (isClientRetryStateError(error)) {
        recoverRetryStateRef.current();
        return;
      }

      if (scheduleRetryFromErrorRef.current(error, "useChat.onError")) {
        return;
      }

      console.error("[ChatProvider] useChat error:", error.message);
      chat.clearError();
    },
  });

  const runtime = useAISDKRuntime(chat, {
    adapters: { attachments: attachmentAdapter },
    toCreateMessage: toCreateMessageWithAttachmentMetadata,
  });

  const recoverRetryState = useCallback(() => {
    chat.setMessages((prev) => {
      const recovered = sanitizeMessagesForInit(cloneMessages(prev));
      return hasUserMessage(recovered) ? recovered : prev;
    });
    chat.clearError();
  }, [chat]);

  const submitRetryMessage = useCallback(async (reason: string, retryMessage = buildRetryMessage(chat.messages)) => {
    if (!retryMessage) {
      return false;
    }

    try {
      await chat.sendMessage(retryMessage);
      return true;
    } catch (retryError) {
      const normalizedError = toError(retryError);
      if (isClientRetryStateError(normalizedError)) {
        console.warn("[ChatProvider] Recovering retry state after client-side failure", {
          reason,
          message: normalizedError.message,
          messageId: retryMessage.messageId,
        });
        recoverRetryState();
        return false;
      }
      console.error("[ChatProvider] Client-side retry failed:", normalizedError);
      return false;
    }
  }, [chat, recoverRetryState]);

  const scheduleRetryFromError = useCallback((error: Error, source: string) => {
    if (
      autoRetryTimerRef.current != null
      || autoRetryAttemptRef.current >= MAX_CLIENT_AUTO_RETRIES
      || !shouldAutoRetryClientChat({ error, messages: chat.messages })
    ) {
      return false;
    }

    const retryMessage = buildRetryMessage(chat.messages);
    if (!retryMessage) {
      return false;
    }

    const attempt = autoRetryAttemptRef.current + 1;
    autoRetryAttemptRef.current = attempt;
    const delayMs = Math.min(1500 * attempt, 4000);
    console.warn("[ChatProvider] Scheduling client-side retry", {
      source,
      attempt,
      delayMs,
      message: error.message,
      messageId: retryMessage.messageId,
    });
    chat.clearError();
    autoRetryTimerRef.current = setTimeout(() => {
      autoRetryTimerRef.current = null;
      void submitRetryMessage(source, retryMessage);
    }, delayMs);
    return true;
  }, [chat, submitRetryMessage]);

  useEffect(() => {
    recoverRetryStateRef.current = recoverRetryState;
    return () => {
      recoverRetryStateRef.current = () => {};
    };
  }, [recoverRetryState]);

  useEffect(() => {
    scheduleRetryFromErrorRef.current = scheduleRetryFromError;
    return () => {
      scheduleRetryFromErrorRef.current = () => false;
    };
  }, [scheduleRetryFromError]);

  useEffect(() => {
    if (transport instanceof AssistantChatTransport) {
      (transport as AssistantChatTransport<UIMessage>).setRuntime(runtime);
    }
  }, [transport, runtime]);

  // Give the transport a handle on `chat.setMessages` so it can splice an
  // injected user UIMessage into the thread when a
  // `data-injected-user-message` chunk arrives mid-stream. See
  // `BufferedAssistantChatTransport.spliceInjectedUserMessage`.
  useEffect(() => {
    if (transport instanceof BufferedAssistantChatTransport) {
      transport.setChatHelpers({ setMessages: chat.setMessages });
    }
    return () => {
      if (transport instanceof BufferedAssistantChatTransport) {
        transport.setChatHelpers(null);
      }
    };
  }, [transport, chat.setMessages]);

  useEffect(() => {
    chatStatusRef.current = chat.status;
  }, [chat.status]);

  useEffect(() => {
    const lastUserMessageId = getLastUserMessageId(chat.messages);
    if (lastUserMessageId && lastUserMessageId !== lastTrackedUserMessageIdRef.current) {
      autoRetryAttemptRef.current = 0;
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
      }
    }
    lastTrackedUserMessageIdRef.current = lastUserMessageId;
  }, [chat.messages]);

  useEffect(() => {
    return () => {
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
      }
    };
  }, []);

  const recoveryRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    recoveryRef.current = () => {
      recoverRetryState();
    };
    return () => {
      recoveryRef.current = null;
    };
  }, [recoverRetryState]);

  const lastStreamingRef = useRef<number>(0);
  if (chat.status === "streaming" || chat.status === "submitted") {
    lastStreamingRef.current = Date.now();
  }

  // Delegation results are now auto-delivered by blocking in prepareStep —
  // no SSE auto-resume needed. The turn stays alive while subagents run.

  return (
    <ChatErrorBoundary
      processingText={tAssistant("processingTool")}
      genericError={tErrors("genericRefresh")}
      recoveryRef={recoveryRef}
      lastStreamingRef={lastStreamingRef}
    >
      <AssistantRuntimeProvider runtime={runtime}>
        <ChatSessionIdContext.Provider value={sessionId}>
          <ChatTransportErrorContext.Provider value={{ error: transportError, clearError: clearTransportError }}>
            <ChatSetMessagesContext.Provider value={chat.setMessages}>
              <ChatStatusContext.Provider value={chat.status as ChatLifecycleStatus}>
                <VoiceProvider>
                  <DeepResearchProvider sessionId={sessionId}>
                    {children}
                  </DeepResearchProvider>
                </VoiceProvider>
              </ChatStatusContext.Provider>
            </ChatSetMessagesContext.Provider>
          </ChatTransportErrorContext.Provider>
        </ChatSessionIdContext.Provider>
      </AssistantRuntimeProvider>
    </ChatErrorBoundary>
  );
};

"use client";

import type { FC } from "react";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
// Note: animate (animejs), useReducedMotion, ZLUTTY_*, useIsInitialLoad removed — no message entrance animations
import {
  ComposerPrimitive,
  MessagePrimitive,
  BranchPickerPrimitive,
  ActionBarPrimitive,
  AttachmentPrimitive,
  useThreadComposerAttachment,
  useMessageAttachment,
  useMessage,
} from "@assistant-ui/react";
import {
  CopyIcon,
  CheckIcon,
  RefreshCwIcon,
  PencilIcon,
  CircleStopIcon,
  Volume2Icon,
  Loader2Icon,
  FileTextIcon,
  FileSpreadsheetIcon,
  PresentationIcon,
  Music4Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { GradientBackground } from "@/components/ui/noisy-gradient-backgrounds";
import { getAgentAccentColor, buildAgentGradientColors } from "@/lib/personalization/accent-colors";
import { MarkdownText, UserMarkdownText } from "./markdown-text";
import { ToolFallback } from "./tool-fallback";
import { ToolCallGroup, resetToolGroupExpansion } from "./tool-call-group";
import { VectorSearchToolUI } from "./vector-search-inline";
import { ProductGalleryToolUI } from "./product-gallery-inline";
import { ExecuteCommandToolUI } from "./execute-command-tool-ui";
import { EditFileToolUI } from "./edit-file-tool-ui";
import { PatchFileToolUI } from "./patch-file-tool-ui";
import { CalculatorToolUI } from "./calculator-tool-ui";
import { PlanToolUI } from "./plan-tool-ui";
import { PlanApprovalToolUI } from "./plan-approval-tool-ui";
import { SpeakAloudToolUI, TranscribeToolUI } from "./voice-tool-ui";
import { ChromiumWorkspaceToolUI } from "./chromium-workspace-tool-ui";
import { AskFollowupQuestionToolUI } from "./ask-question-tool-ui";
import { PromptLibraryToolUI } from "./prompt-library-tool-ui";
import { DesignWorkspaceToolUI } from "./design-workspace-tool-ui";

import {
  ClaudeEditToolUI,
  ClaudeBashToolUI,
  ClaudeReadToolUI,
  ClaudeWriteToolUI,
  ClaudeGlobToolUI,
  ClaudeGrepToolUI,
  ClaudeAgentToolUI,
  ClaudeWebFetchToolUI,
  ClaudeWebSearchToolUI,
  ClaudeNotebookEditToolUI,
  ClaudeTodoWriteToolUI,
  ClaudeEnterPlanModeToolUI,
  ClaudeEnterWorktreeToolUI,
  ClaudeSkillToolUI,
  ClaudeTaskOutputToolUI,
  ClaudeTaskStopToolUI,
  DelegationToolUI,
} from "./claude-code-tools";
import { ReasoningPart } from "./reasoning-part";
import { useOptionalVoice } from "./voice-context";
import { stripMarkdown } from "@/lib/utils/strip-markdown";
import { YouTubeInlinePreview } from "./youtube-inline";
import { TooltipIconButton } from "./tooltip-icon-button";
import { useCharacter, DEFAULT_CHARACTER } from "./character-context";
import { useTranslations } from "next-intl";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { useChatSessionId } from "@/components/chat-provider";
import { useLiveToolStatuses } from "./tool-live-status";
import {
  getVisibleActivitySignature,
  isMessageInitiallyThinking,
  shouldShowIdleThinking,
  SYNTHETIC_THINKING_IDLE_DELAY_MS,
} from "./thread-message-activity";

/**
 * Wraps a by_name tool map so MCP-prefixed names (e.g. mcp__selene-platform__vectorSearch)
 * resolve to the same component as the short name (vectorSearch).
 * Without this, assistant-ui's by_name lookup fails for all MCP tools and falls back to ToolFallback.
 */
const MCP_PREFIX = "mcp__selene-platform__";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mcpAwareToolMap(map: Record<string, FC<any>>): Record<string, FC<any>> {
  return new Proxy(map, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop.startsWith(MCP_PREFIX)) {
        const short = prop.slice(MCP_PREFIX.length);
        return target[short] ?? Reflect.get(target, prop, receiver);
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === "string" && prop.startsWith(MCP_PREFIX)) {
        const short = prop.slice(MCP_PREFIX.length);
        return short in target || prop in target;
      }
      return prop in target;
    },
  });
}

/**
 * No-op render for the mid-stream live-prompt injection wire event. The
 * primary swallow happens inside `BufferedAssistantChatTransport`'s chunk
 * intercept (see `components/chat-provider.tsx`). This fallback exists in
 * case a stray frame ever reaches the reducer — it renders nothing instead
 * of emitting the core's "no renderer registered" console warning. The
 * actual injected user row is dispatched through `setMessages` as its own
 * UIMessage, never as a part inside another row.
 */
const InjectedUserMessagePartNoop: FC = () => null;

// Static tool map — all values are stable component references, no render-time closures.
// Hoisted to module scope to avoid rebuilding the Proxy on every render.
const TOOL_BY_NAME_MAP = mcpAwareToolMap({
  // Selene MCP tools
  vectorSearch: VectorSearchToolUI,
  showProductImages: ProductGalleryToolUI,
  executeCommand: ExecuteCommandToolUI,
  editFile: EditFileToolUI,
  writeFile: EditFileToolUI,
  patchFile: PatchFileToolUI,
  calculator: CalculatorToolUI,
  updatePlan: PlanToolUI,
  speakAloud: SpeakAloudToolUI,
  transcribe: TranscribeToolUI,
  chromiumWorkspace: ChromiumWorkspaceToolUI,
  designWorkspace: DesignWorkspaceToolUI,

  askUserQuestion: AskFollowupQuestionToolUI,
  askFollowupQuestion: AskFollowupQuestionToolUI,
  AskFollowupQuestion: AskFollowupQuestionToolUI,
  AskUserQuestion: AskFollowupQuestionToolUI,
  ExitPlanMode: PlanApprovalToolUI,
  promptLibrary: PromptLibraryToolUI,
  // Claude Code native tools
  Edit: ClaudeEditToolUI,
  bash: ClaudeBashToolUI,
  Bash: ClaudeBashToolUI,
  Read: ClaudeReadToolUI,
  Write: ClaudeWriteToolUI,
  Glob: ClaudeGlobToolUI,
  Grep: ClaudeGrepToolUI,
  Agent: ClaudeAgentToolUI,
  WebFetch: ClaudeWebFetchToolUI,
  WebSearch: ClaudeWebSearchToolUI,
  NotebookEdit: ClaudeNotebookEditToolUI,
  TodoWrite: ClaudeTodoWriteToolUI,
  EnterPlanMode: ClaudeEnterPlanModeToolUI,
  EnterWorktree: ClaudeEnterWorktreeToolUI,
  Skill: ClaudeSkillToolUI,
  TaskOutput: ClaudeTaskOutputToolUI,
  TaskStop: ClaudeTaskStopToolUI,
  delegateToSubagent: DelegationToolUI,
});

export function getToolComponentByName(toolName: string) {
  return TOOL_BY_NAME_MAP[toolName];
}

export function getAttachmentImageUrl(attachment: {
  contentType?: string;
  content?: Array<{ type?: string; image?: string; url?: string; mimeType?: string; filename?: string }>;
}): string | undefined {
  const imageContent = attachment.content?.find(
    (content): content is { type: "image"; image: string } =>
      content.type === "image" && typeof content.image === "string",
  );
  if (imageContent?.image) {
    return imageContent.image;
  }

  const imageFileContent = attachment.content?.find(
    (content): content is { type: "file"; url: string; mimeType?: string } =>
      content.type === "file"
      && typeof content.url === "string"
      && (
        (typeof content.mimeType === "string" && content.mimeType.startsWith("image/"))
        || attachment.contentType?.startsWith("image/") === true
      ),
  );

  return imageFileContent?.url;
}

function getFilenameFromUrl(value?: string): string | undefined {
  if (!value) return undefined;
  const withoutQuery = value.split("?")[0]?.split("#")[0];
  const filename = withoutQuery?.split("/").pop();
  if (!filename || filename.length === 0) {
    return undefined;
  }
  try {
    return decodeURIComponent(filename);
  } catch {
    return filename;
  }
}

function isGenericAttachmentName(name?: string): boolean {
  if (!name) return true;
  const normalized = name.trim().toLowerCase();
  return normalized.length === 0
    || normalized === "file"
    || normalized === "attachment"
    || normalized === "image";
}

export function getAttachmentDisplayName(attachment: {
  name?: string;
  content?: Array<{
    type?: string;
    image?: string;
    url?: string;
    filename?: string;
  }>;
}): string {
  if (!isGenericAttachmentName(attachment.name)) {
    return attachment.name!.trim();
  }

  for (const content of attachment.content ?? []) {
    if (typeof content.filename === "string" && content.filename.trim().length > 0) {
      return content.filename.trim();
    }
    const derivedName = getFilenameFromUrl(content.type === "image" ? content.image : content.url);
    if (derivedName) {
      return derivedName;
    }
  }

  return attachment.name?.trim() || "Attachment";
}

function getAttachmentMediaType(attachment: {
  contentType?: string;
  content?: Array<{ type?: string; mimeType?: string }>;
}): string {
  return attachment.contentType
    || attachment.content?.find((content) => typeof content.mimeType === "string")?.mimeType
    || "application/octet-stream";
}

function getAttachmentExtension(name?: string): string {
  return name?.split(".").pop()?.toUpperCase() || "FILE";
}

function getAttachmentIcon(mediaType: string) {
  if (mediaType.startsWith("audio/")) {
    return Music4Icon;
  }
  if (mediaType.includes("presentation") || mediaType.includes("powerpoint")) {
    return PresentationIcon;
  }
  if (mediaType.includes("spreadsheet") || mediaType.includes("excel") || mediaType.includes("csv")) {
    return FileSpreadsheetIcon;
  }
  return FileTextIcon;
}

function formatAttachmentMeta(params: {
  mediaType: string;
  name?: string;
}): string {
  if (params.mediaType.startsWith("image/")) {
    return "Image attachment";
  }
  if (params.mediaType.startsWith("audio/")) {
    return "Audio attachment";
  }

  return `${getAttachmentExtension(params.name)} document`;
}

function ComposerAttachmentChip({
  attachment,
  showRemove,
}: {
  attachment: {
    name?: string;
    contentType?: string;
    content?: Array<{ type?: string; image?: string; url?: string; mimeType?: string; filename?: string }>;
    status?: { type?: string; reason?: string };
  };
  showRemove?: boolean;
}) {
  const isUploading = attachment.status?.type === "running";
  const displayName = getAttachmentDisplayName(attachment);
  const extension = getAttachmentExtension(displayName);

  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors",
        isUploading
          ? "border-amber-500/30 bg-amber-50/80 text-amber-900"
          : "border-border/50 bg-card text-foreground hover:bg-accent/50"
      )}
    >
      <span className="text-xs font-mono uppercase text-muted-foreground">{extension}</span>
      <span className="max-w-[12ch] truncate text-sm" title={displayName}>
        {displayName}
      </span>
      {isUploading ? (
        <Loader2Icon className="size-3.5 animate-spin text-amber-600" />
      ) : showRemove ? (
        <AttachmentPrimitive.Remove className="ml-0.5 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive">
          <XIcon className="size-3.5" />
        </AttachmentPrimitive.Remove>
      ) : null}
    </div>
  );
}

function MessageAttachmentCard({
  attachment,
}: {
  attachment: {
    name?: string;
    contentType?: string;
    content?: Array<{ type?: string; image?: string; url?: string; mimeType?: string; filename?: string }>;
  };
}) {
  const imageUrl = getAttachmentImageUrl(attachment);
  const mediaType = getAttachmentMediaType(attachment);
  const Icon = getAttachmentIcon(mediaType);
  const displayName = getAttachmentDisplayName(attachment);
  const metaLabel = formatAttachmentMeta({ mediaType, name: displayName });

  return (
    <div className="flex max-w-xs flex-col gap-1.5 rounded-lg border border-border/50 bg-card p-3">
      <div className="flex items-start gap-2">
        {imageUrl ? (
          <div className="size-10 shrink-0 overflow-hidden rounded-lg border border-border/50 bg-muted/50">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt={displayName} className="size-full object-cover" />
          </div>
        ) : (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-muted/50 text-muted-foreground">
            <Icon className="size-5" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground" title={displayName}>
            {displayName}
          </div>
          <div className="text-xs text-muted-foreground">{metaLabel}</div>
        </div>
      </div>
    </div>
  );
}

export const ComposerAttachment: FC = () => {
  const attachment = useThreadComposerAttachment((a: { id: string; name?: string; contentType?: string; content?: Array<{ type?: string; image?: string; mimeType?: string }>; status?: { type?: string; reason?: string } }) => a);

  return (
    <AttachmentPrimitive.Root>
      <ComposerAttachmentChip
        attachment={attachment}
        showRemove={attachment.status?.type !== "running"}
      />
    </AttachmentPrimitive.Root>
  );
};

const UserFileContent: FC<{ type: "file"; data: string; mimeType: string; filename?: string }> = ({ data, mimeType, filename }) => {
  if (mimeType?.startsWith("image/")) {
    // data may be a URL (/api/media/...) or a base64 data URI
    const src = data.startsWith("data:") || data.startsWith("/") || data.startsWith("http")
      ? data
      : `data:${mimeType};base64,${data}`;
    return (
      <div className="mt-1 max-w-56 overflow-hidden rounded-lg border border-border/30">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={filename || "Uploaded image"} className="max-h-44 w-auto object-contain" />
      </div>
    );
  }
  return null;
};

export const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="relative mb-6 flex w-full max-w-[80rem] min-w-0 flex-col items-end gap-2 pl-8"
    >
      <div className="flex items-start gap-3">
        <UserActionBar />
        <div className="flex min-w-0 max-w-[80rem] flex-col gap-1">
          <div className="flex flex-wrap gap-2 justify-end empty:hidden">
            <MessagePrimitive.Attachments
              components={{ Attachment: UserAttachment }}
            />
          </div>
          <div className="rounded-2xl rounded-tr-sm bg-terminal-dark px-4 py-2.5 text-terminal-cream font-mono text-sm [overflow-wrap:anywhere]">
            <MessagePrimitive.Content components={{ Text: UserMarkdownText, File: UserFileContent }} />
          </div>
        </div>
        <Avatar className="size-8 shadow-sm">
          <AvatarFallback className="bg-terminal-amber/20 text-terminal-amber text-xs font-mono">
            U
          </AvatarFallback>
        </Avatar>
      </div>
      <BranchPicker />
    </MessagePrimitive.Root>
  );
};

const UserAttachment: FC = () => {
  const attachment = useMessageAttachment((a: { id: string; name?: string; contentType?: string; content?: Array<{ type?: string; image?: string; mimeType?: string }> }) => a);

  return (
    <AttachmentPrimitive.Root>
      <MessageAttachmentCard attachment={attachment} />
    </AttachmentPrimitive.Root>
  );
};

export const SystemMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="relative mb-6 flex w-full max-w-[80rem] justify-center px-4"
    >
      <div className="flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-mono text-red-700 shadow-sm">
        <CircleStopIcon className="size-3" />
        <MessagePrimitive.Content components={{ Text: MarkdownText }} />
      </div>
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  const t = useTranslations("assistantUi");
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="flex flex-col items-end gap-1 mt-2"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton
          tooltip={t("tooltips.edit")}
          side="left"
          className="text-terminal-muted hover:text-terminal-dark hover:bg-terminal-dark/10"
        >
          <PencilIcon className="size-3" />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

export const EditComposer: FC = () => {
  const t = useTranslations("assistantUi");

  return (
    <ComposerPrimitive.Root className="mb-6 flex w-full max-w-[80rem] flex-col gap-2 pl-8">
      <div className="flex flex-col gap-2 rounded-2xl bg-terminal-dark/5 p-4">
        <ComposerPrimitive.Input
          className="flex-1 resize-none bg-transparent text-sm font-mono outline-none placeholder:text-terminal-muted text-terminal-dark min-h-[60px]"
          placeholder={t("composer.editPlaceholder")}
        />
        <div className="flex items-center justify-end gap-2">
          <ComposerPrimitive.Cancel asChild>
            <Button
              variant="ghost"
              size="sm"
              className="font-mono text-xs text-terminal-muted hover:text-terminal-dark"
            >
              {t("composer.cancel")}
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button
              size="sm"
              className="font-mono text-xs bg-terminal-dark text-terminal-cream hover:bg-terminal-dark/90"
            >
              {t("composer.save")}
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};

export const AssistantMessage: FC<{ ttsEnabled?: boolean }> = ({ ttsEnabled = false }) => {
  const { character } = useCharacter();
  const displayChar = character || DEFAULT_CHARACTER;
  const lastVisibleActivityAtRef = useRef<number | null>(null);
  const lastActivityKeyRef = useRef<string>("");
  const sessionId = useChatSessionId();
  const liveStatuses = useLiveToolStatuses(sessionId);
  const [isIdleThinking, setIsIdleThinking] = useState(false);

  // Clear stale tool-group expansion state on session/thread change
  useEffect(() => {
    resetToolGroupExpansion();
  }, [sessionId]);

  const accentColor = useMemo(
    () => getAgentAccentColor(displayChar.id),
    [displayChar.id]
  );

  const assistantGradientColors = useMemo(() => buildAgentGradientColors(accentColor.hex), [accentColor.hex]);

  // Access message metadata for token usage
  // assistant-ui stores custom metadata in message.metadata.custom
  // and step-level usage in message.metadata.steps
  const message = useMessage();
  const customMetadata = message?.metadata?.custom as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } } | undefined;
  const steps = message?.metadata?.steps as Array<{ usage?: { promptTokens?: number; completionTokens?: number } }> | undefined;

  // Try custom metadata first (from our database), then fall back to step usage
  const tokenUsage = customMetadata?.usage || (steps?.length ? {
    inputTokens: steps.reduce((sum, s) => sum + (s.usage?.promptTokens || 0), 0),
    outputTokens: steps.reduce((sum, s) => sum + (s.usage?.completionTokens || 0), 0),
  } : undefined);

  const isInitialThinking = useMemo(
    () => isMessageInitiallyThinking(message?.status, message?.content),
    [message?.status, message?.content]
  );

  const visibleActivitySignature = useMemo(
    () => getVisibleActivitySignature(message?.content, liveStatuses),
    [liveStatuses, message?.content]
  );

  const isThinking = isInitialThinking || isIdleThinking;

  useEffect(() => {
    if (message?.status?.type !== "running") {
      lastVisibleActivityAtRef.current = null;
      lastActivityKeyRef.current = "";
      setIsIdleThinking(false);
      return;
    }

    if (visibleActivitySignature === lastActivityKeyRef.current) {
      return;
    }

    lastActivityKeyRef.current = visibleActivitySignature;
    lastVisibleActivityAtRef.current = Date.now();
    setIsIdleThinking(false);
  }, [message?.status, visibleActivitySignature]);

  useEffect(() => {
    if (message?.status?.type !== "running") {
      setIsIdleThinking(false);
      return;
    }

    const lastVisibleActivityAt = lastVisibleActivityAtRef.current;
    if (lastVisibleActivityAt === null || isInitialThinking) {
      setIsIdleThinking(false);
      return;
    }

    const elapsed = Date.now() - lastVisibleActivityAt;
    const remaining = SYNTHETIC_THINKING_IDLE_DELAY_MS - elapsed;

    if (remaining <= 0) {
      setIsIdleThinking(true);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsIdleThinking(
        shouldShowIdleThinking(message?.status, lastVisibleActivityAtRef.current, Date.now())
      );
    }, remaining);

    return () => window.clearTimeout(timeoutId);
  }, [isInitialThinking, message?.status, visibleActivitySignature]);

  // Extract text content from message for YouTube preview detection
  const messageText = useMemo(() => {
    const content = message?.content;
    if (!content || !Array.isArray(content)) return "";
    return content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }, [message?.content]);

  return (
    <MessagePrimitive.Root
      className="relative mb-6 flex w-full max-w-[80rem] min-w-0 gap-3 pr-8"
    >
      <Avatar className="size-8 shrink-0 shadow-sm">
        {displayChar.avatarUrl || displayChar.primaryImageUrl ? (
          <AvatarImage
            src={displayChar.avatarUrl || displayChar.primaryImageUrl || undefined}
            alt={displayChar.name}
          />
        ) : null}
        <AvatarFallback className="relative overflow-hidden">
          <GradientBackground
            colors={assistantGradientColors}
            gradientOrigin="bottom-middle"
            gradientSize="150% 150%"
            noiseIntensity={0.9}
            noisePatternAlpha={45}
            noisePatternSize={60}
            noisePatternRefreshInterval={7}
            className="rounded-full"
          />
        </AvatarFallback>
      </Avatar>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 flex-col gap-1 font-mono text-sm text-terminal-dark [overflow-wrap:anywhere]">
          {isThinking && (
            <TextShimmer
              className={cn("font-mono text-sm", isIdleThinking && "opacity-80")}
              duration={12}
              spread={3}
            >
              Thinking...
            </TextShimmer>
          )}
          <MessagePrimitive.Content
            components={{
              Text: MarkdownText,
              Reasoning: ReasoningPart,
              ToolGroup: ToolCallGroup,
              tools: {
                by_name: TOOL_BY_NAME_MAP,
                Fallback: ToolFallback,
              },
              // Defensive no-op for the mid-stream live-prompt injection frame.
              // The transport-level chunk-intercept already swallows these
              // before they reach the reducer (see BufferedAssistantChatTransport
              // in components/chat-provider.tsx), and sanitizeMessagesForInit
              // filters any that slipped into persisted rows. This third layer
              // renders nothing if one still shows up at runtime — the
              // injected message is always rendered as a separate user
              // UIMessage via setMessages, never as a part inside another row.
              data: {
                by_name: {
                  "injected-user-message": InjectedUserMessagePartNoop,
                },
              },
            }}
          />
        </div>

        {/* YouTube video preview for any YouTube URLs in the message */}
        {messageText && <YouTubeInlinePreview messageText={messageText} />}

        {/* Token usage display */}
        {(tokenUsage?.inputTokens || tokenUsage?.outputTokens) && (
          <div className="text-[10px] text-terminal-muted/60 font-mono">
            {tokenUsage.inputTokens ?? 0}↓ {tokenUsage.outputTokens ?? 0}↑
          </div>
        )}

        <BranchPicker />
        <AssistantActionBar ttsEnabled={ttsEnabled} messageText={messageText} />
      </div>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC = () => {
  const t = useTranslations("assistantUi");
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className="inline-flex items-center gap-1 text-xs text-terminal-muted font-mono"
    >
      <BranchPickerPrimitive.Previous asChild>
        <Button variant="ghost" size="icon" aria-label={t("prevBranch")} className="size-6 text-terminal-muted hover:text-terminal-dark hover:bg-terminal-dark/10">
          ←
        </Button>
      </BranchPickerPrimitive.Previous>
      <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      <BranchPickerPrimitive.Next asChild>
        <Button variant="ghost" size="icon" aria-label={t("nextBranch")} className="size-6 text-terminal-muted hover:text-terminal-dark hover:bg-terminal-dark/10">
          →
        </Button>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};

const AssistantActionBar: FC<{ ttsEnabled?: boolean; messageText?: string }> = ({
  ttsEnabled = false,
  messageText,
}) => {
  const t = useTranslations("assistantUi");
  const voiceCtx = useOptionalVoice();
  const [isSpeaking, setIsSpeaking] = useState(false);
  const audioUrlRef = useRef<string | null>(null);
  const speakableMessageText = (messageText || "").trim();
  const handleCopyClick = useCallback(() => {
    toast.success(t("toast.copied"));
  }, [t]);

  useEffect(() => {
    return () => {
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, []);

  const isPlayingCurrentMessage = Boolean(
    voiceCtx?.voice.isPlaying &&
    audioUrlRef.current &&
    voiceCtx.voice.currentAudioUrl === audioUrlRef.current
  );

  const handleSpeakClick = useCallback(async () => {
    if (!ttsEnabled || !speakableMessageText) {
      return;
    }

    if (isPlayingCurrentMessage && voiceCtx) {
      voiceCtx.stopAudio();
      return;
    }

    setIsSpeaking(true);
    voiceCtx?.setSynthesizing(true);
    try {
      const response = await fetch("/api/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: speakableMessageText }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || t("toast.synthesizeFailed"));
      }

      const audioBlob = await response.blob();
      if (!audioBlob.size) {
        throw new Error("No audio generated");
      }

      const nextAudioUrl = URL.createObjectURL(audioBlob);
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
      audioUrlRef.current = nextAudioUrl;

      if (voiceCtx) {
        voiceCtx.playAudio(nextAudioUrl);
      } else {
        const audio = new Audio(nextAudioUrl);
        void audio.play();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t("toast.synthesizeFailed");
      toast.error(errorMessage);
    } finally {
      setIsSpeaking(false);
      voiceCtx?.setSynthesizing(false);
    }
  }, [isPlayingCurrentMessage, speakableMessageText, ttsEnabled, voiceCtx]);

  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="flex gap-1"
    >
      {ttsEnabled && speakableMessageText.length > 0 && (
        <TooltipIconButton
          tooltip={isPlayingCurrentMessage ? t("tooltips.stopAudio") : t("tooltips.readAloud")}
          side="bottom"
          className="text-terminal-muted hover:text-terminal-dark hover:bg-terminal-dark/10"
          onClick={handleSpeakClick}
          disabled={isSpeaking}
        >
          {isSpeaking ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : isPlayingCurrentMessage ? (
            <CircleStopIcon className="size-3" />
          ) : (
            <Volume2Icon className="size-3" />
          )}
        </TooltipIconButton>
      )}
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton
          tooltip={t("tooltips.copy")}
          side="bottom"
          className="text-terminal-muted hover:text-terminal-dark hover:bg-terminal-dark/10"
          onClick={handleCopyClick}
        >
          <MessagePrimitive.If copied>
            <CheckIcon className="size-3" />
          </MessagePrimitive.If>
          <MessagePrimitive.If copied={false}>
            <CopyIcon className="size-3" />
          </MessagePrimitive.If>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton
          tooltip={t("tooltips.regenerate")}
          side="bottom"
          className="text-terminal-muted hover:text-terminal-dark hover:bg-terminal-dark/10"
        >
          <RefreshCwIcon className="size-3" />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
    </ActionBarPrimitive.Root>
  );
};

"use client";

import type { FC } from "react";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  ComposerPrimitive,
  useThread,
  useThreadRuntime,
  useThreadComposer,
} from "@assistant-ui/react";
import type { CompleteAttachment } from "@assistant-ui/react";
import type { JSONContent } from "@tiptap/core";
import {
  ClockIcon,
  XIcon,
  FlaskConicalIcon,
  Loader2Icon,
  CircleStopIcon,
  CheckCircleIcon,
  SparklesIcon,
  UndoIcon,
  MicIcon,
  CrosshairIcon,
} from "lucide-react";
import { resilientFetch, resilientPost } from "@/lib/utils/resilient-fetch";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useDesignWorkspaceStore } from "@/lib/design/workspace";
import {
  buildInspectMessageContext,
  formatInspectSelectionLabel,
  type InspectMessageContext,
} from "@/lib/design/workspace/inspect-context";
import { useCharacter } from "./character-context";
import { useChatLifecycleStatus } from "@/components/chat-provider";
import { useOptionalDeepResearch } from "./deep-research-context";
import { DeepResearchPanel } from "./deep-research-panel";
import { animate } from "animejs";
import { useReducedMotion } from "@/lib/animations/hooks";
import { ZLUTTY_EASINGS, ZLUTTY_DURATIONS } from "@/lib/animations/utils";
import { useTranslations } from "next-intl";
import { useTheme } from "@/components/theme/theme-provider";
import { useMCPReloadStatus } from "@/hooks/use-mcp-reload-status";
import { useSessionComposerDraft } from "@/lib/hooks/use-session-composer-draft";
import { useSessionComposerEditorState } from "@/lib/hooks/use-session-composer-editor-state";
import { ContextWindowIndicator } from "./context-window-indicator";
import { ModelSelector } from "./model-selector";
import { ActiveDelegationsIndicator } from "./active-delegations-indicator";
import FileMentionAutocomplete from "./file-mention-autocomplete";
import { ComposerAttachment } from "./thread-message-components";
import { ComposerActionBar } from "./composer-action-bar";
import { buildSimpleComposerSubmission } from "./composer-submit";
import {
  useVoiceRecording,
  usePromptEnhancement,
} from "./composer-hooks";
import { buildTranscriptInsertion } from "./voice-transcript-utils";
import { VoiceWaveform } from "@/components/voice/voice-waveform";
import { VoiceActions } from "@/components/voice/voice-actions";
import { useGlobalVoiceHotkey } from "@/lib/hooks/use-global-hotkey";
import { getElectronAPI } from "@/lib/electron/types";
import type { ChatWorkspaceMode } from "@/lib/chat/workspace-mode";
import { useScreenCapture } from "@/lib/hooks/use-screen-capture";
import { useUnifiedCapture } from "@/lib/hooks/use-unified-capture";
import { useCaptureSession } from "@/lib/hooks/use-capture-session";
import { UnifiedCaptureOverlay } from "./unified-capture-overlay";
import { AutoSendCountdown } from "./auto-send-countdown";
import {
  TiptapEditor,
  contentPartsToComposerText,
  plainTextToTiptapDoc,
  serializeDocToContentArray,
  type TiptapEditorHandle,
  type ContentPart,
} from "./tiptap-editor";
import {
  estimateTaskRewardSuggestion,
  type RewardSuggestion,
} from "@/lib/rewards/reward-calculator";

// Maximum message length — matches server-side MAX_TEXT_CONTENT_LENGTH.
// Messages exceeding this are blocked on the client before send.
const MAX_MESSAGE_LENGTH = 75_000;

// Interface for queued messages
interface QueuedMessage {
  id: string;
  content: string;
  mode: "chat" | "deep-research";
  inspectContext?: InspectMessageContext | null;
  // "queued-classic": waiting for run to end before replaying
  // "queued-live": currently being submitted to the live queue API
  // "injected-live": successfully delivered to the running model
  // "fallback": live injection failed, will replay after run ends
  status: "queued-classic" | "queued-live" | "injected-live" | "fallback";
}

type VoiceTranscriptPhase = "polishing" | "swap" | "stable";

interface ActiveVoiceTranscript {
  rawText: string;
  displayText: string;
  isEnhanced: boolean;
  phase: VoiceTranscriptPhase;
}

interface TextareaVoiceTranscriptRange {
  start: number;
  end: number;
}

function buildInspectChipLabel(element: {
  tagName: string;
  className: string;
  textContent: string;
}): string {
  return formatInspectSelectionLabel({
    tagName: element.tagName,
    textContent: element.textContent,
    classes: element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2),
  });
}

function buildUserMessageMetadata(inspectContext: InspectMessageContext | null) {
  return inspectContext ? { custom: { inspectContext } } : undefined;
}

function appendQueuedUserMessage(
  threadRuntime: ReturnType<typeof useThreadRuntime>,
  message: QueuedMessage,
): void {
  if (!threadRuntime) return;
  threadRuntime.append({
    role: "user",
    content: [{ type: "text", text: message.content }],
    metadata: buildUserMessageMetadata(message.inspectContext ?? null),
  });
}

export const Composer: FC<{
  isBackgroundTaskRunning?: boolean;
  isProcessingInBackground?: boolean;
  sessionId?: string;
  activeRunId?: string | null;
  workspaceMode?: ChatWorkspaceMode;
  onOpenDelegationSession?: (sessionId: string, delegateAgentId: string) => void | Promise<void>;
  sttEnabled?: boolean;
  voicePostProcessing?: boolean;
  voiceActionsEnabled?: boolean;
  voiceAudioCues?: boolean;
  voiceActivationMode?: "tap" | "push";
  voiceHotkey?: string;
  screenCaptureEnabled?: boolean;
  quickCaptureEnabled?: boolean;
  quickCaptureHotkey?: string;
  quickCaptureAutoSend?: boolean;
  quickCaptureAutoSendDelay?: number;
  onCancelBackgroundRun?: () => void;
  isCancellingBackgroundRun?: boolean;
  canCancelBackgroundRun?: boolean;
  isZombieBackgroundRun?: boolean;
  onLivePromptInjected?: () => void | Promise<void | boolean>;
  onPostCancel?: () => void;
  contextStatus?: import("@/lib/hooks/use-context-status").ContextStatusInfo | null;
  contextLoading?: boolean;
  onCompact?: () => Promise<{ success: boolean; compacted: boolean }>;
  isCompacting?: boolean;
}> = ({
  isBackgroundTaskRunning = false,
  isProcessingInBackground = false,
  sessionId,
  activeRunId,
  workspaceMode = "sidebar",
  onOpenDelegationSession,
  sttEnabled = false,
  voicePostProcessing = true,
  voiceActionsEnabled = true,
  voiceAudioCues = true,
  voiceActivationMode = "tap",
  voiceHotkey = "CommandOrControl+Shift+Space",
  screenCaptureEnabled = false,
  quickCaptureEnabled = true,
  quickCaptureHotkey: _quickCaptureHotkey = "CommandOrControl+Shift+A",
  quickCaptureAutoSend = false,
  quickCaptureAutoSendDelay = 3,
  onCancelBackgroundRun,
  isCancellingBackgroundRun = false,
  canCancelBackgroundRun = false,
  isZombieBackgroundRun = false,
  onLivePromptInjected,
  onPostCancel,
  contextStatus = null,
  contextLoading = false,
  onCompact,
  isCompacting = false,
}) => {
  const composerRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mentionRef = useRef<HTMLDivElement>(null);
  const tiptapRef = useRef<TiptapEditorHandle>(null);
  const prefersReducedMotion = useReducedMotion();
  const { chatBackground } = useTheme();
  const hasWallpaper = chatBackground.type !== "none";
  const simpleDraftAtRichModeEntryRef = useRef<string | null>(null);
  const rawTranscriptRef = useRef<string | null>(null);
  const textareaVoiceTranscriptRangeRef = useRef<TextareaVoiceTranscriptRange | null>(null);
  const textareaVoiceTranscriptOverlayRef = useRef<HTMLDivElement>(null);
  const textareaVoiceTranscriptHighlightRef = useRef<HTMLSpanElement>(null);
  const voiceTranscriptDecorationTimeoutRef = useRef<number | null>(null);
  const voiceCursorPositionsRef = useRef<Map<string, number>>(new Map());

  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [activeVoiceTranscript, setActiveVoiceTranscript] = useState<ActiveVoiceTranscript | null>(null);

  // Design workspace inspect state — for attaching inspect context on send
  const inspectorEnabled = useDesignWorkspaceStore((s) => s.inspectorEnabled);
  const selectedElements = useDesignWorkspaceStore((s) => s.selectedElements);
  const activeComponentId = useDesignWorkspaceStore((s) => s.activeComponentId);
  const designComponents = useDesignWorkspaceStore((s) => s.components);
  const removeSelectedElement = useDesignWorkspaceStore((s) => s.removeSelectedElement);
  const clearSelectedElements = useDesignWorkspaceStore((s) => s.clearSelectedElements);

  const inspectContext = useMemo((): InspectMessageContext | null => {
    if (!inspectorEnabled || selectedElements.length === 0) return null;
    const component = activeComponentId
      ? designComponents.find((c) => c.id === activeComponentId) ?? null
      : null;
    return buildInspectMessageContext({
      selectedElements,
      component: component ? { id: component.id, name: component.name } : null,
      sessionId,
    });
  }, [inspectorEnabled, selectedElements, activeComponentId, designComponents, sessionId]);

  // Attempt to inject a message into the currently active run's live prompt queue.
  // The server resolves the active runId from the session index — no runId needed on the client.
  //
  // Retries on ALL transient failures (409 `no_active_run`, network errors,
  // `queued:false` responses). 409 in particular is NOT terminal — the server
  // registers the queue via `reserveLivePromptQueueBySession` early in
  // /api/chat, but the HTTP request from this composer can still race that
  // reservation in a cold-start / slow-DB edge case. Retrying covers that
  // residual window.
  //
  // Backoff: base 200ms doubling, capped at 3200ms, 8 attempts
  // → sleeps [0, 200, 400, 800, 1600, 3200, 3200, 3200] = ~12.6s total
  // plus 8 × 5s request timeout budget. More than enough to cover any
  // realistic /api/chat warmup even in slow environments.
  //
  // Returns true if successfully queued, false if all retries failed.
  const queueLivePromptForActiveRun = useCallback(
    async (content: string, inspectCtx?: InspectMessageContext | null): Promise<boolean> => {
      const MAX_RETRIES = 8;
      const BASE_DELAY_MS = 200;
      const MAX_DELAY_MS = 3200;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const delay = Math.min(
            BASE_DELAY_MS * Math.pow(2, attempt - 1),
            MAX_DELAY_MS
          );
          await new Promise<void>(resolve => setTimeout(resolve, delay));
        }

        try {
          const { data, status } = await resilientPost<{ queued: boolean; reason?: string }>(
            `/api/sessions/${sessionId}/live-prompt-queue`,
            { content, ...(inspectCtx ? { inspectContext: inspectCtx } : {}) },
            { timeout: 5_000, retries: 0 }
          );

          if (data?.queued) {
            return true;
          }
          // 409 `no_active_run` or any other non-success — fall through to
          // the next retry attempt. With Fix A (early server-side
          // reservation) the server should accept injections within ms of
          // /api/chat starting; retries handle only residual races.
        } catch {
          // Network error — retry.
        }
      }

      return false;
    },
    [sessionId]
  );

  const [isCancelling, setIsCancelling] = useState(false);
  const [cursorPosition, setCursorPosition] = useState(0);

  const {
    draft: inputValue,
    setDraft: setInputValue,
    setSelection,
    restoredSelection,
    clearDraft,
  } = useSessionComposerDraft(sessionId);
  const {
    isEditorMode,
    setIsEditorMode,
    tiptapDraft,
    setTiptapDraft,
    clearTiptapDraft,
  } = useSessionComposerEditorState(sessionId);

  const updateCursorPosition = useCallback(
    (selectionStart: number, selectionEnd: number = selectionStart) => {
      setCursorPosition(selectionStart);
      setSelection(selectionStart, selectionEnd);
    },
    [setSelection]
  );

  const { character } = useCharacter();
  const isRunning = useThread((t) => t.isRunning);
  // Authoritative AI SDK stream lifecycle status. Assistant-ui's `isRunning`
  // is derived but can lag by a frame or two around abort/resume transitions;
  // the raw AI SDK status is the source of truth for gating destructive
  // reconciliation (e.g. force-reload after injection).
  const chatLifecycleStatus = useChatLifecycleStatus();
  const threadRuntime = useThreadRuntime();
  const attachmentCount = useThreadComposer((c) => c.attachments.length);
  const t = useTranslations("assistantUi");
  const tChat = useTranslations("chat");
  const { status: mcpStatus } = useMCPReloadStatus();

  const deepResearch = useOptionalDeepResearch();
  const isDeepResearchMode = deepResearch?.isDeepResearchMode ?? false;
  const isDeepResearchActive = deepResearch?.isActive ?? false;
  const electronAPI = useMemo(() => getElectronAPI(), []);
  const isScreenCaptureAvailable = screenCaptureEnabled && Boolean(electronAPI?.screenCapture);
  const isDeepResearchLoading = deepResearch?.isLoading ?? false;
  const isDeepResearchBackgroundPolling = deepResearch?.isBackgroundPolling ?? false;
  const isOperationRunning = isRunning || isDeepResearchLoading || isDeepResearchBackgroundPolling;
  // Treat an active run ID as authoritative queue-blocking state. This keeps
  // follow-ups queued while the backend run is still alive, even if the UI has
  // temporarily hidden the background banner (e.g. interactive wait states).
  const hasTrackedBackgroundRun = typeof activeRunId === "string" && activeRunId.length > 0;
  const isQueueBlocked = isOperationRunning || isBackgroundTaskRunning || hasTrackedBackgroundRun;

  // Block sending when message exceeds the server-side content limit
  const isOverMessageLimit = inputValue.length > MAX_MESSAGE_LENGTH;

  const isProcessingQueue = useRef(false);
  const isAwaitingRunStart = useRef(false);

  // Recent messages for enhancement context
  const threadMessages = useThread((th) => th.messages);
  const recentMessages = useMemo(
    () =>
      threadMessages.slice(-3).map((msg) => {
        const textContent =
          msg.content
            ?.filter(
              (part): part is { type: "text"; text: string } => part.type === "text"
            )
            .map((part) => part.text)
            .join("\n") || "";
        return { role: msg.role, content: textContent };
      }),
    [threadMessages]
  );

  // Prompt enhancement
  const {
    isEnhancing,
    enhancedContext,
    enhancementInfo,
    clearEnhancement,
    handleEnhance,
  } = usePromptEnhancement({
    inputValue,
    setInputValue,
    characterId: character?.id,
    sessionId,
    recentMessages,
  });
  const [rewardSuggestion, setRewardSuggestion] = useState<RewardSuggestion | null>(null);
  const [showRewardSuggestion, setShowRewardSuggestion] = useState(false);
  const [rewardDismissed, setRewardDismissed] = useState(false);
  const ghostScrollRef = useRef<HTMLDivElement>(null);
  const composerTextForReward = useMemo(() => {
    if (isEditorMode) {
      return contentPartsToComposerText(serializeDocToContentArray(tiptapDraft));
    }
    return inputValue.trim();
  }, [inputValue, isEditorMode, tiptapDraft]);
  const rewardReasonLabel = useMemo(() => {
    if (!rewardSuggestion) {
      return "";
    }
    return t(`composer.rewardBands.${rewardSuggestion.complexityBand}`);
  }, [rewardSuggestion, t]);

  // Ghost text string for the inline reward suggestion
  const rewardGhostText = useMemo(() => {
    if (!showRewardSuggestion || !rewardSuggestion || rewardDismissed) return "";
    return t("composer.rewardSuggestion", {
      amount: rewardSuggestion.amountLabel,
      reason: rewardReasonLabel || rewardSuggestion.reasonLabel,
    });
  }, [showRewardSuggestion, rewardSuggestion, rewardDismissed, rewardReasonLabel, t]);

  const syncRewardSuggestion = useCallback(
    (textOverride?: string) => {
      const nextText = (textOverride ?? composerTextForReward).trim();
      if (!nextText) {
        setRewardSuggestion(null);
        setShowRewardSuggestion(false);
        return;
      }

      const nextSuggestion = estimateTaskRewardSuggestion(nextText);
      setRewardSuggestion(nextSuggestion);
      setShowRewardSuggestion(Boolean(nextSuggestion));
    },
    [composerTextForReward]
  );

  useEffect(() => {
    if (!composerTextForReward.trim()) {
      setRewardSuggestion(null);
      setShowRewardSuggestion(false);
      setRewardDismissed(false); // Reset only when input is fully cleared (new message)
      return;
    }

    setShowRewardSuggestion(false);
    // Don't reset rewardDismissed here — once accepted/dismissed via Tab/Escape,
    // stay dismissed until the input is fully cleared (handled above)
    const timeoutId = window.setTimeout(() => {
      syncRewardSuggestion(composerTextForReward);
    }, 900);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [composerTextForReward, syncRewardSuggestion]);

  // Voice recording
  const { isRecordingVoice, isTranscribingVoice, isPolishingTranscript, handleVoiceInput, handleVoiceStart, handleVoiceStop, analyserNode, lastTranscriptRef, wasAiEnhancedRef, lastTranscriptionFailedRef } = useVoiceRecording({
    sttEnabled,
    voicePostProcessing,
    voiceAudioCues,
    voiceActivationMode,
    onRecordingStart: (voiceSessionId: string) => {
      // Snapshot cursor position at the moment recording starts so that when
      // the transcript arrives (possibly seconds later) we insert at the
      // original location even if the user moved the cursor in between.
      if (isEditorMode && tiptapRef.current) {
        // Store -1 as sentinel meaning "use current selection at recording time".
        // The tiptap handle's insertVoiceTranscript accepts insertAt for explicit positioning.
        voiceCursorPositionsRef.current.set(voiceSessionId, -1);
      } else {
        voiceCursorPositionsRef.current.set(voiceSessionId, cursorPosition);
      }
    },
    onTranscript: (payload) => {
      const textToInsert = payload.finalText;
      if (!textToInsert) return;

      const voiceSessionId = payload.voiceSessionId || crypto.randomUUID();
      const insertAt = voiceCursorPositionsRef.current.get(voiceSessionId);

      // Track the active voice transcript for polish phase UI indicators.
      // When post-processing is enabled, mark as "polishing" so the
      // decoration shows a shimmer effect while grammar cleanup runs.
      if (voicePostProcessing && !payload.usedPostProcessing) {
        setActiveVoiceTranscript({
          rawText: textToInsert,
          displayText: textToInsert,
          isEnhanced: false,
          phase: "polishing",
        });
      }

      // Rich text editor mode — use transaction-based insertion for proper undo/redo
      if (isEditorMode && tiptapRef.current) {
        tiptapRef.current.insertVoiceTranscript(
          textToInsert,
          voiceSessionId,
          insertAt !== undefined && insertAt !== -1 ? insertAt : undefined,
        );

        // When post-processing is disabled the decoration would never be
        // cleared because onTranscriptPolished never fires.  Clear it after
        // a brief flash so the user still sees a visual confirmation.
        if (!voicePostProcessing) {
          setTimeout(() => {
            tiptapRef.current?.clearVoiceTranscriptDecoration(voiceSessionId);
            voiceCursorPositionsRef.current.delete(voiceSessionId);
          }, 400);
        }
        return;
      }

      // Simple textarea mode — use functional updater to read latest state
      // and avoid stale closure over inputValue (which caused message loss
      // when a second transcription error wiped the composer).
      const textarea = inputRef.current;
      const selStart = textarea?.selectionStart ?? null;
      const selEnd = textarea?.selectionEnd ?? null;

      rawTranscriptRef.current = textToInsert;

      setInputValue((prev) => {
        const insertion = buildTranscriptInsertion({
          currentValue: prev,
          transcript: textToInsert,
          selectionStart: selStart,
          selectionEnd: selEnd,
        });

        if (insertion) {
          // Track the character range so the overlay knows what to highlight
          textareaVoiceTranscriptRangeRef.current = {
            start: insertion.selectionStart,
            end: insertion.selectionStart + insertion.replacementText.length,
          };
          // Schedule cursor update after render
          requestAnimationFrame(() => updateCursorPosition(insertion.nextCursor));
          return insertion.nextValue;
        }
        // Fallback: append
        const fallbackStart = prev.trim() ? prev.length + (prev.endsWith(" ") ? 0 : 1) : 0;
        const fallbackValue = !prev.trim()
          ? textToInsert
          : `${prev}${prev.endsWith(" ") ? "" : " "}${textToInsert}`;
        textareaVoiceTranscriptRangeRef.current = {
          start: fallbackStart,
          end: fallbackStart + textToInsert.length,
        };
        return fallbackValue;
      });
    },
    onTranscriptInserted: () => {
      if (isEditorMode && tiptapRef.current) {
        tiptapRef.current.focus();
        return;
      }
      requestAnimationFrame(() => {
        const textarea = inputRef.current;
        if (!textarea) return;
        textarea.focus();
        const cursor = textarea.value.length;
        textarea.setSelectionRange(cursor, cursor);
        updateCursorPosition(cursor);
      });
    },
    onTranscriptPolished: (polishedText, rawText, voiceSessionId) => {
      // Rich text editor — swap raw transcript with polished version via
      // the tracked decoration range, then transition to "swap" phase.
      if (isEditorMode && tiptapRef.current) {
        const replaced = tiptapRef.current.replaceVoiceTranscript(rawText, polishedText, voiceSessionId);
        if (replaced) {
          // Update active transcript state for any UI indicators
          setActiveVoiceTranscript((prev) =>
            prev
              ? { ...prev, displayText: polishedText, isEnhanced: true, phase: "swap" }
              : { rawText, displayText: polishedText, isEnhanced: true, phase: "swap" },
          );
          // Clear the "swap" highlight after a brief moment
          if (voiceTranscriptDecorationTimeoutRef.current) {
            window.clearTimeout(voiceTranscriptDecorationTimeoutRef.current);
          }
          voiceTranscriptDecorationTimeoutRef.current = window.setTimeout(() => {
            voiceTranscriptDecorationTimeoutRef.current = null;
            tiptapRef.current?.clearVoiceTranscriptDecoration(voiceSessionId);
            voiceCursorPositionsRef.current.delete(voiceSessionId);
            setActiveVoiceTranscript((prev) =>
              prev ? { ...prev, phase: "stable" } : null,
            );
          }, 1800);
        }
        return;
      }

      // Simple textarea mode — find and replace raw text with polished version
      setInputValue((prev) => {
        const idx = prev.lastIndexOf(rawText);
        if (idx === -1) {
          // raw text was manually edited — clear range tracking
          textareaVoiceTranscriptRangeRef.current = null;
          return prev;
        }
        // Update the tracked range to reflect polished text length
        textareaVoiceTranscriptRangeRef.current = {
          start: idx,
          end: idx + polishedText.length,
        };
        return prev.slice(0, idx) + polishedText + prev.slice(idx + rawText.length);
      });

      // Track the textarea range for overlay highlight
      setActiveVoiceTranscript({
        rawText,
        displayText: polishedText,
        isEnhanced: true,
        phase: "swap",
      });

      // Clear swap state after animation
      if (voiceTranscriptDecorationTimeoutRef.current) {
        window.clearTimeout(voiceTranscriptDecorationTimeoutRef.current);
      }
      voiceTranscriptDecorationTimeoutRef.current = window.setTimeout(() => {
        voiceTranscriptDecorationTimeoutRef.current = null;
        rawTranscriptRef.current = null;
        textareaVoiceTranscriptRangeRef.current = null;
        voiceCursorPositionsRef.current.delete(voiceSessionId);
        setActiveVoiceTranscript((prev) =>
          prev ? { ...prev, phase: "stable" } : null,
        );
      }, 1800);
    },
  });

  // Clear stale voice transcript decorations when polish completes or fails
  // without triggering onTranscriptPolished (e.g. timeout, error).
  useEffect(() => {
    if (!isPolishingTranscript && activeVoiceTranscript?.phase === "polishing") {
      // Polish ended but decoration is still in "polishing" phase — it was never
      // swapped, meaning polish failed or timed out. Clear ALL remaining decorations.
      const timeoutId = window.setTimeout(() => {
        if (isEditorMode && tiptapRef.current) {
          // No sessionId = clear all decorations across all sessions
          tiptapRef.current.clearVoiceTranscriptDecoration();
        }
        rawTranscriptRef.current = null;
        textareaVoiceTranscriptRangeRef.current = null;
        voiceCursorPositionsRef.current.clear();
        setActiveVoiceTranscript((prev) =>
          prev?.phase === "polishing" ? { ...prev, phase: "stable" } : prev,
        );
      }, 300);
      return () => window.clearTimeout(timeoutId);
    }
  }, [isPolishingTranscript, activeVoiceTranscript?.phase, isEditorMode]);

  // Global voice hotkey (Electron global shortcut + browser fallback)
  useGlobalVoiceHotkey({
    enabled: sttEnabled,
    onTrigger: () => { void handleVoiceInput(); },
    hotkey: voiceHotkey,
  });

  const handleAttachCapturedScreen = useCallback(
    async (file: File) => {
      await threadRuntime.composer.addAttachment(file);
      if (isEditorMode && tiptapRef.current) {
        tiptapRef.current.focus();
        return;
      }
      inputRef.current?.focus();
    },
    [isEditorMode, threadRuntime]
  );

  useScreenCapture({
    enabled: isScreenCaptureAvailable,
    onCaptured: handleAttachCapturedScreen,
  });

  // Capture session coordinator — manages the lifecycle:
  // capturing → recording → transcribing → reviewing → (auto-send)
  const captureSession = useCaptureSession({
    isRecordingVoice,
    isTranscribingVoice,
    lastTranscriptionFailed: lastTranscriptionFailedRef.current,
    autoSendEnabled: quickCaptureAutoSend,
    autoSendDelay: quickCaptureAutoSendDelay,
    onSend: () => { void handleSubmit(); },
    onClearAttachments: () => { threadRuntime.composer.clearAttachments(); },
  });

  // Unified capture hook — DISABLED: the mini overlay now handles all
  // Cmd+Shift+A capture flows. Keeping the hook call with enabled=false
  // so the import and plumbing remain available if needed as fallback.
  useUnifiedCapture({
    enabled: false,
    isSessionActive: captureSession.isUnifiedSession,
    onScreenshotCaptured: handleAttachCapturedScreen,
    onStartVoice: () => { void handleVoiceInput(); },
    onSessionStarted: captureSession.startSession,
    isDeepResearchMode,
  });

  // Keyboard shortcuts to focus the composer: "/" or Cmd/Ctrl+L
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const tag = active?.tagName?.toLowerCase();
      const isEditable =
        tag === "input" ||
        tag === "textarea" ||
        (active instanceof HTMLElement && active.isContentEditable);

      // Cmd/Ctrl+L — always focus composer (even from other inputs)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "l") {
        e.preventDefault();
        if (isEditorMode && tiptapRef.current) {
          tiptapRef.current.focus();
        } else {
          inputRef.current?.focus();
        }
        return;
      }

      // "/" — focus composer only when not already in an editable field and not inside a dialog
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !isEditable && !(active as HTMLElement)?.closest("[role='dialog']")) {
        e.preventDefault();
        if (isEditorMode && tiptapRef.current) {
          tiptapRef.current.focus();
        } else {
          inputRef.current?.focus();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isEditorMode]);

  // Stable refs for compose-inject handler — avoids re-registering the
  // listener on every voice/capture state change, and gives the handler
  // access to the latest values without stale closures.
  const handleVoiceStopRef = useRef(handleVoiceStop);
  handleVoiceStopRef.current = handleVoiceStop;
  const isRecordingVoiceRef = useRef(isRecordingVoice);
  isRecordingVoiceRef.current = isRecordingVoice;
  const isTranscribingVoiceRef = useRef(isTranscribingVoice);
  isTranscribingVoiceRef.current = isTranscribingVoice;
  const captureSessionRef = useRef(captureSession);
  captureSessionRef.current = captureSession;

  // Deduplication guard: ignore compose-inject events that arrive within
  // 2 seconds of a previous one (e.g. overlay dismiss delay → double trigger).
  const lastComposeInjectTimestampRef = useRef(0);

  // Overlay compose-inject: receive transcript + optional screenshot from the
  // mini-overlay (via OverlaySyncBridge → custom window event) and inject them
  // into the main window composer.
  useEffect(() => {
    const handleOverlayInject = (e: Event) => {
      const payload = (e as CustomEvent<{ transcript: string; screenshotUrl?: string }>).detail;
      if (!payload) return;

      // Dedup guard: ignore if another compose-inject arrived within the last 2s
      const now = Date.now();
      if (now - lastComposeInjectTimestampRef.current < 2000) {
        console.warn("[Composer] Ignoring duplicate compose-inject event (debounce)");
        return;
      }
      lastComposeInjectTimestampRef.current = now;

      // If the main composer has an active voice recording or transcription,
      // stop it immediately so the user doesn't see conflicting UI (duplicate
      // waveforms, "Transcribing..." spinners, etc.)
      if (isRecordingVoiceRef.current) {
        handleVoiceStopRef.current();
      }

      // If a unified capture session is active, cancel it to avoid stale
      // screenshot state and overlay UI conflicts.
      if (captureSessionRef.current.isUnifiedSession) {
        captureSessionRef.current.cancelSession();
      }

      const { transcript, screenshotUrl } = payload;

      // Inject transcript text
      if (transcript) {
        if (isEditorMode && tiptapRef.current) {
          tiptapRef.current.insertVoiceTranscript(transcript);
        } else {
          // Use functional updater to avoid stale closure over inputValue
          const textarea = inputRef.current;
          const selStart = textarea?.selectionStart ?? null;
          const selEnd = textarea?.selectionEnd ?? null;

          setInputValue((prev) => {
            const insertion = buildTranscriptInsertion({
              currentValue: prev,
              transcript,
              selectionStart: selStart,
              selectionEnd: selEnd,
            });
            if (insertion) return insertion.nextValue;
            if (!prev.trim()) return transcript;
            return `${prev}${prev.endsWith(" ") ? "" : " "}${transcript}`;
          });
        }
      }

      // Fetch and attach screenshot if provided (validate scheme first)
      const ALLOWED_SCHEMES = ["/api/", "local-media:", "http://localhost", "https://localhost"];
      if (screenshotUrl && ALLOWED_SCHEMES.some((s) => screenshotUrl.startsWith(s))) {
        void (async () => {
          try {
            const response = await fetch(screenshotUrl);
            if (!response.ok) return;
            const blob = await response.blob();
            const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
            const file = new File([blob], `overlay-capture.${ext}`, { type: blob.type, lastModified: Date.now() });
            await handleAttachCapturedScreen(file);
          } catch {
            // Non-fatal: screenshot attachment is best-effort
          }
        })();
      } else {
        // No screenshot — just focus the composer
        if (isEditorMode && tiptapRef.current) {
          tiptapRef.current.focus();
        } else {
          inputRef.current?.focus();
        }
      }
    };

    window.addEventListener("overlay:compose-inject", handleOverlayInject);
    return () => window.removeEventListener("overlay:compose-inject", handleOverlayInject);
  }, [isEditorMode, inputValue, setInputValue, handleAttachCapturedScreen]);

  // Process queued messages when AI finishes
  useEffect(() => {
    if (isAwaitingRunStart.current && isRunning) {
      isAwaitingRunStart.current = false;
    }
    if (isProcessingQueue.current && !isRunning && !isAwaitingRunStart.current) {
      isProcessingQueue.current = false;
    }

    // Only process classic or fallback chips — injected-live ones are already delivered
    const replayable = queuedMessages.filter(
      m => m.status === "queued-classic" || m.status === "fallback"
    );

    if (!isQueueBlocked && replayable.length > 0 && !isProcessingQueue.current) {
      isProcessingQueue.current = true;
      isAwaitingRunStart.current = true;

      const nextMessage = replayable[0];
      setQueuedMessages((prev) => prev.filter(m => m.id !== nextMessage.id));

      setTimeout(() => {
        if (nextMessage.mode === "deep-research" && deepResearch) {
          deepResearch.startResearch(nextMessage.content);
          return;
        }
        threadRuntime.append({
          role: "user",
          content: [{ type: "text", text: nextMessage.content }],
        });
      }, 100);
    }
  }, [isQueueBlocked, queuedMessages, threadRuntime, deepResearch]);

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      const hasText = inputValue.trim().length > 0;
      const hasAttachments = attachmentCount > 0;
      if (!hasText && !hasAttachments) return;

      if (inputValue.length > MAX_MESSAGE_LENGTH) {
        toast.error(`Message too long (${inputValue.length.toLocaleString()} / ${MAX_MESSAGE_LENGTH.toLocaleString()} chars)`);
        return;
      }

      if (isDeepResearchMode && deepResearch && hasText && !isQueueBlocked) {
        deepResearch.startResearch(inputValue.trim());
        clearDraft();
        updateCursorPosition(0);
        return;
      }

      // Auto-learn from voice corrections: if user edited a voice transcript before sending,
      // submit the diff to the learn endpoint (fire-and-forget)
      const rawTranscript = lastTranscriptRef.current;
      if (rawTranscript && hasText && rawTranscript !== inputValue.trim()) {
        void fetch("/api/voice/learn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ originalText: rawTranscript, editedText: inputValue.trim() }),
        }).catch(() => {});
      }
      // Always clear transcript refs on send — bar disappears after message is sent
      lastTranscriptRef.current = null;
      wasAiEnhancedRef.current = false;

      const expandedMessage = buildSimpleComposerSubmission({
        inputValue,
        enhancedContext,
        captureMetadata: captureSession.isUnifiedSession ? captureSession.metadata : null,
      });

      if (isQueueBlocked) {
        if (hasText) {
          const msgId = `queued-${Date.now()}`;

          if (sessionId && !isDeepResearchMode) {
            // Live injection path: server resolves the active runId from the session index
            setQueuedMessages(prev => [...prev, {
              id: msgId,
              content: expandedMessage,
              mode: "chat",
              inspectContext,
              status: "queued-live",
            }]);

            // Fire injection in the background; chip lifecycle driven by result
            void queueLivePromptForActiveRun(expandedMessage, inspectContext).then(injected => {
              if (injected) {
                // Successfully delivered — show brief confirmation then remove chip
                setQueuedMessages(prev =>
                  prev.map(m => m.id === msgId ? { ...m, status: "injected-live" as const } : m)
                );
                // NOTE: We intentionally do NOT call onLivePromptInjected here.
                // Calling refreshMessages mid-stream with remount:true would destroy
                // ChatProvider and kill the SSE connection. The injected message is
                // saved at the correct ordering position in prepareStep and will appear
                // when the run finishes naturally via the post-run effect below.
              } else {
                // No active run — fall back to classic replay after run
                setQueuedMessages(prev =>
                  prev.map(m => m.id === msgId ? { ...m, status: "fallback" as const } : m)
                );
              }
            });
          } else {
            // Classic queue: replay when run ends
            setQueuedMessages(prev => [...prev, {
              id: msgId,
              content: expandedMessage,
              mode: isDeepResearchMode ? "deep-research" : "chat",
              inspectContext,
              status: "queued-classic",
            }]);
          }
        }
        clearDraft();
        updateCursorPosition(0);
        clearEnhancement();
        if (hasAttachments) threadRuntime.composer.clearAttachments();
        // End unified capture session after queuing (metadata consumed, no attachment clear)
        if (captureSession.isUnifiedSession) {
          captureSession.endSession();
        }
        // Clear inspect selections after queuing
        if (inspectContext) clearSelectedElements();
      } else {
        if (inspectContext) {
          // Use threadRuntime.append() to include inspect metadata (composer.send() doesn't support metadata)
          const composerAttachments = (threadRuntime.composer.getState().attachments ?? []).filter(
            (a): a is CompleteAttachment =>
              a.status.type === "complete" || a.status.type === "requires-action",
          );
          threadRuntime.append({
            role: "user",
            content: [{ type: "text", text: expandedMessage }],
            attachments: composerAttachments,
            metadata: buildUserMessageMetadata(inspectContext),
          });
          if (hasAttachments) threadRuntime.composer.clearAttachments();
          clearSelectedElements();
        } else {
          threadRuntime.composer.setText(expandedMessage);
          threadRuntime.composer.send();
          // Belt-and-suspenders: send() clears attachments internally via
          // _emptyTextAndAttachments(), but clear explicitly to match the
          // Tiptap path and guard against future runtime changes.
          if (hasAttachments) threadRuntime.composer.clearAttachments();
        }
        clearDraft();
        updateCursorPosition(0);
        clearEnhancement();
        if (captureSession.isUnifiedSession) {
          captureSession.endSession();
        }
      }
    },
    [
      inputValue,
      isQueueBlocked,
      threadRuntime,
      attachmentCount,
      isDeepResearchMode,
      deepResearch,
      enhancedContext,
      clearDraft,
      updateCursorPosition,
      clearEnhancement,
      lastTranscriptRef,
      wasAiEnhancedRef,
      captureSession,
      inspectContext,
      clearSelectedElements,
    ]
  );

  // -----------------------------------------------------------------------
  // Tiptap editor submit — Path B: preserve composer attachment serialization
  // -----------------------------------------------------------------------
  const handleEditorSubmit = useCallback(
    async (contentParts: ContentPart[]) => {
      const inlineImageParts = contentParts.filter(
        (part): part is ContentPart & { type: "image"; image: string } =>
          part.type === "image" && typeof part.image === "string",
      );
      const rawComposerAttachments = threadRuntime.composer.getState().attachments ?? [];
      // Accept both "complete" and "requires-action" (upload finished, pending send finalization).
      // The rich editor path uses threadRuntime.append() directly instead of composer.send(),
      // so attachments never go through attachmentAdapter.send() which transitions to "complete".
      // Only block on "running" (actively uploading) attachments.
      const composerAttachments = rawComposerAttachments.filter(
        (attachment): attachment is CompleteAttachment =>
          attachment.status.type === "complete" || attachment.status.type === "requires-action",
      );
      if (contentParts.length === 0 && attachmentCount === 0 && inlineImageParts.length === 0) return;

      const textOnly = contentParts
        .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim();

      // Deep research mode only accepts text.
      if (isDeepResearchMode && deepResearch && !isQueueBlocked) {
        if (textOnly) {
          deepResearch.startResearch(textOnly);
        }
        tiptapRef.current?.clear();
        clearTiptapDraft();
        if (captureSession.isUnifiedSession) captureSession.endSession();
        return;
      }

      if (isQueueBlocked) {
        if (textOnly) {
          const msgId = `queued-${Date.now()}`;
          setQueuedMessages((prev) => [
            ...prev,
            {
              id: msgId,
              content: textOnly.slice(0, 100),
              mode: isDeepResearchMode ? "deep-research" : "chat",
              status: "queued-classic",
            },
          ]);
        }
        tiptapRef.current?.clear();
        clearTiptapDraft();
        if (attachmentCount > 0) {
          threadRuntime.composer.clearAttachments();
        }
        if (captureSession.isUnifiedSession) captureSession.endSession();
        return;
      }

      const composerText = contentPartsToComposerText(contentParts).trim();
      if (!composerText && composerAttachments.length === 0 && inlineImageParts.length === 0) {
        return;
      }
      if (composerAttachments.length !== rawComposerAttachments.length) {
        toast.error("Wait for attachments to finish uploading before sending.");
        return;
      }

      // Prepend screen capture context if metadata is available from a unified session
      let finalComposerText = composerText;
      if (captureSession.isUnifiedSession && captureSession.metadata) {
        const meta = captureSession.metadata;
        const contextParts: string[] = [];
        if (meta.activeAppName && meta.activeWindowTitle) {
          contextParts.push(`[Screen Context: ${meta.activeAppName} — ${meta.activeWindowTitle}]`);
        } else if (meta.activeWindowTitle) {
          contextParts.push(`[Screen Context: ${meta.activeWindowTitle}]`);
        }
        if (meta.browserUrl) {
          contextParts.push(`[URL: ${meta.browserUrl}]`);
        }
        if (contextParts.length > 0) {
          finalComposerText = contextParts.join("\n") + "\n\n" + finalComposerText;
        }
      }

      const inlineAttachments = inlineImageParts.map((part, index) => ({
        id: `tiptap-inline-${Date.now()}-${index}`,
        type: "image" as const,
        name: `inline-image-${index + 1}`,
        contentType: part.contentType ?? "image/*",
        content: [{ type: "image" as const, image: part.image }],
        status: { type: "complete" as const },
        metadata: {
          url: part.image,
          localPath: part.localPath,
          filePath: part.filePath,
          contentType: part.contentType,
          size: part.size,
          kind: part.kind ?? "image",
        },
      }));

      threadRuntime.append({
        role: "user",
        content: finalComposerText ? [{ type: "text", text: finalComposerText }] : [],
        attachments: [...composerAttachments, ...inlineAttachments],
        metadata: buildUserMessageMetadata(inspectContext),
      });

      tiptapRef.current?.clear();
      clearTiptapDraft();
      clearEnhancement();
      if (composerAttachments.length > 0) {
        threadRuntime.composer.clearAttachments();
      }
      // End unified capture session after send (don't clear attachments — already sent)
      if (captureSession.isUnifiedSession) captureSession.endSession();
      if (inspectContext) clearSelectedElements();
    },
    [
      attachmentCount,
      captureSession,
      clearEnhancement,
      clearTiptapDraft,
      deepResearch,
      isDeepResearchMode,
      isQueueBlocked,
      t,
      threadRuntime,
      inspectContext,
      clearSelectedElements,
    ]
  );

  const toggleEditorMode = useCallback(() => {
    if (!isEditorMode) {
      if (!tiptapDraft) {
        const seededDoc = plainTextToTiptapDoc(inputValue);
        if (seededDoc) {
          setTiptapDraft(seededDoc);
        }
      }

      simpleDraftAtRichModeEntryRef.current = inputValue;
      setIsEditorMode(true);
      return;
    }

    const composerTextFromRichEditor = contentPartsToComposerText(
      tiptapRef.current?.getContentArray() ?? [],
    );
    const draftAtEntry = simpleDraftAtRichModeEntryRef.current;
    const canOverwriteSimpleDraft =
      inputValue.trim().length === 0 ||
      draftAtEntry === null ||
      inputValue === draftAtEntry;

    if (composerTextFromRichEditor && canOverwriteSimpleDraft) {
      setInputValue(composerTextFromRichEditor);
      updateCursorPosition(composerTextFromRichEditor.length);
    }

    simpleDraftAtRichModeEntryRef.current = null;
    setIsEditorMode(false);
  }, [
    inputValue,
    isEditorMode,
    setInputValue,
    setIsEditorMode,
    setTiptapDraft,
    tiptapDraft,
    updateCursorPosition,
  ]);

  const handleTiptapDraftChange = useCallback(
    (nextDraft: JSONContent | null) => {
      setTiptapDraft(nextDraft);
      // Cancel auto-send countdown when user edits in Tiptap (matches textarea behavior)
      if (captureSession.countdownRemaining > 0) {
        captureSession.cancelAutoSend();
      }
    },
    [setTiptapDraft, captureSession],
  );

  const handleClearTiptapDraft = useCallback(() => {
    clearTiptapDraft();
  }, [clearTiptapDraft]);

  const handleInsertMention = useCallback(
    (mention: string, atIndex: number, queryLength: number) => {
      const before = inputValue.slice(0, atIndex);
      const after = inputValue.slice(atIndex + 1 + queryLength);
      const newValue = `${before}@${mention} ${after}`;
      setInputValue(newValue);
      const newCursor = atIndex + mention.length + 2;
      updateCursorPosition(newCursor);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.setSelectionRange(newCursor, newCursor);
        }
      });
    },
    [inputValue, updateCursorPosition]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (mentionRef.current) {
        const handler = (
          mentionRef.current as unknown as {
            handleKeyDown?: (e: React.KeyboardEvent) => boolean;
          }
        ).handleKeyDown;
        if (handler && handler(e)) return;
      }

      // Tab → accept reward ghost text
      if (e.key === "Tab" && rewardGhostText) {
        e.preventDefault();
        const suffix = `\n${rewardGhostText}`;
        setInputValue((prev) => prev + suffix);
        setRewardDismissed(true);
        return;
      }

      // Escape → dismiss reward ghost text
      if (e.key === "Escape" && rewardGhostText) {
        e.preventDefault();
        setRewardDismissed(true);
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, rewardGhostText, setInputValue]
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;

          const MAX_SIZE = 10 * 1024 * 1024;
          if (file.size > MAX_SIZE) {
            toast.error(t("composer.fileTooLarge", { size: Math.round(file.size / 1024 / 1024), max: 10 }));
            return;
          }
          try {
            await threadRuntime.composer.addAttachment(file);
            toast.success(t("composer.imagePasted"));
          } catch (error) {
            console.error("[Composer] Failed to paste image:", error);
            toast.error(t("composer.pasteError"));
          }
          return;
        }
      }

      // Auto-wrap multi-line pastes in code fences for clean display in chat bubbles.
      const pastedText = e.clipboardData.getData("text/plain");
      if (pastedText && pastedText.includes("\n")) {
        const nonEmptyLines = pastedText.split("\n").filter((l) => l.trim() !== "");
        if (nonEmptyLines.length >= 2) {
          e.preventDefault();
          const fenced = "```\n" + pastedText.trimEnd() + "\n```";
          const start = inputRef.current?.selectionStart ?? inputValue.length;
          const end = inputRef.current?.selectionEnd ?? start;
          setInputValue((v) => v.slice(0, start) + fenced + v.slice(end));
          return;
        }
      }
    },
    [threadRuntime, t, inputValue]
  );

  const removeFromQueue = useCallback((id: string) => {
    setQueuedMessages((prev) => prev.filter((msg) => msg.id !== id));
  }, []);

  const cancelForegroundRunOnServer = useCallback(async () => {
    if (!sessionId) return;

    const { data, error } = await resilientFetch<{ hasActiveRun?: boolean; runId?: string | null }>(
      `/api/sessions/${sessionId}/active-run`,
      { retries: 0, timeout: 5000 },
    );

    if (error || !data?.hasActiveRun || !data.runId) {
      if (error) {
        console.warn("[Composer] Failed to resolve active foreground run for cancellation:", error);
      }
      return;
    }

    const cancelResult = await resilientPost<{ cancelled?: boolean }>(
      `/api/agent-runs/${data.runId}/cancel`,
      {},
      { retries: 0, timeout: 5000 },
    );

    // 404/409 are effectively terminal from the UI perspective (already ended / already cancelled).
    if (cancelResult.error && cancelResult.status !== 404 && cancelResult.status !== 409) {
      console.warn("[Composer] Failed to cancel foreground run on server:", cancelResult.error);
    }
  }, [sessionId]);

  const handleCancel = useCallback(() => {
    if (!isOperationRunning || isCancelling) return;
    setIsCancelling(true);
    if (isRunning) {
      void cancelForegroundRunOnServer();
      try { threadRuntime.cancelRun(); } catch { /* pre-init abort — no-op */ }
    }
    if (deepResearch && (isDeepResearchActive || isDeepResearchLoading)) {
      deepResearch.cancelResearch();
    }
  }, [
    cancelForegroundRunOnServer,
    deepResearch,
    isCancelling,
    isDeepResearchActive,
    isDeepResearchLoading,
    isOperationRunning,
    isRunning,
    threadRuntime,
  ]);

  // When the operation stops after a cancel, refresh messages from DB to
  // restore any messages the AI SDK discarded from its optimistic state
  // (e.g. user pressed Stop very quickly after sending).
  const wasCancellingRef = useRef(false);
  useEffect(() => {
    if (isCancelling) {
      wasCancellingRef.current = true;
    }
    if (!isOperationRunning) {
      const wasCancelling = wasCancellingRef.current;
      setIsCancelling(false);
      wasCancellingRef.current = false;
      if (wasCancelling && onPostCancel) {
        setTimeout(onPostCancel, 500);
      }
    }
  }, [isOperationRunning, isCancelling, onPostCancel]);

  // When the run ends: reload messages and determine whether injected-live chips
  // were processed by prepareStep (normal injection) or not (undrained — run ended
  // before the queue was drained). Processed chips are cleared; unprocessed chips
  // are converted to "fallback" so the replayable mechanism sends them as a new run.
  useEffect(() => {
    if (isQueueBlocked) return;
    // Defense-in-depth: the AI SDK's own status must be "ready" or "error"
    // before we trigger a force-reload. `isRunning` (→ `isQueueBlocked`) is a
    // derived value inside assistant-ui and can briefly be false during the
    // transition between in-flight steps when the transport is still
    // streaming (e.g. post-injection, before the next step emits chunks).
    // Force-reloading in that window tears down ChatProvider and kills the
    // SSE connection — exactly the mid-stream render regression this fix
    // exists to prevent. The chunk-intercept in BufferedAssistantChatTransport
    // already renders the injected row inline, so we can safely defer the
    // reconcile to the natural post-run settle.
    if (
      chatLifecycleStatus === "streaming" ||
      chatLifecycleStatus === "submitted"
    ) {
      return;
    }
    const hasInjected = queuedMessages.some(m => m.status === "injected-live");
    if (hasInjected && onLivePromptInjected) {
      void Promise.resolve(onLivePromptInjected()).then((result) => {
        const hasUndrained = result === true;
        if (hasUndrained) {
          // Server signals undrained messages — convert chips to fallback for replay.
          setQueuedMessages(prev => {
            let didChange = false;
            const next = prev.map(m => {
              if (m.status !== "injected-live") {
                return m;
              }
              didChange = true;
              return { ...m, status: "fallback" as const };
            });
            return didChange ? next : prev;
          });
        } else {
          // Messages were processed by prepareStep — clear the chips.
          setQueuedMessages(prev => {
            const next = prev.filter(m => m.status !== "injected-live");
            return next.length === prev.length ? prev : next;
          });
        }
      });
      return;
    }

    setQueuedMessages(prev => {
      const next = prev.filter(m => m.status !== "injected-live");
      return next.length === prev.length ? prev : next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isQueueBlocked, queuedMessages, onLivePromptInjected, chatLifecycleStatus]);

  // Auto-grow textarea
  const adjustTextareaHeight = useCallback(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const lineHeight = 24;
    const newHeight = Math.min(Math.max(textarea.scrollHeight, lineHeight * 1.5), lineHeight * 8);
    textarea.style.height = `${newHeight}px`;
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [inputValue, adjustTextareaHeight]);

  // Restore cursor selection after draft hydration
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const { selectionStart, selectionEnd } = restoredSelection;
    if (selectionStart === null || selectionEnd === null) return;

    const maxPosition = textarea.value.length;
    const start = Math.max(0, Math.min(selectionStart, maxPosition));
    const end = Math.max(start, Math.min(selectionEnd, maxPosition));
    requestAnimationFrame(() => {
      textarea.setSelectionRange(start, end);
      updateCursorPosition(start, end);
    });
  }, [restoredSelection, updateCursorPosition]);

  const handleFocus = () => {
    if (!composerRef.current || prefersReducedMotion) return;
    animate(composerRef.current, {
      scale: [1, 1.01, 1],
      duration: ZLUTTY_DURATIONS.fast,
      ease: ZLUTTY_EASINGS.smooth,
    });
  };

  const getPlaceholder = () => {
    if (isDeepResearchMode) return t("composer.placeholderResearch");
    if (isRunning) return t("composer.placeholderQueue");
    if (mcpStatus.isReloading) return t("composer.placeholderInitializing");
    return t("composer.placeholderDefault");
  };

  const getStatusMessage = () => {
    if (mcpStatus.isReloading) return `Initializing tools... ${mcpStatus.progress.toFixed(0)}%`;
    if (isDeepResearchLoading) return "Researching...";
    if (isRunning) return "Responding...";
    return null;
  };

  const statusMessage = getStatusMessage();
  const shouldShowDeepResearchPanel = Boolean(
    deepResearch
    && (
      isDeepResearchActive
      || isDeepResearchLoading
      || isDeepResearchBackgroundPolling
      || deepResearch.phase === "error"
    )
  );
  const isBackgroundProcessingVisible = isProcessingInBackground || isDeepResearchBackgroundPolling;

  return (
    <div className="relative w-full">
      {/* Deep Research Panel - includes active and resumed background states */}
      {deepResearch && shouldShowDeepResearchPanel && (
        <DeepResearchPanel
          phase={deepResearch.phase}
          phaseMessage={deepResearch.phaseMessage}
          progress={deepResearch.progress}
          findings={deepResearch.findings}
          finalReport={deepResearch.finalReport}
          error={deepResearch.error}
          onCancel={handleCancel}
          onReset={deepResearch.reset}
        />
      )}

      {/* Background Processing Indicator - compact inline version */}
      {isBackgroundProcessingVisible && (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-terminal-green/30 bg-terminal-green/5 px-3 py-2">
          <div className="flex items-center gap-2 flex-1">
            <div className="flex gap-1">
              <span className="size-1.5 rounded-full bg-terminal-green animate-dot-pulse" />
              <span className="size-1.5 rounded-full bg-terminal-green animate-dot-pulse-delay-1" />
              <span className="size-1.5 rounded-full bg-terminal-green animate-dot-pulse-delay-2" />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono font-medium text-terminal-dark">
                {tChat("processingInBackground")}
              </span>
              <span className="text-[11px] font-mono text-terminal-muted">
                {isZombieBackgroundRun ? tChat("backgroundRun.zombieHint") : tChat("processingInBackgroundHint")}
              </span>
            </div>
          </div>
          {onCancelBackgroundRun && canCancelBackgroundRun && (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 px-2 text-xs font-mono shrink-0"
              onClick={onCancelBackgroundRun}
              disabled={isCancellingBackgroundRun || !canCancelBackgroundRun}
            >
              {isCancellingBackgroundRun ? (
                <><Loader2Icon className="mr-1.5 h-3 w-3 animate-spin" />{tChat("backgroundRun.stopping")}</>
              ) : (
                <><CircleStopIcon className="mr-1.5 h-3 w-3" />{isZombieBackgroundRun ? tChat("backgroundRun.forceStop") : tChat("backgroundRun.stop")}</>
              )}
            </Button>
          )}
        </div>
      )}

      {/* Queued messages */}
      {queuedMessages.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          <div className="text-xs text-terminal-muted font-mono flex items-center gap-1">
            <ClockIcon className="size-3" />
            {queuedMessages.every(m => m.status === "injected-live")
              ? t("queue.messagesInjected", { count: queuedMessages.length })
              : t("queue.messagesQueued", { count: queuedMessages.length })}
          </div>
          {isBackgroundTaskRunning && !queuedMessages.every(m => m.status === "injected-live") && (
            <div className="text-[11px] text-terminal-muted/80 font-mono">{t("queue.backgroundHint")}</div>
          )}
          <div className="flex flex-wrap gap-1">
            {queuedMessages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-1 text-xs font-mono",
                  msg.status === "injected-live"
                    ? "bg-terminal-dark/10 text-terminal-muted border border-terminal-dark/20"
                    : msg.status === "queued-live"
                    ? "bg-yellow-50/30 text-yellow-700 border border-yellow-300/40"
                    : msg.status === "fallback"
                    ? "bg-orange-50/30 text-orange-700 border border-orange-300/40"
                    : "bg-terminal-dark/10 text-terminal-dark"
                )}
              >
                {msg.status === "injected-live" && (
                  <CheckCircleIcon className="size-3 shrink-0 text-terminal-muted" />
                )}
                {msg.status === "queued-live" && (
                  <Loader2Icon className="size-3 shrink-0 animate-spin" />
                )}
                <span className="max-w-32 truncate">{msg.content}</span>
                {msg.status !== "injected-live" && msg.status !== "queued-live" && (
                  <button onClick={() => removeFromQueue(msg.id)} className="text-terminal-muted hover:text-red-500 transition-colors">
                    <XIcon className="size-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <FileMentionAutocomplete
        ref={mentionRef}
        characterId={character?.id ?? null}
        inputValue={inputValue}
        cursorPosition={cursorPosition}
        onInsertMention={handleInsertMention}
      />

      <ComposerPrimitive.Root
        ref={composerRef}
        className={cn(
          "relative flex w-full flex-col rounded-lg shadow-md transition-shadow focus-within:shadow-lg transform-gpu",
          isDeepResearchMode
            ? "bg-purple-50/80 focus-within:bg-purple-50 border border-purple-200 dark:bg-purple-950/50 dark:focus-within:bg-purple-950/60 dark:border-purple-800"
            : hasWallpaper ? "bg-terminal-cream/50 backdrop-blur-sm focus-within:bg-terminal-cream/60" : "bg-terminal-cream/80 focus-within:bg-terminal-cream"
        )}
        onFocus={handleFocus}
      >
        {statusMessage && (
          <div className="flex items-center gap-2 px-4 py-2 text-xs font-mono text-terminal-muted border-b border-terminal-dark/10">
            <Loader2Icon className="size-3 animate-spin flex-shrink-0" />
            <span>{statusMessage}</span>
            {mcpStatus.isReloading && mcpStatus.estimatedTimeRemaining > 0 && (
              <span className="text-terminal-muted/70">
                (~{Math.ceil(mcpStatus.estimatedTimeRemaining / 1000)}s remaining)
              </span>
            )}
          </div>
        )}

        {isDeepResearchMode && (
          <div className="flex items-center gap-2 px-4 pt-2 text-xs font-mono text-purple-600 dark:text-purple-400">
            <FlaskConicalIcon className="size-3" />
            {t("deepResearch.modeLabel")}
          </div>
        )}

        <div className="flex flex-wrap gap-2 p-2 empty:hidden">
          <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachment }} />
        </div>

        {/* Inspect context chips — show selected design elements */}
        {inspectorEnabled && selectedElements.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 px-3 py-1.5 border-b border-terminal-dark/10">
            <CrosshairIcon className="size-3 text-blue-500 shrink-0" />
            <span className="text-[11px] font-mono text-muted-foreground mr-1">Inspect:</span>
            {selectedElements.map((el) => (
              <span
                key={el.selector}
                className="inline-flex items-center gap-0.5 rounded bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 px-1.5 py-0.5 text-[11px] font-mono text-blue-700 dark:text-blue-300"
              >
                {buildInspectChipLabel(el)}
                <button
                  type="button"
                  onClick={() => removeSelectedElement(el.selector)}
                  className="ml-0.5 text-blue-400 hover:text-red-500 transition-colors"
                  aria-label={`Remove ${el.tagName} from selection`}
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            ))}
            {selectedElements.length > 1 && (
              <button
                type="button"
                onClick={clearSelectedElements}
                className="text-[11px] font-mono text-muted-foreground hover:text-red-500 transition-colors ml-1"
              >
                Clear all
              </button>
            )}
          </div>
        )}

{/* Reward suggestion is shown as inline ghost text in the textarea */}

        {/* Unified capture overlay — replaces standalone waveform during unified sessions */}
        {captureSession.isUnifiedSession && captureSession.phase !== "idle" ? (
          <>
            <UnifiedCaptureOverlay
              phase={captureSession.phase}
              screenshotUrl={captureSession.screenshotUrl}
              isRecording={isRecordingVoice}
              analyserNode={analyserNode}
              onCancel={() => {
                captureSession.cancelSession();
                if (isRecordingVoice) handleVoiceStop();
              }}
              onStopRecording={() => {
                captureSession.stopAndSend();
                handleVoiceStop();
              }}
              className="border-b border-terminal-dark/10"
            />
            {captureSession.phase === "reviewing" && captureSession.countdownRemaining > 0 && (
              <AutoSendCountdown
                remaining={captureSession.countdownRemaining}
                total={quickCaptureAutoSendDelay}
                onCancel={captureSession.cancelAutoSend}
                onSendNow={() => {
                  captureSession.cancelAutoSend();
                  void handleSubmit();
                }}
              />
            )}
          </>
        ) : (
          <>
            {isRecordingVoice && (
              <VoiceWaveform
                isRecording={isRecordingVoice}
                analyserNode={analyserNode}
                className="border-b border-terminal-dark/10"
              />
            )}
          </>
        )}

        {!isRecordingVoice && !isTranscribingVoice && sttEnabled && voiceActionsEnabled && inputValue.trim().length > 0 && (
          <VoiceActions
            text={inputValue}
            sessionId={sessionId}
            onResult={(text) => {
              setInputValue(text);
            }}
            className="px-3 py-1.5 border-b border-terminal-dark/10"
          />
        )}

        {/* I7: Transcribing state indicator — only shown outside unified sessions */}
        {!captureSession.isUnifiedSession && isTranscribingVoice && (
          <div className="flex items-center gap-2 px-4 py-2 text-xs font-mono text-terminal-muted border-b border-terminal-dark/10">
            <Loader2Icon className="size-3 animate-spin flex-shrink-0" />
            <span>Transcribing...</span>
          </div>
        )}

        {/* I5: Voice transcript indicator — always visible when a transcript is stored */}
        {!isRecordingVoice && !isTranscribingVoice && lastTranscriptRef.current && (
          <div className="flex items-center gap-1.5 px-3 py-1 border-b border-terminal-dark/10">
            {wasAiEnhancedRef.current && lastTranscriptRef.current !== inputValue.trim() ? (
              <>
                <SparklesIcon className="size-3 text-amber-500" />
                <span className="text-[10px] font-mono text-terminal-muted">AI-cleaned</span>
              </>
            ) : (
              <>
                <MicIcon className="size-3 text-terminal-muted" />
                <span className="text-[10px] font-mono text-terminal-muted">Voice transcript</span>
              </>
            )}
            <button
              type="button"
              disabled={lastTranscriptRef.current === inputValue.trim()}
              onClick={() => {
                if (lastTranscriptRef.current) {
                  setInputValue(lastTranscriptRef.current);
                }
              }}
              className="flex items-center gap-0.5 text-[10px] font-mono text-terminal-muted hover:text-terminal-dark transition-colors ml-1 disabled:opacity-30 disabled:cursor-default disabled:hover:text-terminal-muted"
            >
              <UndoIcon className="size-3" />
              Restore
            </button>
          </div>
        )}

        {isEditorMode ? (
          /* ---- Tiptap rich editor mode ---- */
          <div className="flex flex-col">
            <TiptapEditor
              ref={tiptapRef}
              onSubmit={handleEditorSubmit}
              sessionId={sessionId}
              placeholder={getPlaceholder()}
              disabled={isDeepResearchLoading}
              isSubmitting={false}
              initialContent={tiptapDraft}
              onDraftChange={handleTiptapDraftChange}
              onDraftClear={handleClearTiptapDraft}
            />
            <div className="flex items-center justify-end">
              <ComposerActionBar
                isOperationRunning={isOperationRunning}
                isCancelling={isCancelling}
                isQueueBlocked={isQueueBlocked}
                isRunning={isRunning}
                isDeepResearchMode={isDeepResearchMode}
                isDeepResearchActive={isDeepResearchActive}
                isDeepResearchLoading={isDeepResearchLoading}
                mcpIsReloading={mcpStatus.isReloading}
                mcpEstimatedTimeRemaining={mcpStatus.estimatedTimeRemaining}
                onToggleDeepResearch={deepResearch?.toggleDeepResearchMode}
                sttEnabled={sttEnabled}
                isRecordingVoice={isRecordingVoice}
                isTranscribingVoice={isTranscribingVoice}
                onVoiceInput={handleVoiceInput}
                voiceActivationMode={voiceActivationMode}
                onVoiceStart={handleVoiceStart}
                onVoiceStop={handleVoiceStop}
                inputHasText={tiptapRef.current?.hasContent() ?? false}
                attachmentCount={attachmentCount}
                showEnhanceButton={false}
                isEnhancing={false}
                enhancedContext={null}
                enhancementFilesFound={0}
                onEnhance={handleEnhance}
                isEditorMode={isEditorMode}
                onToggleEditorMode={toggleEditorMode}
                isOverMessageLimit={isOverMessageLimit}
                onCancel={handleCancel}
                onSubmit={() => {
                  const parts = tiptapRef.current?.getContentArray();
                  if (parts?.length) handleEditorSubmit(parts);
                }}
              />
            </div>
          </div>
        ) : (
          /* ---- Simple textarea mode (default) ---- */
          <div className="flex items-end">
            <div className="relative flex-1">
              <textarea
                ref={inputRef}
                value={inputValue}
                onChange={(e) => {
                  setInputValue(e.target.value);
                  updateCursorPosition(e.target.selectionStart ?? 0, e.target.selectionEnd ?? e.target.selectionStart ?? 0);
                  if (captureSession.countdownRemaining > 0) {
                    captureSession.cancelAutoSend();
                  }
                  if (enhancedContext || enhancementInfo) clearEnhancement();
                  // User manually edited text — dismiss voice transcript overlay
                  if (activeVoiceTranscript && activeVoiceTranscript.phase !== "stable") {
                    rawTranscriptRef.current = null;
                    textareaVoiceTranscriptRangeRef.current = null;
                    setActiveVoiceTranscript(null);
                    if (voiceTranscriptDecorationTimeoutRef.current) {
                      window.clearTimeout(voiceTranscriptDecorationTimeoutRef.current);
                      voiceTranscriptDecorationTimeoutRef.current = null;
                    }
                  }
                }}
                onSelect={(e) => {
                  const textarea = e.target as HTMLTextAreaElement;
                  updateCursorPosition(textarea.selectionStart ?? 0, textarea.selectionEnd ?? textarea.selectionStart ?? 0);
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onBlur={() => syncRewardSuggestion()}
                onScroll={() => {
                  if (inputRef.current) {
                    const st = inputRef.current.scrollTop;
                    if (ghostScrollRef.current) ghostScrollRef.current.scrollTop = st;
                    if (textareaVoiceTranscriptOverlayRef.current) textareaVoiceTranscriptOverlayRef.current.scrollTop = st;
                  }
                }}
                autoFocus
                placeholder={getPlaceholder()}
                rows={1}
                className="w-full resize-none bg-transparent p-4 text-sm font-mono outline-none placeholder:text-terminal-muted text-terminal-dark overflow-y-auto transition-[height] duration-150 ease-out"
                style={{ minHeight: "36px", maxHeight: "192px" }}
              />
              {/* Ghost text overlay for reward suggestion */}
              {rewardGhostText && inputValue.trim() && (
                <div
                  ref={ghostScrollRef}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 overflow-hidden p-4 text-sm font-mono whitespace-pre-wrap break-words"
                  style={{ minHeight: "36px", maxHeight: "192px" }}
                >
                  {/* Invisible mirror of real text to position ghost suffix */}
                  <span className="invisible">{inputValue}</span>
                  <span className="text-terminal-muted/50 select-none">{`\n${rewardGhostText}`}</span>
                  <span className="ml-2 inline-flex items-center px-1.5 py-0.5 text-[10px] text-terminal-muted/40 bg-terminal-muted/8 border border-terminal-muted/15 rounded select-none font-sans align-middle">Tab ↵</span>
                </div>
              )}
              {/* Voice transcript highlight overlay */}
              {activeVoiceTranscript && activeVoiceTranscript.phase !== "stable" && !isEditorMode && textareaVoiceTranscriptRangeRef.current && (
                <div
                  ref={textareaVoiceTranscriptOverlayRef}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 overflow-hidden p-4 text-sm font-mono whitespace-pre-wrap break-words"
                  style={{ minHeight: "36px", maxHeight: "192px" }}
                >
                  {/* Invisible text before the transcript range — positions the highlight */}
                  <span className="invisible">{inputValue.slice(0, textareaVoiceTranscriptRangeRef.current.start)}</span>
                  {/* Highlighted transcript region */}
                  <span
                    ref={textareaVoiceTranscriptHighlightRef}
                    className={
                      activeVoiceTranscript.phase === "polishing"
                        ? "rounded-sm bg-terminal-green/14 dark:bg-terminal-green/20 motion-safe:animate-pulse"
                        : "rounded-sm bg-terminal-green/18 dark:bg-terminal-green/24 transition-colors duration-500"
                    }
                  >
                    {inputValue.slice(textareaVoiceTranscriptRangeRef.current.start, textareaVoiceTranscriptRangeRef.current.end)}
                  </span>
                  {/* Invisible text after the transcript range */}
                  <span className="invisible">{inputValue.slice(textareaVoiceTranscriptRangeRef.current.end)}</span>
                </div>
              )}
            </div>

            <ComposerActionBar
              isOperationRunning={isOperationRunning}
              isCancelling={isCancelling}
              isQueueBlocked={isQueueBlocked}
              isRunning={isRunning}
              isDeepResearchMode={isDeepResearchMode}
              isDeepResearchActive={isDeepResearchActive}
              isDeepResearchLoading={isDeepResearchLoading}
              mcpIsReloading={mcpStatus.isReloading}
              mcpEstimatedTimeRemaining={mcpStatus.estimatedTimeRemaining}
              onToggleDeepResearch={deepResearch?.toggleDeepResearchMode}
              sttEnabled={sttEnabled}
              isRecordingVoice={isRecordingVoice}
              isTranscribingVoice={isTranscribingVoice}
              onVoiceInput={handleVoiceInput}
              voiceActivationMode={voiceActivationMode}
              onVoiceStart={handleVoiceStart}
              onVoiceStop={handleVoiceStop}
              inputHasText={inputValue.trim().length > 2}
              attachmentCount={attachmentCount}
              showEnhanceButton={!!(character?.id && character.id !== "default")}
              isEnhancing={isEnhancing}
              enhancedContext={enhancedContext}
              enhancementFilesFound={enhancementInfo?.filesFound || 0}
              onEnhance={handleEnhance}
              isEditorMode={isEditorMode}
              onToggleEditorMode={toggleEditorMode}
              isOverMessageLimit={isOverMessageLimit}
              onCancel={handleCancel}
              onSubmit={handleSubmit}
            />
          </div>
        )}
      </ComposerPrimitive.Root>

      {isOverMessageLimit && (
        <div className="px-3 py-1.5 text-xs font-mono text-red-600 dark:text-red-400">
          Message too long — {inputValue.length.toLocaleString()} / {MAX_MESSAGE_LENGTH.toLocaleString()} chars
        </div>
      )}

      <div className="mt-1.5 w-full px-1 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <ContextWindowIndicator
            status={contextStatus}
            isLoading={contextLoading}
            onCompact={onCompact}
            isCompacting={isCompacting}
            compact
          />
        </div>
        {sessionId && <ModelSelector sessionId={sessionId} status={contextStatus} />}
      </div>

      <ActiveDelegationsIndicator
        characterId={character?.id ?? null}
        workspaceMode={workspaceMode}
        onOpenSession={onOpenDelegationSession}
      />
    </div>
  );
};

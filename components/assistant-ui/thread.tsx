"use client";

import type { FC } from "react";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { ArrowsOut } from "@phosphor-icons/react";
import { getElectronAPI } from "@/lib/electron/types";
import {
  ThreadPrimitive,
  useThreadRuntime,
} from "@assistant-ui/react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCharacter } from "./character-context";
import { useOptionalDeepResearch } from "./deep-research-context";
import { BrowserActiveProvider } from "./browser-active-context";
import { ToolExpansionProvider } from "./tool-expansion-context";
import { ExpandAllToolsButton } from "./expand-all-tools-button";
import { ToolDisplayProvider, type ToolDisplayMode } from "./tool-display-context";
import { useContextStatus } from "@/lib/hooks/use-context-status";
import { useSessionHasActiveRun, useSessionSyncStore } from "@/lib/stores/session-sync-store";
import {
  ContextWindowBlockedBanner,
  type ContextWindowBlockedPayload,
} from "./context-window-blocked-banner";
import { resilientFetch } from "@/lib/utils/resilient-fetch";
import { useSettings } from "@/lib/hooks/use-settings";
import { AgentResourcesBadge } from "./agent-resources-badge";
import { type VoiceUiSettings } from "./thread-drop-utils";
import { useThreadDropHandler } from "./use-thread-drop-handler";
import {
  DragOverlay,
  SkillImportOverlay,
  ComfyImportDialog,
} from "./thread-import-overlays";
import { ThreadWelcome } from "./thread-welcome";
import { GalleryWrapper, SessionActivityWatcher, ThreadScrollToBottom } from "./thread-scroll-to-bottom";
import {
  AssistantMessage,
  UserMessage,
  SystemMessage,
  EditComposer as EditComposerComponent,
} from "./thread-message-components";
import { Composer } from "./thread-composer";
import { BrowserBackdrop } from "./browser-backdrop";
import { useTheme } from "@/components/theme/theme-provider";
import { useChatTransportError } from "@/components/chat-provider";
import type { ChatWorkspaceMode } from "@/lib/chat/workspace-mode";

type OpenDelegationSessionHandler = (sessionId: string, delegateAgentId: string) => void | Promise<void>;

interface ThreadProps {
  onSessionActivity?: (message: { id?: string; role: "user" | "assistant" }) => void;
  footer?: React.ReactNode;
  isBackgroundTaskRunning?: boolean;
  isProcessingInBackground?: boolean;
  sessionId?: string;
  activeRunId?: string | null;
  onCancelBackgroundRun?: () => void;
  isCancellingBackgroundRun?: boolean;
  canCancelBackgroundRun?: boolean;
  isZombieBackgroundRun?: boolean;
  onLivePromptInjected?: () => void | Promise<void | boolean>;
  onPostCancel?: () => void;
  isWorkspaceContext?: boolean;
  workspaceMode?: ChatWorkspaceMode;
  onOpenDelegationSession?: OpenDelegationSessionHandler;
}

export const Thread: FC<ThreadProps> = ({
  onSessionActivity,
  footer,
  isBackgroundTaskRunning = false,
  isProcessingInBackground = false,
  sessionId,
  activeRunId,
  onCancelBackgroundRun,
  isCancellingBackgroundRun = false,
  canCancelBackgroundRun = false,
  isZombieBackgroundRun = false,
  onLivePromptInjected,
  onPostCancel,
  workspaceMode = "sidebar",
  onOpenDelegationSession,
}) => {
  const router = useRouter();
  const { character } = useCharacter();
  const threadRuntime = useThreadRuntime();


  // Deep research mode (for drag-drop gating)
  const deepResearch = useOptionalDeepResearch();
  const isDeepResearchMode = deepResearch?.isDeepResearchMode ?? false;

  const [voiceUiSettings, setVoiceUiSettings] = useState<VoiceUiSettings>({
    ttsEnabled: false,
    sttEnabled: false,
    voicePostProcessing: true,
    voiceActionsEnabled: true,
    voiceAudioCues: true,
    voiceActivationMode: "tap",
    voiceHotkey: "CommandOrControl+Shift+Space",
    screenCaptureEnabled: true,
    quickCaptureEnabled: true,
    quickCaptureHotkey: "CommandOrControl+Shift+A",
    quickCaptureAutoSend: false,
    quickCaptureAutoSendDelay: 3,
  });
  const [toolDisplayMode, setToolDisplayMode] = useState<ToolDisplayMode>("compact");
  const [devWorkspaceEnabled, setDevWorkspaceEnabled] = useState(false);

  // Browser backdrop active — when true, make backgrounds transparent
  const [isBrowserActive, setIsBrowserActive] = useState(false);
  const { chatBackground } = useTheme();

  const { settings: _cachedSettings } = useSettings();
  useEffect(() => {
    if (!_cachedSettings) return;
    const data = _cachedSettings;

    setVoiceUiSettings({
      ttsEnabled: Boolean(data.ttsEnabled),
      sttEnabled: Boolean(data.sttEnabled),
      voicePostProcessing: data.voicePostProcessing !== false,
      voiceActionsEnabled: data.voiceActionsEnabled !== false,
      voiceAudioCues: data.voiceAudioCues !== false,
      voiceActivationMode: data.voiceActivationMode === "push" ? "push" : "tap",
      voiceHotkey:
        typeof data.voiceHotkey === "string" && (data.voiceHotkey as string).trim().length > 0
          ? (data.voiceHotkey as string).trim()
          : "CommandOrControl+Shift+Space",
      screenCaptureEnabled: data.screenCaptureEnabled !== false,
      quickCaptureEnabled: data.quickCaptureEnabled !== false,
      quickCaptureHotkey:
        typeof data.quickCaptureHotkey === "string" && (data.quickCaptureHotkey as string).trim().length > 0
          ? (data.quickCaptureHotkey as string).trim()
          : "CommandOrControl+Shift+A",
      quickCaptureAutoSend: data.quickCaptureAutoSend === true,
      quickCaptureAutoSendDelay: typeof data.quickCaptureAutoSendDelay === "number" ? (data.quickCaptureAutoSendDelay as number) : 3,
    });
    setToolDisplayMode(data.toolDisplayMode === "detailed" ? "detailed" : "compact");
    setDevWorkspaceEnabled(data.devWorkspaceEnabled === true);
  }, [_cachedSettings]);

  const {
    isDragging,
    isImportingSkill,
    skillImportPhase,
    skillImportProgress,
    skillImportName,
    skillImportError,
    importResultDetail,
    comfyImportDialogOpen,
    setComfyImportDialogOpen,
    comfyImportPreviews,
    comfyImportLoading,
    comfyImportSelected,
    setComfyImportSelected,
    comfyImportNameOverrides,
    setComfyImportNameOverrides,
    comfyImportExpanded,
    setComfyImportExpanded,
    comfyImportSubmitting,
    selectedComfyPreviewCount,
    validComfyPreviewCount,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    resetComfyImportState,
    submitComfyWorkflowImport,
  } = useThreadDropHandler({
    characterId: character?.id,
    characterName: character?.name,
    sessionId,
    isDeepResearchMode,
    threadRuntime,
    router,
  });

  const hasActiveRun = useSessionHasActiveRun(sessionId ?? null);
  const contextPollIntervalMs = hasActiveRun ? 5000 : 30000;

  // Context window status tracking
  const {
    status: contextStatus,
    isLoading: contextLoading,
    refresh: refreshContextStatus,
    compact: triggerCompact,
    isCompacting,
  } = useContextStatus({
    sessionId,
    pollIntervalMs: contextPollIntervalMs,
    pauseWhenHidden: true,
  });

  // Write context status to Zustand store so sidebar badges update
  useEffect(() => {
    if (!sessionId) return;
    const setStatus = useSessionSyncStore.getState().setSessionContextStatus;
    if (!contextStatus || contextStatus.status === "safe") {
      setStatus(sessionId, null);
    } else {
      setStatus(sessionId, {
        status: contextStatus.status,
        percentage: contextStatus.percentage,
        updatedAt: Date.now(),
      });
    }
  }, [sessionId, contextStatus?.status, contextStatus?.percentage]);

  // Blocked banner state — set when a 413 error is received
  const [blockedPayload, setBlockedPayload] =
    useState<ContextWindowBlockedPayload | null>(null);
  const transportErrorState = useChatTransportError();

  useEffect(() => {
    const transportError = transportErrorState?.error;
    if (!transportError) return;

    if (transportError.httpStatus === 413) {
      setBlockedPayload({
        message: transportError.message,
        details: transportError.details,
        status: transportError.status,
        recovery: transportError.recovery,
        compactionResult: transportError.compactionResult,
      });
      return;
    }

    setBlockedPayload(null);
  }, [transportErrorState?.error]);

  // Refresh context status after each session activity (message sent/received)
  const wrappedOnSessionActivity = useCallback(
    (message: { id?: string; role: "user" | "assistant" }) => {
      onSessionActivity?.(message);
      // Refresh context status after assistant responds (slight delay for DB to settle)
      if (message.role === "assistant") {
        setTimeout(() => refreshContextStatus(), 1500);
      }
    },
    [onSessionActivity, refreshContextStatus]
  );

  const AssistantMessageWithVoice: FC = useCallback(
    () => <AssistantMessage ttsEnabled={voiceUiSettings.ttsEnabled} />,
    [voiceUiSettings.ttsEnabled]
  );

  return (
    <TooltipProvider>
      <ThreadPrimitive.Root
        className={cn(
          "isolate relative flex h-full flex-1 min-h-0 flex-col transition-colors duration-700",
          (isBrowserActive || chatBackground.type !== "none") ? "bg-transparent" : "bg-terminal-cream"
        )}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <ToolExpansionProvider>
        <ToolDisplayProvider displayMode={toolDisplayMode} devWorkspaceEnabled={devWorkspaceEnabled}>
        <BrowserActiveProvider isBrowserActive={isBrowserActive} activeSessionId={sessionId}>
        {/* Live browser video backdrop — auto-detects active screencast */}
        <BrowserBackdrop sessionId={sessionId} onActiveChange={setIsBrowserActive} />

        {/* Browser session controls — rendered above viewport z-layer so they're clickable */}
        {isBrowserActive && sessionId && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex justify-end p-3">
            <div className="pointer-events-auto flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  const api = getElectronAPI();
                  if (api) {
                    try {
                      await api.ipc.invoke("browser-session:open", sessionId);
                    } catch {
                      window.open(`/browser-session?sessionId=${sessionId}`, "_blank");
                    }
                  } else {
                    window.open(`/browser-session?sessionId=${sessionId}`, "_blank");
                  }
                }}
                className="flex items-center gap-1 rounded-full bg-black/40 px-2.5 py-1 backdrop-blur-sm hover:bg-black/60 transition-colors cursor-pointer"
                title="Open in dedicated window"
              >
                <ArrowsOut className="size-3.5 text-white/70" weight="bold" />
                <span className="text-[10px] font-medium text-white/60">Pop out</span>
              </button>

              <div className="flex items-center gap-1.5 rounded-full bg-black/40 px-2 py-0.5 backdrop-blur-sm">
                <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-400" />
                <span className="text-[10px] font-medium text-white/60">LIVE</span>
              </div>
            </div>
          </div>
        )}

        <DragOverlay isDragging={isDragging} isImportingSkill={isImportingSkill} />

        <SkillImportOverlay
          isImportingSkill={isImportingSkill}
          skillImportPhase={skillImportPhase}
          skillImportProgress={skillImportProgress}
          skillImportName={skillImportName}
          skillImportError={skillImportError}
          importResultDetail={importResultDetail}
        />

        <ComfyImportDialog
          open={comfyImportDialogOpen}
          previews={comfyImportPreviews}
          loading={comfyImportLoading}
          selected={comfyImportSelected}
          nameOverrides={comfyImportNameOverrides}
          expanded={comfyImportExpanded}
          submitting={comfyImportSubmitting}
          selectedCount={selectedComfyPreviewCount}
          validCount={validComfyPreviewCount}
          agentName={character?.name || "Agent"}
          onOpenChange={setComfyImportDialogOpen}
          onReset={resetComfyImportState}
          onSelectAll={() => {
            setComfyImportSelected((prev) => {
              const next = { ...prev };
              for (const preview of comfyImportPreviews) {
                if (!preview.error) {
                  next[preview.fileName] = true;
                }
              }
              return next;
            });
          }}
          onClearSelection={() => {
            setComfyImportSelected((prev) => {
              const next = { ...prev };
              for (const key of Object.keys(next)) {
                next[key] = false;
              }
              return next;
            });
          }}
          onToggleSelect={(fileName, checked) => {
            setComfyImportSelected((prev) => ({ ...prev, [fileName]: checked }));
          }}
          onNameChange={(fileName, name) => {
            setComfyImportNameOverrides((prev) => ({ ...prev, [fileName]: name }));
          }}
          onToggleExpand={(fileName) => {
            setComfyImportExpanded((prev) => ({ ...prev, [fileName]: !prev[fileName] }));
          }}
          onSubmit={submitComfyWorkflowImport}
        />

        <SessionActivityWatcher onSessionActivity={wrappedOnSessionActivity} />
        <GalleryWrapper>
          <ThreadPrimitive.Viewport
          className="relative z-10 flex min-w-0 flex-1 flex-col items-center overflow-x-hidden overflow-y-auto px-4 pt-8 [overflow-anchor:auto]"
          data-chat-viewport="true">
            <ThreadWelcome />
            <ThreadPrimitive.Messages
              components={{
                UserMessage,
                AssistantMessage: AssistantMessageWithVoice,
                SystemMessage,
                EditComposer: EditComposerComponent,
              }}
            />
            {/* Context window blocked banner — always render container to prevent layout shift */}
            {blockedPayload ? (
              <ContextWindowBlockedBanner
                payload={blockedPayload}
                onCompact={async () => {
                  const result = await triggerCompact();
                  if (result.success) {
                    setTimeout(() => setBlockedPayload(null), 2000);
                  }
                  return result;
                }}
                onDismiss={() => setBlockedPayload(null)}
                isCompacting={isCompacting}
              />
            ) : null}
            {footer}
            <div className="min-h-8 flex-shrink-0 [overflow-anchor:auto]" />
          </ThreadPrimitive.Viewport>

          <div className={cn("sticky bottom-0 z-10 mt-auto flex w-full max-w-4xl flex-col items-center justify-end rounded-t-lg pb-4 mx-auto px-4", isBrowserActive ? "bg-black/30 backdrop-blur-sm" : chatBackground.type !== "none" ? "bg-terminal-cream/60 backdrop-blur-md" : "bg-terminal-cream")}>
            <ThreadScrollToBottom />
            <div className="flex min-h-[24px] w-full items-center justify-between px-1">
              <ExpandAllToolsButton />
              <AgentResourcesBadge />
            </div>
            <Composer
              isBackgroundTaskRunning={isBackgroundTaskRunning}
              isProcessingInBackground={isProcessingInBackground}
              sessionId={sessionId}
              activeRunId={activeRunId}
              workspaceMode={workspaceMode}
              onOpenDelegationSession={onOpenDelegationSession}
              sttEnabled={voiceUiSettings.sttEnabled}
              voicePostProcessing={voiceUiSettings.voicePostProcessing}
              voiceActionsEnabled={voiceUiSettings.voiceActionsEnabled}
              voiceAudioCues={voiceUiSettings.voiceAudioCues}
              voiceActivationMode={voiceUiSettings.voiceActivationMode}
              voiceHotkey={voiceUiSettings.voiceHotkey}
              screenCaptureEnabled={voiceUiSettings.screenCaptureEnabled}
              quickCaptureEnabled={voiceUiSettings.quickCaptureEnabled}
              quickCaptureHotkey={voiceUiSettings.quickCaptureHotkey}
              quickCaptureAutoSend={voiceUiSettings.quickCaptureAutoSend}
              quickCaptureAutoSendDelay={voiceUiSettings.quickCaptureAutoSendDelay}
              onCancelBackgroundRun={onCancelBackgroundRun}
              isCancellingBackgroundRun={isCancellingBackgroundRun}
              canCancelBackgroundRun={canCancelBackgroundRun}
              isZombieBackgroundRun={isZombieBackgroundRun}
              onLivePromptInjected={onLivePromptInjected}
              onPostCancel={onPostCancel}
              contextStatus={contextStatus}
              contextLoading={contextLoading}
              onCompact={triggerCompact}
              isCompacting={isCompacting}
            />
          </div>
        </GalleryWrapper>
        </BrowserActiveProvider>
        </ToolDisplayProvider>
        </ToolExpansionProvider>
      </ThreadPrimitive.Root>
    </TooltipProvider>
  );
};

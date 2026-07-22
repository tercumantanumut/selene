"use client";

/**
 * BrowserSessionViewer — Dedicated full-screen browser session viewer.
 *
 * Three-panel layout:
 *  - Top: Full-size live screencast (no blur/dim)
 *  - Bottom-left: Live action timeline
 *  - Bottom-right: Controls (replay, record, download)
 */

import { useEffect, useRef, useState, useCallback, type FC } from "react";
import {
  Globe,
  CursorClick,
  TextT,
  TreeStructure,
  Code,
  Eye,
  X,
  Play,
  ArrowRight,
  CheckCircle,
  XCircle,
  CircleNotch,
  Clock,
  Record as RecordIcon,
  Stop,
  DownloadSimple,
  ArrowClockwise,
  Hand,
  User,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { useScreencastRecorder } from "./use-screencast-recorder";
import { useBrowserInteraction, type BrowserViewportSize } from "./use-browser-interaction";
import { useActionIndicators, type ActionSSEData } from "./use-action-indicators";
import { ActionIndicators } from "./action-indicators";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActionRecord {
  seq: number;
  timestamp: string;
  action: string;
  input: Record<string, unknown>;
  output: unknown;
  success: boolean;
  durationMs: number;
  pageUrl?: string;
  pageTitle?: string;
  domSnapshot?: string;
  error?: string;
  source?: "agent" | "user";
}

interface SessionHistory {
  sessionId: string;
  agentId?: string;
  startedAt: string;
  endedAt?: string;
  totalDurationMs?: number;
  actions: ActionRecord[];
}

interface ScreencastFrameMetadata {
  deviceWidth?: number;
  deviceHeight?: number;
}

interface ScreencastFrameEvent {
  data?: string;
  ts?: number;
  metadata?: ScreencastFrameMetadata;
}

function viewportSizeFromMetadata(
  metadata?: ScreencastFrameMetadata
): BrowserViewportSize | null {
  if (!metadata) return null;
  const width = Math.round(Number(metadata.deviceWidth));
  const height = Math.round(Number(metadata.deviceHeight));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

// ─── Action helpers ───────────────────────────────────────────────────────────

const ACTION_ICONS: Record<string, typeof Globe> = {
  open: Globe,
  navigate: ArrowRight,
  click: CursorClick,
  type: TextT,
  snapshot: TreeStructure,
  extract: Eye,
  replay: Play,
  evaluate: Code,
  setViewport: Eye,
  resetViewport: ArrowClockwise,
  close: X,
};

function getActionIcon(action: string) {
  return ACTION_ICONS[action] ?? Globe;
}

function getActionLabel(action: string): string {
  const labels: Record<string, string> = {
    open: "Open",
    navigate: "Navigate",
    click: "Click",
    type: "Type",
    snapshot: "Snapshot",
    extract: "Extract",
    evaluate: "Evaluate",
    setViewport: "Set Viewport",
    resetViewport: "Reset Viewport",
    close: "Close",
    replay: "Replay",
  };
  return labels[action] ?? action;
}

function truncateUrl(url: string, maxLen: number): string {
  try {
    const u = new URL(url);
    const display = u.hostname + u.pathname;
    return display.length > maxLen ? display.slice(0, maxLen) + "..." : display;
  } catch {
    return url.slice(0, maxLen);
  }
}

// ─── Main Component ───────────────────────────────────────────────────────────

export const BrowserSessionViewer: FC<{ sessionId: string }> = ({ sessionId }) => {
  const t = useTranslations("browserSession");
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const hasFrameRef = useRef(false);
  const [history, setHistory] = useState<SessionHistory | null>(null);
  const [pageTitle, setPageTitle] = useState<string>("");
  const [pageUrl, setPageUrl] = useState<string>("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const historyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isReplaying, setIsReplaying] = useState(false);

  // activeSessionId drives SSE + history polling.
  // Starts as the prop sessionId, switches when replay starts.
  const [activeSessionId, setActiveSessionId] = useState(sessionId);
  const [viewportSize, setViewportSize] = useState<BrowserViewportSize | null>(null);

  // Store the original session history for the replay button
  const originalHistoryRef = useRef<SessionHistory | null>(null);

  const {
    isRecording,
    hasRecording,
    startRecording,
    stopRecording,
    downloadRecording,
    feedFrame,
  } = useScreencastRecorder(canvasRef);

  const [isInteractive, setIsInteractive] = useState(false);
  const [urlBarValue, setUrlBarValue] = useState("");
  const interactionContainerRef = useRef<HTMLDivElement>(null);

  const {
    handleMouseDown,
    isSending,
    navigate,
  } = useBrowserInteraction({
    sessionId: activeSessionId,
    imgRef,
    viewportSize,
    enabled: isInteractive,
    containerRef: interactionContainerRef,
  });

  const [showIndicators, setShowIndicators] = useState(true);

  const { indicators, addAction, clearIndicators } = useActionIndicators({
    sessionId: activeSessionId,
    imgRef,
    containerRef: interactionContainerRef,
    viewportSize,
    enabled: showIndicators,
  });

  // H7: Sequential key queue — processes one keystroke at a time to avoid out-of-order delivery
  const keyQueueRef = useRef<Array<{type: string; [key: string]: unknown}>>([]);
  const processingKeyRef = useRef(false);

  const processKeyQueue = useCallback(async () => {
    if (processingKeyRef.current) return;
    processingKeyRef.current = true;

    while (keyQueueRef.current.length > 0) {
      const payload = keyQueueRef.current.shift()!;
      try {
        await fetch(`/api/browser/${activeSessionId}/interact`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch { /* ignore */ }
    }

    processingKeyRef.current = false;
  }, [activeSessionId]);

  // Capture keyboard events when interactive mode is on
  useEffect(() => {
    if (!isInteractive || !activeSessionId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture if user is typing in the URL bar
      if (e.target instanceof HTMLInputElement) return;

      e.preventDefault();

      const specialKeys = new Set([
        "Enter", "Tab", "Escape", "Backspace", "Delete",
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        "Home", "End", "PageUp", "PageDown", "Space",
      ]);

      if (specialKeys.has(e.key)) {
        let modifiers = 0;
        if (e.altKey) modifiers |= 1;
        if (e.ctrlKey) modifiers |= 2;
        if (e.metaKey) modifiers |= 4;
        if (e.shiftKey) modifiers |= 8;

        keyQueueRef.current.push({ type: "keypress", key: e.key, modifiers });
        void processKeyQueue();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        keyQueueRef.current.push({ type: "type", text: e.key });
        void processKeyQueue();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isInteractive, activeSessionId, processKeyQueue]);

  // Connect to screencast stream — uses activeSessionId
  useEffect(() => {
    if (!activeSessionId) return;

    let mounted = true;

    // Reset frame state when switching sessions
    clearIndicators();
    hasFrameRef.current = false;
    setHasFrame(false);
    setIsConnected(false);
    setViewportSize(null);

    const connect = () => {
      const es = new EventSource(`/api/browser/${activeSessionId}/stream`);
      eventSourceRef.current = es;

      es.onopen = () => {
        if (mounted) setIsConnected(true);
      };

      es.onmessage = (event) => {
        try {
          const { data, metadata } = JSON.parse(event.data) as ScreencastFrameEvent;
          const nextViewportSize = viewportSizeFromMetadata(metadata);
          if (mounted && nextViewportSize) {
            setViewportSize((prev) => {
              if (prev?.width === nextViewportSize.width && prev.height === nextViewportSize.height) {
                return prev;
              }
              return nextViewportSize;
            });
          }
          if (data) {
            const src = `data:image/jpeg;base64,${data}`;
            if (imgRef.current) {
              imgRef.current.src = src;
            }
            feedFrame(src);
            if (mounted && !hasFrameRef.current) {
              hasFrameRef.current = true;
              setHasFrame(true);
            }
          }
        } catch {
          // Skip malformed frames
        }
      };

      es.addEventListener("action", (event) => {
        try {
          const data = JSON.parse(event.data) as ActionSSEData;
          addAction(data);
        } catch { /* skip */ }
      });

      es.onerror = () => {
        es.close();
        eventSourceRef.current = null;
        if (mounted) {
          setIsConnected(false);
          // Retry after delay
          setTimeout(() => {
            if (mounted && !eventSourceRef.current) connect();
          }, 3000);
        }
      };
    };

    connect();

    return () => {
      mounted = false;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // Poll for action history — uses activeSessionId
  useEffect(() => {
    if (!activeSessionId) return;

    const poll = async () => {
      try {
        const res = await fetch(`/api/browser/${activeSessionId}/history`);
        if (res.ok) {
          const data = await res.json() as SessionHistory;
          setHistory(data);

          // Update page info from latest action
          const lastAction = data.actions[data.actions.length - 1];
          if (lastAction?.pageTitle) setPageTitle(lastAction.pageTitle);
          if (lastAction?.pageUrl) setPageUrl(lastAction.pageUrl);
        } else if (res.status === 404) {
          // Session ended — stop polling
          if (historyPollRef.current) {
            clearInterval(historyPollRef.current);
            historyPollRef.current = null;
          }
          // If this was a replay session, mark replay done
          if (isReplaying) {
            setIsReplaying(false);
          }
        }
      } catch {
        // Ignore poll errors
      }
    };

    void poll();
    historyPollRef.current = setInterval(poll, 2000);

    return () => {
      if (historyPollRef.current) {
        clearInterval(historyPollRef.current);
        historyPollRef.current = null;
      }
    };
  }, [activeSessionId, isReplaying]);

  const handleReplay = useCallback(async () => {
    // Use the original history (from before replay) or current history
    const historyToReplay = originalHistoryRef.current ?? history;
    if (!sessionId || !historyToReplay) return;

    setIsReplaying(true);
    // Store the original history before replay overwrites it
    if (!originalHistoryRef.current) {
      originalHistoryRef.current = historyToReplay;
    }
    // Clear current state for fresh replay view
    setHistory(null);
    setPageTitle("");
    setPageUrl("");

    try {
      const res = await fetch(`/api/browser/${sessionId}/replay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: historyToReplay }),
      });
      if (!res.ok) {
        console.error("Replay failed:", await res.text());
        setIsReplaying(false);
        return;
      }
      const data = await res.json() as { sessionId: string; totalActions: number };
      console.log(`[Replay] Started: sessionId=${data.sessionId}, ${data.totalActions} actions`);

      // Switch to the replay session for both screencast and history
      setActiveSessionId(data.sessionId);
    } catch (err) {
      console.error("Replay error:", err);
      setIsReplaying(false);
    }
  }, [sessionId, history]);

  const handleBackToLive = useCallback(() => {
    clearIndicators();
    setActiveSessionId(sessionId);
    setIsReplaying(false);
    originalHistoryRef.current = null;
  }, [clearIndicators, sessionId]);

  const handleDownload = useCallback(async () => {
    await downloadRecording(`browser-session-${activeSessionId.slice(0, 8)}.webm`);
  }, [downloadRecording, activeSessionId]);

  const isReplaySession = activeSessionId !== sessionId;

  return (
    <div className="flex h-full flex-col bg-black text-white">
      {/* ── Top bar ── */}
      <div className="flex items-center gap-3 px-4 py-2 bg-black/80 border-b border-white/10 shrink-0">
        <Globe className="size-4 text-white/60" weight="bold" />
        <span className="text-sm font-mono text-white/80 truncate">
          {pageTitle || t("title")}
        </span>
        {pageUrl && (
          <span className="text-xs font-mono text-white/40 truncate ml-auto">
            {truncateUrl(pageUrl, 50)}
          </span>
        )}
        <div className="flex items-center gap-1.5 ml-2">
          {isReplaySession ? (
            <>
              <ArrowClockwise className="size-3 text-blue-400 animate-spin" weight="bold" />
              <span className="text-[10px] font-medium text-blue-400/80">{t("replaying")}</span>
              <button
                type="button"
                onClick={handleBackToLive}
                className="ml-2 text-[10px] font-mono text-white/50 hover:text-white/80 underline"
              >
                {t("backToLive")}
              </button>
            </>
          ) : isConnected ? (
            <>
              <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-400" />
              <span className="text-[10px] font-medium text-green-400/80">{t("live")}</span>
            </>
          ) : (
            <>
              <div className="h-1.5 w-1.5 rounded-full bg-yellow-500" />
              <span className="text-[10px] font-medium text-yellow-500/80">{t("connecting")}</span>
            </>
          )}
        </div>
      </div>

      {/* ── Main content ── */}
      <div className="flex flex-1 min-h-0">
        {/* ── Screencast panel (left, dominant) ── */}
        <div
          className={cn(
            "flex-1 relative flex flex-col bg-black",
            isInteractive && "cursor-crosshair"
          )}
        >
          {/* URL bar — shown in interactive mode */}
          {isInteractive && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 border-b border-white/10 shrink-0">
              <Globe className="size-3.5 text-white/40" weight="bold" />
              <input
                type="text"
                value={urlBarValue}
                onChange={(e) => setUrlBarValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && urlBarValue.trim()) {
                    e.preventDefault();
                    void navigate(urlBarValue.trim());
                    setUrlBarValue("");
                  }
                }}
                placeholder={t("urlPlaceholder")}
                className="flex-1 bg-transparent text-xs font-mono text-white/80 placeholder:text-white/30 outline-none"
              />
              {isSending && (
                <CircleNotch className="size-3 text-white/40 animate-spin" weight="bold" />
              )}
            </div>
          )}

          {/* Screencast image with interaction overlay */}
          <div
            ref={interactionContainerRef}
            className="flex-1 relative flex items-center justify-center"
            onMouseDown={handleMouseDown}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              alt="Live browser screencast"
              className={cn(
                "max-h-full max-w-full object-contain transition-opacity duration-300",
                hasFrame ? "opacity-100" : "opacity-0"
              )}
            />

            {/* Action indicator overlays */}
            {showIndicators && (
              <ActionIndicators
                indicators={indicators}
                containerRef={interactionContainerRef}
              />
            )}

            {/* Hidden canvas for recording */}
            <canvas ref={canvasRef} className="hidden" />

            {/* Placeholder when no frames */}
            {!hasFrame && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex flex-col items-center gap-3 text-white/30">
                  <CircleNotch className="size-8 animate-spin" weight="bold" />
                  <span className="text-sm font-mono">
                    {isReplaying ? t("startingReplay") : t("waitingForFrames")}
                  </span>
                </div>
              </div>
            )}

            {/* Interactive mode indicator */}
            {isInteractive && hasFrame && (
              <div className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-md bg-blue-500/20 px-2 py-1 backdrop-blur-sm">
                <Hand className="size-3 text-blue-400" weight="fill" />
                <span className="text-[10px] font-mono text-blue-400/90 font-medium">
                  {t("interactive")}
                </span>
              </div>
            )}

            {/* H8: Agent activity warning — shown when agent acted within last 3s */}
            {isInteractive && hasFrame && history?.actions.length && (() => {
              const lastAgent = history.actions.filter(a => a.source !== "user").pop();
              if (!lastAgent) return null;
              const agentActiveRecently = Date.now() - new Date(lastAgent.timestamp).getTime() < 3000;
              if (!agentActiveRecently) return null;
              return (
                <div className="absolute bottom-3 left-40 flex items-center gap-1.5 rounded-md bg-amber-500/20 px-2 py-1 backdrop-blur-sm">
                  <span className="text-[10px] font-mono text-amber-400/90 font-medium">
                    {t("agentActive")}
                  </span>
                </div>
              );
            })()}
          </div>
        </div>

        {/* ── Right panel: Timeline + Controls ── */}
        <div className="w-80 flex flex-col border-l border-white/10 bg-black/60 shrink-0">
          {/* Timeline */}
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2">
              <Play className="size-3.5 text-white/60" weight="fill" />
              <span className="text-xs font-mono font-medium text-white/80">
                {t("actionTimeline")}
              </span>
              {history && (
                <span className="text-[10px] text-white/40 ml-auto font-mono">
                  {t("actionsCount", { count: history.actions.length })}
                </span>
              )}
            </div>

            <div className="divide-y divide-white/5">
              {history?.actions.map((record) => {
                const Icon = getActionIcon(record.action);
                return (
                  <div
                    key={record.seq}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-white/5 transition-colors"
                  >
                    {/* Status */}
                    {record.success ? (
                      <CheckCircle className="size-3 text-green-400 shrink-0" weight="fill" />
                    ) : (
                      <XCircle className="size-3 text-red-400 shrink-0" weight="fill" />
                    )}

                    {/* Source indicator */}
                    {record.source === "user" ? (
                      <User className="size-3 text-blue-400/70 shrink-0" weight="fill" />
                    ) : null}

                    {/* Icon */}
                    <Icon className="size-3 text-white/50 shrink-0" weight="bold" />

                    {/* Label */}
                    <span className="text-xs font-mono text-white/70 font-medium shrink-0">
                      {getActionLabel(record.action)}
                    </span>

                    {/* URL or target */}
                    {record.pageUrl && (
                      <span className="text-[10px] font-mono text-white/30 truncate">
                        {truncateUrl(record.pageUrl, 25)}
                      </span>
                    )}

                    {/* Duration */}
                    <span className="ml-auto text-[10px] font-mono text-white/20 shrink-0">
                      {record.durationMs}ms
                    </span>
                  </div>
                );
              })}

              {(!history || history.actions.length === 0) && (
                <div className="px-3 py-8 text-center text-xs text-white/20 font-mono">
                  {isReplaying ? t("replayStarting") : t("noActionsYet")}
                </div>
              )}
            </div>
          </div>

          {/* ── Controls panel ── */}
          <div className="border-t border-white/10 px-3 py-3 space-y-2 shrink-0">
            {/* Session stats */}
            {history && history.actions.length > 0 && (
              <div className="flex items-center gap-3 text-[10px] font-mono text-white/40">
                <span className="flex items-center gap-1 text-green-400/80">
                  <CheckCircle className="size-2.5" weight="fill" />
                  {history.actions.filter((a) => a.success).length}
                </span>
                {history.actions.some((a) => !a.success) && (
                  <span className="flex items-center gap-1 text-red-400/80">
                    <XCircle className="size-2.5" weight="fill" />
                    {history.actions.filter((a) => !a.success).length}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Clock className="size-2.5" />
                  {((history.actions.reduce((sum, a) => sum + a.durationMs, 0)) / 1000).toFixed(1)}s
                </span>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              {/* Interactive mode toggle */}
              <button
                type="button"
                onClick={() => setIsInteractive((prev) => !prev)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-mono transition-colors",
                  isInteractive
                    ? "bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
                    : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white/80"
                )}
              >
                <Hand className={cn("size-3.5", isInteractive && "text-blue-400")} weight={isInteractive ? "fill" : "bold"} />
                {isInteractive ? t("interactiveMode") : t("interact")}
              </button>

              {/* Action indicators toggle */}
              <button
                type="button"
                onClick={() => setShowIndicators((prev) => !prev)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-mono transition-colors",
                  showIndicators
                    ? "bg-violet-500/20 text-violet-400 hover:bg-violet-500/30"
                    : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white/80"
                )}
                title={showIndicators ? t("hideActions") : t("showActions")}
              >
                <Eye className={cn("size-3.5", showIndicators && "text-violet-400")} weight={showIndicators ? "fill" : "bold"} />
                {showIndicators ? t("hideActions") : t("showActions")}
              </button>

              {/* Record / Stop */}
              {isRecording ? (
                <button
                  type="button"
                  onClick={stopRecording}
                  className="flex items-center gap-1.5 rounded-md bg-red-500/20 px-3 py-1.5 text-xs font-mono text-red-400 hover:bg-red-500/30 transition-colors"
                >
                  <Stop className="size-3.5" weight="fill" />
                  {t("stop")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startRecording}
                  className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-xs font-mono text-white/60 hover:bg-white/20 hover:text-white/80 transition-colors"
                >
                  <RecordIcon className="size-3.5 text-red-400" weight="fill" />
                  {t("record")}
                </button>
              )}

              {/* Download recording */}
              {hasRecording && (
                <button
                  type="button"
                  onClick={handleDownload}
                  className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-xs font-mono text-white/60 hover:bg-white/20 hover:text-white/80 transition-colors"
                >
                  <DownloadSimple className="size-3.5" weight="bold" />
                  {t("download")}
                </button>
              )}

              {/* Replay */}
              {((history && history.actions.length > 0) || originalHistoryRef.current) && (
                <button
                  type="button"
                  onClick={handleReplay}
                  disabled={isReplaying}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-mono transition-colors ml-auto",
                    isReplaying
                      ? "bg-blue-500/20 text-blue-400 cursor-wait"
                      : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white/80"
                  )}
                >
                  <ArrowClockwise className={cn("size-3.5", isReplaying && "animate-spin")} weight="bold" />
                  {isReplaying ? t("replayingAction") : t("replay")}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

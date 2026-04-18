"use client";

import type { FC, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useAssistantState, useMessage } from "@assistant-ui/react";
import type { MessagePartState } from "@assistant-ui/react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useChatSessionId } from "@/components/chat-provider";
import { ToolCallBadge, type ToolCallBadgeStatus } from "./tool-call-badge";
import { useBrowserActive } from "./browser-active-context";
import { useToolDisplayPreferences } from "./tool-display-context";
import { useToolExpansion } from "./tool-expansion-context";
import {
  getFallbackToolPhase,
  summarizeToolInputByName,
  summarizeToolOutputByName,
  useLiveToolStatuses,
  type LiveToolPhase,
} from "./tool-live-status";
import { getCanonicalToolName, humanizeToolName, loadToolNameCache } from "./tool-name-utils";
import { getToolBadgeStatus } from "./tool-status";
import { getResultCount } from "./thread-message-activity";

type ToolCallPart = Extract<MessagePartState, { type: "tool-call" }>;
type ToolCallPartLike = ToolCallPart & {
  toolCallId?: string;
  args?: unknown;
  input?: unknown;
  argsText?: string;
};

interface ToolCallGroupProps {
  startIndex: number;
  endIndex: number;
  children?: ReactNode;
}

interface ToolSummaryItem {
  key: string;
  label: string;
  badgeStatus: ToolCallBadgeStatus;
  phase: LiveToolPhase;
  count: number | null;
  detail?: string;
  inputPreview?: string;
  outputPreview?: string;
  /** Elapsed ms for Agent tool calls (from live status, set on completion). */
  elapsedMs?: number;
  /** Unix ms when Agent tool call began executing (for live ticker). */
  startedAt?: number;
  /** Parsed step list for Agent tool calls. */
  steps?: string[];
}

/** Format elapsed milliseconds as a compact human-readable string. */
function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

const toolGroupExpansionState = new Map<string, boolean>();
const TOOL_GROUP_EXPANSION_MAX_SIZE = 500;

/** Clear all stored expansion state. Call on thread/conversation change. */
export function resetToolGroupExpansion() {
  toolGroupExpansionState.clear();
}

/** Prune oldest entries when the map exceeds the max size threshold. */
function pruneExpansionState() {
  if (toolGroupExpansionState.size <= TOOL_GROUP_EXPANSION_MAX_SIZE) return;
  const excess = toolGroupExpansionState.size - TOOL_GROUP_EXPANSION_MAX_SIZE;
  const iter = toolGroupExpansionState.keys();
  for (let i = 0; i < excess; i++) {
    const next = iter.next();
    if (next.done) break;
    toolGroupExpansionState.delete(next.value);
  }
}

/**
 * Tools whose custom UI is the primary content and should auto-expand.
 * Without this, their rich inline UIs (audio player, interactive questions,
 * plan steps, etc.) are hidden behind the "Details" toggle.
 */
const TOOLS_AUTO_EXPAND = new Set([
  "speakAloud",
  "askUserQuestion",
  "askFollowupQuestion",
  "AskUserQuestion",
  "updatePlan",
  "ExitPlanMode",
  "showProductImages",
  "calculator",
  "chromiumWorkspace",
  "promptLibrary",
  "designWorkspace",

]);


function extractMediaFromResult(result: unknown): Array<{ type: "image" | "video"; url: string }> {
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  const media: Array<{ type: "image" | "video"; url: string }> = [];

  // Ephemeral-stub format (canonical-content.ts#makeEphemeralStubResult):
  // tools flagged `ephemeralResults: true` are persisted as compact stubs
  // where only `mediaRefs: [{ url, mimeType }]` survives. On replay this
  // is the only shape with hosted media URLs, so render from it first.
  if (Array.isArray(record.mediaRefs)) {
    for (const item of record.mediaRefs) {
      if (!item || typeof item !== "object") continue;
      const refRecord = item as { url?: unknown; mimeType?: unknown };
      const refUrl = typeof refRecord.url === "string" ? refRecord.url : undefined;
      if (!refUrl) continue;
      const mimeType = typeof refRecord.mimeType === "string" ? refRecord.mimeType : "";
      const type: "image" | "video" = mimeType.startsWith("video/") ? "video" : "image";
      media.push({ type, url: refUrl });
    }
  }

  if (Array.isArray(record.images)) {
    for (const item of record.images) {
      if (item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string") {
        media.push({ type: "image", url: (item as { url: string }).url });
      }
    }
  }

  if (Array.isArray(record.videos)) {
    for (const item of record.videos) {
      if (item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string") {
        media.push({ type: "video", url: (item as { url: string }).url });
      }
    }
  }

  if (Array.isArray(record.results)) {
    for (const nested of record.results) {
      media.push(...extractMediaFromResult(nested));
    }
  }

  return media;
}

function phaseToBadgeStatus(phase: LiveToolPhase): ToolCallBadgeStatus {
  if (phase === "error") return "error";
  if (phase === "completed") return "completed";
  return "running";
}

function phaseToAccentClass(phase: LiveToolPhase): string {
  switch (phase) {
    case "error":
      return "border-destructive/40 bg-background/80 text-foreground backdrop-blur-md";
    case "completed":
      return "border-terminal-green/40 bg-background/80 text-foreground backdrop-blur-md";
    case "preparing":
      return "border-terminal-dark/20 bg-background/80 text-foreground backdrop-blur-md";
    case "running":
    default:
      return "border-terminal-amber/40 bg-background/80 text-foreground backdrop-blur-md";
  }
}

function phaseToStatusText(tStatus: ReturnType<typeof useTranslations>, phase: LiveToolPhase): string {
  switch (phase) {
    case "error":
      return tStatus("failed");
    case "completed":
      return tStatus("completed");
    case "preparing":
    case "running":
    default:
      return tStatus("processing");
  }
}

export const ToolCallGroup: FC<ToolCallGroupProps> = ({
  startIndex,
  endIndex,
  children,
}) => {
  const t = useTranslations("assistantUi.tools");
  const tStatus = useTranslations("assistantUi.toolStatus");
  const sessionId = useChatSessionId();
  const liveStatuses = useLiveToolStatuses(sessionId);
  const { effectiveDisplayMode } = useToolDisplayPreferences();
  const isDetailedMode = effectiveDisplayMode === "detailed";
  const messageParts = useAssistantState((state) => state.message.parts);
  const messageId = useMessage((state) => state.id);
  const { isBrowserActive } = useBrowserActive();
  const [isCompactRevealPinned, setIsCompactRevealPinned] = useState(false);
  const [isCompactRevealHovered, setIsCompactRevealHovered] = useState(false);

  // Load registry display names so grouped labels match expanded fallback labels
  const [registryNames, setRegistryNames] = useState<Record<string, string>>({});
  useEffect(() => {
    loadToolNameCache().then(setRegistryNames);
  }, []);

  const toolParts = useMemo(() => {
    return messageParts
      .slice(startIndex, endIndex + 1)
      .filter((part): part is ToolCallPart => part?.type === "tool-call");
  }, [messageParts, startIndex, endIndex]);

  const isAllChromium = useMemo(() => {
    return toolParts.length > 0 && toolParts.every((part) => getCanonicalToolName(part.toolName) === "chromiumWorkspace");
  }, [toolParts]);

  const isGlass = isBrowserActive && isAllChromium;

  const fallbackKey = useMemo(() => {
    return toolParts
      .map((part, index) => `${part.toolName}:${index}`)
      .join("|");
  }, [toolParts]);

  const expansionKey = useMemo(() => {
    const resolvedMessageId = typeof messageId === "string" ? messageId : fallbackKey || "unknown-message";
    return `${resolvedMessageId}:${startIndex}`;
  }, [fallbackKey, messageId, startIndex]);

  const [isExpanded, setIsExpanded] = useState<boolean>(
    () => toolGroupExpansionState.get(expansionKey) ?? false
  );

  const hasInteractiveUI = useMemo(() => {
    return toolParts.some((part) => TOOLS_AUTO_EXPAND.has(getCanonicalToolName(part.toolName)));
  }, [toolParts]);

  const mediaPreviews = useMemo(() => {
    if (toolParts.length === 0 || toolParts.every((part) => part.result == null)) {
      return [];
    }

    const seen = new Set<string>();
    const collected: Array<{ type: "image" | "video"; url: string }> = [];

    for (const part of toolParts) {
      for (const media of extractMediaFromResult(part.result)) {
        if (seen.has(media.url)) continue;
        seen.add(media.url);
        collected.push(media);
      }
    }

    return collected;
  }, [toolParts]);

  const summaryItems = useMemo<ToolSummaryItem[]>(() => {
    return toolParts.map((part, index) => {
      const partLike = part as ToolCallPartLike;
      const canonicalToolName = getCanonicalToolName(part.toolName);
      const label = t.has(canonicalToolName)
        ? t(canonicalToolName)
        : t.has(part.toolName)
          ? t(part.toolName)
          : registryNames[canonicalToolName] || registryNames[part.toolName] || humanizeToolName(canonicalToolName);
      const canonicalStatus = getToolBadgeStatus(partLike);
      // Always read liveStatus — even for completed tools — so elapsedMs and steps survive past completion.
      const liveStatus = partLike.toolCallId ? liveStatuses[partLike.toolCallId] : undefined;
      // When the tool has a result (DB-persisted), trust canonical status over
      // stale liveStatus. This prevents a "running" live phase from overriding
      // a tool that actually completed (e.g. after network reconnection when
      // the completion progress event was missed).
      const isCanonicalTerminal = canonicalStatus === "completed" || canonicalStatus === "error";
      const phase = isCanonicalTerminal
        ? getFallbackToolPhase(part.result, false)
        : (liveStatus?.phase ?? getFallbackToolPhase(part.result, canonicalStatus === "running"));
      const detail = liveStatus?.detail;
      const inputPreview = liveStatus?.argsPreview ?? summarizeToolInputByName(canonicalToolName, partLike.input ?? partLike.args ?? partLike.argsText);
      const outputPreview = liveStatus?.outputPreview ?? summarizeToolOutputByName(canonicalToolName, part.result);

      const isAgent = canonicalToolName === "Agent";
      // For Agent: use parsed step count as pill count; carry elapsed and steps.
      const resultCount = getResultCount(part.result);
      const count = isAgent
        ? (liveStatus?.stepCount ?? resultCount)
        : resultCount;

      return {
        key: partLike.toolCallId ?? `${part.toolName}-${index}`,
        label,
        badgeStatus: isCanonicalTerminal ? canonicalStatus : (liveStatus ? phaseToBadgeStatus(liveStatus.phase) : canonicalStatus),
        phase,
        count,
        detail,
        inputPreview,
        outputPreview,
        elapsedMs: isAgent ? liveStatus?.elapsedMs : undefined,
        // Clear startedAt when tool completed (stops the live timer).
        // The final elapsedMs is preserved above for display.
        startedAt: isAgent && !isCanonicalTerminal ? liveStatus?.startedAt : undefined,
        steps: isAgent ? liveStatus?.steps : undefined,
      };
    });
  }, [liveStatuses, registryNames, t, toolParts]);

  // Live elapsed ticker: tick every second while any Agent tool is still running with a startedAt.
  const [, setTickMs] = useState(0);
  useEffect(() => {
    const hasRunningAgent = summaryItems.some(
      (item) => item.badgeStatus === "running" && item.startedAt != null
    );
    if (!hasRunningAgent) return;
    const id = setInterval(() => setTickMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [summaryItems]);

  const hasMedia = mediaPreviews.length > 0;
  const hasCompactReveal = !isDetailedMode && summaryItems.some(
    (item) => item.phase !== "error" && (item.detail || item.inputPreview || item.outputPreview)
  );
  const showCompactReveal = hasCompactReveal && !isExpanded && (isCompactRevealHovered || isCompactRevealPinned);
  const showChildren = isDetailedMode || isExpanded;

  useEffect(() => {
    if (toolGroupExpansionState.has(expansionKey)) {
      setIsExpanded(Boolean(toolGroupExpansionState.get(expansionKey)));
      return;
    }
    setIsExpanded(false);
  }, [expansionKey]);

  useEffect(() => {
    if ((isDetailedMode || hasMedia || hasInteractiveUI) && !toolGroupExpansionState.has(expansionKey)) {
      setIsExpanded(true);
      toolGroupExpansionState.set(expansionKey, true);
      pruneExpansionState();
    }
  }, [expansionKey, hasInteractiveUI, hasMedia, isDetailedMode]);

  const expansionCtx = useToolExpansion();
  const lastSignalRef = useRef(0);
  useEffect(() => {
    if (!expansionCtx || expansionCtx.signal.counter === 0) return;
    if (expansionCtx.signal.counter === lastSignalRef.current) return;
    lastSignalRef.current = expansionCtx.signal.counter;
    const next = expansionCtx.signal.mode === "expand";
    setIsExpanded(next);
    toolGroupExpansionState.set(expansionKey, next);
    pruneExpansionState();
  }, [expansionCtx?.signal, expansionKey]);

  useEffect(() => {
    if (isDetailedMode) {
      setIsCompactRevealPinned(false);
      setIsCompactRevealHovered(false);
    }
  }, [isDetailedMode]);

  const handleToggleExpanded = () => {
    setIsExpanded((previous) => {
      const next = !previous;
      toolGroupExpansionState.set(expansionKey, next);
      pruneExpansionState();
      return next;
    });
  };

  const handleCompactPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isDetailedMode || event.pointerType === "mouse" || !hasCompactReveal) return;
    setIsCompactRevealPinned((previous) => !previous);
  };

  if (toolParts.length === 0) {
    return <>{children}</>;
  }

  return (
    <div
      className={cn(
        "my-2 border-l-2 pl-3 transition-all duration-150 ease-in-out",
        isGlass ? "border-white/20" : "border-terminal-dark/15"
      )}
      onMouseEnter={() => setIsCompactRevealHovered(true)}
      onMouseLeave={() => setIsCompactRevealHovered(false)}
      onFocusCapture={() => setIsCompactRevealHovered(true)}
      onBlurCapture={() => setIsCompactRevealHovered(false)}
    >
      <div
        className="flex flex-wrap items-center gap-2 pb-1"
        onPointerDown={handleCompactPointerDown}
      >
        {summaryItems.map((item) => {
          // Live elapsed: use startedAt tick while running, fall back to static elapsedMs on completion.
          const liveElapsedMs = item.badgeStatus === "running" && item.startedAt != null
            ? Date.now() - item.startedAt
            : item.elapsedMs;
          return (
            <ToolCallBadge
              key={item.key}
              label={item.label}
              status={item.badgeStatus}
              count={item.count}
              elapsed={liveElapsedMs != null && liveElapsedMs > 1000 ? formatElapsed(liveElapsedMs) : undefined}
            />
          );
        })}
      </div>

      {showCompactReveal && (
        <div className={cn("mt-2 space-y-2 border-t pt-2", isGlass ? "border-white/10" : "border-terminal-dark/10")}>
          {summaryItems.map((item) => {
            if (item.phase === "error") return null;
            const previewText = item.detail
              ?? (item.phase === "completed"
                ? item.outputPreview ?? item.inputPreview
                : item.inputPreview ?? item.outputPreview);
            if (!previewText) return null;

            return (
              <div
                key={`reveal-${item.key}`}
                className={cn(
                  "rounded-md border px-3 py-2 font-mono text-xs shadow-sm",
                  phaseToAccentClass(item.phase)
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{item.label}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    {(() => {
                      const revealElapsedMs = item.badgeStatus === "running" && item.startedAt != null
                        ? Date.now() - item.startedAt
                        : item.elapsedMs;
                      return revealElapsedMs != null && revealElapsedMs > 1000 ? (
                        <span className="tabular-nums text-[10px] opacity-70">
                          {formatElapsed(revealElapsedMs)}
                        </span>
                      ) : null;
                    })()}
                    <span className="text-[10px] uppercase tracking-[0.14em] opacity-80">
                      {phaseToStatusText(tStatus, item.phase)}
                    </span>
                  </div>
                </div>
                {previewText && (
                  <p className="mt-1 text-[11px] leading-relaxed opacity-90 [overflow-wrap:anywhere]">
                    {previewText}
                  </p>
                )}
                {item.steps && item.steps.length > 0 && (
                  <ol className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed opacity-85">
                    {item.steps.slice(0, 6).map((step, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="shrink-0 tabular-nums opacity-50">{i + 1}.</span>
                        <span className="[overflow-wrap:anywhere]">{step}</span>
                      </li>
                    ))}
                    {item.steps.length > 6 && (
                      <li className="opacity-50">+{item.steps.length - 6} more</li>
                    )}
                  </ol>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!showChildren && mediaPreviews.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {mediaPreviews.map((media, index) =>
            media.type === "image" ? (
              <a
                key={`${media.url}-${index}`}
                href={media.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                <img
                  src={media.url}
                  alt={t("toolOutputPreview", { index: index + 1 })}
                  className="h-24 w-auto rounded-md border border-terminal-dark/10 object-cover shadow-sm"
                />
              </a>
            ) : (
              <video
                key={`${media.url}-${index}`}
                src={media.url}
                controls
                className="h-24 w-auto rounded-md border border-terminal-dark/10 shadow-sm"
              />
            )
          )}
        </div>
      )}

      {isDetailedMode && (
        <div className={cn("mt-2 space-y-2 border-t pt-2", isGlass ? "border-white/10" : "border-terminal-dark/10")}>
          {summaryItems.map((item) => (
            <div
              key={`detailed-${item.key}`}
              className={cn(
                "rounded-lg border px-3 py-2.5 font-mono shadow-sm",
                phaseToAccentClass(item.phase)
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold uppercase tracking-[0.14em] opacity-80">
                    {item.label}
                  </div>
                  {(item.detail || item.inputPreview || item.outputPreview) && (
                    <p className="mt-1 text-sm leading-relaxed [overflow-wrap:anywhere]">
                      {item.detail
                        ?? (item.phase === "completed"
                          ? item.outputPreview ?? item.inputPreview
                          : item.inputPreview ?? item.outputPreview)}
                    </p>
                  )}
                </div>
                <div className="shrink-0 rounded-full border border-current/15 bg-white/30 px-2 py-1 text-[10px] uppercase tracking-[0.14em]">
                  {phaseToStatusText(tStatus, item.phase)}
                </div>
              </div>
              {item.inputPreview && item.detail !== item.inputPreview && (
                <div className="mt-2 text-[11px] opacity-85">
                  <span className="font-semibold">Input:</span> {item.inputPreview}
                </div>
              )}
              {item.outputPreview && item.detail !== item.outputPreview && item.outputPreview !== item.inputPreview && (
                <div className="mt-1 text-[11px] opacity-85">
                  <span className="font-semibold">Output:</span> {item.outputPreview}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-1 flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleToggleExpanded}
          className={cn(
            "h-6 px-2 text-[11px] font-mono rounded-md",
            isGlass
              ? "text-white/50 hover:text-white/80 hover:bg-white/5"
              : "text-terminal-muted/70 hover:text-terminal-dark hover:bg-terminal-dark/5"
          )}
        >
          {showChildren ? t("hide") : t("details")}
          {showChildren ? (
            <ChevronUpIcon className="ml-1 size-3" />
          ) : (
            <ChevronDownIcon className="ml-1 size-3" />
          )}
        </Button>
      </div>

      {showChildren && (
        <div className={cn("mt-2 border-t pt-2", isGlass ? "border-white/10" : "border-terminal-dark/10")}>
          {children}
        </div>
      )}
    </div>
  );
};

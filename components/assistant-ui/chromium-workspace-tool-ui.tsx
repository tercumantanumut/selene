"use client";

import { memo, useEffect, useMemo, useState, type FC } from "react";
import {
  CaretDown,
  CaretRight,
  CheckCircle,
  XCircle,
  CircleNotch,
  Play,
  Clock,
} from "@phosphor-icons/react";
import {
  getActionIcon,
  getActionLabel,
  truncateUrl,
} from "@/components/browser-session/browser-action-helpers";
import { cn } from "@/lib/utils";
import { useChatSessionId } from "@/components/chat-provider";
import { useBrowserActive } from "./browser-active-context";
import { type ActionRecord } from "@/lib/browser/action-history";

// ─── Types ────────────────────────────────────────────────────────────────────

type ToolCallContentPartComponent = FC<{
  toolName: string;
  argsText?: string;
  args?: ChromiumWorkspaceArgs;
  result?: ChromiumWorkspaceResult;
  state?: string;
}>;

interface ChromiumWorkspaceArgs {
  action?: string;
  url?: string;
  selector?: string;
  text?: string;
  expression?: string;
  timeout?: number;
  viewportPreset?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  orientation?: "portrait" | "landscape";
  resetViewport?: boolean;
}

interface HistorySummary {
  sessionId: string;
  agentId?: string;
  startedAt: string;
  endedAt?: string;
  totalDurationMs?: number;
  totalActions: number;
  successfulActions: number;
  failedActions: number;
  actions?: ActionRecord[];
}

interface ChromiumWorkspaceResult {
  status: "success" | "error";
  action?: string;
  durationMs?: number;
  data?: unknown;
  pageUrl?: string;
  pageTitle?: string;
  viewport?: { width: number; height: number; orientation?: string; label?: string; preset?: string };
  error?: string;
}

// ─── Action icon mapping ──────────────────────────────────────────────────────
// Imported from browser-action-helpers.ts

// ─── Human-readable summaries ─────────────────────────────────────────────────

/**
 * Parse CSS selector into a human-readable target description.
 * Examples:
 *   button:has-text("Continue")  → `"Continue" button`
 *   input[type="password"]       → `password field`
 *   input[placeholder*="email"]  → `email field`
 *   #login-form                  → `#login-form`
 */
function humanizeSelector(selector: string): string {
  if (!selector) return "";

  // Try has-text("...") — most descriptive
  const hasTextMatch = selector.match(/:has-text\("([^"]+)"\)/);
  if (hasTextMatch) {
    return `"${hasTextMatch[1]}"`;
  }

  // Try placeholder*="..."
  const placeholderMatch = selector.match(/placeholder\*?="([^"]+)"/i);
  if (placeholderMatch) {
    return `${placeholderMatch[1].toLowerCase()} field`;
  }

  // Try type="..."
  const typeMatch = selector.match(/type="([^"]+)"/);
  if (typeMatch) {
    return `${typeMatch[1]} field`;
  }

  // Try name="..."
  const nameMatch = selector.match(/name="([^"]+)"/);
  if (nameMatch) {
    return `${nameMatch[1]} field`;
  }

  // Try role="..."
  const roleMatch = selector.match(/role="([^"]+)"/);
  if (roleMatch) {
    return roleMatch[1];
  }

  // For compound selectors (comma-separated), parse only the first
  const firstSelector = selector.split(",")[0].trim();
  if (firstSelector !== selector) {
    return humanizeSelector(firstSelector);
  }

  // Short enough to show as-is
  if (selector.length <= 25) return selector;

  return selector.slice(0, 22) + "...";
}

function getViewportSummary(args?: ChromiumWorkspaceArgs): string {
  if (!args) return "viewport";
  if (args.resetViewport) return "default desktop viewport";
  const preset = args.viewportPreset ? `${args.viewportPreset}` : "custom";
  const size = args.viewportWidth && args.viewportHeight
    ? `${args.viewportWidth}×${args.viewportHeight}`
    : args.viewportWidth
      ? `${args.viewportWidth}px wide`
      : args.viewportHeight
        ? `${args.viewportHeight}px tall`
        : "";
  const orientation = args.orientation ? ` ${args.orientation}` : "";
  return `${preset}${size ? ` ${size}` : ""}${orientation}`.trim();
}

function getHumanSummary(args?: ChromiumWorkspaceArgs): string {
  if (!args?.action) return "Browser action";

  switch (args.action) {
    case "open":
    case "navigate":
      return args.url ? truncateUrl(args.url, 40) : args.action === "open" ? "Opening browser" : "Navigating";
    case "click": {
      const target = args.selector ? humanizeSelector(args.selector) : "";
      return target ? `Clicking ${target}` : "Clicking";
    }
    case "type": {
      const field = args.selector ? humanizeSelector(args.selector) : "field";
      // Mask password fields
      const isPassword = args.selector?.includes('type="password"') || args.selector?.includes("password");
      if (isPassword) return `Typing into ${field}`;
      const text = args.text ? `"${args.text.slice(0, 20)}${(args.text.length ?? 0) > 20 ? "..." : ""}"` : "";
      return text ? `Typing ${text} into ${field}` : `Typing into ${field}`;
    }
    case "snapshot":
      return "Capturing page snapshot";
    case "extract": {
      const extractTarget = args.selector ? humanizeSelector(args.selector) : "";
      return extractTarget ? `Extracting ${extractTarget}` : "Extracting content";
    }
    case "evaluate":
      return args.expression
        ? `Running: ${args.expression.slice(0, 30)}${args.expression.length > 30 ? "..." : ""}`
        : "Running JS";
    case "setViewport":
      return `Setting ${getViewportSummary(args)}`;
    case "resetViewport":
      return "Resetting to desktop viewport";
    case "close":
      return "Closing session";
    default:
      return args.action;
  }
}

/** Legacy raw summary — still used for full card details view */
function getActionSummary(args?: ChromiumWorkspaceArgs): string {
  if (!args?.action) return "Browser action";

  switch (args.action) {
    case "open":
    case "navigate":
      return args.url
        ? truncateUrl(args.url, 50)
        : args.action === "open" ? "Opening browser..." : "Navigating...";
    case "click":
      return args.selector ? `→ ${args.selector}` : "Clicking...";
    case "type":
      return args.selector
        ? `→ ${args.selector}: "${(args.text ?? "").slice(0, 30)}${(args.text?.length ?? 0) > 30 ? "..." : ""}"`
        : "Typing...";
    case "snapshot":
      return "Capturing accessibility tree";
    case "extract":
      return args.selector ? `→ ${args.selector}` : "Extracting...";
    case "evaluate":
      return args.expression
        ? `${args.expression.slice(0, 40)}${args.expression.length > 40 ? "..." : ""}`
        : "Running JS...";
    case "setViewport":
      return getViewportSummary(args);
    case "resetViewport":
      return "Default desktop viewport";
    case "close":
      return "Closing session";
    default:
      return args.action;
  }
}

function formatUnknown(value: unknown, maxLen: number): string {
  if (typeof value === "string") return value.slice(0, maxLen);
  try {
    return (JSON.stringify(value, null, 2) ?? "null").slice(0, maxLen);
  } catch {
    return String(value).slice(0, maxLen);
  }
}

// ─── Compact action row (glass mode) ─────────────────────────────────────────

/** Minimal single-line row for completed actions during live backdrop */
const CompactActionRow: FC<{
  args?: ChromiumWorkspaceArgs;
  result?: ChromiumWorkspaceResult;
}> = memo(({ args, result }) => {
  const isRunning = result === undefined;
  const parsed = result as ChromiumWorkspaceResult | undefined;
  const isError = parsed?.status === "error";
  const ActionIcon = getActionIcon(args?.action ?? "open");
  const summary = getHumanSummary(args);

  return (
    <div className="flex items-center gap-2 px-2 py-1 font-mono">
      {/* Status icon */}
      {isRunning ? (
        <CircleNotch className="size-3 animate-spin text-green-400 shrink-0" weight="bold" />
      ) : isError ? (
        <XCircle className="size-3 text-red-400 shrink-0" weight="fill" />
      ) : (
        <CheckCircle className="size-3 text-green-400 shrink-0" weight="fill" />
      )}

      {/* Action icon */}
      <ActionIcon className="size-3 text-white/60 shrink-0" weight="bold" />

      {/* Label */}
      <span className="text-xs text-white/80 font-medium shrink-0">
        {getActionLabel(args?.action ?? "")}
      </span>

      {/* Summary */}
      <span className="text-xs text-white/50 truncate">
        {summary}
      </span>

      {/* Duration */}
      {parsed?.durationMs != null && (
        <span className="ml-auto text-[10px] text-white/30 font-mono shrink-0">
          {parsed.durationMs}ms
        </span>
      )}

      {/* Running indicator */}
      {isRunning && (
        <span className="ml-auto text-[10px] text-green-400/80 font-mono shrink-0">
          running...
        </span>
      )}
    </div>
  );
});
CompactActionRow.displayName = "CompactActionRow";

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Single action row in the execution timeline */
const ActionTimelineRow: FC<{
  record: ActionRecord;
  isExpanded: boolean;
  onToggle: () => void;
}> = memo(({ record, isExpanded, onToggle }) => {
  const Icon = getActionIcon(record.action);

  return (
    <div className="group">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-terminal-dark/5 transition-colors"
      >
        {/* Expand indicator */}
        {isExpanded ? (
          <CaretDown className="size-3 text-terminal-muted shrink-0" weight="bold" />
        ) : (
          <CaretRight className="size-3 text-terminal-muted shrink-0" weight="bold" />
        )}

        {/* Sequence number */}
        <span className="text-[10px] text-terminal-muted/60 font-mono w-4 shrink-0 text-right">
          {record.seq}
        </span>

        {/* Action icon */}
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            record.success ? "text-terminal-green" : "text-red-500"
          )}
          weight="bold"
        />

        {/* Action label + summary */}
        <span className="text-xs font-mono text-terminal-dark truncate">
          <span className="font-medium">{getActionLabel(record.action)}</span>
          {record.pageUrl && (
            <span className="text-terminal-muted ml-1.5">
              {truncateUrl(record.pageUrl, 35)}
            </span>
          )}
        </span>

        {/* Status + duration */}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {record.success ? (
            <CheckCircle className="size-3 text-terminal-green" weight="fill" />
          ) : (
            <XCircle className="size-3 text-red-500" weight="fill" />
          )}
          <span className="text-[10px] text-terminal-muted/60 font-mono">
            {record.durationMs}ms
          </span>
        </span>
      </button>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="ml-9 mr-2 mb-1 space-y-1">
          {/* Input params */}
          {Object.keys(record.input).length > 1 && (
            <div className="text-[10px] font-mono text-terminal-muted">
              <span className="text-terminal-muted/60">input: </span>
              <span className="text-terminal-dark">
                {JSON.stringify(
                  Object.fromEntries(
                    Object.entries(record.input).filter(([k]) => k !== "action")
                  )
                )}
              </span>
            </div>
          )}

          {/* Output preview */}
          {record.output != null && (
            <details className="text-[10px] font-mono text-terminal-muted">
              <summary className="cursor-pointer hover:text-terminal-dark">
                output
              </summary>
              <pre className="mt-1 max-h-32 overflow-y-auto rounded bg-terminal-dark/5 p-1.5 text-terminal-dark whitespace-pre-wrap break-words">
                {formatUnknown(record.output, 1000)}
              </pre>
            </details>
          )}

          {/* DOM Snapshot preview */}
          {record.domSnapshot && (
            <details className="text-[10px] font-mono text-terminal-muted">
              <summary className="cursor-pointer hover:text-terminal-dark">
                dom snapshot ({record.domSnapshot.length} chars)
              </summary>
              <pre className="mt-1 max-h-32 overflow-y-auto rounded bg-terminal-dark/5 p-1.5 text-terminal-dark whitespace-pre-wrap break-words">
                {record.domSnapshot.slice(0, 1000)}
              </pre>
            </details>
          )}

          {/* Error message */}
          {record.error && (
            <div className="text-[10px] font-mono text-red-600 bg-red-50 rounded p-1.5">
              {record.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
ActionTimelineRow.displayName = "ActionTimelineRow";

/** Full execution history panel (shown on close) */
const ExecutionHistory: FC<{ history: HistorySummary }> = memo(({ history }) => {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [showTimeline, setShowTimeline] = useState(true);

  const toggleRow = (seq: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {/* Summary bar */}
      <div className="flex items-center gap-3 text-xs font-mono">
        <span className="flex items-center gap-1 text-terminal-green">
          <CheckCircle className="size-3" weight="fill" />
          {history.successfulActions}
        </span>
        {history.failedActions > 0 && (
          <span className="flex items-center gap-1 text-red-500">
            <XCircle className="size-3" weight="fill" />
            {history.failedActions}
          </span>
        )}
        {history.totalDurationMs != null && (
          <span className="flex items-center gap-1 text-terminal-muted">
            <Clock className="size-3" />
            {(history.totalDurationMs / 1000).toFixed(1)}s total
          </span>
        )}
        {history.agentId && (
          <span className="text-terminal-muted/60 text-[10px] ml-auto truncate max-w-[120px]">
            agent: {history.agentId.slice(0, 8)}…
          </span>
        )}
      </div>

      {/* Timeline toggle */}
      {history.actions && history.actions.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowTimeline(!showTimeline)}
            className="flex items-center gap-1 text-xs font-mono text-terminal-muted hover:text-terminal-dark transition-colors"
          >
            {showTimeline ? (
              <CaretDown className="size-3" weight="bold" />
            ) : (
              <CaretRight className="size-3" weight="bold" />
            )}
            <Play className="size-3" weight="fill" />
            Execution Timeline ({history.actions.length} actions)
          </button>

          {showTimeline && (
            <div className="rounded-lg border border-terminal-dark/10 bg-white/50 divide-y divide-terminal-dark/5">
              {history.actions.map((record) => (
                <ActionTimelineRow
                  key={record.seq}
                  record={record}
                  isExpanded={expandedRows.has(record.seq)}
                  onToggle={() => toggleRow(record.seq)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
});
ExecutionHistory.displayName = "ExecutionHistory";

// ─── Main Component ───────────────────────────────────────────────────────────

export const ChromiumWorkspaceToolUI: ToolCallContentPartComponent = memo(({
  args,
  result,
}) => {
  const sessionId = useChatSessionId();
  const { isBrowserActive } = useBrowserActive();
  const isRunning = result === undefined;
  const parsed = result as ChromiumWorkspaceResult | undefined;
  const isClose = args?.action === "close";
  const isReplay = args?.action === "replay";
  const isError = parsed?.status === "error";

  // Notify BrowserBackdrop during foreground streaming that a chromium tool is active.
  // background-task-progress events only fire in background mode, so foreground streams
  // need this bridge to activate the workspace panel.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("browser-tool-detected", {
        detail: { active: isRunning && !isClose, sessionId },
      })
    );
  }, [isRunning, isClose]);

  // In glass/compact mode: render a single-line row for non-close/non-replay completed actions
  const useCompact = isBrowserActive && !isClose && !isReplay;

  // Extract history from close action result
  const history = useMemo<HistorySummary | null>(() => {
    if (!isClose || !parsed?.data) return null;
    const d = parsed.data as { history?: HistorySummary };
    return d.history ?? null;
  }, [isClose, parsed]);

  // Extract replay results
  const replayData = useMemo(() => {
    if (!isReplay || !parsed?.data) return null;
    return parsed.data as {
      message?: string;
      totalActions?: number;
      successfulActions?: number;
      failedActions?: number;
      outputMatchCount?: number | null;
      aborted?: boolean;
      results?: Array<{
        action: string;
        seq: number;
        originalOutput: unknown;
        replayOutput: unknown;
        outputMatches: boolean;
        success: boolean;
        error?: string;
      }>;
    };
  }, [isReplay, parsed]);

  // ── Compact mode: single-line row ──
  if (useCompact) {
    return <CompactActionRow args={args} result={result as ChromiumWorkspaceResult | undefined} />;
  }

  // ── Full card mode (default / non-active backdrop) ──
  const ActionIcon = getActionIcon(args?.action ?? "open");
  const summary = isBrowserActive ? getHumanSummary(args) : getActionSummary(args);

  return (
    <div
      className={cn(
        "my-2 rounded-lg p-3 font-mono shadow-sm transition-all duration-150",
        isBrowserActive
          ? "bg-black/20 backdrop-blur-md border border-white/10"
          : "bg-terminal-cream/80",
        isRunning && "animate-pulse"
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        {isRunning ? (
          <CircleNotch
            className={cn("size-4 animate-spin", isBrowserActive ? "text-green-400" : "text-terminal-green")}
            weight="bold"
          />
        ) : isError ? (
          <XCircle className="size-4 text-red-500" weight="fill" />
        ) : (
          <ActionIcon className={cn("size-4", isBrowserActive ? "text-green-400" : "text-terminal-green")} weight="bold" />
        )}

        <span className={cn("text-sm font-medium", isBrowserActive ? "text-white" : "text-terminal-dark")}>
          {isClose ? "Browser Session" : getActionLabel(args?.action ?? "")}
        </span>

        {/* Status badge */}
        <span
          className={cn(
            "ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-medium",
            isRunning
              ? isBrowserActive ? "bg-green-400/20 text-green-400" : "bg-terminal-green/10 text-terminal-green"
              : isError
                ? "bg-red-50 text-red-600"
                : isBrowserActive ? "bg-green-400/20 text-green-400" : "bg-terminal-green/10 text-terminal-green"
          )}
        >
          {isRunning ? "running" : isError ? "failed" : "done"}
        </span>

        {/* Duration */}
        {parsed?.durationMs != null && (
          <span className={cn("text-[10px]", isBrowserActive ? "text-white/40" : "text-terminal-muted/60")}>
            {parsed.durationMs}ms
          </span>
        )}
      </div>

      {/* Action summary (non-close) */}
      {!isClose && (
        <div className={cn("text-xs ml-6 mb-1 truncate", isBrowserActive ? "text-white/50" : "text-terminal-muted")}>
          {summary}
        </div>
      )}

      {/* Page info */}
      {parsed?.pageUrl && !isClose && (
        <div className={cn("text-[10px] ml-6 truncate", isBrowserActive ? "text-white/30" : "text-terminal-muted/60")}>
          {parsed.pageTitle && (
            <span className={cn("mr-2", isBrowserActive ? "text-white/60" : "text-terminal-dark")}>{parsed.pageTitle}</span>
          )}
          {truncateUrl(parsed.pageUrl, 60)}
        </div>
      )}

      {/* Error display */}
      {isError && parsed?.error && (
        <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-600 font-mono">
          {parsed.error}
        </div>
      )}

      {/* Snapshot data (collapsible) */}
      {!isClose && parsed?.data != null && typeof parsed.data === "object" && "accessibilityTree" in (parsed.data as Record<string, unknown>) && (
        <details className={cn("mt-2 text-xs", isBrowserActive ? "text-white/50" : "text-terminal-muted")}>
          <summary className={cn("cursor-pointer ml-6", isBrowserActive ? "hover:text-white/80" : "hover:text-terminal-dark")}>
            View accessibility tree
          </summary>
          <pre className={cn("mt-1 ml-6 max-h-48 overflow-y-auto rounded p-2 text-[10px] whitespace-pre-wrap break-words", isBrowserActive ? "bg-black/20 text-white/70" : "bg-terminal-dark/5 text-terminal-dark")}>
            {((parsed.data as Record<string, unknown>).accessibilityTree as string)?.slice(0, 3000)}
          </pre>
        </details>
      )}

      {/* Extract/evaluate data (collapsible) */}
      {!isClose && parsed?.data != null && typeof parsed.data === "string" && (parsed.data as string).length > 80 && (
        <details className={cn("mt-2 text-xs", isBrowserActive ? "text-white/50" : "text-terminal-muted")}>
          <summary className={cn("cursor-pointer ml-6", isBrowserActive ? "hover:text-white/80" : "hover:text-terminal-dark")}>
            View output
          </summary>
          <pre className={cn("mt-1 ml-6 max-h-48 overflow-y-auto rounded p-2 text-[10px] whitespace-pre-wrap break-words", isBrowserActive ? "bg-black/20 text-white/70" : "bg-terminal-dark/5 text-terminal-dark")}>
            {(parsed.data as string).slice(0, 3000)}
          </pre>
        </details>
      )}

      {/* Execution History (close action with full history) */}
      {isClose && history && (
        <div className={cn("mt-2 border-t pt-2", isBrowserActive ? "border-white/10" : "border-terminal-dark/10")}>
          <ExecutionHistory history={history} />
        </div>
      )}

      {/* Replay Results */}
      {isReplay && replayData && (
        <div className={cn("mt-2 border-t pt-2 space-y-2", isBrowserActive ? "border-white/10" : "border-terminal-dark/10")}>
          <div className={cn("text-xs font-mono", isBrowserActive ? "text-white" : "text-terminal-dark")}>
            {replayData.message}
          </div>
          <div className="flex items-center gap-3 text-xs font-mono">
            <span className="flex items-center gap-1 text-terminal-green">
              <CheckCircle className="size-3" weight="fill" />
              {replayData.successfulActions ?? 0}
            </span>
            {(replayData.failedActions ?? 0) > 0 && (
              <span className="flex items-center gap-1 text-red-500">
                <XCircle className="size-3" weight="fill" />
                {replayData.failedActions}
              </span>
            )}
            {replayData.outputMatchCount != null && (
              <span className="text-terminal-muted">
                {replayData.outputMatchCount}/{replayData.totalActions} outputs match
              </span>
            )}
            {replayData.aborted && (
              <span className="text-red-500 text-[10px]">ABORTED</span>
            )}
          </div>
          {replayData.results && replayData.results.length > 0 && (
            <details className="text-xs text-terminal-muted">
              <summary className="cursor-pointer hover:text-terminal-dark">
                View replay details ({replayData.results.length} actions)
              </summary>
              <div className="mt-1 space-y-1">
                {replayData.results.map((r) => (
                  <div
                    key={r.seq}
                    className={cn(
                      "flex items-center gap-2 px-2 py-0.5 rounded text-[10px] font-mono",
                      r.success ? "text-terminal-dark" : "text-red-600 bg-red-50/50"
                    )}
                  >
                    <span className="w-4 text-right text-terminal-muted/60">{r.seq}</span>
                    {r.success ? (
                      <CheckCircle className="size-2.5 text-terminal-green shrink-0" weight="fill" />
                    ) : (
                      <XCircle className="size-2.5 text-red-500 shrink-0" weight="fill" />
                    )}
                    <span>{getActionLabel(r.action)}</span>
                    {r.outputMatches === false && (
                      <span className="text-amber-600 ml-auto">output mismatch</span>
                    )}
                    {r.error && (
                      <span className="text-red-500 ml-auto truncate max-w-[200px]">{r.error}</span>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
});
ChromiumWorkspaceToolUI.displayName = "ChromiumWorkspaceToolUI";

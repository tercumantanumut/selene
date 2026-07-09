"use client";

import { type FC, useEffect, useRef, useState } from "react";
import {
  CheckCircleIcon,
  XCircleIcon,
  UsersIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToolExpansion } from "../tool-expansion-context";
import { parseTextResult } from "./parse-text-result";
import { useTranslations } from "next-intl";

type ToolCallContentPartComponent = FC<{
  toolName: string;
  argsText?: string;
  state?: string;
  active?: boolean;
  args?: {
    action?: string;
    agentName?: string;
    agentId?: string;
    task?: string;
    context?: string;
    delegationId?: string;
    mode?: string;
    waitSeconds?: number;
    followUpMessage?: string;
    resume?: string;
    [key: string]: unknown;
  };
  result?: unknown;
}>;

interface DelegationResult {
  completed?: boolean;
  running?: boolean;
  status?: string;
  delegationId?: string;
  delegateAgent?: string;
  lastResponse?: string;
  result?: string;
  allResponses?: string[];
  error?: string;
  isError?: boolean;
  content?: unknown;
  summary?: string;
  message?: string;
  [key: string]: unknown;
}

function extractDelegationResult(result: unknown): DelegationResult {
  if (!result) return {};
  if (typeof result === "string") {
    try {
      return JSON.parse(result) as DelegationResult;
    } catch {
      return { result: result };
    }
  }
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    // Handle MCP content wrapper
    const text = parseTextResult(result);
    if (text && r.status === undefined && !r.completed && !r.delegationId && !r.lastResponse) {
      try {
        return JSON.parse(text) as DelegationResult;
      } catch {
        return { result: text };
      }
    }
    return r as DelegationResult;
  }
  return {};
}

function isErrorResult(dr: DelegationResult): boolean {
  if (dr.isError === true) return true;
  if (dr.error) return true;
  if (dr.status === "error") return true;
  return false;
}

/**
 * Dedicated UI for `delegateToSubagent` tool calls.
 * Shows agent name, delegation status, action, and result content.
 */
export const DelegationToolUI: ToolCallContentPartComponent = ({ args, result, state, active }) => {
  const t = useTranslations("assistantUi.claudeTools.delegation");
  const [expanded, setExpanded] = useState(false);

  const expansionCtx = useToolExpansion();
  const lastSignalRef = useRef(0);
  useEffect(() => {
    if (!expansionCtx || expansionCtx.signal.counter === 0) return;
    if (expansionCtx.signal.counter === lastSignalRef.current) return;
    lastSignalRef.current = expansionCtx.signal.counter;
    setExpanded(expansionCtx.signal.mode === "expand");
  }, [expansionCtx?.signal]);

  const action = args?.action || "start";
  const agentName = args?.agentName || "Sub-agent";
  const task = args?.task;
  const delegationIdFromArgs = args?.delegationId;

  const dr = extractDelegationResult(result);
  const isProjectedPending = active === true && state === "input-available" && result === undefined;
  const isRunning = isProjectedPending || result === undefined;
  const isStopped = dr.status === "stopped";
  const isWaiting = isProjectedPending || dr.running === true || (dr.completed !== true && dr.status === "waiting");
  const hasError = !isWaiting && !isStopped && isErrorResult(dr);
  const delegationId = dr.delegationId || delegationIdFromArgs;
  const resolvedAgentName = dr.delegateAgent || agentName;

  // Extract the main content to display.
  // Observe action returns `lastResponse` (full final text) + `allResponses` (preview list).
  // Start/continue/answer actions return `message` (status text).
  // Fallback: if allResponses has entries but lastResponse is missing, use the last entry.
  const mainContent =
    dr.lastResponse ||
    dr.result ||
    (dr.allResponses && dr.allResponses.length > 0
      ? dr.allResponses[dr.allResponses.length - 1]
      : undefined) ||
    parseTextResult(result) ||
    dr.message ||
    dr.summary ||
    "";

  const DISPLAY_LIMIT = 10_000;
  const displayContent =
    mainContent && mainContent.length > DISPLAY_LIMIT
      ? mainContent.substring(0, DISPLAY_LIMIT) +
        `\n\n... [${(mainContent.length - DISPLAY_LIMIT).toLocaleString()} more characters]`
      : mainContent;

  // M6: `isWaiting` can be true when `isRunning` is false (result arrived
  // but dr.running === true, e.g. observe result for an in-flight delegation).
  // Show spinner for both running and waiting states, not a green check.
  const showSpinner = isRunning || isWaiting;

  const StatusIcon = showSpinner
    ? null
    : hasError
      ? XCircleIcon
      : CheckCircleIcon;

  const statusColor = showSpinner
    ? "text-terminal-muted"
    : hasError
      ? "text-red-600 dark:text-red-400"
      : isStopped
        ? "text-amber-700 dark:text-amber-300"
        : "text-emerald-600 dark:text-emerald-400";

  const statusLabel = isWaiting
    ? t("waiting", { agent: resolvedAgentName })
    : isRunning
      ? t("delegating", { agent: resolvedAgentName })
    : hasError
      ? t("failed", { agent: resolvedAgentName })
      : isStopped
        ? t("stopped", { agent: resolvedAgentName })
        : t("done", { agent: resolvedAgentName });

  return (
    <div className="my-1 rounded-md border border-border bg-terminal-cream/50 dark:bg-terminal-cream/80 font-mono text-xs overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent/30 transition-colors text-left"
      >
        {StatusIcon && (
          <StatusIcon className={cn("h-3.5 w-3.5 shrink-0", statusColor)} />
        )}
        {!StatusIcon && showSpinner && (
          <Loader2Icon className="h-3.5 w-3.5 shrink-0 text-terminal-muted animate-spin" />
        )}
        <UsersIcon className="h-3 w-3 shrink-0 text-terminal-muted" />
        <span className="text-terminal-muted">{statusLabel}</span>

        {action !== "start" && (
          <span className="text-[10px] text-terminal-muted shrink-0 bg-terminal-dark/5 dark:bg-terminal-dark/[0.06] rounded px-1 py-0.5">
            {action}
          </span>
        )}

        {isWaiting && (
          <span className="text-[10px] shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-amber-700 dark:text-amber-300">
            {t("waitingBadge")}
          </span>
        )}

        {delegationId && (
          <span
            className="text-[10px] text-terminal-muted shrink-0 truncate max-w-[120px]"
            title={delegationId}
          >
            {delegationId.slice(0, 8)}
          </span>
        )}

        {expanded ? (
          <ChevronDownIcon className="h-3 w-3 shrink-0 text-terminal-muted ml-auto" />
        ) : (
          <ChevronRightIcon className="h-3 w-3 shrink-0 text-terminal-muted ml-auto" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          {task && (
            <div className="space-y-1">
              <div className="text-[10px] text-terminal-muted uppercase tracking-wider">
                {t("task")}
              </div>
              <pre className="rounded bg-terminal-dark/5 dark:bg-terminal-dark/[0.06] p-2 overflow-x-auto max-h-48 overflow-y-auto text-terminal-dark dark:text-terminal-dark/90 whitespace-pre-wrap break-all font-mono text-[11px]">
                {task.length > 2000
                  ? task.substring(0, 2000) +
                    `\n\n... [${(task.length - 2000).toLocaleString()} more characters]`
                  : task}
              </pre>
            </div>
          )}

          {displayContent && !hasError && (
            <div className="space-y-1">
              <div className="text-[10px] text-terminal-muted uppercase tracking-wider">
                {t("result")}
              </div>
              <pre className="rounded bg-terminal-dark/5 dark:bg-terminal-dark/[0.06] p-2 overflow-x-auto max-h-96 overflow-y-auto text-terminal-dark dark:text-terminal-dark/90 whitespace-pre-wrap break-all font-mono text-[11px]">
                {displayContent}
              </pre>
            </div>
          )}

          {dr.allResponses && dr.allResponses.length > 1 && mainContent && (
            <div className="space-y-1">
              <div className="text-[10px] text-terminal-muted uppercase tracking-wider">
                {t("allResponses", { count: dr.allResponses.length })}
              </div>
              <pre className="rounded bg-terminal-dark/5 dark:bg-terminal-dark/[0.06] p-2 overflow-x-auto max-h-48 overflow-y-auto text-terminal-dark dark:text-terminal-dark/90 whitespace-pre-wrap break-all font-mono text-[11px]">
                {(() => {
                  const joined = dr.allResponses!
                    .map((r, i) => `--- Response ${i + 1} ---\n${r}`)
                    .join("\n\n");
                  return joined.length > 5000
                    ? joined.slice(0, 5000) +
                      `\n\n... [${(joined.length - 5000).toLocaleString()} more characters]`
                    : joined;
                })()}
              </pre>
            </div>
          )}

          {hasError && (
            <div className="space-y-1">
              <div className="text-[10px] text-red-600 uppercase tracking-wider">
                {t("error")}
              </div>
              <pre className="rounded bg-red-50 dark:bg-red-950/40 p-2 overflow-x-auto max-h-48 overflow-y-auto text-red-700 dark:text-red-300 whitespace-pre-wrap break-all font-mono text-[11px]">
                {dr.error || dr.status || t("unknownError")}
              </pre>
            </div>
          )}

          {isWaiting && (
            <div className="text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
              {t("waitingOnDelegation")}
            </div>
          )}

          {isRunning && !isWaiting && (
            <div className="text-terminal-muted animate-pulse flex items-center gap-1.5">
              {t("subagentWorking")}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

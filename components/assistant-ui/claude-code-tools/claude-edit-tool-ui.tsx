"use client";

import { type FC, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircleIcon, XCircleIcon, PencilIcon, PlusIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToolExpansion } from "../tool-expansion-context";
import { useTranslations } from "next-intl";
import { DiffStyledPre } from "../diff-styled-pre";
import { parseTextResult } from "./parse-text-result";
import { generateSnippetDiff } from "@/lib/ai/filesystem/diff-utils";

type ToolCallContentPartComponent = FC<{
  toolName: string;
  argsText?: string;
  args?: {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    replace_all?: boolean;
  };
  result?: unknown;
}>;

function isErrorResult(result: unknown): boolean {
  if (!result) return false;
  const text = parseTextResult(result);
  if (text && /error|failed|denied/i.test(text.slice(0, 100))) return true;
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.isError === true) return true;
    const status = typeof r.status === "string" ? r.status.toLowerCase() : "";
    if (status === "error" || status === "failed" || status === "denied") return true;
  }
  return false;
}

/**
 * Custom UI for Claude Code's `Edit` tool.
 * Shows file name, diff preview (old_string → new_string), and result status.
 */
export const ClaudeEditToolUI: ToolCallContentPartComponent = ({ args, result }) => {
  const t = useTranslations("assistantUi.claudeTools.edit");
  const [expanded, setExpanded] = useState(false);
  const [showFullDiff, setShowFullDiff] = useState(false);

  const expansionCtx = useToolExpansion();
  const lastSignalRef = useRef(0);
  useEffect(() => {
    if (!expansionCtx || expansionCtx.signal.counter === 0) return;
    if (expansionCtx.signal.counter === lastSignalRef.current) return;
    lastSignalRef.current = expansionCtx.signal.counter;
    setExpanded(expansionCtx.signal.mode === "expand");
  }, [expansionCtx?.signal]);

  const filePath = args?.file_path || "";
  const fileName = filePath.split("/").pop() || filePath;
  const isCreating = !args?.old_string && !!args?.new_string;
  const isRunning = result === undefined;
  const hasError = isErrorResult(result);

  const getActionLabel = () => {
    if (isRunning) return isCreating ? t("creating") : t("editing");
    if (hasError) return isCreating ? t("createFailed") : t("editFailed");
    return isCreating ? t("created") : t("edited");
  };

  const ActionIcon = isCreating ? PlusIcon : PencilIcon;
  const StatusIcon = isRunning ? null : hasError ? XCircleIcon : CheckCircleIcon;
  const statusColor = isRunning
    ? "text-terminal-muted"
    : hasError
      ? "text-red-600 dark:text-red-400"
      : "text-emerald-600 dark:text-emerald-400";

  const diff = useMemo(
    () => generateSnippetDiff(
      filePath,
      args?.old_string ?? "",
      args?.new_string ?? ""
    ),
    [args?.new_string, args?.old_string, filePath]
  );
  const diffLines = diff.lines;
  const additions = diff.additions;
  const removals = diff.deletions;

  const maxDiffLines = 150;
  const isDiffTruncated = diffLines.length > maxDiffLines;
  const visibleDiffLines = !showFullDiff && isDiffTruncated
    ? diffLines.slice(0, maxDiffLines)
    : diffLines;

  return (
    <div className="my-1 rounded-md border border-border bg-terminal-cream/50 dark:bg-terminal-cream/80 font-mono text-xs overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent/30 transition-colors text-left"
      >
        {StatusIcon && <StatusIcon className={cn("h-3.5 w-3.5 shrink-0", statusColor)} />}
        {!StatusIcon && <div className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-terminal-muted animate-pulse" />}
        <ActionIcon className="h-3 w-3 shrink-0 text-terminal-muted" />
        <span className="text-terminal-muted">{getActionLabel()}</span>
        <span className="font-medium text-terminal-dark truncate min-w-0 flex-1" title={filePath || fileName}>{fileName}</span>

        {(additions > 0 || removals > 0) && (
          <span className="ml-auto shrink-0 text-terminal-muted">
            {additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>}
            {additions > 0 && removals > 0 && " "}
            {removals > 0 && <span className="text-red-500 dark:text-red-400">-{removals}</span>}
          </span>
        )}

        {args?.replace_all && (
          <span className="text-terminal-muted text-[10px] ml-1">(all)</span>
        )}

        {expanded ? (
          <ChevronDownIcon className="h-3 w-3 shrink-0 text-terminal-muted" />
        ) : (
          <ChevronRightIcon className="h-3 w-3 shrink-0 text-terminal-muted" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          <div className="text-terminal-muted truncate" title={filePath}>
            {filePath}
          </div>

          {diffLines.length > 0 && (
            <div className="space-y-2">
              <DiffStyledPre lines={visibleDiffLines} />

              {isDiffTruncated && (
                <button
                  type="button"
                  onClick={() => setShowFullDiff(!showFullDiff)}
                  className="text-[11px] text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 underline"
                >
                  {showFullDiff ? t("showLess") : t("showAll", { count: diffLines.length })}
                </button>
              )}
            </div>
          )}

          {/* Result message */}
          {result !== undefined && (
            <div className={cn("text-[11px]", statusColor)}>
              {parseTextResult(result) || (hasError ? t("resultFailed") : t("resultApplied"))}
            </div>
          )}

          {isRunning && (
            <div className="text-terminal-muted animate-pulse">{t("processing")}</div>
          )}
        </div>
      )}
    </div>
  );
};

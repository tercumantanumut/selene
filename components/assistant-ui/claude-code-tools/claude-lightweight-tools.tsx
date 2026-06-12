"use client";

/**
 * Lightweight custom UIs for Claude Code tools that don't need
 * full expandable card treatment. These render as compact inline
 * status rows matching the style of the other claude-code-tools.
 */

import { type FC, useEffect, useRef, useState } from "react";
import {
  CheckCircleIcon,
  XCircleIcon,
  ListTodoIcon,
  MapIcon,
  CheckIcon,
  GitBranchIcon,
  MessageCircleQuestionIcon,
  ZapIcon,
  ClipboardListIcon,
  SquareIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToolExpansion } from "../tool-expansion-context";
import { parseTextResult, parseTextResultWithStatus } from "./parse-text-result";
import { useTranslations } from "next-intl";

// Shared type
type ToolCallContentPartComponent = FC<{
  toolName: string;
  argsText?: string;
  args?: Record<string, unknown>;
  result?: unknown;
}>;

function isErrorResult(result: unknown): boolean {
  if (!result) return false;
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.isError === true) return true;
  }
  return false;
}

function useGlobalExpansion() {
  const [expanded, setExpanded] = useState(false);
  const expansionCtx = useToolExpansion();
  const lastSignalRef = useRef(0);
  useEffect(() => {
    if (!expansionCtx || expansionCtx.signal.counter === 0) return;
    if (expansionCtx.signal.counter === lastSignalRef.current) return;
    lastSignalRef.current = expansionCtx.signal.counter;
    setExpanded(expansionCtx.signal.mode === "expand");
  }, [expansionCtx?.signal]);
  return { expanded, setExpanded };
}

// Reusable compact card shell
function CompactToolCard({
  icon: Icon,
  label,
  detail,
  isRunning,
  hasError,
  expandedContent,
}: {
  icon: FC<{ className?: string }>;
  label: string;
  detail?: string;
  isRunning: boolean;
  hasError: boolean;
  expandedContent?: string;
}) {
  const { expanded, setExpanded } = useGlobalExpansion();
  const hasExpandable = !!expandedContent;

  const StatusIcon = isRunning ? null : hasError ? XCircleIcon : CheckCircleIcon;
  const statusColor = isRunning
    ? "text-terminal-muted"
    : hasError
      ? "text-red-600 dark:text-red-400"
      : "text-emerald-600 dark:text-emerald-400";

  return (
    <div className="my-1 rounded-md border border-border bg-terminal-cream/50 dark:bg-terminal-cream/80 font-mono text-xs overflow-hidden">
      <button
        type="button"
        onClick={() => hasExpandable && setExpanded(!expanded)}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 transition-colors text-left",
          hasExpandable && "hover:bg-accent/30 cursor-pointer",
          !hasExpandable && "cursor-default"
        )}
      >
        {StatusIcon && <StatusIcon className={cn("h-3.5 w-3.5 shrink-0", statusColor)} />}
        {!StatusIcon && <div className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-terminal-muted animate-pulse" />}
        <Icon className="h-3 w-3 shrink-0 text-terminal-muted" />
        <span className="text-terminal-muted">{label}</span>
        {detail && (
          <span className="font-medium text-terminal-dark truncate min-w-0 flex-1" title={detail}>{detail}</span>
        )}
        {hasExpandable && (
          expanded ? (
            <ChevronDownIcon className="h-3 w-3 shrink-0 text-terminal-muted ml-auto" />
          ) : (
            <ChevronRightIcon className="h-3 w-3 shrink-0 text-terminal-muted ml-auto" />
          )
        )}
      </button>
      {expanded && expandedContent && (
        <div className="border-t border-border px-3 py-2">
          <pre className="rounded bg-terminal-dark/5 dark:bg-terminal-dark/[0.06] p-2 overflow-x-auto max-h-48 overflow-y-auto text-terminal-dark dark:text-terminal-dark/90 whitespace-pre-wrap break-all font-mono text-[11px]">
            {expandedContent.length > 3000
              ? expandedContent.substring(0, 3000) + `\n\n... [${(expandedContent.length - 3000).toLocaleString()} more characters]`
              : expandedContent}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * TodoWrite — Claude Code's task list tool
 */
export const ClaudeTodoWriteToolUI: ToolCallContentPartComponent = ({ args, result }) => {
  const t = useTranslations("assistantUi.claudeTools.todoWrite");
  const todos = Array.isArray(args?.todos) ? args.todos as Array<{ content?: string; status?: string }> : [];
  const todoCount = todos.length;
  const completedCount = todos.filter(td => td.status === "completed").length;
  const isRunning = result === undefined;
  const hasError = isErrorResult(result);

  const detail = todoCount > 0
    ? `${completedCount}/${todoCount} tasks`
    : undefined;

  return (
    <CompactToolCard
      icon={ListTodoIcon}
      label={isRunning ? t("running") : hasError ? t("failed") : t("done")}
      detail={detail}
      isRunning={isRunning}
      hasError={hasError}
      expandedContent={todos.length > 0
        ? todos.map(td => `${td.status === "completed" ? "✓" : td.status === "in_progress" ? "●" : "○"} ${td.content || ""}`).join("\n")
        : undefined}
    />
  );
};

/**
 * EnterPlanMode — Claude Code's planning mode trigger
 */
export const ClaudeEnterPlanModeToolUI: ToolCallContentPartComponent = ({ result }) => {
  const t = useTranslations("assistantUi.claudeTools.planMode");
  const isRunning = result === undefined;
  const hasError = isErrorResult(result);

  return (
    <CompactToolCard
      icon={MapIcon}
      label={isRunning ? t("entering") : hasError ? t("failed") : t("done")}
      isRunning={isRunning}
      hasError={hasError}
    />
  );
};

/**
 * ExitPlanMode — Claude Code's plan approval step
 */
const ClaudeExitPlanModeToolUI: ToolCallContentPartComponent = ({ result }) => {
  const t = useTranslations("assistantUi.claudeTools.exitPlanMode");
  const isRunning = result === undefined;
  const hasError = isErrorResult(result);

  return (
    <CompactToolCard
      icon={CheckIcon}
      label={isRunning ? t("awaiting") : hasError ? t("rejected") : t("approved")}
      isRunning={isRunning}
      hasError={hasError}
    />
  );
};

/**
 * EnterWorktree — Claude Code's git worktree creation
 */
export const ClaudeEnterWorktreeToolUI: ToolCallContentPartComponent = ({ args, result }) => {
  const t = useTranslations("assistantUi.claudeTools.worktree");
  const name = typeof args?.name === "string" ? args.name : undefined;
  const isRunning = result === undefined;
  const hasError = isErrorResult(result);

  return (
    <CompactToolCard
      icon={GitBranchIcon}
      label={isRunning ? t("creating") : hasError ? t("failed") : t("created")}
      detail={name}
      isRunning={isRunning}
      hasError={hasError}
    />
  );
};

/**
 * AskUserQuestion — Claude Code's interactive question tool
 */
const ClaudeAskUserQuestionToolUI: ToolCallContentPartComponent = ({ args, result }) => {
  const t = useTranslations("assistantUi.claudeTools.askUser");
  const questions = Array.isArray(args?.questions) ? args.questions as Array<{ question?: string }> : [];
  const firstQ = questions[0]?.question;
  const detail = firstQ
    ? (firstQ.length > 80 ? firstQ.substring(0, 80) + "..." : firstQ)
    : undefined;
  const isRunning = result === undefined;
  const hasError = isErrorResult(result);

  return (
    <CompactToolCard
      icon={MessageCircleQuestionIcon}
      label={isRunning ? t("asking") : hasError ? t("failed") : t("asked")}
      detail={detail}
      isRunning={isRunning}
      hasError={hasError}
      expandedContent={parseTextResult(result)}
    />
  );
};

/**
 * Skill — Claude Code's skill invocation
 */
export const ClaudeSkillToolUI: ToolCallContentPartComponent = ({ args, result }) => {
  const t = useTranslations("assistantUi.claudeTools.skill");
  const skill = typeof args?.skill === "string" ? args.skill : undefined;
  const isRunning = result === undefined;
  const hasError = isErrorResult(result);

  return (
    <CompactToolCard
      icon={ZapIcon}
      label={isRunning ? t("running") : hasError ? t("failed") : t("done")}
      detail={skill}
      isRunning={isRunning}
      hasError={hasError}
      expandedContent={parseTextResult(result)}
    />
  );
};

/**
 * TaskOutput — Claude Code's task output reader
 */
export const ClaudeTaskOutputToolUI: ToolCallContentPartComponent = ({ args, result }) => {
  const t = useTranslations("assistantUi.claudeTools.taskOutput");
  const taskId = typeof args?.task_id === "string" ? args.task_id : undefined;
  const isRunning = result === undefined;
  const baseError = isErrorResult(result);
  const { text: content, statuses } = parseTextResultWithStatus(result);

  // Detect timeout/error statuses from XML tags (e.g., <retrieval_status>timeout</retrieval_status>)
  const isTimeout = statuses.retrieval_status === "timeout";
  const hasError = baseError || isTimeout;
  const label = isRunning
    ? t("reading")
    : isTimeout
      ? t("timedOut")
      : hasError
        ? t("failed")
        : t("done");

  return (
    <CompactToolCard
      icon={ClipboardListIcon}
      label={label}
      detail={taskId ? `#${taskId.slice(0, 8)}` : undefined}
      isRunning={isRunning}
      hasError={hasError}
      expandedContent={content}
    />
  );
};

/**
 * TaskStop — Claude Code's task stop tool
 */
export const ClaudeTaskStopToolUI: ToolCallContentPartComponent = ({ args, result }) => {
  const t = useTranslations("assistantUi.claudeTools.taskStop");
  const taskId = typeof args?.task_id === "string" ? args.task_id : undefined;
  const isRunning = result === undefined;
  const hasError = isErrorResult(result);

  return (
    <CompactToolCard
      icon={SquareIcon}
      label={isRunning ? t("stopping") : hasError ? t("failed") : t("done")}
      detail={taskId ? `#${taskId.slice(0, 8)}` : undefined}
      isRunning={isRunning}
      hasError={hasError}
    />
  );
};

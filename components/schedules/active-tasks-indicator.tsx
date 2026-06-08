/**
 * Active Tasks Indicator
 *
 * Shared UI for currently running background tasks.
 * Displays agent, session, and live activity/tool-call context.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Clock,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Loader2,
  MessageSquare,
  Sparkles,
  Workflow,
  Wrench,
  XCircle,
} from "lucide-react";
import { ActiveDelegationsIndicator } from "@/components/assistant-ui/active-delegations-indicator";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useActiveTasks } from "@/lib/stores/unified-tasks-store";
import {
  useSessionActivity,
  useSessionSyncStore,
  type SessionActivityIndicator,
  type SessionActivityKind,
} from "@/lib/stores/session-sync-store";
import type { UnifiedTask } from "@/lib/background-tasks/types";
import { selectVisibleActiveTasks } from "@/lib/background-tasks/visible-active-tasks";
import { cn } from "@/lib/utils";

const HOVER_CLOSE_DELAY_MS = 140;

function indicatorIcon(kind: SessionActivityKind) {
  if (kind === "tool") return Wrench;
  if (kind === "hook") return Sparkles;
  if (kind === "skill") return Sparkles;
  if (kind === "delegation") return Workflow;
  if (kind === "workspace") return GitBranch;
  if (kind === "pr") return GitPullRequest;
  if (kind === "error") return XCircle;
  return Loader2;
}

function formatTimeAgo(startedAt: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function shortId(value?: string) {
  if (!value) return undefined;
  return value.length <= 8 ? value : value.slice(0, 8);
}

function taskMetadata(task: UnifiedTask): Record<string, unknown> {
  return task.metadata && typeof task.metadata === "object" ? task.metadata : {};
}

function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function trimLabel(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function useVisibleActiveTasks() {
  const tasks = useActiveTasks();
  return useMemo(() => selectVisibleActiveTasks(tasks), [tasks]);
}

function useTaskDisplayContext(task: UnifiedTask) {
  const metadata = taskMetadata(task);
  const cachedSession = useSessionSyncStore((state) => task.sessionId ? state.sessionsById.get(task.sessionId) : undefined);

  const agentName =
    metadataString(metadata, "activeTaskAgentName") ||
    metadataString(metadata, "characterName") ||
    metadataString(metadata, "agentName") ||
    metadataString(metadata, "delegateAgent") ||
    (task.type === "channel" ? task.channelType : undefined) ||
    (task.characterId ? `Agent ${shortId(task.characterId)}` : "Agent");

  const sessionTitle =
    metadataString(metadata, "activeTaskSessionTitle") ||
    cachedSession?.title ||
    (task.type === "scheduled" ? task.taskName : undefined) ||
    (task.type === "channel" ? task.peerName || task.peerId : undefined);

  const sessionContext = sessionTitle
    ? trimLabel(sessionTitle, 42)
    : task.sessionId
      ? `Session ${shortId(task.sessionId)}`
      : undefined;

  return { agentName, sessionContext };
}

function pickPrimaryIndicator(indicators: SessionActivityIndicator[] | undefined) {
  if (!indicators?.length) return null;
  return indicators.find((indicator) => indicator.key !== "run" && indicator.label.toLowerCase() !== "working") ?? null;
}

function fallbackActivityLabel(task: UnifiedTask) {
  const metadata = taskMetadata(task);
  const toolName = metadataString(metadata, "toolName");
  if (toolName) return `Calling ${toolName}`;

  if (task.type === "scheduled") return task.taskName;
  if (task.type === "chat") {
    if (metadata.isDelegation === true) return "Delegating task";
    if (task.pipelineName === "deep-research") return "Deep research";
    return "Running task";
  }
  return `Channel ${task.channelType}`;
}

function ActivityLine({ indicator, task }: { indicator: SessionActivityIndicator | null; task: UnifiedTask }) {
  const label = indicator?.label ?? fallbackActivityLabel(task);
  const detail = indicator?.detail;
  const Icon = indicator ? indicatorIcon(indicator.kind) : Loader2;
  const shouldSpin = !indicator || indicator.kind === "run" || indicator.kind === "tool" || indicator.kind === "workspace";

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Icon className={cn("h-3.5 w-3.5 shrink-0 text-terminal-green", shouldSpin && "animate-spin")} />
      <p className="truncate font-mono text-sm font-medium text-terminal-dark">
        {label}
        {detail ? <span className="text-terminal-muted"> · {detail}</span> : null}
      </p>
    </div>
  );
}

function TaskRow({
  task,
  onNavigate,
  compact = false,
}: {
  task: UnifiedTask;
  onNavigate: (url: string) => void;
  compact?: boolean;
}) {
  const t = useTranslations("schedules.notifications");
  const activity = useSessionActivity(task.sessionId);
  const primaryIndicator = pickPrimaryIndicator(activity?.indicators);
  const { agentName, sessionContext } = useTaskDisplayContext(task);
  const handleOpenDelegationSession = useCallback((delegationSessionId: string, delegateAgentId: string) => {
    onNavigate(`/chat/${delegateAgentId}?sessionId=${delegationSessionId}`);
  }, [onNavigate]);

  return (
    <div className={cn(
      compact
        ? "rounded-lg px-2.5 py-2 transition-colors hover:bg-accent/60"
        : "border-b border-terminal-green/10 p-3 transition-colors last:border-0 hover:bg-terminal-green/5",
    )}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-sm font-semibold text-terminal-dark">
              {agentName}
            </span>
            {sessionContext ? (
              <span className="flex min-w-0 items-center gap-1 truncate font-mono text-xs text-terminal-muted">
                <MessageSquare className="h-3 w-3 shrink-0" />
                <span className="truncate">{sessionContext}</span>
              </span>
            ) : null}
          </div>

          <ActivityLine indicator={primaryIndicator} task={task} />

          <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-terminal-muted">
            <Clock className="h-3 w-3 shrink-0" />
            <span>{t("startedAgo", { time: formatTimeAgo(task.startedAt) })}</span>
            {activity?.progressText && activity.progressText !== primaryIndicator?.label ? (
              <span className="truncate">· {activity.progressText}</span>
            ) : null}
          </div>

          {task.sessionId && task.characterId ? (
            <ActiveDelegationsIndicator
              characterId={task.characterId}
              initiatorSessionId={task.sessionId}
              onOpenSession={handleOpenDelegationSession}
              embedded
            />
          ) : null}
        </div>

        {task.sessionId && task.characterId && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs font-mono text-terminal-green hover:text-terminal-green/80"
            onClick={() => onNavigate(`/chat/${task.characterId}?sessionId=${task.sessionId}`)}
          >
            <ExternalLink className="mr-1 h-3 w-3" />
            {t("viewTask")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Pick the freshest meaningful activity label across all active tasks. */
function useLatestActivityLabel(tasks: UnifiedTask[]): SessionActivityIndicator | null {
  const sessionActivityById = useSessionSyncStore((s) => s.sessionActivityById);

  let best: { indicator: SessionActivityIndicator; updatedAt: number } | null = null;
  for (const task of tasks) {
    if (!task.sessionId) continue;
    const activity = sessionActivityById.get(task.sessionId);
    const indicator = pickPrimaryIndicator(activity?.indicators);
    if (!indicator) continue;
    const updatedAt = activity?.updatedAt ?? 0;
    if (!best || updatedAt > best.updatedAt) {
      best = { indicator, updatedAt };
    }
  }
  return best?.indicator ?? null;
}

function useTaskNavigator(close?: () => void) {
  const router = useRouter();
  return (url: string) => {
    router.push(url);
    close?.();
  };
}

function InlineStatusSummary({ task, count }: { task: UnifiedTask; count: number }) {
  const activity = useSessionActivity(task.sessionId);
  const primaryIndicator = pickPrimaryIndicator(activity?.indicators);
  const { agentName } = useTaskDisplayContext(task);
  const label = primaryIndicator?.label ?? fallbackActivityLabel(task);
  const Icon = primaryIndicator ? indicatorIcon(primaryIndicator.kind) : Loader2;
  const shouldSpin = !primaryIndicator || primaryIndicator.kind === "run" || primaryIndicator.kind === "tool" || primaryIndicator.kind === "workspace";
  const countLabel = count === 1 ? agentName : `${count} agents active`;
  const agentSummary = count > 1 ? `${agentName} +${count - 1}` : undefined;

  return (
    <>
      <span className="relative inline-flex size-2 items-center justify-center" aria-hidden="true">
        <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/40" />
        <span className="relative size-2 rounded-full bg-emerald-500" />
      </span>
      <span className="min-w-0 truncate tabular-nums">{countLabel}</span>
      {agentSummary ? (
        <span className="hidden min-w-0 max-w-[130px] truncate text-muted-foreground/90 sm:inline">
          · {agentSummary}
        </span>
      ) : null}
      <span className="hidden min-w-0 items-center gap-1 text-muted-foreground/90 md:inline-flex">
        <span className="text-muted-foreground/60">·</span>
        <Icon className={cn("h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400", shouldSpin && "animate-spin")} />
        <span className="max-w-[160px] truncate">{label}</span>
      </span>
    </>
  );
}

export function ActiveTasksInlineStatus({ className }: { className?: string }) {
  const tasks = useVisibleActiveTasks();
  const count = tasks.length;
  const firstTask = tasks[0];
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleNavigate = useTaskNavigator(() => setOpen(false));

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, HOVER_CLOSE_DELAY_MS);
  }, [cancelClose]);

  const handleOpen = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  if (count === 0 || !firstTask) return null;

  const activeAgentsLabel = count === 1 ? "1 active agent" : `${count} active agents`;

  return (
    <div className={cn("flex w-full justify-start px-1", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            onMouseEnter={handleOpen}
            onMouseLeave={scheduleClose}
            onFocus={handleOpen}
            onBlur={scheduleClose}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={activeAgentsLabel}
            className={cn(
              "group inline-flex max-w-full items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground",
              "transition-colors duration-150",
              "hover:border-emerald-400/60 hover:bg-emerald-500/[0.06] hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              "data-[state=open]:border-emerald-400/70 data-[state=open]:bg-emerald-500/[0.08] data-[state=open]:text-foreground",
            )}
          >
            <InlineStatusSummary task={firstTask} count={count} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="w-96 max-w-[calc(100vw-2rem)] border-border/80 bg-popover/95 p-0 shadow-xl backdrop-blur-sm"
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <span className="relative inline-flex size-2 items-center justify-center" aria-hidden="true">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/40" />
              <span className="relative size-2 rounded-full bg-emerald-500" />
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {activeAgentsLabel}
            </span>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto p-1.5">
            {tasks.map((task) => (
              <TaskRow key={task.runId} task={task} onNavigate={handleNavigate} compact />
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function ActiveTasksIndicator() {
  const t = useTranslations("schedules.notifications");
  const [open, setOpen] = useState(false);
  const tasks = useVisibleActiveTasks();
  const count = tasks.length;
  const latestIndicator = useLatestActivityLabel(tasks);
  const handleNavigate = useTaskNavigator(() => setOpen(false));

  if (count === 0) return null;

  const triggerLabel = latestIndicator?.label ?? t("activeTasks", { count });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "relative gap-2 overflow-hidden font-mono text-sm",
            "text-terminal-green hover:text-terminal-green/80",
            "hover:bg-terminal-green/10"
          )}
        >
          <span className="relative max-w-[180px] truncate animate-text-shine bg-[length:200%_100%] bg-clip-text bg-gradient-to-r from-terminal-green via-[hsl(var(--terminal-green)/0.4)] to-terminal-green">
            {triggerLabel}
          </span>

          {count > 1 && (
            <span className="text-xs text-terminal-muted">({count})</span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="w-96 p-0 bg-terminal-cream border-terminal-green/30"
        align="end"
      >
        <div className="p-3 border-b border-terminal-green/20">
          <h4 className="font-mono font-semibold text-terminal-dark text-sm">
            {t("activeTasks", { count })}
          </h4>
        </div>

        <div className="max-h-72 overflow-y-auto">
          {tasks.map((task) => (
            <TaskRow key={task.runId} task={task} onNavigate={handleNavigate} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

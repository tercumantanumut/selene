"use client";

import { FC, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Loader2,
  Play,
  Square,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  useBackgroundProcessStatus,
  type BackgroundProcessInfo,
} from "@/lib/hooks/use-background-process-status";
import { cn } from "@/lib/utils";

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const HOVER_CLOSE_DELAY_MS = 140;

type DisplayStatus = "running" | "stopping" | "succeeded" | "failed" | "cancelled" | "interrupted";

interface StatusConfig {
  label: string;
  Icon: LucideIcon;
  iconClassName: string;
  chipClassName: string;
  spin?: boolean;
}

const STATUS_CONFIG: Record<DisplayStatus, StatusConfig> = {
  running: {
    label: "Running",
    Icon: Play,
    iconClassName: "text-amber-500",
    chipClassName: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  stopping: {
    label: "Stopping…",
    Icon: Loader2,
    iconClassName: "text-amber-500",
    chipClassName: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    spin: true,
  },
  succeeded: {
    label: "Completed",
    Icon: CheckCircle2,
    iconClassName: "text-emerald-500",
    chipClassName: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  failed: {
    label: "Failed",
    Icon: XCircle,
    iconClassName: "text-red-500",
    chipClassName: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  },
  cancelled: {
    label: "Stopped",
    Icon: Ban,
    iconClassName: "text-muted-foreground",
    chipClassName: "border-border bg-muted text-muted-foreground",
  },
  interrupted: {
    label: "Interrupted",
    Icon: AlertTriangle,
    iconClassName: "text-amber-600",
    chipClassName: "border-amber-600/30 bg-amber-600/10 text-amber-700 dark:text-amber-300",
  },
};

export function displayStatusFor(process: BackgroundProcessInfo, isStopping: boolean): DisplayStatus {
  if (process.running) return isStopping ? "stopping" : "running";
  switch (process.status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "stale":
      return "interrupted";
    default:
      // A settled process with an unexpected status (e.g. lost server state
      // after a restart) is surfaced explicitly instead of guessed at.
      return "interrupted";
  }
}

function statusDetail(process: BackgroundProcessInfo): string | null {
  if (process.running) return null;
  const parts: string[] = [];
  if (process.settleReason === "timeout") parts.push("timed out");
  if (process.settleReason === "spawn-error") parts.push("failed to start");
  if (process.exitCode !== undefined && process.exitCode !== null) {
    parts.push(`exit ${process.exitCode}`);
  }
  if (process.signal) parts.push(process.signal);
  if (parts.length === 0 && process.error) parts.push(process.error);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export const BackgroundProcessesIndicator: FC<{
  characterId: string | null;
  sessionId?: string | null;
}> = ({ characterId, sessionId }) => {
  const { processes, stopProcess, stoppingProcessIds, error } = useBackgroundProcessStatus(characterId, sessionId);
  const visibleProcesses = processes.filter((process) => process.running || process.settledAt);

  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  if (visibleProcesses.length === 0) return null;

  const runningCount = visibleProcesses.filter((process) => process.running).length;
  const failedCount = visibleProcesses.filter(
    (process) => !process.running && process.status === "failed",
  ).length;
  const finishedCount = visibleProcesses.length - runningCount;

  const countLabel =
    runningCount > 0
      ? `${runningCount} running${finishedCount > 0 ? ` · ${finishedCount} finished` : ""}`
      : failedCount > 0
        ? `${visibleProcesses.length} finished · ${failedCount} failed`
        : `${visibleProcesses.length} finished`;
  const triggerLabel = `Background processes: ${countLabel}`;

  const dotClassName =
    runningCount > 0 ? "bg-amber-500" : failedCount > 0 ? "bg-red-500" : "bg-muted-foreground/50";

  return (
    <div className="mt-2 w-full px-1">
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
            aria-label={`${triggerLabel}, show details`}
            className={cn(
              "group inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground",
              "transition-colors duration-150",
              "hover:border-amber-400/60 hover:bg-amber-500/[0.06] hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              "data-[state=open]:border-amber-400/70 data-[state=open]:bg-amber-500/[0.08] data-[state=open]:text-foreground",
            )}
          >
            <span className="relative inline-flex size-2 items-center justify-center" aria-hidden="true">
              {runningCount > 0 && <span className="absolute inset-0 rounded-full bg-amber-500/40 animate-ping" />}
              <span className={cn("relative size-2 rounded-full", dotClassName)} />
            </span>
            <TerminalSquare className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="tabular-nums">
              {visibleProcesses.length === 1 ? "Background process" : "Background processes"} · {countLabel}
            </span>
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
          className="w-96 border-border/80 bg-popover/95 p-0 shadow-xl backdrop-blur-sm"
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <TerminalSquare className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Background processes · {countLabel}
            </span>
          </div>
          <div className="max-h-80 space-y-1 overflow-y-auto p-1.5">
            {visibleProcesses.map((process) => {
              const isStopping = stoppingProcessIds.has(process.processId);
              const status = displayStatusFor(process, isStopping);
              const config = STATUS_CONFIG[status];
              const detail = statusDetail(process);

              return (
                <div
                  key={process.processId}
                  className="group/row flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/60"
                >
                  <config.Icon
                    className={cn("mt-1 h-3.5 w-3.5 shrink-0", config.iconClassName, config.spin && "animate-spin")}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <span
                        className="min-w-0 truncate font-mono text-sm font-semibold text-foreground"
                        title={process.command}
                      >
                        {process.command}
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
                            config.chipClassName,
                          )}
                        >
                          {config.label}
                        </span>
                        {process.running && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void stopProcess(process.processId).catch(() => {
                                // Surfaced via the hook's error state below.
                              });
                            }}
                            disabled={isStopping}
                            aria-label={`Stop background process ${process.processId}`}
                            className={cn(
                              "inline-flex h-6 items-center gap-1 rounded-full border border-red-500/30 px-2 text-[10px] font-semibold text-red-600 transition-colors",
                              "hover:border-red-500/60 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50",
                              "disabled:cursor-not-allowed disabled:opacity-60",
                            )}
                          >
                            {isStopping ? (
                              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                            ) : (
                              <Square className="h-3 w-3" aria-hidden="true" />
                            )}
                            Stop
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      {process.toolName && (
                        <span className="inline-flex rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                          {process.toolName}
                        </span>
                      )}
                      <span className="tabular-nums">
                        {process.running ? `running for ${formatElapsed(process.elapsed)}` : `ran ${formatElapsed(process.elapsed)}`}
                      </span>
                      {detail && <span className="font-mono">{detail}</span>}
                    </div>
                    {status === "failed" && process.error && (
                      <div className="mt-1 truncate text-[11px] text-red-600 dark:text-red-300" title={process.error}>
                        {process.error}
                      </div>
                    )}
                    {status === "interrupted" && (
                      <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                        Process state was lost — it may have been interrupted by a restart.
                      </div>
                    )}
                    <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
                      {process.processId}
                      {process.cwd ? ` · ${process.cwd}` : ""}
                    </div>
                  </div>
                </div>
              );
            })}
            {error && (
              <div className="mx-2 mb-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-600 dark:text-red-300">
                {error}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

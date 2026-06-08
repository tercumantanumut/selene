"use client";

import { FC, useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock3, Loader2, Square, TerminalSquare, XCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useBackgroundProcessStatus } from "@/lib/hooks/use-background-process-status";
import { cn } from "@/lib/utils";

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const HOVER_CLOSE_DELAY_MS = 140;

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
  const countLabel = runningCount > 0
    ? `${runningCount} running background ${runningCount === 1 ? "process" : "processes"}`
    : `${visibleProcesses.length} stopped background ${visibleProcesses.length === 1 ? "process" : "processes"}`;

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
            aria-label={`${countLabel}, show details`}
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
              <span className="relative size-2 rounded-full bg-amber-500" />
            </span>
            <TerminalSquare className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="tabular-nums">{countLabel}</span>
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
              {countLabel}
            </span>
          </div>
          <div className="max-h-80 space-y-1 overflow-y-auto p-1.5">
            {visibleProcesses.map((process) => {
              const isStopping = stoppingProcessIds.has(process.processId);
              const isSuccess = !process.running && process.exitCode === 0;
              const isFailure = !process.running && !isSuccess;
              const StatusIcon = process.running ? Clock3 : isSuccess ? CheckCircle2 : XCircle;
              const statusLabel = process.running
                ? isStopping ? "Stopping" : "Running"
                : isSuccess
                  ? "Stopped successfully"
                  : "Stopped with error";

              return (
                <div
                  key={process.processId}
                  className="group/row flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/60"
                >
                  <StatusIcon
                    className={cn(
                      "mt-1 h-3.5 w-3.5 shrink-0",
                      process.running && "text-amber-500",
                      isSuccess && "text-emerald-500",
                      isFailure && "text-red-500",
                    )}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="min-w-0">
                        <span className="block truncate font-mono text-sm font-semibold text-foreground">
                          {process.command}
                        </span>
                        {process.toolName && (
                          <span className="mt-0.5 inline-flex rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                            {process.toolName}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-amber-700 dark:text-amber-300">
                          {formatElapsed(process.elapsed)}
                        </span>
                        {process.running && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void stopProcess(process.processId);
                            }}
                            disabled={isStopping}
                            aria-label={`Stop background process ${process.processId}`}
                            className={cn(
                              "inline-flex h-6 items-center gap-1 rounded-full border border-red-500/30 px-2 text-[10px] font-semibold text-red-600 transition-colors",
                              "hover:border-red-500/60 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50",
                              "disabled:cursor-not-allowed disabled:opacity-60",
                            )}
                          >
                            {isStopping ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Square className="h-3 w-3" aria-hidden="true" />}
                            Stop
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {process.processId}
                    </div>
                    {process.cwd && (
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
                        {process.cwd}
                      </div>
                    )}
                    <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground/90 group-hover/row:text-foreground">
                      <span>{statusLabel}</span>
                      {!process.running && process.exitCode !== undefined && process.exitCode !== null && (
                        <span className="font-mono">exit {process.exitCode}</span>
                      )}
                      {!process.running && process.signal && (
                        <span className="font-mono">{process.signal}</span>
                      )}
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

"use client";

import { FC, useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, LayoutGrid, PanelLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDelegationStatus } from "@/lib/hooks/use-delegation-status";
import { cn } from "@/lib/utils";
import type { ChatWorkspaceMode } from "@/lib/chat/workspace-mode";

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

type OpenDelegationSessionHandler = (
  sessionId: string,
  delegateAgentId: string,
) => void | Promise<void>;

const HOVER_CLOSE_DELAY_MS = 140;

export const ActiveDelegationsIndicator: FC<{
  characterId: string | null;
  workspaceMode?: ChatWorkspaceMode;
  onOpenSession?: OpenDelegationSessionHandler;
}> = ({ characterId, workspaceMode = "sidebar", onOpenSession }) => {
  const t = useTranslations("assistantUi.delegations");
  const { delegations } = useDelegationStatus(characterId);

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

  const running = delegations.filter(
    (d) => d.running && d.sessionId && d.delegateAgentId,
  );
  if (running.length === 0) return null;

  const countLabel = t("activeDelegations", { count: running.length });
  const ModeIcon = workspaceMode === "browser-tabs" ? LayoutGrid : PanelLeft;
  const modeLabel =
    workspaceMode === "browser-tabs"
      ? t("openInBrowserTabs")
      : t("openInSidebar");

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
            aria-label={t("triggerAriaLabel", { count: running.length })}
            className={cn(
              "group inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground",
              "transition-colors duration-150",
              "hover:border-emerald-400/60 hover:bg-emerald-500/[0.06] hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              "data-[state=open]:border-emerald-400/70 data-[state=open]:bg-emerald-500/[0.08] data-[state=open]:text-foreground",
            )}
          >
            <span
              className="relative inline-flex size-2 items-center justify-center"
              aria-hidden="true"
            >
              <span className="absolute inset-0 rounded-full bg-emerald-500/40 animate-ping" />
              <span className="relative size-2 rounded-full bg-emerald-500" />
            </span>
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
          className={cn(
            "w-80 border-border/80 bg-popover/95 p-0 shadow-xl backdrop-blur-sm",
          )}
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <span
              className="relative inline-flex size-2 items-center justify-center"
              aria-hidden="true"
            >
              <span className="absolute inset-0 rounded-full bg-emerald-500/40 animate-ping" />
              <span className="relative size-2 rounded-full bg-emerald-500" />
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {countLabel}
            </span>
          </div>
          <div className="max-h-80 space-y-1 overflow-y-auto p-1.5">
            {running.map((delegation) => {
              const taskLabel =
                delegation.task?.trim() || t("taskUnavailable");
              return (
                <button
                  key={delegation.delegationId}
                  type="button"
                  onClick={() => {
                    void onOpenSession?.(
                      delegation.sessionId,
                      delegation.delegateAgentId,
                    );
                    setOpen(false);
                  }}
                  disabled={!onOpenSession}
                  aria-label={t("openDelegationSessionRich", {
                    agent: delegation.delegateAgent,
                    task: taskLabel,
                    destination: modeLabel,
                  })}
                  className={cn(
                    "group/row flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                    "hover:bg-accent/60",
                    "focus-visible:outline-none focus-visible:bg-accent/60 focus-visible:ring-1 focus-visible:ring-emerald-500/40",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                  )}
                >
                  <span
                    className="relative mt-1.5 inline-flex size-2 shrink-0 items-center justify-center"
                    aria-hidden="true"
                  >
                    <span className="absolute inset-0 rounded-full bg-emerald-500/40 animate-ping" />
                    <span className="relative size-2 rounded-full bg-emerald-500" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">
                        {delegation.delegateAgent}
                      </span>
                      <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-emerald-700 dark:text-emerald-300">
                        {formatElapsed(delegation.elapsed)}
                      </span>
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {taskLabel}
                    </div>
                    <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground/90 group-hover/row:text-foreground">
                      <ModeIcon className="h-3 w-3" aria-hidden="true" />
                      <span>{modeLabel}</span>
                      <ExternalLink
                        className="h-3 w-3 opacity-60 transition-opacity group-hover/row:opacity-100"
                        aria-hidden="true"
                      />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

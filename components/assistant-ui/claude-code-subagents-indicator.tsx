"use client";

import { FC, useMemo, useState } from "react";
import { Bot, CheckCircle2, Clock3, Loader2, TerminalSquare, XCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useClaudeCodeSubagentEvents } from "@/lib/hooks/use-claudecode-subagent-events";
import {
  useClaudeCodeSubagentActivities,
  useClaudeCodeSubagentEvents as useClaudeCodeSubagentTimeline,
} from "@/lib/stores/claudecode-subagent-activity-store";
import type { ClaudeCodeSubagentActivity } from "@/lib/claudecode/subagent-activity-types";
import { cn } from "@/lib/utils";

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function statusIcon(activity: ClaudeCodeSubagentActivity) {
  if (activity.status === "completed") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
  if (activity.status === "failed" || activity.status === "cancelled") return <XCircle className="h-3.5 w-3.5 text-red-500" />;
  if (activity.streamAvailability === "unavailable") return <Clock3 className="h-3.5 w-3.5 text-amber-500" />;
  return <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500" />;
}

export const ClaudeCodeSubagentsIndicator: FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  useClaudeCodeSubagentEvents(sessionId);
  const activities = useClaudeCodeSubagentActivities(sessionId ?? undefined);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => activities.find((activity) => activity.id === selectedId) ?? null,
    [activities, selectedId],
  );
  const timeline = useClaudeCodeSubagentTimeline(selected?.id);

  if (!sessionId || activities.length === 0) return null;

  const activeCount = activities.filter((activity) => activity.status === "running" || activity.status === "starting").length;
  const label = activeCount > 0
    ? `${activeCount} Claude native ${activeCount === 1 ? "sub-agent" : "sub-agents"}`
    : `${activities.length} recent Claude native ${activities.length === 1 ? "sub-agent" : "sub-agents"}`;

  return (
    <div className="mt-2 w-full px-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-expanded={open}
            aria-haspopup="dialog"
            className={cn(
              "group inline-flex items-center gap-2 rounded-full border border-orange-500/40 bg-orange-500/[0.08] px-2.5 py-1 text-[11px] font-medium text-orange-700",
              "transition-colors duration-150 hover:border-orange-500/70 hover:bg-orange-500/[0.12] hover:text-orange-800",
              "dark:text-orange-300 dark:hover:text-orange-200",
            )}
          >
            <span className="relative inline-flex size-2 items-center justify-center" aria-hidden="true">
              {activeCount > 0 && <span className="absolute inset-0 rounded-full bg-orange-500/40 animate-ping" />}
              <span className="relative size-2 rounded-full bg-orange-500" />
            </span>
            <Bot className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="tabular-nums">{label}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" sideOffset={8} collisionPadding={16} className="w-96 border-border/80 bg-popover/95 p-0 shadow-xl backdrop-blur-sm">
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <TerminalSquare className="h-3.5 w-3.5 text-orange-500" aria-hidden="true" />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Claude Code native sub-agents
            </span>
          </div>
          <div className="max-h-80 space-y-1 overflow-y-auto p-1.5">
            {activities.map((activity) => (
              <button
                key={activity.id}
                type="button"
                onClick={() => {
                  setSelectedId(activity.id);
                  setOpen(false);
                }}
                className="group/row flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:bg-accent/60"
              >
                <span className="mt-1">{statusIcon(activity)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">{activity.subagentName}</span>
                    <span className="shrink-0 rounded-full bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-orange-700 dark:text-orange-300">
                      {activity.completedAt ? activity.status : formatElapsed(Date.now() - activity.startedAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{activity.latestSummary}</div>
                  <div className="mt-1.5 text-[11px] font-medium text-muted-foreground/90">
                    Claude Code native · stream {activity.streamAvailability}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={!!selected} onOpenChange={(next) => !next && setSelectedId(null)}>
        <DialogContent className="max-h-[82vh] max-w-4xl border-terminal-border bg-terminal-bg p-0 text-terminal-text">
          <DialogHeader className="border-b border-terminal-border px-5 py-4">
            <DialogTitle className="flex items-center gap-2 font-mono text-base">
              <TerminalSquare className="h-4 w-4 text-orange-400" />
              Claude Code native sub-agent
            </DialogTitle>
            <DialogDescription className="font-mono text-xs text-terminal-text/70">
              {selected?.subagentName ?? "Sub-agent"} · stream {selected?.streamAvailability ?? "pending"}
            </DialogDescription>
          </DialogHeader>
          {selected?.streamAvailability === "unavailable" && (
            <div className="mx-5 mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 font-mono text-xs text-amber-200">
              Live nested activity is unavailable from the Claude Code SDK for this run. Selene will update when the sub-agent returns.
            </div>
          )}
          <div className="max-h-[60vh] overflow-y-auto px-5 py-4 font-mono text-xs">
            {timeline.length === 0 ? (
              <div className="text-terminal-text/60">Waiting for Claude Code activity...</div>
            ) : (
              <div className="space-y-2">
                {timeline.map((event) => (
                  <div key={event.id} className="rounded-md border border-terminal-border/70 bg-black/20 px-3 py-2">
                    <div className="flex items-center justify-between gap-3 text-terminal-text/60">
                      <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
                      <span>{event.type}</span>
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-terminal-text">{event.summary}</div>
                    {event.toolName && <div className="mt-1 text-orange-300">tool: {event.toolName}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

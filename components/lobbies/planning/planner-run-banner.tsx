"use client";

/**
 * PlannerRunBanner — minimal status header for the planner subagent.
 *
 * Sprint 7A scope: just communicates whether the planner has been kicked
 * off and whether cards have landed yet. The full transcript view (live
 * SSE-streamed thought log) is a Sprint 8 deliverable, alongside the live
 * card execution UI — both feed off the same `agent_runs` SSE channel,
 * so building them in one pass keeps the wiring consistent.
 *
 * State machine (derived from lobby + cards, not separate fetch):
 *   - lobby.planningRunId == null         → "Planner not started"
 *   - lobby.planningRunId set, 0 cards    → "Planner running"
 *   - lobby.planningRunId set, cards > 0  → "Planner finished — N cards drafted"
 *
 * The third case is a heuristic: there is no `planner_status` column. The
 * planner could still be appending cards — but the captain's response is
 * the same in both cases (review and edit). Sprint 8's SSE wiring will
 * upgrade this to read live status from the agent_runs row.
 *
 * Sprint 7A.1 (S7A R3 HIGH + R2 HIGH + R5 BLOCKER #2):
 *   - The wrapper carries `role="status" aria-live="polite"` so SR users
 *     hear state transitions ("Planner running" → "Planner draft ready").
 *   - When in the "running, no cards" state, render a manual "Check for
 *     cards" button bound to the parent's refetch. Without this, a captain
 *     on an SSE-less browser sees a perpetual spinner; the only escape was
 *     the top-bar Refresh button which isn't discoverable. Polling is held
 *     for Sprint 8 (it lands with the SSE wire); a manual button is the
 *     cheap V1 escape hatch and keeps the banner deterministic.
 */

import { ClipboardList, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export type PlannerRunBannerProps = {
  hasPlanningRun: boolean;
  cardCount: number;
  /**
   * Optional refetch hook. When the banner is in the "running, no cards"
   * state and a refetch is available, render a "Check for cards" button so
   * the captain has a discoverable path forward without scrolling to the
   * top-bar refresh.
   */
  onRefresh?: () => void;
};

export function PlannerRunBanner({
  hasPlanningRun,
  cardCount,
  onRefresh,
}: PlannerRunBannerProps) {
  let label: string;
  let detail: string;
  let Icon: React.ElementType;
  let pulsing = false;

  if (!hasPlanningRun) {
    label = "Planner not started";
    detail =
      "The planner subagent runs after `ready_roster` fires. Lock the roster to begin.";
    Icon = ClipboardList;
  } else if (cardCount === 0) {
    label = "Planner running";
    detail =
      "The planner is drafting your card list. Cards will appear below as it works.";
    Icon = Loader2;
    pulsing = true;
  } else {
    label = "Planner draft ready";
    detail = `${cardCount} card${cardCount === 1 ? "" : "s"} drafted. Edit, add, or accept the plan to roll.`;
    Icon = ClipboardList;
  }

  const isRunning = hasPlanningRun && cardCount === 0;

  return (
    <Card
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="p-3 flex items-start gap-3 bg-terminal-cream/30 border-terminal-border/50"
    >
      <Icon
        className={`h-4 w-4 text-terminal-dark mt-0.5 shrink-0 ${pulsing ? "animate-spin" : ""}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="font-mono text-sm font-semibold text-terminal-dark">
          {label}
        </p>
        <p className="font-mono text-xs text-terminal-muted mt-0.5">
          {detail}
        </p>
      </div>
      {isRunning && onRefresh && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onRefresh}
          className="h-7 px-2 font-mono text-[11px] shrink-0"
          aria-label="Check for new planner cards"
        >
          <RefreshCw className="h-3 w-3 mr-1" aria-hidden="true" />
          Check
        </Button>
      )}
    </Card>
  );
}

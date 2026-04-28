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
 */

import { ClipboardList, Loader2 } from "lucide-react";

import { Card } from "@/components/ui/card";

export type PlannerRunBannerProps = {
  hasPlanningRun: boolean;
  cardCount: number;
};

export function PlannerRunBanner({
  hasPlanningRun,
  cardCount,
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

  return (
    <Card className="p-3 flex items-start gap-3 bg-terminal-cream/30 border-terminal-border/50">
      <Icon
        className={`h-4 w-4 text-terminal-dark mt-0.5 shrink-0 ${pulsing ? "animate-spin" : ""}`}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="font-mono text-sm font-semibold text-terminal-dark">
          {label}
        </p>
        <p className="font-mono text-xs text-terminal-muted mt-0.5">
          {detail}
        </p>
      </div>
    </Card>
  );
}

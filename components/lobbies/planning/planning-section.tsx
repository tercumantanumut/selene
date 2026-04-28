"use client";

/**
 * PlanningSection — captain's planning phase surface.
 *
 * Only editable while `lobby.status === "planning"`. Earlier phases (the
 * roster) hide this section's interactive parts; later phases (rolling /
 * review / completed) show the section as a read-only summary so the
 * captain can revisit what was planned.
 *
 * Composes:
 *   - PlannerRunBanner — light-weight planner status header,
 *   - CardDraftList — list of cards (planner-drafted + human-added),
 *     editable while planning,
 *   - AcceptPlanButton — fires `accept_plan` to start the rolling phase.
 *
 * The transcript view (live planner thoughts) is deliberately deferred to
 * Sprint 8 so SSE wiring lands once across both the planner-run channel and
 * the per-card-run channel. Today this section gets the captain to a usable
 * "edit + accept" surface even before SSE is wired.
 */

import type {
  Lobby,
  LobbyCard,
  LobbySeat,
} from "@/lib/db/sqlite-lobbies-schema";

import { PlannerRunBanner } from "./planner-run-banner";
import { CardDraftList } from "./card-draft-list";
import { AcceptPlanButton } from "./accept-plan-button";

export type PlanningSectionProps = {
  lobby: Lobby;
  cards: LobbyCard[];
  seats: LobbySeat[];
  onChanged: () => void;
};

export function PlanningSection({
  lobby,
  cards,
  seats,
  onChanged,
}: PlanningSectionProps) {
  const isEditable = lobby.status === "planning";
  const defaultMaxAttempts = lobby.config?.defaultMaxAttempts ?? 3;

  return (
    <div className="space-y-4">
      <PlannerRunBanner
        hasPlanningRun={lobby.planningRunId !== null}
        cardCount={cards.length}
        // Sprint 7A.1 (S7A R5 BLOCKER #2): wire the parent's refetch through
        // so the banner can render a "Check for cards" escape hatch while the
        // planner is running with no cards yet. SSE auto-refresh ships in
        // Sprint 8.
        onRefresh={onChanged}
      />

      <CardDraftList
        lobbyId={lobby.id}
        cards={cards}
        seats={seats}
        isEditable={isEditable}
        defaultMaxAttempts={defaultMaxAttempts}
        onChanged={onChanged}
      />

      {isEditable && cards.length > 0 && (
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-terminal-border/30">
          <p className="font-mono text-[11px] text-terminal-muted">
            Once accepted, cards become read-only and the rolling phase
            begins. The orchestrator will start eligible cards immediately.
          </p>
          <AcceptPlanButton
            lobby={lobby}
            cards={cards}
            seats={seats}
            onAccepted={onChanged}
          />
        </div>
      )}
    </div>
  );
}

"use client";

/**
 * RollingSection — captain's rolling-phase surface.
 *
 * Composed of:
 *   - KanbanBoard            (the drag/keyboard kanban),
 *   - CardEditDialog         (reused from planning — phase-agnostic),
 *   - CardDependencyEditor   (rolling-only for now; planning Sprint 7A
 *                             intentionally omitted dep editing because
 *                             the planner usually wires deps server-side
 *                             and the captain only adjusts mid-flight),
 *   - DagOverlay             (read-only DAG view with deep-link to the
 *                             dependency editor).
 *
 * The section is editable while `lobby.status === "rolling"`. After
 * `enter_review` fires, the kanban becomes a read-only summary so the
 * captain can revisit what was done. The section is also visible during
 * `review`, `completed`, and `aborted` so the captain still has the
 * record after the run finishes.
 *
 * SPEC §3 #6 (no Query/SWR): all mutations are direct fetches; the
 * parent owns the live refetch via `useLobbyDetail.refetch`.
 */

import { useState } from "react";
import { Network } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  Lobby,
  LobbyCard,
  LobbyCardDependency,
  LobbySeat,
} from "@/lib/db/sqlite-lobbies-schema";

import { CardEditDialog } from "../planning/card-edit-dialog";

import { KanbanBoard } from "./kanban-board";
import { CardDependencyEditor } from "./card-dependency-editor";
import { DagOverlay } from "./dag-overlay";

// ─── Props ────────────────────────────────────────────────────────────────

export type RollingSectionProps = {
  lobby: Lobby;
  cards: LobbyCard[];
  dependencies: LobbyCardDependency[];
  seats: LobbySeat[];
  onChanged: () => void;
};

// ─── Component ───────────────────────────────────────────────────────────

export function RollingSection({
  lobby,
  cards,
  dependencies,
  seats,
  onChanged,
}: RollingSectionProps) {
  const isEditable = lobby.status === "rolling";
  const defaultMaxAttempts = lobby.config?.defaultMaxAttempts ?? 3;

  // ── Modal state ───────────────────────────────────────────────────────
  const [editingCard, setEditingCard] = useState<LobbyCard | null>(null);
  const [depEditorCard, setDepEditorCard] = useState<LobbyCard | null>(null);
  const [dagOpen, setDagOpen] = useState(false);

  // No cards yet: friendly empty state. This shouldn't happen in practice
  // (Sprint 7A's `accept_plan` blocks empty plans) but the rolling phase
  // can still be entered from a custom transition path.
  if (cards.length === 0) {
    return (
      <p className="font-mono text-sm text-terminal-muted">
        No cards in this lobby — the orchestrator has nothing to roll.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header controls — DAG overlay toggle + edit-deps shortcut. */}
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-[11px] text-terminal-muted">
          {countSummary(cards)}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setDagOpen(true)}
            className="font-mono text-xs"
          >
            <Network className="h-3 w-3 mr-1.5" aria-hidden="true" />
            Dependency graph
          </Button>
        </div>
      </div>

      <KanbanBoard
        lobbyId={lobby.id}
        cards={cards}
        dependencies={dependencies}
        seats={seats}
        isEditable={isEditable}
        onChanged={onChanged}
        onEditCard={setEditingCard}
      />

      {/* Card edit dialog (reused from planning). The dialog calls
          updateCard / createCard with `expectedVersion`; server returns
          409 if the captain raced an SSE update. */}
      <CardEditDialog
        open={editingCard !== null}
        onOpenChange={(o) => !o && setEditingCard(null)}
        lobbyId={lobby.id}
        card={editingCard}
        seats={seats}
        defaultMaxAttempts={defaultMaxAttempts}
        onSaved={onChanged}
      />

      {/* Dependency editor — opened from the DAG overlay. */}
      <CardDependencyEditor
        open={depEditorCard !== null}
        onOpenChange={(o) => !o && setDepEditorCard(null)}
        lobbyId={lobby.id}
        card={depEditorCard}
        allCards={cards}
        allDependencies={dependencies}
        onSaved={onChanged}
      />

      {/* DAG overlay — modal that lists cards in topological order. */}
      <DagOverlay
        open={dagOpen}
        onOpenChange={setDagOpen}
        cards={cards}
        dependencies={dependencies}
        onEditDependencies={(card) => {
          // Hand-off: close the DAG overlay first so the captain isn't
          // stacked under two modals (focus traps fight when nested).
          setDagOpen(false);
          setDepEditorCard(card);
        }}
      />
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function countSummary(cards: LobbyCard[]): string {
  const total = cards.length;
  const running = cards.filter((c) => c.status === "running").length;
  const review = cards.filter((c) => c.status === "awaiting_review").length;
  const done = cards.filter((c) => c.status === "approved").length;
  const blocked = cards.filter(
    (c) =>
      c.status === "rejected" ||
      c.status === "failed" ||
      c.status === "cancelled",
  ).length;
  const parts: string[] = [`${total} card${total === 1 ? "" : "s"}`];
  if (running > 0) parts.push(`${running} running`);
  if (review > 0) parts.push(`${review} awaiting review`);
  if (done > 0) parts.push(`${done} done`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  return parts.join(" · ");
}

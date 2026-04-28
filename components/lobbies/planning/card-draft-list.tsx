"use client";

/**
 * CardDraftList — list of cards visible during the planning phase.
 *
 * Sprint 7A scope:
 *   - read-only summary tile per card (title, description preview, AC count,
 *     assigned seat, max attempts),
 *   - "edit" / "remove" buttons on each tile when the lobby is editable
 *     (status = `planning`),
 *   - "Add card" CTA at the top.
 *
 * Out of scope here (Sprint 7B+):
 *   - drag-to-reorder,
 *   - dependency graph visualization (handled by DAG overlay in rolling),
 *   - inline status badges (pending/running/etc) — those are rolling-phase.
 *
 * Removal uses `updateCard` is wrong — there's no DELETE endpoint. SPEC §6
 * routes only expose CREATE / UPDATE / TRANSITION; cards are removed in
 * planning by setting `status = cancelled` via the transition endpoint.
 * Sprint 7A keeps it simpler: we don't expose a destructive delete here
 * because the API doesn't support it cleanly. Captain can edit out cards
 * they don't want or cancel them post-accept (Sprint 8 review surface).
 */

import { useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Edit3,
  Plus,
  User,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

import type {
  LobbyCard,
  LobbySeat,
} from "@/lib/db/sqlite-lobbies-schema";

import { CardEditDialog } from "./card-edit-dialog";

export type CardDraftListProps = {
  lobbyId: string;
  cards: LobbyCard[];
  seats: LobbySeat[];
  isEditable: boolean;
  defaultMaxAttempts: number;
  onChanged: () => void;
};

function describeAc(card: LobbyCard): string {
  const total = card.acceptanceCriteria?.length ?? 0;
  if (total === 0) return "No acceptance criteria";
  const required = card.acceptanceCriteria?.filter(
    (c) => c.required ?? true,
  ).length ?? 0;
  return `${total} criteri${total === 1 ? "on" : "a"} (${required} required)`;
}

export function CardDraftList({
  lobbyId,
  cards,
  seats,
  isEditable,
  defaultMaxAttempts,
  onChanged,
}: CardDraftListProps) {
  const [editing, setEditing] = useState<LobbyCard | null>(null);
  const [creating, setCreating] = useState(false);

  const seatById = new Map(seats.map((s) => [s.id, s]));

  // Order: planner-created first (in their original `position`), then
  // human-added cards. Within each bucket, sort by position. Keeps the
  // planner's narrative coherent but lets the captain see their own
  // additions distinctly.
  const ordered = [...cards].sort((a, b) => {
    if (a.createdBy !== b.createdBy) {
      return a.createdBy === "planner" ? -1 : 1;
    }
    return a.position - b.position;
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-mono text-xs text-terminal-muted">
          {cards.length === 0
            ? "No cards yet."
            : `${cards.length} card${cards.length === 1 ? "" : "s"} drafted.`}
        </p>
        {isEditable && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setCreating(true)}
            className="font-mono text-xs"
          >
            <Plus className="h-3 w-3 mr-1" />
            Add card
          </Button>
        )}
      </div>

      {ordered.length === 0 ? (
        <Card className="border-dashed border-terminal-border/40 bg-transparent p-6 text-center">
          <p className="font-mono text-xs text-terminal-muted">
            The planner hasn't drafted any cards yet
            {isEditable ? " — add one manually if you'd like to seed the plan." : "."}
          </p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {ordered.map((card) => {
            const seat = card.assignedSeatId
              ? seatById.get(card.assignedSeatId)
              : null;
            return (
              <li key={card.id}>
                <Card className="p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-mono text-sm font-semibold text-terminal-dark truncate">
                          {card.title}
                        </p>
                        <Badge
                          variant={
                            card.createdBy === "planner" ? "outline" : "secondary"
                          }
                          className="font-mono text-[10px]"
                        >
                          {card.createdBy}
                        </Badge>
                      </div>
                      {card.description && (
                        <p className="font-mono text-xs text-terminal-muted whitespace-pre-wrap line-clamp-3 mt-1">
                          {card.description}
                        </p>
                      )}
                    </div>
                    {isEditable && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(card)}
                        aria-label={`Edit ${card.title}`}
                        className="h-7 px-2 font-mono text-[11px]"
                      >
                        <Edit3 className="h-3 w-3 mr-1" />
                        Edit
                      </Button>
                    )}
                  </div>

                  <div className="flex items-center gap-3 flex-wrap text-[11px] font-mono text-terminal-muted">
                    <span className="inline-flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                      {describeAc(card)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <User className="h-3 w-3" aria-hidden="true" />
                      {seat ? seat.role : "Unassigned"}
                    </span>
                    <span>
                      max {card.maxAttempts} attempt
                      {card.maxAttempts === 1 ? "" : "s"}
                    </span>
                    {!card.assignedSeatId && (
                      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                        <AlertCircle
                          className="h-3 w-3"
                          aria-hidden="true"
                        />
                        Needs a seat before plan can be accepted
                      </span>
                    )}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <CardEditDialog
        open={creating}
        onOpenChange={(o) => setCreating(o)}
        lobbyId={lobbyId}
        card={null}
        seats={seats}
        defaultMaxAttempts={defaultMaxAttempts}
        onSaved={onChanged}
      />

      <CardEditDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        lobbyId={lobbyId}
        card={editing}
        seats={seats}
        defaultMaxAttempts={defaultMaxAttempts}
        onSaved={onChanged}
      />
    </div>
  );
}

"use client";

/**
 * SeatGrid — responsive grid of SeatCards with an "Add seat" tile when the
 * lobby is editable.
 *
 * Sprint 6 keeps reorder out of scope: seats render in `position` order, but
 * there's no DnD or up/down handles yet. Sprint 7 lands the kanban DnD; we'll
 * reuse the keyboard-first DnD pattern here at that point.
 *
 * Stateless. The parent (`RosterSection`) owns:
 *   - which seats exist (server data + working copy),
 *   - which agent-picker / scope sheet is open,
 *   - all mutation calls (updateSeat / replaceSeats).
 *
 * SeatGrid only forwards click intents up.
 */

import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

import type { LobbySeat } from "@/lib/db/sqlite-lobbies-schema";
import type { CharacterSummary } from "@/lib/lobbies/client/character-hooks";

import { SeatCard } from "./seat-card";

export type SeatGridProps = {
  seats: LobbySeat[];
  charactersById: Record<string, CharacterSummary>;
  isEditable: boolean;
  onRoleChange: (seatId: string, role: string) => void;
  onPickAgent: (seatId: string) => void;
  onEditScope: (seatId: string) => void;
  onRemove: (seatId: string) => void;
  onAddSeat: () => void;
};

export function SeatGrid({
  seats,
  charactersById,
  isEditable,
  onRoleChange,
  onPickAgent,
  onEditScope,
  onRemove,
  onAddSeat,
}: SeatGridProps) {
  // Defensive sort by `position` so the visual order matches the canonical
  // position field even if the server returns rows out of order. The server
  // currently does ORDER BY position, but the cost of sorting client-side is
  // trivial and removes one assumption.
  const ordered = [...seats].sort((a, b) => a.position - b.position);

  // Sprint 6.1 (S6 R3 MEDIUM): announce the empty-roster state. Without a
  // role="status", screen-reader users hear silence when the grid is empty
  // and `isEditable=false` — they can't tell whether the section is loading,
  // restricted, or genuinely empty. The visible-but-muted copy mirrors the
  // tone of the rest of the surface; sighted captains in the editable case
  // already see the dashed "Add seat" CTA, so we only render the helper
  // copy in the read-only-empty case.
  if (ordered.length === 0 && !isEditable) {
    return (
      <p
        role="status"
        className="font-mono text-xs text-terminal-muted py-6 text-center"
      >
        No seats configured for this lobby yet.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {ordered.map((seat) => {
        const agent = seat.agentId ? charactersById[seat.agentId] ?? null : null;
        return (
          <SeatCard
            key={seat.id}
            seat={seat}
            agent={agent}
            isEditable={isEditable}
            onRoleChange={(role) => onRoleChange(seat.id, role)}
            onPickAgent={() => onPickAgent(seat.id)}
            onEditScope={() => onEditScope(seat.id)}
            onRemove={() => onRemove(seat.id)}
          />
        );
      })}

      {isEditable && (
        <Button
          type="button"
          variant="outline"
          onClick={onAddSeat}
          className="h-auto min-h-[140px] border-dashed font-mono text-xs flex flex-col items-center justify-center gap-1.5 text-terminal-muted hover:text-terminal-dark"
          aria-label="Add a new seat"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add seat
        </Button>
      )}
    </div>
  );
}

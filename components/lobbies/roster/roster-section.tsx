"use client";

/**
 * RosterSection — the captain's roster phase surface.
 *
 * Owns the wiring between server data and the seat-editing components:
 *   - Holds which sheet is open (`seatPickerSeatId`, `seatScopeSeatId`).
 *   - Translates click intents from `<SeatGrid>` into mutations
 *     (`updateSeat` for in-place edits, `replaceSeats` for add/remove).
 *   - Triggers a parent `onChanged` callback after each successful mutation
 *     so the canonical lobby data refetches and downstream sections
 *     (planning rail, etc.) reflect the new state.
 *
 * `isEditable` derives from the lobby status — the roster can only be edited
 * while the lobby is in the `roster` phase. After `ready_roster` fires, every
 * surface here goes read-only.
 *
 * SPEC §3 #6 (no Query/SWR): all mutations are direct fetches; the parent
 * page owns the live refetch via `useLobbyDetail.refetch`.
 */

import { useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";

import {
  LobbyApiError,
  replaceSeats,
  updateSeat,
} from "@/lib/lobbies/client/api";
import {
  useCharacters,
  indexCharactersById,
} from "@/lib/lobbies/client/character-hooks";
import type {
  Lobby,
  LobbySeat,
} from "@/lib/db/sqlite-lobbies-schema";
import type { LobbyPermissionScopeV1 } from "@/lib/lobbies/types";

import { LobbyGoalEditor } from "./lobby-goal-editor";
import { SeatGrid } from "./seat-grid";
import { AgentPickerSheet } from "./agent-picker-sheet";
import { SeatPermissionScopeSheet } from "./seat-permission-scope-sheet";
import { TransitionToPlanningButton } from "./transition-to-planning-button";

export type RosterSectionProps = {
  lobby: Lobby;
  seats: LobbySeat[];
  onChanged: () => void;
};

/**
 * Default role label for newly-added seats. The captain can rename inline
 * via SeatCard's role editor. Numeric suffix is `position + 1` so the first
 * extra seat reads "Seat 2" when added to a 1-seat roster.
 */
function defaultRoleForPosition(position: number): string {
  return `Seat ${position + 1}`;
}

export function RosterSection({ lobby, seats, onChanged }: RosterSectionProps) {
  const isEditable = lobby.status === "roster";

  // Character library for the picker sheet + the SeatCard's display label
  // (avoids per-card fetches). Stays mounted so the sheet doesn't refetch
  // every open.
  const { characters } = useCharacters();
  const charactersById = useMemo(
    () => indexCharactersById(characters),
    [characters],
  );

  // Sheet state — at most one is open at a time.
  const [agentPickerSeatId, setAgentPickerSeatId] = useState<string | null>(
    null,
  );
  const [scopeSeatId, setScopeSeatId] = useState<string | null>(null);

  // Mutation status — for inline error banners.
  const [busy, setBusy] = useState(false);
  const [scopeSaving, setScopeSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);

  const agentPickerSeat = agentPickerSeatId
    ? seats.find((s) => s.id === agentPickerSeatId) ?? null
    : null;
  const scopeSeat = scopeSeatId
    ? seats.find((s) => s.id === scopeSeatId) ?? null
    : null;
  const scopeSeatAgent =
    scopeSeat && scopeSeat.agentId
      ? charactersById[scopeSeat.agentId] ?? null
      : null;

  // ────────────────────────────────────────────────────────────────────────
  // Single-seat mutations (role, agent, scope)
  // ────────────────────────────────────────────────────────────────────────

  async function patchSeat(
    seat: LobbySeat,
    patch: Parameters<typeof updateSeat>[2]["patch"],
  ) {
    setError(null);
    setBusy(true);
    try {
      await updateSeat(lobby.id, seat.id, {
        expectedVersion: seat.lockVersion,
        patch,
      });
      onChanged();
    } catch (err) {
      const message = describeMutationError(err, "Failed to update seat");
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleScopeSave(scope: LobbyPermissionScopeV1) {
    if (!scopeSeat) return;
    setScopeError(null);
    setScopeSaving(true);
    try {
      await updateSeat(lobby.id, scopeSeat.id, {
        expectedVersion: scopeSeat.lockVersion,
        patch: { permissionScope: scope },
      });
      onChanged();
      setScopeSeatId(null);
    } catch (err) {
      setScopeError(describeMutationError(err, "Failed to save scope"));
    } finally {
      setScopeSaving(false);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Add / remove (PUT replaceSeats — atomic)
  // ────────────────────────────────────────────────────────────────────────

  async function flushReplaceSeats(
    nextSeats: Array<{
      role: string;
      position: number;
      agentId?: string | null;
      permissionScope?: LobbyPermissionScopeV1;
      status?: LobbySeat["status"];
    }>,
  ) {
    setError(null);
    setBusy(true);
    try {
      await replaceSeats(lobby.id, {
        expectedLobbyVersion: lobby.lockVersion,
        seats: nextSeats,
      });
      onChanged();
    } catch (err) {
      setError(describeMutationError(err, "Failed to update seats"));
    } finally {
      setBusy(false);
    }
  }

  async function handleAddSeat() {
    const nextPosition = seats.length;
    const next = [
      ...seats.map(seatToReplaceItem),
      {
        role: defaultRoleForPosition(nextPosition),
        position: nextPosition,
        agentId: null,
        status: "empty" as const,
      },
    ];
    await flushReplaceSeats(next);
  }

  async function handleRemove(seatId: string) {
    const remaining = seats
      .filter((s) => s.id !== seatId)
      // Re-index `position` so the column count stays dense after a removal.
      // Otherwise positions get gaps and the next add would overlap.
      .sort((a, b) => a.position - b.position)
      .map((s, idx) => ({ ...seatToReplaceItem(s), position: idx }));
    await flushReplaceSeats(remaining);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <LobbyGoalEditor lobby={lobby} isEditable={isEditable} onSaved={onChanged} />

      {error && (
        // Sprint 6.1 (S6 R3 HIGH): destructive token (#ef4444) on cream is
        // ~3.4:1 (fails AA). Use red-700 (#b91c1c) → ~5.9:1.
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/5 p-3"
        >
          <AlertCircle
            className="h-3.5 w-3.5 text-red-700 dark:text-red-300 mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <p className="font-mono text-xs text-red-700 dark:text-red-300">
            {error}
          </p>
        </div>
      )}

      <SeatGrid
        seats={seats}
        charactersById={charactersById}
        isEditable={isEditable && !busy}
        onRoleChange={(seatId, role) => {
          const seat = seats.find((s) => s.id === seatId);
          if (seat) void patchSeat(seat, { role });
        }}
        onPickAgent={(seatId) => setAgentPickerSeatId(seatId)}
        onEditScope={(seatId) => {
          setScopeError(null);
          setScopeSeatId(seatId);
        }}
        onRemove={(seatId) => void handleRemove(seatId)}
        onAddSeat={() => void handleAddSeat()}
      />

      {isEditable && (
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-terminal-border/30">
          <p className="font-mono text-[11px] text-terminal-muted">
            Lock the roster to start planning. Seats become read-only after
            this step.
          </p>
          <TransitionToPlanningButton
            lobby={lobby}
            seats={seats}
            onTransitioned={onChanged}
          />
        </div>
      )}

      {/* Agent picker sheet */}
      {agentPickerSeat && (
        <AgentPickerSheet
          open={agentPickerSeatId !== null}
          onOpenChange={(open) => !open && setAgentPickerSeatId(null)}
          seatRole={agentPickerSeat.role}
          seedSelectedAgentId={agentPickerSeat.agentId}
          onPick={(agentId) => {
            void patchSeat(agentPickerSeat, { agentId });
          }}
        />
      )}

      {/* Scope sheet */}
      {scopeSeat && (
        <SeatPermissionScopeSheet
          open={scopeSeatId !== null}
          onOpenChange={(open) => {
            if (!open) {
              setScopeSeatId(null);
              setScopeError(null);
            }
          }}
          seatRole={scopeSeat.role}
          agent={scopeSeatAgent}
          // Sprint 6.1 (S6 R4 LOW): drop the `| undefined` widening on the
          // cast. The DB column is `permissionScope: LobbyPermissionScopeV1`
          // (`$inferSelect` types it as never-undefined). The `??` was
          // belt-and-braces around a phantom undefined; removing it lets
          // TS narrow correctly downstream.
          initialScope={scopeSeat.permissionScope as LobbyPermissionScopeV1}
          saving={scopeSaving}
          error={scopeError}
          onSave={(scope) => void handleScopeSave(scope)}
        />
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function seatToReplaceItem(seat: LobbySeat): {
  role: string;
  position: number;
  agentId: string | null;
  permissionScope?: LobbyPermissionScopeV1;
  status: LobbySeat["status"];
} {
  // Sprint 6.1 (S6 R4 LOW): the schema types `permissionScope` as
  // `LobbyPermissionScopeV1` (never undefined). The previous `?? undefined`
  // dance was meaningless, but kept for the optional `permissionScope?:`
  // contract on the replaceSeats body — drop the cast widening, keep the
  // optional projection to preserve the wire shape.
  return {
    role: seat.role,
    position: seat.position,
    agentId: seat.agentId,
    permissionScope: seat.permissionScope as LobbyPermissionScopeV1,
    status: seat.status,
  };
}

function describeMutationError(err: unknown, fallback: string): string {
  if (err instanceof LobbyApiError) {
    if (err.reason === "VERSION_CONFLICT") {
      return "Lobby state changed since you last loaded — refreshing. Re-apply your edit.";
    }
    if (err.reason === "FORBIDDEN") {
      return "You don't have permission to modify this lobby.";
    }
    if (err.reason === "INVALID_TRANSITION") {
      return err.message || "Operation not allowed in the current lobby phase.";
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

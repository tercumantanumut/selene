"use client";

/**
 * AcceptPlanButton — fires the `accept_plan` lobby transition.
 *
 * Server-side guards (lib/lobbies/services.ts `transitionLobbyAcceptPlan`):
 *   - lobby is in `planning` status,
 *   - cards.length > 0,
 *   - dependency graph is acyclic,
 *   - every assigned seat is in `ready` or `idle` status,
 *   - every card's `assignedSeatId` resolves to a seat in this lobby.
 *
 * Client-side preflight mirrors the cheaply-checkable subset (skip the
 * cycle check — that needs the dependencies graph; the server validates).
 * We do this so a captain who hasn't filled in seat assignments sees the
 * problem before clicking, instead of getting a 422 surface.
 */

import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

import { LobbyApiError, transitionLobby } from "@/lib/lobbies/client/api";
import type {
  Lobby,
  LobbyCard,
  LobbySeat,
} from "@/lib/db/sqlite-lobbies-schema";

export type AcceptPlanButtonProps = {
  lobby: Lobby;
  cards: LobbyCard[];
  seats: LobbySeat[];
  onAccepted: () => void;
};

type PreflightFailure = { reason: string } | null;

function preflight(
  cards: LobbyCard[],
  seats: LobbySeat[],
): PreflightFailure {
  if (cards.length === 0) {
    return { reason: "Add at least one card before accepting the plan." };
  }
  const seatById = new Map(seats.map((s) => [s.id, s]));
  for (const card of cards) {
    if (!card.assignedSeatId) {
      return {
        reason: `Card "${card.title}" needs an assigned seat.`,
      };
    }
    const seat = seatById.get(card.assignedSeatId);
    if (!seat) {
      return {
        reason: `Card "${card.title}" references a seat not in this lobby.`,
      };
    }
    if (seat.status !== "ready" && seat.status !== "idle") {
      return {
        reason: `Seat "${seat.role}" is in status '${seat.status}' — must be ready or idle.`,
      };
    }
  }
  return null;
}

export function AcceptPlanButton({
  lobby,
  cards,
  seats,
  onAccepted,
}: AcceptPlanButtonProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const failure = preflight(cards, seats);
  const disabled = failure !== null || submitting;

  async function handleClick() {
    setError(null);
    if (failure) {
      setError(failure.reason);
      return;
    }
    setSubmitting(true);
    try {
      await transitionLobby(lobby.id, {
        action: "accept_plan",
        expectedVersion: lobby.lockVersion,
      });
      onAccepted();
    } catch (err) {
      if (err instanceof LobbyApiError) {
        if (err.reason === "VERSION_CONFLICT") {
          setError(
            "Lobby was updated since you last loaded — refreshing. Try again.",
          );
          onAccepted();
        } else if (err.reason === "INVALID_TRANSITION") {
          setError(
            err.message ||
              "Plan can't be accepted yet — fix the highlighted issues.",
          );
        } else if (err.reason === "INVARIANT_VIOLATION") {
          setError(
            err.message ||
              "Plan failed server validation (likely a dependency cycle).",
          );
        } else {
          setError(err.message);
        }
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to accept plan.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-1">
      <Button
        type="button"
        onClick={() => void handleClick()}
        disabled={disabled}
        className="font-mono"
      >
        {submitting ? (
          <>
            <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
            Starting rolling phase…
          </>
        ) : (
          <>
            Accept plan & roll
            <ArrowRight className="h-3.5 w-3.5 ml-2" />
          </>
        )}
      </Button>
      {(failure || error) && (
        <p
          role="alert"
          className="font-mono text-[11px] text-amber-700 dark:text-amber-300"
        >
          {error ?? failure?.reason}
        </p>
      )}
    </div>
  );
}

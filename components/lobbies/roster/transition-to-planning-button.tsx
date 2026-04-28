"use client";

/**
 * TransitionToPlanningButton — fires the `ready_roster` lobby transition.
 *
 * Captain-side preflight (so we don't surface a server INVALID_TRANSITION
 * 422 when we can predict the failure):
 *   - All seats have an agent assigned.
 *   - Every seat has a non-empty `role`.
 *
 * Server-side guards still apply (it owns the truth — Sprint 4
 * `transitionLobbyReadyRoster` checks the same invariants and bumps version).
 *
 * On success, the parent re-fetches lobby detail; the page advances to the
 * planning section automatically because `seedDefaultsForStatus` will fire
 * for the new status... actually no — that's gated by `seededForLobbyId`,
 * so we explicitly call the section helpers from the parent. This component
 * only owns the click + mutation.
 */

import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

import { LobbyApiError, transitionLobby } from "@/lib/lobbies/client/api";
import type { Lobby, LobbySeat } from "@/lib/db/sqlite-lobbies-schema";

export type TransitionToPlanningButtonProps = {
  lobby: Lobby;
  seats: LobbySeat[];
  onTransitioned: () => void;
};

type PreflightFailure = { reason: string } | null;

function preflight(seats: LobbySeat[]): PreflightFailure {
  if (seats.length === 0) {
    return { reason: "Add at least one seat before moving to planning." };
  }
  const empty = seats.filter((s) => !s.agentId);
  if (empty.length > 0) {
    const list = empty.map((s) => s.role || `Seat ${s.position + 1}`).join(", ");
    return {
      reason: `These seats need an agent: ${list}.`,
    };
  }
  const blank = seats.filter((s) => !s.role.trim());
  if (blank.length > 0) {
    return {
      reason: "Every seat needs a non-empty role label.",
    };
  }
  return null;
}

export function TransitionToPlanningButton({
  lobby,
  seats,
  onTransitioned,
}: TransitionToPlanningButtonProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const failure = preflight(seats);
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
        action: "ready_roster",
        expectedVersion: lobby.lockVersion,
      });
      onTransitioned();
    } catch (err) {
      if (err instanceof LobbyApiError) {
        if (err.reason === "VERSION_CONFLICT") {
          setError(
            "Lobby was updated since you last loaded — refreshing. Try again.",
          );
          onTransitioned();
        } else if (err.reason === "INVALID_TRANSITION") {
          setError(
            err.message ||
              "Server rejected the transition — make sure all seats are filled.",
          );
        } else {
          setError(err.message);
        }
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to start planning.");
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
            Locking roster…
          </>
        ) : (
          <>
            Ready for planning
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

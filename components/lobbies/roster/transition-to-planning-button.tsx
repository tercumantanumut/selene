"use client";

/**
 * TransitionToPlanningButton — fires the `ready_roster` lobby transition.
 *
 * Captain-side preflight (so we don't surface a server INVALID_TRANSITION
 * 422 when we can predict the failure). Sprint 6.1 (S6 R1 HIGH) realigned
 * this with the actual server contract in `services.ts:525-535`:
 *
 *   - Server requires AT LEAST ONE seat in status `ready` with an agent.
 *   - Server is silent about empty seats: `[ready, empty, empty]` is fine.
 *   - Server is silent about role labels (column `role` is `text NOT NULL`,
 *     but an empty string is allowed at the DB layer; the captain still has
 *     to live with that label later, so the client gates on non-empty).
 *
 * The previous client preflight required EVERY seat to have an agent. That
 * was stricter than the server — captains hit a "These seats need an agent"
 * banner for unfilled extra seats they planned to leave for later. We now
 * mirror the server invariant ("≥1 ready+filled seat") and surface a hint
 * about partially-filled rosters rather than blocking.
 *
 * Server-side guards still apply (it owns the truth). On success, the parent
 * re-fetches lobby detail; the page advances to the planning section
 * automatically because `seedDefaultsForStatus` will fire for the new
 * status... actually no — that's gated by `seededForLobbyId`, so we
 * explicitly call the section helpers from the parent. This component only
 * owns the click + mutation.
 */

import { useId, useState } from "react";
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
  // Sprint 6.1 (S6 R1 HIGH): align with server (`services.ts` requires at
  // least one ready+filled seat). Allow unfilled extras through; server
  // tolerates them. Roles are gated client-side because empty role labels
  // hurt the captain UX downstream — server allows them.
  const blank = seats.filter((s) => !s.role.trim());
  if (blank.length > 0) {
    return {
      reason: "Every seat needs a non-empty role label.",
    };
  }
  const ready = seats.filter(
    (s) => s.agentId !== null && (s.status === "ready" || s.status === "idle"),
  );
  if (ready.length === 0) {
    const filled = seats.filter((s) => s.agentId !== null).length;
    if (filled === 0) {
      return {
        reason: "Pick an agent for at least one seat before moving on.",
      };
    }
    // Filled seat exists but its status hasn't flipped to ready/idle —
    // catches the rare case where `updateSeat` was called with an explicit
    // non-ready status (services.ts preserves it).
    return {
      reason: "At least one filled seat must be in 'ready' or 'idle' status.",
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
  // Sprint 6.1 (S6 R3 / S7A R3 parity): same aria-describedby pattern as
  // AcceptPlanButton so disabled states surface their reason to AT.
  const reasonId = useId();

  const failure = preflight(seats);
  const disabled = failure !== null || submitting;
  const reasonText = error ?? failure?.reason ?? null;

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
        } else if (
          err.reason === "INVALID_TRANSITION" ||
          err.reason === "INVARIANT_VIOLATION"
        ) {
          // Sprint 6.1 (S6 R1 HIGH followup): server's INVARIANT_VIOLATION
          // for `ready_roster` carries useful detail (e.g. "no ready seat
          // with an agent"). Surface verbatim so the captain knows what to
          // fix without re-deriving the rule.
          setError(
            err.message ||
              "Server rejected the transition — at least one seat must be ready and filled.",
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
        aria-describedby={reasonText ? reasonId : undefined}
        aria-busy={submitting}
        className="font-mono"
      >
        {submitting ? (
          <>
            <Loader2
              className="h-3.5 w-3.5 mr-2 animate-spin"
              aria-hidden="true"
            />
            Locking roster…
          </>
        ) : (
          <>
            Ready for planning
            <ArrowRight className="h-3.5 w-3.5 ml-2" aria-hidden="true" />
          </>
        )}
      </Button>
      {reasonText && (
        // Sprint 6.1 (S6 R3 HIGH): amber-700 → amber-800 for AA contrast.
        <p
          id={reasonId}
          role="alert"
          className="font-mono text-[11px] text-amber-800 dark:text-amber-300"
        >
          {reasonText}
        </p>
      )}
    </div>
  );
}

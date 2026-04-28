"use client";

/**
 * AbortLobbyButton — captain's "halt this lobby" CTA.
 *
 * Sprint 9.1 (R5 BLOCKER B2 + B3 fix): the abort button lived inside
 * `RollingSection` and was gated on `lobby.status === "rolling"`. Once the
 * lobby flipped to `review` — including when the synthesizer wedged — the
 * button vanished and the captain had no UI path to halt the run. The
 * orchestrator could be stuck in an LLM stall or an infinite tool loop and
 * the only recovery was curling the transition endpoint or starting a new
 * lobby. SynthesisSection's docstring even claimed "abort lives in the
 * lobby header / top bar" — that statement was aspirational, not factual.
 *
 * This component is the actual top-bar abort. It's rendered from
 * `lobby-detail-client.tsx` in the lobby header so it's visible across
 * every non-terminal status (roster / planning / rolling / review). The
 * dialog confirmation flow (cancel default, destructive action, in-flight
 * spinner, inline error preserved by `e.preventDefault()` on action click)
 * is unchanged from Sprint 7B.1's RollingSection version — we just
 * extracted it so two surfaces don't fork.
 *
 * Visibility rule: only render for non-terminal statuses. `completed` and
 * `aborted` are terminal — there's nothing left to halt — so the parent
 * passes `status` and we no-op.
 *
 * SPEC §3 #6: optimistic concurrency via `expectedVersion`. The server
 * returns 409 if another tab moved the lobby first; we surface the
 * server's message inline (the dialog stays open) so the captain can
 * Refresh and retry without losing context.
 */

import { useState } from "react";
import { AlertOctagon, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LobbyApiError, transitionLobby } from "@/lib/lobbies/client/api";
import type { Lobby, LobbyCard, LobbyStatus } from "@/lib/lobbies/types";

// Statuses where the lobby can no longer be aborted (already terminal).
const TERMINAL_STATUSES = new Set<LobbyStatus>(["completed", "aborted"]);

export type AbortLobbyButtonProps = {
  lobby: Lobby;
  /**
   * Card list — used to preview "N cards currently running will be
   * cancelled" inside the confirmation dialog so the captain knows the
   * blast radius before clicking.
   */
  cards: LobbyCard[];
  /** Called after a successful abort. Parent should refetch. */
  onChanged: () => void;
  /**
   * Optional override for the visible button label. Defaults to "Abort
   * lobby". The synthesis-side caller may want "Halt synthesis" since
   * that's the user's mental model in `review`.
   */
  label?: string;
  /** Optional className for the trigger button (size/variant tweaks). */
  className?: string;
};

export function AbortLobbyButton({
  lobby,
  cards,
  onChanged,
  label = "Abort lobby",
  className,
}: AbortLobbyButtonProps) {
  const [open, setOpen] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Don't render once the lobby is terminal — there's nothing to halt.
  if (TERMINAL_STATUSES.has(lobby.status)) return null;

  const runningCount = cards.filter((c) => c.status === "running").length;

  async function handleAbort() {
    setAborting(true);
    setError(null);
    try {
      await transitionLobby(lobby.id, {
        action: "abort",
        expectedVersion: lobby.lockVersion,
        // `cancel` mode tells the orchestrator to mark in-flight cards
        // `cancelled` (vs. `wait` which lets them finish, vs. `abandon`
        // which leaves them as-is). Cancel is the right default for a
        // captain-initiated halt — the captain wants the system to stop.
        mode: "cancel",
        reason: "Captain aborted the lobby",
      });
      setOpen(false);
      onChanged();
    } catch (err) {
      if (err instanceof LobbyApiError) {
        if (err.reason === "VERSION_CONFLICT") {
          setError(
            "The lobby was updated in another tab. Refresh and try again.",
          );
          // Trigger a refetch so the captain's next attempt sees the
          // latest lockVersion. Matches the codebase's standard recovery
          // pattern (Sprint 9.1 R1 H1 carryover).
          onChanged();
        } else {
          setError(err.message);
        }
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to abort the lobby");
      }
    } finally {
      setAborting(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        className={
          "font-mono text-xs text-red-700 hover:text-red-800 dark:text-red-300 border-red-700/40 " +
          (className ?? "")
        }
        aria-label={`${label} — cancels every running card and ends this lobby`}
      >
        <AlertOctagon className="h-3 w-3 mr-1.5" aria-hidden="true" />
        {label}
      </Button>

      {/*
        AlertDialog (vs. plain Dialog) gives us role="alertdialog" — SR
        interrupts every other announcement, the destructive button is
        styled red, and Cancel is the default focus target. Same shape
        Sprint 7B.1 R5-H2 introduced; just extracted so we don't fork.
      */}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-base">
              Abort this lobby?
            </AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-xs">
              The orchestrator will stop dispatching new work, every
              currently <span className="font-semibold">running</span> card
              will be cancelled, and the lobby moves to{" "}
              <span className="font-semibold">aborted</span>. You can still
              review what was done; you cannot resume from this state.
              {runningCount > 0 && (
                <span className="block pt-2">
                  {runningCount} card{runningCount === 1 ? "" : "s"} currently
                  running will be cancelled.
                </span>
              )}
              {lobby.synthesisRunId !== null && (
                <span className="block pt-2">
                  The in-flight synthesis run will be cancelled.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p
              role="alert"
              className="font-mono text-[11px] text-red-700 dark:text-red-300"
            >
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={aborting}
              className="font-mono text-xs"
            >
              Keep going
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={aborting}
              onClick={(e) => {
                // AlertDialogAction auto-closes on click; we want to keep
                // the dialog open while the request is in flight so the
                // captain sees the spinner / error inline.
                e.preventDefault();
                void handleAbort();
              }}
              className="font-mono text-xs bg-red-700 hover:bg-red-800 text-white"
            >
              {aborting ? (
                <>
                  <Loader2
                    className="h-3 w-3 mr-1.5 animate-spin"
                    aria-hidden="true"
                  />
                  Aborting…
                </>
              ) : (
                <>
                  <AlertOctagon
                    className="h-3 w-3 mr-1.5"
                    aria-hidden="true"
                  />
                  Abort lobby
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

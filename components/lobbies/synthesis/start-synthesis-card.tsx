"use client";

/**
 * StartSynthesisCard — pre-flight panel + `start_synthesis` CTA.
 *
 * Visible while the lobby is in `review` phase and `synthesisRunId` is
 * still null. Renders three things:
 *
 *   1. Approval roll-up: "N of M cards approved". The CTA stays disabled
 *      until every card is approved (matches the server-side guard in
 *      `transitionLobbyStartSynthesis` — SPEC §5). Showing the count up
 *      front saves the captain a 422 round-trip.
 *
 *   2. Synthesizer character picker: reuses RosterSection's
 *      `AgentPickerSheet` with `seatRole="synthesizer"`. The selected
 *      character id is passed to the transition as
 *      `synthesizerCharacterId`. If the lobby's `config.synthesizerCharacterId`
 *      is already set (configured at template/lobby creation) it seeds the
 *      picker; the captain can override it before kicking off synthesis.
 *
 *   3. The CTA itself. On click → `transitionLobby({ action: "start_synthesis", … })`.
 *      The result is server-authoritative; we call `onChanged()` so the
 *      parent refetches and the section flips to `SynthesisRunProgress`.
 *
 * Permission scope: V1 ships the synthesizer with an empty `tool_list`
 * scope (the planner/synthesizer sentinel — `lib/lobbies/scope-injection.ts`).
 * That means the synthesizer uses its character's *own* enabled tools, not
 * a per-lobby overlay. We don't expose a scope editor here because there's
 * nothing meaningful to edit in V1.
 *
 * Error handling: VERSION_CONFLICT → ask the captain to refresh and
 * retry (the lobby's lockVersion drifted, usually because another tab or
 * another transition landed in the meantime). Other errors land verbatim
 * in a `role="alert"` banner.
 */

import { Loader2, Sparkles, UserCircle2, AlertCircle } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { AgentPickerSheet } from "@/components/lobbies/roster/agent-picker-sheet";
import {
  useCharacters,
  indexCharactersById,
} from "@/lib/lobbies/client/character-hooks";
import { LobbyApiError, transitionLobby } from "@/lib/lobbies/client/api";
import type { Lobby, LobbyCard } from "@/lib/db/sqlite-lobbies-schema";

export type StartSynthesisCardProps = {
  lobby: Lobby;
  cards: LobbyCard[];
  /** Called after a successful `start_synthesis`. Parent should refetch. */
  onChanged: () => void;
  className?: string;
};

export function StartSynthesisCard({
  lobby,
  cards,
  onChanged,
  className,
}: StartSynthesisCardProps) {
  // Approval roll-up: V1 treats every card as required (no per-card
  // `required` flag yet — matches the server's `transitionLobbyStartSynthesis`
  // logic which checks ALL cards). Once we add a `required` column on
  // lobby_cards, narrow this filter accordingly.
  const totalCards = cards.length;
  const approvedCards = useMemo(
    () => cards.filter((c) => c.status === "approved").length,
    [cards],
  );
  const allApproved = totalCards > 0 && approvedCards === totalCards;
  const unapprovedCount = totalCards - approvedCards;

  // Synthesizer character: seed from lobby.config; let captain override.
  // We don't write the override back to lobby.config — `start_synthesis`
  // takes the character id directly, and persisting it on the lobby would
  // require an extra updateLobby PATCH. V1 keeps it transient.
  const initialCharacterId =
    (lobby.config?.synthesizerCharacterId as string | undefined) ?? null;
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(
    initialCharacterId,
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  const { characters, loading: charactersLoading } = useCharacters();
  const characterById = useMemo(
    () => indexCharactersById(characters),
    [characters],
  );
  const selectedCharacter = selectedCharacterId
    ? (characterById[selectedCharacterId] ?? null)
    : null;

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startSynthesis() {
    setSubmitting(true);
    setError(null);
    try {
      await transitionLobby(lobby.id, {
        action: "start_synthesis",
        expectedVersion: lobby.lockVersion,
        // Only forward the character id when the captain explicitly picked
        // one (or the lobby config seeded it). Omitting the field tells
        // the server to leave `agent_runs.character_id` null and let the
        // orchestrator pick a default.
        ...(selectedCharacterId
          ? { synthesizerCharacterId: selectedCharacterId }
          : {}),
      });
      onChanged();
    } catch (err) {
      if (err instanceof LobbyApiError) {
        if (err.reason === "VERSION_CONFLICT") {
          setError(
            "The lobby was updated in another tab. Refresh and try again.",
          );
        } else {
          setError(err.message);
        }
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to start synthesis.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const ctaDisabled = !allApproved || submitting;

  return (
    <Card
      className={cn(
        "p-4 flex flex-col gap-4 border-terminal-border/50 bg-terminal-cream/40",
        className,
      )}
    >
      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="flex items-start gap-3">
        <Sparkles
          className="h-5 w-5 text-terminal-dark mt-0.5 shrink-0"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-semibold text-terminal-dark">
            Ready for synthesis?
          </p>
          <p className="font-mono text-xs text-terminal-muted mt-0.5">
            The synthesizer subagent reads every approved card's output and
            produces the final artifact. All cards must be approved first.
          </p>
        </div>
      </div>

      {/* ── Approval roll-up ─────────────────────────────────────── */}
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "rounded border px-3 py-2 font-mono text-xs",
          allApproved
            ? "border-terminal-green/40 bg-terminal-green/5 text-terminal-green"
            : "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300",
        )}
      >
        {totalCards === 0 ? (
          <>No cards in this lobby — nothing to synthesize.</>
        ) : allApproved ? (
          <>All {totalCards} cards approved.</>
        ) : (
          <>
            {approvedCards} of {totalCards} cards approved
            {unapprovedCount > 0 && (
              <>
                {" "}
                — {unapprovedCount} still {unapprovedCount === 1 ? "needs" : "need"}{" "}
                review.
              </>
            )}
          </>
        )}
      </div>

      {/* ── Synthesizer character picker ─────────────────────────── */}
      <div className="rounded border border-terminal-border/50 bg-terminal-cream/60 p-3">
        <p className="font-mono text-[11px] uppercase tracking-wide text-terminal-muted">
          Synthesizer character
        </p>
        <div className="mt-2 flex items-center gap-2">
          <UserCircle2
            className="h-4 w-4 text-terminal-dark shrink-0"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            {charactersLoading ? (
              <p className="font-mono text-xs text-terminal-muted italic">
                Loading characters…
              </p>
            ) : selectedCharacter ? (
              <p className="font-mono text-xs text-terminal-dark truncate">
                {selectedCharacter.displayName ?? selectedCharacter.name}
              </p>
            ) : (
              <p className="font-mono text-xs text-terminal-muted italic">
                No character selected — orchestrator default will run.
              </p>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setPickerOpen(true)}
            className="font-mono text-[11px]"
          >
            {selectedCharacter ? "Change" : "Pick"}
          </Button>
        </div>
      </div>

      {/* ── Error banner ─────────────────────────────────────────── */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/5 p-2"
        >
          <AlertCircle
            className="h-3.5 w-3.5 text-red-700 dark:text-red-300 mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <p className="font-mono text-xs text-red-700 dark:text-red-300 break-words">
            {error}
          </p>
        </div>
      )}

      {/* ── CTA ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void startSynthesis()}
          disabled={ctaDisabled}
          className="font-mono"
          // Disabled buttons don't fire pointer events; the title gives
          // SR users (and pointer-hover users) a hint about what's missing.
          title={
            !allApproved
              ? `${unapprovedCount} card${unapprovedCount === 1 ? "" : "s"} still need review`
              : undefined
          }
        >
          {submitting ? (
            <Loader2
              className="h-3.5 w-3.5 mr-1.5 animate-spin"
              aria-hidden="true"
            />
          ) : (
            <Sparkles className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
          )}
          Start synthesis
        </Button>
      </div>

      {/* ── Picker sheet ─────────────────────────────────────────── */}
      <AgentPickerSheet
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        seatRole="synthesizer"
        seedSelectedAgentId={selectedCharacterId}
        onPick={(agentId) => setSelectedCharacterId(agentId)}
      />
    </Card>
  );
}

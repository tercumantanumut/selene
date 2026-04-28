"use client";

/**
 * SynthesisSection — final-phase surface for Solo Story Mode.
 *
 * Renders one of four states based on the lobby's status + synthesis
 * fields. The mapping mirrors the server-side state machine in
 * `lib/lobbies/services.ts` (`transitionLobbyStartSynthesis` /
 * `completeSynthesis`):
 *
 *   pre-review   lobby.status ∈ {roster, planning, rolling}
 *                → "Synthesis runs after the review phase. Approve every
 *                   card to unlock the kickoff."
 *
 *   not-started  lobby.status === "review" && synthesisRunId === null
 *                → <StartSynthesisCard />
 *
 *   running      lobby.status === "review" && synthesisRunId !== null
 *                → <SynthesisRunProgress />
 *
 *   completed    lobby.status === "completed"
 *                → <ArtifactViewer />
 *
 *   aborted      lobby.status === "aborted"
 *                → "Lobby aborted; synthesis did not run."
 *
 * SPEC §3 #6/#8: this is the same `useLobbyRunStream` instance the rolling
 * and review sections subscribe to. The page-level hook in
 * `lobby-detail-client.tsx` lifts it to one EventSource that fans out to
 * all three sections — see Sprint 8 lift + Sprint 9-1 byRole extension.
 *
 * Sprint 9 explicit non-goals (and why):
 *   - No abort button. Aborting a synthesis run is identical to aborting
 *     the lobby; that CTA already lives in the lobby header / top bar
 *     (Sprint 5 shell). Adding a duplicate here would create a confusing
 *     "abort what?" question.
 *   - No retry button. A failed synthesis run cannot be retried in V1
 *     because the server's `transitionLobbyStartSynthesis` rejects when
 *     `synthesisRunId !== null`. A future sprint can add a `retry_synthesis`
 *     transition that nulls the prior run id and starts a new one.
 *   - No transcript export / download. Out of scope; the chat session
 *     for the lobby preserves the synthesizer's output in full.
 */

import { Sparkles, XCircle } from "lucide-react";

import { Card } from "@/components/ui/card";
import type { Lobby, LobbyCard } from "@/lib/db/sqlite-lobbies-schema";
import type { LobbyRunStreamHandle } from "@/lib/lobbies/client/run-stream";

import { ArtifactViewer } from "./artifact-viewer";
import { StartSynthesisCard } from "./start-synthesis-card";
import { SynthesisRunProgress } from "./synthesis-run-progress";

export type SynthesisSectionProps = {
  lobby: Lobby;
  cards: LobbyCard[];
  runStream: LobbyRunStreamHandle;
  /** Called after a successful transition. Parent should refetch. */
  onChanged: () => void;
};

export function SynthesisSection({
  lobby,
  cards,
  runStream,
  onChanged,
}: SynthesisSectionProps) {
  const status = lobby.status;
  const hasSynthesisRun = lobby.synthesisRunId !== null;

  // Pre-review (roster, planning, rolling): synthesis isn't a meaningful
  // surface yet. Render a minimal "what to expect" hint so the section is
  // discoverable as the captain scrolls down, without competing with the
  // active phase's surface.
  if (status === "roster" || status === "planning" || status === "rolling") {
    return (
      <Card
        role="status"
        aria-live="polite"
        className="p-3 flex items-start gap-3 bg-terminal-cream/30 border-terminal-border/50"
      >
        <Sparkles
          className="h-4 w-4 text-terminal-muted mt-0.5 shrink-0"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-semibold text-terminal-dark">
            Synthesis pending
          </p>
          <p className="font-mono text-xs text-terminal-muted mt-0.5">
            Once every card is approved, the captain can kick off the
            synthesizer to produce the final artifact.
          </p>
        </div>
      </Card>
    );
  }

  // Aborted: terminal failure path. The lobby never produced a synthesis
  // run (or had one that was implicitly cancelled by `abort`). No CTA;
  // the captain's path forward is creating a new lobby.
  if (status === "aborted") {
    return (
      <Card
        role="status"
        className="p-3 flex items-start gap-3 border-red-500/30 bg-red-500/5"
      >
        <XCircle
          className="h-4 w-4 text-red-700 dark:text-red-300 mt-0.5 shrink-0"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-semibold text-red-700 dark:text-red-300">
            Lobby aborted
          </p>
          <p className="font-mono text-xs text-terminal-muted mt-0.5">
            Synthesis did not run. Card outputs (where present) are still
            readable in the review section above.
          </p>
        </div>
      </Card>
    );
  }

  // Completed: synthesis succeeded and the artifact id was written. Even
  // if we still have a stale `runState` in `byRole.synthesizer`, the
  // ArtifactViewer is the canonical surface — the run-progress timeline
  // is no longer the captain's primary concern.
  if (status === "completed") {
    return <ArtifactViewer lobby={lobby} />;
  }

  // status === "review": the only branch left. Either the captain hasn't
  // started synthesis yet, or it's in flight.
  if (!hasSynthesisRun) {
    return (
      <StartSynthesisCard
        lobby={lobby}
        cards={cards}
        onChanged={onChanged}
      />
    );
  }

  return (
    <SynthesisRunProgress
      runState={runStream.byRole.get("synthesizer")}
      isInFlight={true}
    />
  );
}

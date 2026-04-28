"use client";

/**
 * SynthesisRunProgress — live transcript of the synthesizer subagent.
 *
 * Why a dedicated component instead of reusing `RunTranscript`?
 *
 *   `RunTranscript` is *card-centric*: it requires a `LobbyCard` so it can
 *   read `card.output` / `card.failureReason` / `card.status` and decide
 *   whether the live SSE stream or the persisted card row should win. The
 *   synthesis run is lobby-level — there is no card to anchor that
 *   decision tree on. Forking a parallel `LobbyRunTranscript` would have
 *   doubled the surface; this component is a much smaller carve-out that
 *   only handles the synthesizer's progress timeline.
 *
 * Data source: a single `RunStreamState` from
 * `LobbyRunStreamHandle.byRole.get("synthesizer")` (see Sprint 9-1
 * extension to `useLobbyRunStream`). Sprint 9-1 ensures lobby-level runs
 * land in `byRole`, separately from the per-card map.
 *
 * Lifecycle:
 *   - undefined runState → "Synthesizer queued. Waiting for first event…"
 *     (the lobby's `synthesisRunId` is set but no SSE has arrived yet —
 *     either because the EventSource is connecting, or because the
 *     orchestrator hasn't fired `task:started` yet).
 *   - running → live timeline updates as fragments arrive.
 *   - succeeded → "Synthesis complete" footer; the parent flips to
 *     `ArtifactViewer` once the lobby refetches and reports
 *     `status === "completed"`.
 *   - failed/cancelled → error banner; captain can `abort` the lobby
 *     (handled outside this component) or wait for the orchestration
 *     layer to retry.
 *
 * SSE reconnect resilience: `useLobbyRunStream` already handles transient
 * disconnects with a 2s backoff. If the synthesizer finishes during a
 * disconnect, the parent's `onRoleRunCompleted` callback may not fire —
 * the parent's lobby-detail refetch (every transition / manual refresh)
 * will eventually reconcile via `lobby.outputArtifactId !== null`. We
 * don't try to be clever here.
 */

import { useMemo } from "react";
import { AlertCircle, CheckCircle2, Loader2, Sparkles } from "lucide-react";

import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import type { RunStreamState } from "@/lib/lobbies/client/run-stream";

export type SynthesisRunProgressProps = {
  /** Live state for the synthesizer run. May be undefined if no SSE landed yet. */
  runState: RunStreamState | undefined;
  /**
   * Whether the lobby believes a synthesis run is in flight (i.e.,
   * `lobby.synthesisRunId !== null` AND `lobby.status === "review"`).
   * The component uses this to render the "queued, waiting" state when
   * `runState` is still undefined.
   */
  isInFlight: boolean;
  className?: string;
};

export function SynthesisRunProgress({
  runState,
  isInFlight,
  className,
}: SynthesisRunProgressProps) {
  const fragments = runState?.fragments ?? [];

  // Order: oldest at top, newest at bottom. Mirror RunTranscript's full
  // mode, which reads top-to-bottom like a console.
  const ordered = useMemo(() => fragments.slice(), [fragments]);

  // Sprint 9.1 (R5 P8): `deriveStatus` no longer needs `isInFlight` — both
  // queued sub-cases (lobby thinks a run is in flight / lobby doesn't) now
  // fall through to "queued" for an honest "no observed activity" header.
  const status = deriveStatus(runState);
  // Reference `isInFlight` to keep the prop in the public surface for the
  // queued copy below — the EmptyTimeline "queued" detail mentions it.
  void isInFlight;

  return (
    <Card
      className={cn(
        "flex flex-col gap-3 p-4 border-terminal-border/50 bg-terminal-cream/40",
        className,
      )}
    >
      <Header status={status} />

      {ordered.length === 0 ? (
        <EmptyTimeline status={status} />
      ) : (
        <ScrollArea className="max-h-[420px] -mx-4 px-4">
          <ol
            // role="log" + aria-live="polite" so SR users get incremental
            // updates without speech queue thrash on every fragment.
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            className="space-y-2 font-mono text-xs"
          >
            {ordered.map((frag, i) => (
              <li
                key={frag.id || `${frag.timestamp}-${i}`}
                className="flex gap-3 rounded border border-terminal-border/30 bg-terminal-cream/60 px-2 py-1.5"
              >
                <span
                  className="shrink-0 text-terminal-muted tabular-nums"
                  aria-label={`Fragment ${i + 1} at ${frag.timestamp}`}
                >
                  {fragmentTimestampLabel(frag.timestamp)}
                </span>
                <div className="min-w-0 flex-1">
                  {frag.text ? (
                    <p className="whitespace-pre-wrap break-words text-terminal-dark">
                      {frag.text}
                    </p>
                  ) : (
                    <p className="italic text-terminal-muted">
                      {/*
                        A fragment with no text is normal: silent tool
                        calls produce progress events that only carry a
                        `contentCount` bump. Show that count instead of
                        an empty row so the captain still sees activity.
                      */}
                      {frag.contentCount
                        ? `+${frag.contentCount} event${frag.contentCount === 1 ? "" : "s"}`
                        : "(no text)"}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </ScrollArea>
      )}

      {status.kind === "failed" && runState?.error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/5 p-2"
        >
          <AlertCircle
            className="h-3.5 w-3.5 text-red-700 dark:text-red-300 mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <p className="font-mono text-xs text-red-700 dark:text-red-300 break-words">
            {runState.error}
          </p>
        </div>
      )}

      {/* Sprint 9.1 (R5 BLOCKER B3): recovery hint. Without this, a failed
          or cancelled synthesizer dead-ended the captain — the run sat
          there with no obvious next move, and the abort CTA used to live
          inside RollingSection (which is no longer the visible section in
          `review`). Now we point at the lobby-header abort button so the
          captain has an explicit recovery path. */}
      {(status.kind === "failed" || status.kind === "cancelled") && (
        <p
          role="status"
          aria-live="polite"
          className="font-mono text-[11px] text-terminal-muted"
        >
          Use{" "}
          <span className="font-semibold text-terminal-dark">Abort lobby</span>{" "}
          in the header to halt this run and end the lobby, or refresh once
          the orchestrator retries.
        </p>
      )}
    </Card>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────

type Status =
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "succeeded" }
  | { kind: "failed" }
  | { kind: "cancelled" };

function deriveStatus(runState: RunStreamState | undefined): Status {
  if (!runState) {
    // Sprint 9.1 (R5 P8): the previous fallback returned `running` when
    // both `runState` and `isInFlight` were false — visually showing a
    // spinning header for a lobby that has no synthesis run at all. The
    // parent only mounts this component when `synthesisRunId !== null`,
    // so the false branch should be effectively dead — but if it's hit
    // (race between props update and refetch), `queued` is the honest
    // default: "we expect activity, none observed yet."
    return { kind: "queued" };
  }
  switch (runState.phase) {
    case "succeeded":
      return { kind: "succeeded" };
    case "failed":
      return { kind: "failed" };
    case "cancelled":
      return { kind: "cancelled" };
    case "running":
    case "starting":
      return { kind: "running" };
    case "idle":
    default:
      return { kind: "queued" };
  }
}

function Header({ status }: { status: Status }) {
  let Icon: React.ElementType = Loader2;
  let label = "";
  let pulsing = false;
  let tone = "text-terminal-dark";

  switch (status.kind) {
    case "queued":
      Icon = Sparkles;
      label = "Synthesizer queued — waiting for first event";
      break;
    case "running":
      Icon = Loader2;
      label = "Synthesizer running";
      pulsing = true;
      break;
    case "succeeded":
      Icon = CheckCircle2;
      label = "Synthesis complete";
      // Sprint 9.1 (R3 H1): `text-terminal-green` on the cream Card bg
      // measures ≈3.0–3.3:1 — fails WCAG AA for body text. Use the
      // green only on the icon (decorative / aria-hidden) and keep the
      // text in `terminal-dark` (high contrast).
      tone = "text-terminal-dark";
      break;
    case "failed":
      Icon = AlertCircle;
      label = "Synthesis failed";
      tone = "text-red-700 dark:text-red-300";
      break;
    case "cancelled":
      Icon = AlertCircle;
      label = "Synthesis cancelled";
      tone = "text-terminal-muted";
      break;
  }

  return (
    <div
      // Sprint 9.1 (R3 H2): the previous markup combined `role="status"`,
      // `aria-live="polite"`, AND `aria-atomic="true"`. With the timeline
      // below using `role="log"` + `aria-live="polite"`, the atomic header
      // re-announced its full text on every transition — competing with
      // the log's incremental announcements. Dropping aria-atomic lets
      // the SR announce only the changed substring on transition (which
      // is the natural behaviour for role=status), and keeps the log as
      // the primary stream surface.
      role="status"
      aria-live="polite"
      className="flex items-center gap-2"
    >
      <Icon
        className={cn(
          "h-4 w-4 shrink-0",
          tone,
          pulsing && "animate-spin",
        )}
        aria-hidden="true"
      />
      <p className={cn("font-mono text-sm font-semibold", tone)}>{label}</p>
    </div>
  );
}

function EmptyTimeline({ status }: { status: Status }) {
  let detail = "";
  switch (status.kind) {
    case "queued":
      detail =
        "The synthesizer subagent has been requested but no progress has streamed yet.";
      break;
    case "running":
      detail =
        "Synthesizer is working. Fragments will appear here as they stream.";
      break;
    case "succeeded":
      detail =
        "Synthesizer finished without emitting progress fragments. The artifact is ready below.";
      break;
    case "failed":
      detail = "Synthesizer failed before emitting progress fragments.";
      break;
    case "cancelled":
      detail = "Synthesizer was cancelled before emitting progress fragments.";
      break;
  }
  return (
    <p className="font-mono text-xs text-terminal-muted italic">{detail}</p>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Local copy of the formatter from `run-transcript.tsx`. We keep it
 * inline rather than reaching across the rolling/ folder import boundary
 * — this component is a small leaf and a one-liner duplicate is cheaper
 * than coupling synthesis/ to rolling/'s internals.
 */
function fragmentTimestampLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

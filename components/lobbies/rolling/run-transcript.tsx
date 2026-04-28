"use client";

/**
 * RunTranscript — renders a card's live run timeline.
 *
 * Two modes:
 *
 *   - inline: compact, single-pane summary used in-card (shows the latest
 *             fragment plus a "+N more" hint). Designed to fit in a Kanban
 *             tile or a review-section row without dominating the surface.
 *   - full:   scrollable, full timeline used in `<FullscreenRunModal>`.
 *             Includes timestamps, fragment numbering, and a status header.
 *
 * Data sources:
 *   1. `runState` (from `useLobbyRunStream`) — live progress fragments.
 *   2. `card.output` — the persisted card output JSON (set by the server
 *      when a card transitions to `awaiting_review` / `approved`).
 *   3. `card.failureReason` — terminal failure text.
 *
 * Hierarchy: live runState dominates while the card is `running`; once the
 * card lands in a terminal state, persisted card fields take over (the SSE
 * stream may have disconnected by then or the captain may have just opened
 * the lobby and not seen the live events).
 *
 * SPEC §3 #15: card output is JSON with optional `summary` + `artifacts`.
 * We render the summary as text and list artifact titles + URLs; per-artifact
 * inline previews land in Sprint 9 with the synthesis surface.
 */

import { useMemo } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Inbox,
  Loader2,
  PauseCircle,
  Sparkles,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import type { LobbyCard } from "@/lib/db/sqlite-lobbies-schema";
import type {
  RunStreamFragment,
  RunStreamState,
} from "@/lib/lobbies/client/run-stream";
import { formatDuration } from "@/lib/utils/timestamp";

// ─── Types ────────────────────────────────────────────────────────────────

export type RunTranscriptMode = "inline" | "full";

export type RunTranscriptProps = {
  card: LobbyCard;
  /** Live runState for this card. Undefined when no SSE has landed yet. */
  runState: RunStreamState | undefined;
  mode: RunTranscriptMode;
  className?: string;
};

// ─── Component ───────────────────────────────────────────────────────────

export function RunTranscript({
  card,
  runState,
  mode,
  className,
}: RunTranscriptProps) {
  const meta = useMemo(() => deriveTranscriptMeta(card, runState), [card, runState]);

  if (mode === "inline") {
    return <InlineTranscript card={card} meta={meta} className={className} />;
  }
  return <FullTranscript card={card} runState={runState} meta={meta} className={className} />;
}

// ─── Inline mode ─────────────────────────────────────────────────────────

function InlineTranscript({
  card,
  meta,
  className,
}: {
  card: LobbyCard;
  meta: TranscriptMeta;
  className?: string;
}) {
  // For terminal states the inline mode just shows status + a one-line hint.
  // The captain opens the modal for full detail.
  if (meta.terminalLine) {
    return (
      <div
        className={cn(
          "rounded border border-terminal-border/40 bg-terminal-cream/40 px-2 py-1.5",
          className,
        )}
      >
        <p
          className={cn(
            "font-mono text-[11px] flex items-start gap-1.5",
            meta.terminalTone,
          )}
        >
          <meta.statusIcon
            className="h-3 w-3 mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <span className="line-clamp-2">{meta.terminalLine}</span>
        </p>
      </div>
    );
  }

  // Live running state: latest line + a +N hint when the timeline is long.
  if (meta.latestText) {
    return (
      <div
        className={cn(
          "rounded border border-sky-500/30 bg-sky-500/5 px-2 py-1.5",
          className,
        )}
        role="status"
        aria-live="polite"
      >
        <p className="font-mono text-[11px] text-sky-700 dark:text-sky-300 flex items-start gap-1.5">
          <Loader2
            className="h-3 w-3 mt-0.5 shrink-0 animate-spin"
            aria-hidden="true"
          />
          <span className="line-clamp-2">{meta.latestText}</span>
        </p>
        {meta.fragmentCount > 1 && (
          <p className="font-mono text-[10px] text-terminal-muted mt-0.5">
            +{meta.fragmentCount - 1} earlier event
            {meta.fragmentCount - 1 === 1 ? "" : "s"}
          </p>
        )}
      </div>
    );
  }

  // Card is running but no SSE event has landed yet.
  if (card.status === "running") {
    return (
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "font-mono text-[11px] text-terminal-muted inline-flex items-center gap-1.5",
          className,
        )}
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Starting up…
      </p>
    );
  }

  // Pending / not-yet-started — inline mode hides the surface entirely
  // (the kanban tile already conveys "pending" via its status badge).
  return null;
}

// ─── Full mode ───────────────────────────────────────────────────────────

function FullTranscript({
  card,
  runState,
  meta,
  className,
}: {
  card: LobbyCard;
  runState: RunStreamState | undefined;
  meta: TranscriptMeta;
  className?: string;
}) {
  const fragments = runState?.fragments ?? [];
  const hasLive = fragments.length > 0;
  const output = card.output;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Header: status + duration + attempt counter. */}
      <div className="flex items-start gap-2 rounded-md border border-terminal-border/50 bg-terminal-cream/40 px-3 py-2">
        <meta.statusIcon
          className={cn("h-4 w-4 mt-0.5 shrink-0", meta.statusIconClass)}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-semibold text-terminal-dark">
            {meta.statusLabel}
          </p>
          <p className="font-mono text-[11px] text-terminal-muted">
            {meta.subtitleLine}
          </p>
        </div>
        <Badge variant="outline" className="font-mono text-[10px] shrink-0">
          attempt {card.attemptCount}/{card.maxAttempts}
        </Badge>
      </div>

      {/* Failure reason: surfaced prominently for failed/rejected runs. */}
      {card.failureReason && (
        <div
          role="alert"
          className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2"
        >
          <p className="font-mono text-[11px] text-red-700 dark:text-red-300 inline-flex items-start gap-1.5">
            <AlertTriangle
              className="h-3.5 w-3.5 mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <span className="whitespace-pre-wrap">{card.failureReason}</span>
          </p>
        </div>
      )}

      {/* Review notes: surfaced after the captain's reject/approve. */}
      {card.reviewNotes && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
          <p className="font-mono text-[10px] uppercase tracking-wider text-amber-800 dark:text-amber-300 mb-0.5">
            Review notes
          </p>
          <p className="font-mono text-[11px] text-terminal-dark whitespace-pre-wrap">
            {card.reviewNotes}
          </p>
        </div>
      )}

      {/* Output: shown for awaiting_review / approved states. */}
      {output && (output.summary || (output.artifacts?.length ?? 0) > 0) && (
        <CardOutputBlock output={output} />
      )}

      {/* Live timeline. */}
      <div className="space-y-1.5">
        <p className="font-mono text-[10px] uppercase tracking-wider text-terminal-muted">
          Run timeline
        </p>
        {hasLive ? (
          <ScrollArea className="h-72 rounded-md border border-terminal-border/50 bg-terminal-cream/30">
            <ol className="divide-y divide-terminal-border/30 font-mono text-[11px]">
              {fragments.map((fragment, idx) => (
                <TranscriptRow
                  key={fragment.id}
                  index={idx + 1}
                  fragment={fragment}
                />
              ))}
            </ol>
          </ScrollArea>
        ) : (
          <EmptyTimeline status={card.status} />
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function TranscriptRow({
  index,
  fragment,
}: {
  index: number;
  fragment: RunStreamFragment;
}) {
  const t = fragmentTimestampLabel(fragment.timestamp);
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <span className="font-mono text-[10px] text-terminal-muted/70 tabular-nums shrink-0 w-7 text-right">
        {index.toString().padStart(2, "0")}
      </span>
      <div className="min-w-0 flex-1">
        {fragment.text ? (
          <p className="text-terminal-dark whitespace-pre-wrap break-words">
            {fragment.text}
          </p>
        ) : (
          <p className="text-terminal-muted italic">
            (silent event{fragment.contentCount ? ` · ${fragment.contentCount} parts` : ""})
          </p>
        )}
        <p className="text-[10px] text-terminal-muted/70 mt-0.5">
          {t}
          {fragment.percent !== undefined && (
            <> · {Math.round(fragment.percent * 100)}%</>
          )}
        </p>
      </div>
    </li>
  );
}

function EmptyTimeline({ status }: { status: LobbyCard["status"] }) {
  if (status === "running") {
    return (
      <p
        role="status"
        aria-live="polite"
        className="font-mono text-xs text-terminal-muted px-3 py-6 text-center inline-flex items-center justify-center gap-2 rounded-md border border-terminal-border/40 bg-terminal-cream/30 w-full"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Waiting for the agent's first event…
      </p>
    );
  }
  if (status === "pending") {
    return (
      <p className="font-mono text-xs text-terminal-muted px-3 py-6 text-center inline-flex items-center justify-center gap-2 rounded-md border border-terminal-border/40 bg-terminal-cream/30 w-full">
        <Inbox className="h-3.5 w-3.5" aria-hidden="true" />
        Run hasn't started yet.
      </p>
    );
  }
  return (
    <p className="font-mono text-xs text-terminal-muted px-3 py-6 text-center rounded-md border border-terminal-border/40 bg-terminal-cream/30 w-full">
      No live events recorded for this run.
    </p>
  );
}

function CardOutputBlock({
  output,
}: {
  output: NonNullable<LobbyCard["output"]>;
}) {
  return (
    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2">
      <p className="font-mono text-[10px] uppercase tracking-wider text-emerald-800 dark:text-emerald-300 mb-1 inline-flex items-center gap-1">
        <Sparkles className="h-3 w-3" aria-hidden="true" />
        Output
      </p>
      {output.summary && (
        <p className="font-mono text-[12px] text-terminal-dark whitespace-pre-wrap mb-2">
          {output.summary}
        </p>
      )}
      {output.artifacts && output.artifacts.length > 0 && (
        <ul className="space-y-1">
          {output.artifacts.map((artifact, idx) => (
            <li
              key={artifact.id ?? idx}
              className="font-mono text-[11px] text-terminal-dark inline-flex items-start gap-1.5"
            >
              <Badge variant="outline" className="font-mono text-[10px] shrink-0">
                {artifact.kind}
              </Badge>
              <span className="flex-1 min-w-0">
                {artifact.url ? (
                  <a
                    href={artifact.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-terminal-green underline hover:no-underline inline-flex items-center gap-1"
                  >
                    {artifact.title || artifact.url}
                    <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
                  </a>
                ) : (
                  artifact.title || "(untitled)"
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {output.stale && (
        <p className="font-mono text-[10px] text-amber-800 dark:text-amber-300 mt-1.5 inline-flex items-center gap-1">
          <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
          Output marked stale (upstream card was reopened — output may be obsolete).
        </p>
      )}
    </div>
  );
}

// ─── Meta derivation ─────────────────────────────────────────────────────

type TranscriptMeta = {
  statusLabel: string;
  subtitleLine: string;
  statusIcon: typeof CheckCircle2;
  statusIconClass: string;
  /** A one-line summary for terminal states (rendered in inline mode). */
  terminalLine: string | null;
  terminalTone: string;
  /** Latest progress text for the live state. */
  latestText: string | undefined;
  fragmentCount: number;
};

function deriveTranscriptMeta(
  card: LobbyCard,
  runState: RunStreamState | undefined,
): TranscriptMeta {
  const fragmentCount = runState?.fragments.length ?? 0;
  const latestText = runState?.latestText;

  // `card.status` is canonical, not the live phase. The live phase only
  // updates the running-mid-flight rendering; once the server has settled
  // the card, we trust `card.status` to drive the surface.
  switch (card.status) {
    case "running":
      return {
        statusLabel: "Running",
        subtitleLine: subtitleForRunning(card, runState),
        statusIcon: Loader2,
        statusIconClass: "text-sky-700 dark:text-sky-300 animate-spin",
        terminalLine: null,
        terminalTone: "text-terminal-muted",
        latestText,
        fragmentCount,
      };
    case "awaiting_review":
      return {
        statusLabel: "Ready for review",
        subtitleLine: card.completedAt
          ? `Completed ${shortRelative(card.completedAt)}`
          : "Run finished, captain action required.",
        statusIcon: CheckCircle2,
        statusIconClass: "text-amber-700 dark:text-amber-300",
        terminalLine: card.output?.summary
          ? card.output.summary
          : "Awaiting captain review.",
        terminalTone: "text-amber-800 dark:text-amber-300",
        latestText,
        fragmentCount,
      };
    case "approved":
      return {
        statusLabel: "Approved",
        subtitleLine: card.reviewedAt
          ? `Approved ${shortRelative(card.reviewedAt)}`
          : "Captain accepted the output.",
        statusIcon: CheckCircle2,
        statusIconClass: "text-emerald-700 dark:text-emerald-300",
        terminalLine: card.output?.summary || "Approved.",
        terminalTone: "text-emerald-800 dark:text-emerald-300",
        latestText,
        fragmentCount,
      };
    case "rejected":
      return {
        statusLabel: "Rejected",
        subtitleLine: card.reviewedAt
          ? `Rejected ${shortRelative(card.reviewedAt)}`
          : "Captain rejected the output.",
        statusIcon: XCircle,
        statusIconClass: "text-red-700 dark:text-red-300",
        terminalLine: card.reviewNotes || "Rejected.",
        terminalTone: "text-red-700 dark:text-red-300",
        latestText,
        fragmentCount,
      };
    case "failed":
      return {
        statusLabel: "Failed",
        subtitleLine: card.completedAt
          ? `Failed ${shortRelative(card.completedAt)}`
          : "Run failed.",
        statusIcon: AlertTriangle,
        statusIconClass: "text-red-700 dark:text-red-300",
        terminalLine: card.failureReason || "Run failed.",
        terminalTone: "text-red-700 dark:text-red-300",
        latestText,
        fragmentCount,
      };
    case "cancelled":
      return {
        statusLabel: "Cancelled",
        subtitleLine: card.completedAt
          ? `Cancelled ${shortRelative(card.completedAt)}`
          : "Cancelled by captain.",
        statusIcon: PauseCircle,
        statusIconClass: "text-terminal-muted",
        terminalLine: "Cancelled.",
        terminalTone: "text-terminal-muted",
        latestText,
        fragmentCount,
      };
    case "pending":
    default:
      return {
        statusLabel: "Pending",
        subtitleLine:
          card.column === "ready"
            ? "Dependencies clear — waiting for the orchestrator."
            : "Not started yet.",
        statusIcon: Inbox,
        statusIconClass: "text-terminal-muted",
        terminalLine: null,
        terminalTone: "text-terminal-muted",
        latestText,
        fragmentCount,
      };
  }
}

function subtitleForRunning(
  card: LobbyCard,
  runState: RunStreamState | undefined,
): string {
  const start = runState?.startedAt ?? card.startedAt;
  if (!start) return "Run is starting…";
  const startedMs = Date.parse(start);
  if (Number.isNaN(startedMs)) return "Running…";
  const elapsed = Date.now() - startedMs;
  return `Running for ${formatDuration(elapsed)}`;
}

/**
 * Short relative timestamp ("3m ago", "2h ago"). Hand-rolled to dodge a
 * date-fns dependency for one helper; the project doesn't ship moment/dayjs.
 */
function shortRelative(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const elapsed = Date.now() - ms;
  if (elapsed < 0) return "just now";
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function fragmentTimestampLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms);
  // HH:MM:SS — local time. Captain is staring at this; absolute time is
  // far more useful than "3 seconds ago" rolling forward.
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

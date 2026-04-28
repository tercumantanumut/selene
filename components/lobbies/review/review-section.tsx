"use client";

/**
 * ReviewSection — captain's per-card review surface.
 *
 * Replaces the Sprint 7B `ReviewSectionPlaceholder`. This is the canonical
 * landing zone for cards that have either finished a run or need captain
 * attention before the lobby can move forward:
 *
 *   - Awaiting review: status === "awaiting_review". The captain reads the
 *                      run transcript + output, then approves or rejects.
 *   - Recent runs    : status ∈ {approved, rejected, failed, cancelled}.
 *                      Sorted by `completedAt` desc so the latest runs sit
 *                      on top. Each row exposes Retry / Reopen affordances
 *                      via the compact `ReviewActions` and links into the
 *                      fullscreen run modal for the full transcript.
 *
 * The section is visible during `rolling`, `review`, `completed`, and
 * `aborted`. While in `rolling`, it doubles as a triage panel — the captain
 * sees what needs attention without leaving the kanban surface.
 *
 * `enter_review` transition (rolling → review) is offered as a CTA at the
 * top of the section when applicable: the lobby must be in `rolling` AND
 * every card must be in a terminal state (approved | rejected | failed |
 * cancelled). When the captain accepts the plan they don't have to go
 * back to the kanban to flip the lobby into review — the prompt lives
 * here next to the cards being reviewed.
 *
 * SPEC §5: card state machine + lobby state machine.
 * SPEC §3 #6: no Query/SWR. All mutations go through `transitionCard` /
 * `transitionLobby`; the parent's `onChanged` triggers a refetch.
 */

import { useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  PlayCircle,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type {
  Lobby,
  LobbyCard,
  LobbySeat,
} from "@/lib/db/sqlite-lobbies-schema";
import {
  LobbyApiError,
  transitionLobby,
} from "@/lib/lobbies/client/api";
import {
  getRunStateForCard,
  type LobbyRunStreamHandle,
} from "@/lib/lobbies/client/run-stream";
import { useSoloStoryUiStore } from "@/lib/stores/solo-story-ui-store";

import { RunTranscript } from "../rolling/run-transcript";
import { ReviewActions } from "../rolling/review-actions";

// ─── Props ────────────────────────────────────────────────────────────────

export type ReviewSectionProps = {
  lobby: Lobby;
  cards: LobbyCard[];
  seats: LobbySeat[];
  /** Page-scoped run-stream from `useLobbyRunStream`. */
  runStream: LobbyRunStreamHandle;
  onChanged: () => void;
};

// Statuses that count as "card finished" for the review surface.
const TERMINAL_STATUSES = new Set<LobbyCard["status"]>([
  "approved",
  "rejected",
  "failed",
  "cancelled",
]);

// Statuses we render in the "Recent runs" group.
const RECENT_STATUSES = TERMINAL_STATUSES;

// ─── Component ───────────────────────────────────────────────────────────

export function ReviewSection({
  lobby,
  cards,
  seats,
  runStream,
  onChanged,
}: ReviewSectionProps) {
  const seatById = useMemo(
    () => new Map(seats.map((s) => [s.id, s])),
    [seats],
  );

  // Award the captain control surfaces only while the lobby is in `rolling`
  // (cards are still being processed) or `review` (terminal, but the
  // captain may still reopen approved cards). Once the lobby is `completed`
  // or `aborted`, the rows go read-only.
  const isEditable = lobby.status === "rolling" || lobby.status === "review";

  const awaiting = useMemo(
    () => cards.filter((c) => c.status === "awaiting_review"),
    [cards],
  );

  const recent = useMemo(() => {
    const subset = cards.filter((c) => RECENT_STATUSES.has(c.status));
    // Sort by completedAt desc; fall back to updatedAt when null (e.g. a
    // cancelled card that never reached completion).
    return [...subset].sort((a, b) => {
      const aTime = (a.completedAt ?? a.updatedAt) || "";
      const bTime = (b.completedAt ?? b.updatedAt) || "";
      return bTime.localeCompare(aTime);
    });
  }, [cards]);

  // `enter_review` CTA: lobby must be in `rolling` and every card terminal.
  // We deliberately do not auto-fire — the captain owns this transition so
  // they can approve/reject one last batch before the surface flips.
  const allCardsTerminal = useMemo(
    () => cards.length > 0 && cards.every((c) => TERMINAL_STATUSES.has(c.status)),
    [cards],
  );
  const canEnterReview = lobby.status === "rolling" && allCardsTerminal;

  if (cards.length === 0) {
    return (
      <p className="font-mono text-sm text-terminal-muted">
        No cards in this lobby — nothing to review yet.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Status summary + transition CTA ───────────────────────────── */}
      <ReviewSummary
        lobby={lobby}
        awaitingCount={awaiting.length}
        recentCount={recent.length}
        canEnterReview={canEnterReview}
        onChanged={onChanged}
      />

      {/* ── Awaiting review ────────────────────────────────────────────── */}
      <ReviewGroup
        title="Awaiting review"
        icon={Clock}
        tone="amber"
        emptyMessage={
          lobby.status === "rolling"
            ? "Nothing waiting yet — the kanban shows live runs above."
            : "No cards awaiting review."
        }
        cards={awaiting}
        seatById={seatById}
        runStream={runStream}
        isEditable={isEditable}
        lobbyId={lobby.id}
        onChanged={onChanged}
      />

      {/* ── Recent runs ────────────────────────────────────────────────── */}
      <ReviewGroup
        title="Recent runs"
        icon={CheckCircle2}
        tone="neutral"
        emptyMessage="No completed runs yet."
        cards={recent}
        seatById={seatById}
        runStream={runStream}
        isEditable={isEditable}
        lobbyId={lobby.id}
        onChanged={onChanged}
        compactRows
      />
    </div>
  );
}

// ─── Summary + lobby-level transition ────────────────────────────────────

function ReviewSummary({
  lobby,
  awaitingCount,
  recentCount,
  canEnterReview,
  onChanged,
}: {
  lobby: Lobby;
  awaitingCount: number;
  recentCount: number;
  canEnterReview: boolean;
  onChanged: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enterReview() {
    setSubmitting(true);
    setError(null);
    try {
      await transitionLobby(lobby.id, {
        action: "enter_review",
        expectedVersion: lobby.lockVersion,
      });
      onChanged();
    } catch (err) {
      if (err instanceof LobbyApiError) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to enter review.");
      }
      // Always refetch so the captain sees the latest lockVersion next time.
      onChanged();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-terminal-border/40 bg-terminal-cream/30 px-3 py-2">
      <p className="font-mono text-[11px] text-terminal-muted">
        {awaitingCount} awaiting · {recentCount} completed · lobby is{" "}
        <code className="px-1 rounded bg-terminal-cream/80 text-terminal-dark">
          {lobby.status}
        </code>
      </p>
      <div className="flex items-center gap-2">
        {canEnterReview && (
          <Button
            type="button"
            size="sm"
            onClick={() => void enterReview()}
            disabled={submitting}
            aria-busy={submitting}
            className="font-mono"
          >
            {submitting ? (
              <>
                <Loader2
                  className="h-3.5 w-3.5 mr-1.5 animate-spin"
                  aria-hidden="true"
                />
                Entering review…
              </>
            ) : (
              "Promote lobby to review"
            )}
          </Button>
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="basis-full font-mono text-[11px] text-red-700 dark:text-red-300 inline-flex items-start gap-1.5"
        >
          <AlertCircle
            className="h-3 w-3 mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

// ─── Grouped list ────────────────────────────────────────────────────────

function ReviewGroup({
  title,
  icon: Icon,
  tone,
  emptyMessage,
  cards,
  seatById,
  runStream,
  isEditable,
  lobbyId,
  onChanged,
  compactRows = false,
}: {
  title: string;
  icon: typeof Clock;
  tone: "amber" | "neutral";
  emptyMessage: string;
  cards: LobbyCard[];
  seatById: ReadonlyMap<string, LobbySeat>;
  runStream: LobbyRunStreamHandle;
  isEditable: boolean;
  lobbyId: string;
  onChanged: () => void;
  compactRows?: boolean;
}) {
  const headerToneClass =
    tone === "amber"
      ? "text-amber-700 dark:text-amber-300"
      : "text-terminal-dark";

  return (
    <section aria-labelledby={`review-group-${title.replace(/\s+/g, "-")}`}>
      <h3
        id={`review-group-${title.replace(/\s+/g, "-")}`}
        className={cn(
          "font-mono text-[11px] uppercase tracking-wider mb-2 inline-flex items-center gap-1.5",
          headerToneClass,
        )}
      >
        <Icon className="h-3 w-3" aria-hidden="true" />
        {title}
        <span className="text-terminal-muted">({cards.length})</span>
      </h3>
      {cards.length === 0 ? (
        <p className="font-mono text-[11px] text-terminal-muted px-1">
          {emptyMessage}
        </p>
      ) : (
        <ul className="space-y-2">
          {cards.map((card) => (
            <li key={card.id}>
              <CardReviewRow
                card={card}
                seat={
                  card.assignedSeatId
                    ? seatById.get(card.assignedSeatId) ?? null
                    : null
                }
                runState={getRunStateForCard(runStream, card.id)}
                isEditable={isEditable}
                lobbyId={lobbyId}
                onChanged={onChanged}
                compact={compactRows}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── Single row ──────────────────────────────────────────────────────────

function CardReviewRow({
  card,
  seat,
  runState,
  isEditable,
  lobbyId,
  onChanged,
  compact,
}: {
  card: LobbyCard;
  seat: LobbySeat | null;
  runState: ReturnType<typeof getRunStateForCard>;
  isEditable: boolean;
  lobbyId: string;
  onChanged: () => void;
  compact: boolean;
}) {
  const openFullscreenRun = useSoloStoryUiStore((s) => s.openFullscreenRun);
  const visual = STATUS_VISUALS[card.status];
  const StatusIcon = visual.icon;

  return (
    <article
      className={cn(
        "rounded-md border bg-terminal-cream/40 p-3 space-y-2",
        visual.borderClass,
      )}
    >
      {/* Header — title + status + seat. */}
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p
            className="font-mono text-sm font-semibold text-terminal-dark truncate"
            title={card.title}
          >
            {card.title}
          </p>
          <p className="font-mono text-[10px] text-terminal-muted">
            {seat ? `Assigned to ${seat.role}` : "Unassigned"}
            {" · "}
            attempt {card.attemptCount}/{card.maxAttempts}
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "font-mono text-[10px] uppercase tracking-wider shrink-0",
            visual.badgeClass,
          )}
        >
          <StatusIcon
            className={cn("h-2.5 w-2.5 mr-1", visual.iconClass)}
            aria-hidden="true"
          />
          {visual.label}
        </Badge>
      </header>

      {/* Inline transcript — for awaiting_review and failed/rejected this
          shows the latest progress / failure line. For approved we surface
          the output summary instead (which the inline transcript already
          knows how to render via card.output). */}
      {!compact && (
        <RunTranscript
          card={card}
          runState={runState}
          mode="inline"
          className="mt-1"
        />
      )}

      {/* Action row: Open run + (when applicable) review actions inline. */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => openFullscreenRun(card.id)}
          className="h-7 px-2.5 font-mono text-[11px]"
        >
          <PlayCircle className="h-3 w-3 mr-1" aria-hidden="true" />
          Open run
        </Button>
        <ReviewActions
          lobbyId={lobbyId}
          card={card}
          isEditable={isEditable}
          onChanged={onChanged}
          variant="compact"
        />
      </div>
    </article>
  );
}

// ─── Status visuals ──────────────────────────────────────────────────────

type StatusVisual = {
  label: string;
  borderClass: string;
  badgeClass: string;
  icon: typeof CheckCircle2;
  iconClass: string;
};

const STATUS_VISUALS: Record<LobbyCard["status"], StatusVisual> = {
  pending: {
    label: "pending",
    borderClass: "border-terminal-border/50",
    badgeClass: "border-terminal-border/60 text-terminal-muted",
    icon: Clock,
    iconClass: "text-terminal-muted",
  },
  running: {
    label: "running",
    borderClass: "border-sky-500/40",
    badgeClass:
      "border-sky-500/50 text-sky-700 dark:text-sky-300 bg-sky-500/10",
    icon: Loader2,
    iconClass: "text-sky-600 dark:text-sky-300 animate-spin",
  },
  awaiting_review: {
    label: "review",
    borderClass: "border-amber-500/50",
    badgeClass:
      "border-amber-500/50 text-amber-800 dark:text-amber-300 bg-amber-500/10",
    icon: AlertCircle,
    iconClass: "text-amber-700 dark:text-amber-300",
  },
  approved: {
    label: "approved",
    borderClass: "border-emerald-500/40",
    badgeClass:
      "border-emerald-500/50 text-emerald-800 dark:text-emerald-300 bg-emerald-500/10",
    icon: CheckCircle2,
    iconClass: "text-emerald-700 dark:text-emerald-300",
  },
  rejected: {
    label: "rejected",
    borderClass: "border-red-500/50 border-dashed",
    badgeClass:
      "border-red-500/50 text-red-700 dark:text-red-300 bg-red-500/10",
    icon: XCircle,
    iconClass: "text-red-700 dark:text-red-300",
  },
  failed: {
    label: "failed",
    borderClass: "border-red-500/50",
    badgeClass:
      "border-red-500/50 text-red-700 dark:text-red-300 bg-red-500/10",
    icon: AlertTriangle,
    iconClass: "text-red-700 dark:text-red-300",
  },
  cancelled: {
    label: "cancelled",
    borderClass: "border-terminal-border/40",
    badgeClass: "border-terminal-border/60 text-terminal-muted",
    icon: XCircle,
    iconClass: "text-terminal-muted/70",
  },
};

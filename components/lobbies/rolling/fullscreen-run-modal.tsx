"use client";

/**
 * FullscreenRunModal — large modal that combines a card's run transcript
 * with the captain review actions.
 *
 * Triggered from anywhere in the rolling/review surfaces by calling
 * `useSoloStoryUiStore.openFullscreenRun(cardId)`. The modal subscribes to
 * the store directly, so callers don't need to thread `open`/`onOpenChange`
 * props through the tree — they only need to render the modal once at the
 * lobby-detail level.
 *
 * Composition:
 *   - Header: card title + status badge + assigned seat role.
 *   - Body  : <RunTranscript mode="full" /> with live fragments + persisted
 *             output + failure reason.
 *   - Footer: <ReviewActions variant="full" /> when an action is applicable
 *             for the current status (gated on `isEditable`).
 *
 * The modal is sized large (`max-w-5xl max-h-[90vh]`) because the timeline
 * and the review form both need vertical real estate. We deliberately
 * don't make this fullscreen — keeping the captain anchored to the lobby
 * page underneath helps them flip between cards without re-orienting.
 *
 * SPEC §3 #6 (no Query/SWR): mutations inside the modal go through the
 * shared `transitionCard` API; the parent's `onChanged` triggers a refetch
 * via `useLobbyDetail.refetch`.
 */

import { useMemo } from "react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import type {
  LobbyCard,
  LobbySeat,
} from "@/lib/db/sqlite-lobbies-schema";
import { useSoloStoryUiStore } from "@/lib/stores/solo-story-ui-store";
import {
  getRunStateForCard,
  type LobbyRunStreamHandle,
} from "@/lib/lobbies/client/run-stream";

import { RunTranscript } from "./run-transcript";
import { ReviewActions } from "./review-actions";

// ─── Types ────────────────────────────────────────────────────────────────

export type FullscreenRunModalProps = {
  lobbyId: string;
  /** Lobby cards keyed by `id` lookup; we need to resolve the active card. */
  cards: LobbyCard[];
  /** Lobby seats; used to label the assigned agent in the header. */
  seats: LobbySeat[];
  /**
   * Live-stream handle from `useLobbyRunStream`. The modal pulls the active
   * card's slice via `getRunStateForCard`.
   */
  runStream: LobbyRunStreamHandle;
  /** True while the lobby is in `rolling`. Gates the review actions. */
  isEditable: boolean;
  /** Fires after a successful mutation so the parent can refetch. */
  onChanged: () => void;
};

// ─── Component ───────────────────────────────────────────────────────────

export function FullscreenRunModal({
  lobbyId,
  cards,
  seats,
  runStream,
  isEditable,
  onChanged,
}: FullscreenRunModalProps) {
  const fullscreenRunCardId = useSoloStoryUiStore((s) => s.fullscreenRunCardId);
  const closeFullscreenRun = useSoloStoryUiStore((s) => s.closeFullscreenRun);

  // Resolve the card. If the card no longer exists (deleted under us), close
  // the modal — better than rendering a ghost.
  const card = useMemo(() => {
    if (!fullscreenRunCardId) return null;
    return cards.find((c) => c.id === fullscreenRunCardId) ?? null;
  }, [fullscreenRunCardId, cards]);

  const seat = useMemo(() => {
    if (!card?.assignedSeatId) return null;
    return seats.find((s) => s.id === card.assignedSeatId) ?? null;
  }, [card, seats]);

  const runState = card ? getRunStateForCard(runStream, card.id) : undefined;

  const open = card !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeFullscreenRun();
      }}
    >
      <DialogContent
        className={cn(
          "w-full max-w-5xl max-h-[90vh] overflow-hidden",
          "p-0 flex flex-col gap-0",
          // The shared DialogContent ships with a 6-padded body; we override
          // it so the header/body/footer can each manage their own padding
          // (otherwise the scrollable transcript collides with the close
          // button).
        )}
      >
        {card ? (
          <ModalBody
            lobbyId={lobbyId}
            card={card}
            seat={seat}
            runState={runState}
            isEditable={isEditable}
            onChanged={onChanged}
          />
        ) : (
          // Defensive: should never render — `open` is false when card is null.
          // Keeping a placeholder avoids Radix yelling about a missing title.
          <DialogHeader className="px-6 pt-5 pb-3">
            <DialogTitle className="font-mono text-base">Run details</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              No card selected.
            </DialogDescription>
          </DialogHeader>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Body ─────────────────────────────────────────────────────────────────

function ModalBody({
  lobbyId,
  card,
  seat,
  runState,
  isEditable,
  onChanged,
}: {
  lobbyId: string;
  card: LobbyCard;
  seat: LobbySeat | null;
  runState: ReturnType<typeof getRunStateForCard>;
  isEditable: boolean;
  onChanged: () => void;
}) {
  const statusInfo = statusBadgeFor(card.status);

  return (
    <>
      {/* Header — pinned. */}
      <DialogHeader className="px-6 pt-5 pb-3 border-b border-terminal-border/40">
        <div className="flex items-start justify-between gap-3 pr-8">
          {/* pr-8 leaves room for the close X button at top-right. */}
          <div className="min-w-0 flex-1">
            <DialogTitle
              className="font-mono text-base text-terminal-dark leading-snug truncate"
              title={card.title}
            >
              {card.title || "Untitled card"}
            </DialogTitle>
            <DialogDescription className="font-mono text-[11px] text-terminal-muted mt-0.5">
              {seat ? `Assigned to ${seat.role}` : "Unassigned"}
              {" · "}
              attempt {card.attemptCount}/{card.maxAttempts}
            </DialogDescription>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "font-mono text-[10px] uppercase tracking-wider shrink-0",
              statusInfo.tone,
            )}
          >
            {statusInfo.label}
          </Badge>
        </div>
      </DialogHeader>

      {/* Body — scrollable transcript. */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <RunTranscript card={card} runState={runState} mode="full" />
      </div>

      {/* Footer — review actions. Only renders when at least one action is
          applicable; ReviewActions returns null otherwise so the footer
          collapses cleanly. */}
      <div className="px-6 py-3 border-t border-terminal-border/40 bg-terminal-cream/20">
        <ReviewActions
          lobbyId={lobbyId}
          card={card}
          isEditable={isEditable}
          onChanged={onChanged}
          variant="full"
        />
      </div>
    </>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

type StatusBadgeInfo = { label: string; tone: string };

function statusBadgeFor(status: LobbyCard["status"]): StatusBadgeInfo {
  switch (status) {
    case "pending":
      return {
        label: "Pending",
        tone: "border-terminal-border/60 text-terminal-muted",
      };
    case "running":
      return {
        label: "Running",
        tone: "border-sky-500/50 text-sky-700 dark:text-sky-300 bg-sky-500/10",
      };
    case "awaiting_review":
      return {
        label: "Awaiting review",
        tone: "border-amber-500/50 text-amber-800 dark:text-amber-300 bg-amber-500/10",
      };
    case "approved":
      return {
        label: "Approved",
        tone: "border-emerald-500/50 text-emerald-800 dark:text-emerald-300 bg-emerald-500/10",
      };
    case "rejected":
      return {
        label: "Rejected",
        tone: "border-red-500/50 text-red-700 dark:text-red-300 bg-red-500/10",
      };
    case "failed":
      return {
        label: "Failed",
        tone: "border-red-500/50 text-red-700 dark:text-red-300 bg-red-500/10",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        tone: "border-terminal-border/60 text-terminal-muted bg-terminal-cream/40",
      };
    default:
      // Exhaustiveness guard — status is a string-literal union, but be
      // defensive against a server-side enum addition.
      return {
        label: status,
        tone: "border-terminal-border/60 text-terminal-muted",
      };
  }
}

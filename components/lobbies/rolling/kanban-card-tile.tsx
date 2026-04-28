"use client";

/**
 * KanbanCardTile — single draggable card in the Kanban board.
 *
 * Props are intentionally narrow (the card row + a few derived bits) so the
 * tile re-renders only when the captain's view of *this* card changes —
 * critical for the rolling phase when SSE updates are flowing in for many
 * cards at once.
 *
 * The tile is the DnD pickup target. It takes the spread from
 * `useKanbanDnd().getItemProps(...)` and applies it to the root element.
 * All nested action buttons (Edit, Cancel, Open run, ...) carry
 * `data-dnd-skip` so a pointerdown on a button doesn't pick the card up.
 *
 * Status ↔ column drives the styling:
 *   - pending        → backlog | ready | blocked        (neutral)
 *   - running        → in_progress                       (blue, animated)
 *   - awaiting_review→ review                            (amber)
 *   - approved       → done                              (green)
 *   - rejected       → blocked                           (red, dashed)
 *   - failed         → blocked                           (red, solid)
 *   - cancelled      → blocked                           (muted)
 *
 * SPEC §3 #13: structural edits to `running` cards are 409. We surface that
 * by disabling the Edit button for running cards (captain must Cancel
 * first). Captains see "Cancel & edit" affordance when they hover.
 */

import { memo } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Edit3,
  GripVertical,
  Loader2,
  PauseCircle,
  Play,
  Repeat,
  User,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { LobbyCard, LobbySeat } from "@/lib/db/sqlite-lobbies-schema";
import type { LobbyCardStatus } from "@/lib/lobbies/types";

import type { DnDItemProps, DnDState } from "./use-keyboard-dnd";

// ─── Types ────────────────────────────────────────────────────────────────

export type KanbanCardTileProps = {
  card: LobbyCard;
  seat: LobbySeat | null;
  /** True when the lobby is in `rolling` and the card can be edited. */
  isEditable: boolean;
  /**
   * True while a mutation against this card is in flight (column drop,
   * cancel, retry...). Disables the action buttons + dims the tile.
   */
  isBusy: boolean;
  /** True when this tile is the currently-picked-up DnD source. */
  isPickedUp: boolean;
  /** True when an optimistic move has displaced this card's row. */
  isOptimisticGhost: boolean;
  /** DnD pickup props from `useKanbanDnd().getItemProps`. */
  dndProps: DnDItemProps;
  /** Fires when the captain wants to edit the card (open dialog). */
  onEdit: () => void;
  /** Fires when the captain wants to cancel a running card. */
  onCancel?: () => void;
  /** Fires when the captain retries a failed/rejected card. */
  onRetry?: () => void;
  /** Fires when the captain opens the live run transcript (Sprint 8). */
  onOpenRun?: () => void;
  /** True when there's at least one outstanding dependency. */
  dependencyCount: number;
  /** True when at least one upstream dependency is incomplete. */
  hasUnmetDependency: boolean;
};

type StatusVisual = {
  label: string;
  badgeVariant: "default" | "secondary" | "outline" | "destructive";
  icon: typeof CheckCircle2;
  borderClass: string;
  iconClass: string;
};

const STATUS_VISUALS: Record<LobbyCardStatus, StatusVisual> = {
  pending: {
    label: "pending",
    badgeVariant: "outline",
    icon: PauseCircle,
    borderClass: "border-terminal-border/60",
    iconClass: "text-terminal-muted",
  },
  running: {
    label: "running",
    badgeVariant: "default",
    icon: Loader2,
    borderClass: "border-sky-500/60 ring-1 ring-sky-500/20",
    iconClass: "text-sky-600 dark:text-sky-300 animate-spin",
  },
  awaiting_review: {
    label: "review",
    badgeVariant: "secondary",
    icon: AlertCircle,
    borderClass: "border-amber-500/60 ring-1 ring-amber-500/20",
    iconClass: "text-amber-600 dark:text-amber-300",
  },
  approved: {
    label: "approved",
    badgeVariant: "outline",
    icon: Check,
    borderClass: "border-emerald-500/50",
    iconClass: "text-emerald-600 dark:text-emerald-300",
  },
  rejected: {
    label: "rejected",
    badgeVariant: "destructive",
    icon: XCircle,
    borderClass: "border-red-500/60 border-dashed",
    iconClass: "text-red-600 dark:text-red-300",
  },
  failed: {
    label: "failed",
    badgeVariant: "destructive",
    icon: AlertTriangle,
    borderClass: "border-red-500/60",
    iconClass: "text-red-600 dark:text-red-300",
  },
  cancelled: {
    label: "cancelled",
    badgeVariant: "outline",
    icon: XCircle,
    borderClass: "border-terminal-border/40",
    iconClass: "text-terminal-muted/70",
  },
};

// ─── Component ───────────────────────────────────────────────────────────

export const KanbanCardTile = memo(function KanbanCardTile({
  card,
  seat,
  isEditable,
  isBusy,
  isPickedUp,
  isOptimisticGhost,
  dndProps,
  onEdit,
  onCancel,
  onRetry,
  onOpenRun,
  dependencyCount,
  hasUnmetDependency,
}: KanbanCardTileProps) {
  const visual = STATUS_VISUALS[card.status];
  const StatusIcon = visual.icon;

  // SPEC §3 #13: edits to `running` cards are blocked server-side. Mirror
  // that in the UI so the captain sees the right CTA (Cancel & edit).
  const isRunning = card.status === "running";
  const canEditNow = isEditable && !isRunning && !isBusy;
  const canCancel =
    isEditable && (card.status === "running" || card.status === "pending");
  const canRetry =
    isEditable &&
    (card.status === "failed" ||
      card.status === "rejected" ||
      card.status === "cancelled");

  return (
    <div
      {...dndProps}
      aria-label={`Card: ${card.title}, ${visual.label}${seat ? `, assigned to ${seat.role}` : ", unassigned"}`}
      className={cn(
        "group relative w-full rounded-md border bg-terminal-cream/60 p-2.5 text-left transition-all",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green focus-visible:ring-offset-1",
        visual.borderClass,
        isPickedUp &&
          "shadow-lg ring-2 ring-terminal-green/60 -rotate-[0.5deg] scale-[1.02]",
        isOptimisticGhost && "opacity-50",
        isBusy && "pointer-events-none opacity-70",
      )}
    >
      {/* Pickup indicator — visible on hover/focus only. */}
      <span
        aria-hidden="true"
        className="absolute left-1 top-2 text-terminal-muted/50 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </span>

      <div className="ml-3 space-y-1.5">
        {/* Title row */}
        <div className="flex items-start justify-between gap-2">
          <p className="font-mono text-sm font-semibold text-terminal-dark truncate flex-1 min-w-0">
            {card.title}
          </p>
          <Badge
            variant={visual.badgeVariant}
            className="font-mono text-[10px] shrink-0"
          >
            <StatusIcon className={cn("h-2.5 w-2.5 mr-1", visual.iconClass)} />
            {visual.label}
          </Badge>
        </div>

        {/* Description preview */}
        {card.description && (
          <p className="font-mono text-[11px] text-terminal-muted whitespace-pre-wrap line-clamp-2">
            {card.description}
          </p>
        )}

        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-terminal-muted">
          <span className="inline-flex items-center gap-1">
            <User className="h-2.5 w-2.5" aria-hidden="true" />
            {seat ? seat.role : "Unassigned"}
          </span>
          {card.attemptCount > 0 && (
            <span>
              attempt {card.attemptCount}/{card.maxAttempts}
            </span>
          )}
          {dependencyCount > 0 && (
            <span
              className={cn(
                "inline-flex items-center gap-1",
                hasUnmetDependency && "text-amber-700 dark:text-amber-300",
              )}
            >
              {hasUnmetDependency ? (
                <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-2.5 w-2.5" aria-hidden="true" />
              )}
              {dependencyCount} dep{dependencyCount === 1 ? "" : "s"}
              {hasUnmetDependency ? " · waiting" : ""}
            </span>
          )}
        </div>

        {/* Failure reason — visible inline so the captain doesn't have to
            open the run modal to see why a card failed. */}
        {card.failureReason && card.status === "failed" && (
          <p
            role="status"
            className="rounded border border-red-500/30 bg-red-500/5 px-2 py-1 font-mono text-[10px] text-red-700 dark:text-red-300"
          >
            {card.failureReason}
          </p>
        )}

        {/* Action row — buttons all carry `data-dnd-skip` so they don't
            preempt as DnD pickups. */}
        {isEditable && (
          <div className="flex items-center gap-1 pt-0.5">
            {canEditNow ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onEdit}
                data-dnd-skip="true"
                aria-label={`Edit ${card.title}`}
                className="h-6 px-2 font-mono text-[10px]"
              >
                <Edit3 className="h-2.5 w-2.5 mr-1" />
                Edit
              </Button>
            ) : isRunning ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled
                data-dnd-skip="true"
                aria-label="Cannot edit running card — cancel first"
                className="h-6 px-2 font-mono text-[10px] text-terminal-muted/60"
              >
                <Edit3 className="h-2.5 w-2.5 mr-1" />
                Cancel to edit
              </Button>
            ) : null}
            {canCancel && onCancel && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onCancel}
                data-dnd-skip="true"
                aria-label={`Cancel ${card.title}`}
                className="h-6 px-2 font-mono text-[10px] text-amber-700 hover:text-amber-800 dark:text-amber-300"
              >
                <PauseCircle className="h-2.5 w-2.5 mr-1" />
                Cancel
              </Button>
            )}
            {canRetry && onRetry && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onRetry}
                data-dnd-skip="true"
                aria-label={`Retry ${card.title}`}
                className="h-6 px-2 font-mono text-[10px]"
              >
                <Repeat className="h-2.5 w-2.5 mr-1" />
                Retry
              </Button>
            )}
            {(card.status === "running" ||
              card.status === "awaiting_review") &&
              onOpenRun && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={onOpenRun}
                  data-dnd-skip="true"
                  aria-label={`Open run for ${card.title}`}
                  className="h-6 px-2 font-mono text-[10px] ml-auto"
                >
                  <Play className="h-2.5 w-2.5 mr-1" />
                  Open run
                </Button>
              )}
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * Tiny utility: derive the `dndState`-aware flags `KanbanCardTile` needs
 * from a parent's DnD state object. Keeps the per-card prop-derivation
 * cheap and obvious.
 */
export function deriveCardDndFlags(
  cardId: string,
  dndState: DnDState,
): { isPickedUp: boolean } {
  return {
    isPickedUp: dndState.kind === "active" && dndState.itemId === cardId,
  };
}

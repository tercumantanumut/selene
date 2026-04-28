"use client";

/**
 * KanbanBoard — root of the rolling-phase Kanban surface.
 *
 * Owns:
 *   - the DnD hook (`useKanbanDnd`),
 *   - the optimistic-overlay projection of server cards (consumes
 *     `useSoloStoryUiStore` for in-flight moves),
 *   - the per-card mutation calls (`updateCard`, `transitionCard`),
 *   - the live-region announcer for DnD a11y.
 *
 * Does NOT own:
 *   - per-card visuals (`KanbanCardTile`),
 *   - column shells (`KanbanColumn`),
 *   - the dependency editor (separate dialog mounted by the parent
 *     `RollingSection` so the dependency surface can be shared with
 *     planning when we eventually backport).
 *
 * ─── Optimistic projection ─────────────────────────────────────────────
 *
 * Server is canonical. The store keeps a `Map<cardId, OptimisticCardMove>`
 * for in-flight kanban drops. We compose the projection per render:
 *
 *   1. Start with `cards` from the server.
 *   2. For each entry in `optimisticMoves`, override that card's
 *      `column` and re-derive its position so the projected list shows
 *      the captain where the card is *about to be*, not where it lives
 *      server-side.
 *   3. Sort each column's items by `position`.
 *
 * The store's `optimisticVersion` lets late server replies that arrive
 * out of order resolve only the version they belong to — newer queued
 * moves survive an old commit's resolve call.
 *
 * ─── Drop validity (canDrop) ──────────────────────────────────────────
 *
 * SPEC §3 #13 + the status↔column consistency rules limit which moves
 * make sense:
 *   - `pending` cards         → backlog | ready | blocked
 *   - `running` cards         → in_progress (NOT draggable)
 *   - `awaiting_review` cards → review (NOT draggable — captain uses
 *                                approve/reject instead)
 *   - `approved` cards        → done (NOT draggable)
 *   - `rejected/failed/cancelled` → blocked (read-only column)
 *
 * `canDrag` blocks pickup at the source side; `canDrop` blocks
 * cross-column drops at the target side. Same-column reorders are
 * always allowed for any non-running card so the captain can manually
 * prioritize the queue.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleDashed,
  Clock,
  EyeOff,
  Inbox,
  Pause,
  type LucideIcon,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import {
  LobbyApiError,
  transitionCard,
  updateCard,
} from "@/lib/lobbies/client/api";
import type {
  LobbyCard,
  LobbyCardDependency,
  LobbySeat,
} from "@/lib/db/sqlite-lobbies-schema";
import type { LobbyCardColumn } from "@/lib/lobbies/types";
import type { LobbyRunStreamHandle } from "@/lib/lobbies/client/run-stream";
import { useSoloStoryUiStore } from "@/lib/stores/solo-story-ui-store";

import {
  useKanbanDnd,
  type DnDDropArgs,
  type DnDPosition,
} from "./use-keyboard-dnd";
import { KanbanCardTile } from "./kanban-card-tile";
import { KanbanColumn } from "./kanban-column";

// ─── Column metadata ──────────────────────────────────────────────────────

const COLUMN_ORDER: readonly LobbyCardColumn[] = [
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
  "blocked",
] as const;

type ColumnMeta = {
  id: LobbyCardColumn;
  title: string;
  hint?: string;
  icon: LucideIcon;
  accentClass: string;
  /**
   * Captain can manually drop cards here. Other columns are server-driven
   * (e.g., orchestrator moves cards into `in_progress` when it starts
   * them). Drops into non-droppable columns are rejected with a soft
   * announcement.
   */
  manuallyDroppable: boolean;
};

const COLUMN_META: Record<LobbyCardColumn, ColumnMeta> = {
  backlog: {
    id: "backlog",
    title: "Backlog",
    hint: "Drafted, not yet ready to run.",
    icon: Inbox,
    accentClass: "text-terminal-muted",
    manuallyDroppable: true,
  },
  ready: {
    id: "ready",
    title: "Ready",
    hint: "Dependencies clear — orchestrator can pick up.",
    icon: CircleDashed,
    accentClass: "text-terminal-dark",
    manuallyDroppable: true,
  },
  in_progress: {
    id: "in_progress",
    title: "In progress",
    hint: "Agent is running. Captain can cancel.",
    icon: Activity,
    accentClass: "text-sky-700 dark:text-sky-300",
    manuallyDroppable: false,
  },
  review: {
    id: "review",
    title: "Review",
    hint: "Awaiting captain approval.",
    icon: Clock,
    accentClass: "text-amber-700 dark:text-amber-300",
    manuallyDroppable: false,
  },
  done: {
    id: "done",
    title: "Done",
    hint: "Approved, locked.",
    icon: CheckCircle2,
    accentClass: "text-emerald-700 dark:text-emerald-300",
    manuallyDroppable: false,
  },
  blocked: {
    id: "blocked",
    title: "Blocked",
    hint: "Rejected, failed, cancelled, or held.",
    icon: Pause,
    accentClass: "text-red-700 dark:text-red-300",
    manuallyDroppable: true,
  },
};

// ─── Props ────────────────────────────────────────────────────────────────

export type KanbanBoardProps = {
  lobbyId: string;
  cards: LobbyCard[];
  dependencies: LobbyCardDependency[];
  seats: LobbySeat[];
  /**
   * Optional page-scoped run-stream handle. When present, each tile
   * receives its `RunStreamState` slice and renders an inline progress
   * line for `running` cards. Optional so the board stays usable in
   * tests / storybook fixtures without a live SSE source.
   */
  runStream?: LobbyRunStreamHandle;
  /** True while the lobby is in `rolling`; gates DnD + action buttons. */
  isEditable: boolean;
  /** Fired after each successful mutation so the parent can refetch. */
  onChanged: () => void;
  /** Fires when the captain asks to edit a card. Parent owns the dialog. */
  onEditCard: (card: LobbyCard) => void;
  /** Optional Sprint-8 hook — opens a fullscreen run modal. */
  onOpenRun?: (card: LobbyCard) => void;
};

// ─── Component ───────────────────────────────────────────────────────────

export function KanbanBoard({
  lobbyId,
  cards,
  dependencies,
  seats,
  runStream,
  isEditable,
  onChanged,
  onEditCard,
  onOpenRun,
}: KanbanBoardProps) {
  const [busyCardIds, setBusyCardIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [actionError, setActionError] = useState<string | null>(null);
  // Live region message for screen-reader DnD feedback. Updated by the
  // hook's announcer.
  const [liveMessage, setLiveMessage] = useState<string>("");
  const announceTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Optimistic store: subscribe shallowly so we don't re-render on
  // unrelated UI store changes (selected card, fullscreen, etc).
  const { optimisticMoves, queueOptimisticMove, resolveOptimisticMove, rollbackOptimisticMove } =
    useSoloStoryUiStore(
      useShallow((s) => ({
        optimisticMoves: s.optimisticMoves,
        queueOptimisticMove: s.queueOptimisticMove,
        resolveOptimisticMove: s.resolveOptimisticMove,
        rollbackOptimisticMove: s.rollbackOptimisticMove,
      })),
    );

  const seatById = useMemo(
    () => new Map(seats.map((s) => [s.id, s])),
    [seats],
  );

  // Dependency adjacency maps for cheap "has unmet upstream" checks.
  const depsByCard = useMemo(() => {
    const map = new Map<string, LobbyCardDependency[]>();
    for (const dep of dependencies) {
      const list = map.get(dep.cardId) ?? [];
      list.push(dep);
      map.set(dep.cardId, list);
    }
    return map;
  }, [dependencies]);

  // ── Optimistic projection ──────────────────────────────────────────────

  const projectedColumns = useMemo(
    () => projectColumns(cards, optimisticMoves),
    [cards, optimisticMoves],
  );

  // Item-count map for the DnD hook (it needs live counts to clamp
  // keyboard nav indices).
  const itemCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const col of COLUMN_ORDER) {
      out[col] = projectedColumns[col]?.length ?? 0;
    }
    return out;
  }, [projectedColumns]);

  // ── Live-region announcer ─────────────────────────────────────────────

  const announce = useCallback((msg: string) => {
    setLiveMessage(msg);
    // Clear after a moment so a follow-up "same message" still fires the
    // announcement (otherwise repeated identical text is suppressed by
    // the screen-reader).
    if (announceTimeout.current) clearTimeout(announceTimeout.current);
    announceTimeout.current = setTimeout(() => setLiveMessage(""), 1500);
  }, []);

  // ── DnD predicates ────────────────────────────────────────────────────

  const canDrag = useCallback(
    (cardId: string) => {
      if (!isEditable) return false;
      const card = cards.find((c) => c.id === cardId);
      if (!card) return false;
      // Running cards must be cancelled before edits — SPEC §3 #13.
      if (card.status === "running") return false;
      // approved / awaiting_review reside in server-controlled columns.
      // The captain shouldn't yank them out manually.
      if (card.status === "approved" || card.status === "awaiting_review") {
        return false;
      }
      return true;
    },
    [isEditable, cards],
  );

  const canDrop = useCallback(
    ({ source, target }: DnDDropArgs) => {
      // Same-column reorders always allowed (within droppable columns).
      const meta = COLUMN_META[target.containerId as LobbyCardColumn];
      if (!meta) return false;
      if (source.containerId === target.containerId) return true;
      return meta.manuallyDroppable;
    },
    [],
  );

  // ── Drop commit ────────────────────────────────────────────────────────

  const onDrop = useCallback(
    async ({ itemId, source, target }: DnDDropArgs) => {
      const card = cards.find((c) => c.id === itemId);
      if (!card) return;
      const fromColumn = source.containerId as LobbyCardColumn;
      const toColumn = target.containerId as LobbyCardColumn;

      // Compute the canonical "before card id" — the card the captain is
      // dropping above. null when dropping at the end of the column.
      const targetItems = projectedColumns[toColumn] ?? [];
      // When dropping in the SAME column, indices need to skip the moving
      // card itself when computing `beforeCardId`.
      const filtered = targetItems.filter((c) => c.id !== itemId);
      // Adjust target index when removing self from the same column would
      // shift later positions.
      const adjustedIndex =
        source.containerId === target.containerId &&
        source.index < target.index
          ? target.index - 1
          : target.index;
      const beforeCard = filtered[adjustedIndex] ?? null;

      // Queue optimistic overlay BEFORE network so the UI moves the card
      // immediately. The store keeps it until commit/rollback below.
      const queued = queueOptimisticMove({
        cardId: itemId,
        fromColumn,
        toColumn,
        beforeCardId: beforeCard?.id ?? null,
      });

      setBusyCardIds((prev) => addTo(prev, itemId));
      setActionError(null);
      try {
        await updateCard(lobbyId, itemId, {
          expectedVersion: card.lockVersion,
          patch: {
            column: toColumn,
            position: adjustedIndex,
          },
        });
        resolveOptimisticMove(itemId, queued.optimisticVersion);
        onChanged();
      } catch (err) {
        rollbackOptimisticMove(itemId, queued.optimisticVersion);
        setActionError(describeMutationError(err, "Failed to move card"));
        // If it's a 409, refetch so the captain has fresh state.
        if (err instanceof LobbyApiError && err.reason === "VERSION_CONFLICT") {
          onChanged();
        }
        throw err;
      } finally {
        setBusyCardIds((prev) => removeFrom(prev, itemId));
      }
    },
    [
      cards,
      lobbyId,
      projectedColumns,
      queueOptimisticMove,
      resolveOptimisticMove,
      rollbackOptimisticMove,
      onChanged,
    ],
  );

  const dnd = useKanbanDnd({
    columnOrder: COLUMN_ORDER,
    itemCounts,
    onDrop,
    canDrag,
    canDrop,
    announce,
  });

  // ── Card-level actions (cancel / retry) ────────────────────────────────

  const handleCancel = useCallback(
    async (card: LobbyCard) => {
      setActionError(null);
      setBusyCardIds((prev) => addTo(prev, card.id));
      try {
        await transitionCard(lobbyId, card.id, {
          action: "cancel",
          expectedVersion: card.lockVersion,
        });
        onChanged();
      } catch (err) {
        setActionError(describeMutationError(err, "Failed to cancel card"));
      } finally {
        setBusyCardIds((prev) => removeFrom(prev, card.id));
      }
    },
    [lobbyId, onChanged],
  );

  const handleRetry = useCallback(
    async (card: LobbyCard) => {
      setActionError(null);
      setBusyCardIds((prev) => addTo(prev, card.id));
      try {
        await transitionCard(lobbyId, card.id, {
          action: "retry",
          expectedVersion: card.lockVersion,
        });
        onChanged();
      } catch (err) {
        setActionError(describeMutationError(err, "Failed to retry card"));
      } finally {
        setBusyCardIds((prev) => removeFrom(prev, card.id));
      }
    },
    [lobbyId, onChanged],
  );

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-2">
      {/* Live region for DnD announcements (screen readers only). */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {liveMessage}
      </div>

      {actionError && (
        <p
          role="alert"
          className="font-mono text-[11px] text-amber-700 dark:text-amber-300"
        >
          {actionError}
        </p>
      )}

      {!isEditable && (
        <p className="font-mono text-[11px] text-terminal-muted inline-flex items-center gap-1">
          <EyeOff className="h-3 w-3" aria-hidden="true" />
          Read-only — the lobby is no longer in the rolling phase.
        </p>
      )}

      {/* Horizontal scroll on small screens; columns flex-grow on wide. */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {COLUMN_ORDER.map((colId) => {
          const meta = COLUMN_META[colId];
          const items = projectedColumns[colId] ?? [];
          return (
            <KanbanColumn
              key={colId}
              columnId={colId}
              title={meta.title}
              icon={meta.icon}
              hint={meta.hint}
              accentClass={meta.accentClass}
              dndState={dnd.state}
              getDropSlotProps={dnd.getDropSlotProps}
              isReadOnly={!meta.manuallyDroppable && !isEditable}
              items={items.map((card, idx) => ({
                id: card.id,
                node: (
                  <KanbanCardTile
                    card={card}
                    seat={
                      card.assignedSeatId
                        ? seatById.get(card.assignedSeatId) ?? null
                        : null
                    }
                    runState={runStream?.byCardId.get(card.id)}
                    isEditable={isEditable}
                    isBusy={busyCardIds.has(card.id)}
                    isPickedUp={
                      dnd.state.kind === "active" &&
                      dnd.state.itemId === card.id
                    }
                    isOptimisticGhost={optimisticMoves.has(card.id)}
                    dndProps={dnd.getItemProps({
                      itemId: card.id,
                      containerId: colId,
                      index: idx,
                    })}
                    onEdit={() => onEditCard(card)}
                    onCancel={() => void handleCancel(card)}
                    onRetry={() => void handleRetry(card)}
                    onOpenRun={
                      onOpenRun ? () => onOpenRun(card) : undefined
                    }
                    dependencyCount={depsByCard.get(card.id)?.length ?? 0}
                    hasUnmetDependency={hasUnmetUpstream(
                      card.id,
                      depsByCard,
                      cards,
                    )}
                  />
                ),
              }))}
            />
          );
        })}
      </div>

      <p className="font-mono text-[10px] text-terminal-muted">
        Drag with mouse or pick up with{" "}
        <kbd className="font-mono px-1 rounded border border-terminal-border/50 bg-terminal-cream/60">
          Space
        </kbd>{" "}
        on a focused card. Move with arrow keys, drop with{" "}
        <kbd className="font-mono px-1 rounded border border-terminal-border/50 bg-terminal-cream/60">
          Space
        </kbd>
        , cancel with{" "}
        <kbd className="font-mono px-1 rounded border border-terminal-border/50 bg-terminal-cream/60">
          Esc
        </kbd>
        .
      </p>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Project server cards into their on-screen columns, applying any
 * in-flight optimistic moves. Each column is sorted by `position` —
 * server's authoritative ordering — except for cards that are being
 * moved, which jump to their target column at their original `position`
 * (server will recompute on commit, then refetch will re-sort).
 */
function projectColumns(
  cards: LobbyCard[],
  optimisticMoves: Map<string, { toColumn: string; beforeCardId: string | null }>,
): Record<LobbyCardColumn, LobbyCard[]> {
  const buckets: Record<LobbyCardColumn, LobbyCard[]> = {
    backlog: [],
    ready: [],
    in_progress: [],
    review: [],
    done: [],
    blocked: [],
  };
  for (const card of cards) {
    const overlay = optimisticMoves.get(card.id);
    const targetCol = (overlay?.toColumn ?? card.column) as LobbyCardColumn;
    const bucket = buckets[targetCol];
    if (!bucket) continue;
    bucket.push(card);
  }
  // Sort each bucket by position. Optimistic moves don't update position
  // here — refetch lands the canonical order — so we use the existing
  // `position` as a stable sort key.
  for (const col of COLUMN_ORDER) {
    buckets[col].sort((a, b) => a.position - b.position);
  }
  return buckets;
}

/**
 * Returns true when at least one upstream dependency for `cardId` is not
 * yet `approved`. Used to flag cards that are waiting on something.
 */
function hasUnmetUpstream(
  cardId: string,
  depsByCard: Map<string, LobbyCardDependency[]>,
  cards: LobbyCard[],
): boolean {
  const deps = depsByCard.get(cardId);
  if (!deps || deps.length === 0) return false;
  const cardById = new Map(cards.map((c) => [c.id, c]));
  return deps.some((dep) => {
    if (dep.optional) return false;
    const upstream = cardById.get(dep.dependsOnCardId);
    if (!upstream) return false;
    return upstream.status !== "approved";
  });
}

function addTo<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (set.has(value)) return set;
  const next = new Set(set);
  next.add(value);
  return next;
}

function removeFrom<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (!set.has(value)) return set;
  const next = new Set(set);
  next.delete(value);
  return next;
}

function describeMutationError(err: unknown, fallback: string): string {
  if (err instanceof LobbyApiError) {
    if (err.reason === "VERSION_CONFLICT") {
      return "Card state changed since you last loaded — refreshing. Try the move again.";
    }
    if (err.reason === "INVALID_TRANSITION") {
      return err.message || "Move not allowed in the current phase.";
    }
    if (err.reason === "FORBIDDEN") {
      return "You don't have permission to modify this card.";
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

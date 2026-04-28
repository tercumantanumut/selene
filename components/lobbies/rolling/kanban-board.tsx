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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// Sprint 7B.1 (R4-H1/H2/H3): type guard at the kanban↔hook boundary. The
// hook works with `containerId: string` because it's column-agnostic;
// the board needs `LobbyCardColumn`. Without a runtime check, an invalid
// containerId (stale data, malformed event, future column id we don't
// know about) would coerce silently via `as LobbyCardColumn` and crash
// downstream. The guard makes the boundary explicit and gives every
// usage a place to short-circuit safely.
const COLUMN_SET: ReadonlySet<LobbyCardColumn> = new Set(COLUMN_ORDER);
function isLobbyCardColumn(value: string): value is LobbyCardColumn {
  return COLUMN_SET.has(value as LobbyCardColumn);
}

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

export function isRollingKanbanManualDropTarget(
  isEditable: boolean,
  target: DnDPosition,
): boolean {
  if (!isEditable) return false;
  if (!isLobbyCardColumn(target.containerId)) return false;
  return COLUMN_META[target.containerId].manuallyDroppable;
}

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

  // Sprint 7B.1 (R2-H5): mounted gate. Without this, an in-flight
  // `updateCard` whose Promise resolves AFTER the parent unmounts (route
  // change, lobby switch) calls `setBusyCardIds`/`setActionError` on a
  // dead component. React 18 dev-mode warns; production silently leaks.
  // The ref pattern beats AbortController here because the failure mode
  // is "we no longer care about the result", not "stop the network call"
  // — the server still owes the captain a confirmation, but this client
  // session is gone.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
      // Sprint 7B.1 (R1-M3): a card with an in-flight mutation can't be
      // re-picked-up. Without this, a captain who clicks a slow-moving
      // card a second time would queue a second optimistic move on top of
      // the first, with `cardLockVersion` already invalidated — the
      // second request will either 409 (best case) or silently overwrite
      // the position the first move was racing for. Easier to gate at
      // the source: pickup blocked while busy, button-press visibly
      // disabled.
      if (busyCardIds.has(cardId)) return false;
      // Running cards must be cancelled before edits — SPEC §3 #13.
      if (card.status === "running") return false;
      // approved / awaiting_review reside in server-controlled columns.
      // The captain shouldn't yank them out manually.
      if (card.status === "approved" || card.status === "awaiting_review") {
        return false;
      }
      return true;
    },
    [isEditable, cards, busyCardIds],
  );

  const isManualDropTarget = useCallback(
    (target: DnDPosition) => isRollingKanbanManualDropTarget(isEditable, target),
    [isEditable],
  );

  const canDrop = useCallback(
    ({ source, target }: DnDDropArgs) => {
      // Sprint 7B.1 (R4-H2): defend the boundary instead of casting. An
      // unknown containerId can't possibly be droppable.
      if (!isLobbyCardColumn(source.containerId)) return false;
      return isManualDropTarget(target);
    },
    [isManualDropTarget],
  );

  // ── Drop commit ────────────────────────────────────────────────────────

  const onDrop = useCallback(
    async ({ itemId, source, target }: DnDDropArgs) => {
      const card = cards.find((c) => c.id === itemId);
      if (!card) return;
      // Sprint 7B.1 (R4-H1): refuse mismatched column ids. The hook's
      // type signature is intentionally loose; the board narrows here so
      // a malformed event or stale dnd state can't reach the network.
      if (
        !isLobbyCardColumn(source.containerId) ||
        !isLobbyCardColumn(target.containerId)
      ) {
        return;
      }
      const fromColumn: LobbyCardColumn = source.containerId;
      const toColumn: LobbyCardColumn = target.containerId;

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
        // Sprint 7B.1 (R2-H4 + R1-M4): do NOT call resolveOptimisticMove
        // here. The overlay must persist until canonical state catches up
        // (canonical card.column === overlay.toColumn). Resolving early
        // produced a flicker: overlay drops → projection snaps back to
        // server's old column → refetch lands → projection snaps to new
        // column. The canonical-driven drop in the effect below removes
        // the overlay only once both sides agree, eliminating the flash.
        // A watchdog in the same effect bounds the wait so a missing
        // refetch doesn't strand the overlay forever.
        if (mountedRef.current) onChanged();
      } catch (err) {
        rollbackOptimisticMove(itemId, queued.optimisticVersion);
        if (mountedRef.current) {
          setActionError(describeMutationError(err, "Failed to move card"));
        }
        // If it's a 409, refetch so the captain has fresh state.
        if (
          err instanceof LobbyApiError &&
          err.reason === "VERSION_CONFLICT" &&
          mountedRef.current
        ) {
          onChanged();
        }
        throw err;
      } finally {
        if (mountedRef.current) {
          setBusyCardIds((prev) => removeFrom(prev, itemId));
        }
      }
    },
    [
      cards,
      lobbyId,
      projectedColumns,
      queueOptimisticMove,
      rollbackOptimisticMove,
      onChanged,
    ],
  );

  // Sprint 7B.1 (R2-H4 + R1-M4): canonical-driven overlay drop. After
  // `onDrop` lands successfully, the overlay sits in the store until the
  // canonical `cards` prop reflects the new column. This effect compares
  // each overlay's `toColumn` to the matching canonical card; if they
  // agree (or the canonical card has vanished), the overlay is no longer
  // doing useful work and can be dropped.
  useEffect(() => {
    if (optimisticMoves.size === 0) return;
    const cardById = new Map(cards.map((c) => [c.id, c]));
    for (const [cardId, overlay] of optimisticMoves) {
      const canonical = cardById.get(cardId);
      // Card vanished server-side (orchestrator deleted, lobby reset, ...)
      // — drop the now-meaningless overlay.
      if (!canonical) {
        resolveOptimisticMove(cardId, overlay.optimisticVersion);
        continue;
      }
      if (canonical.column === overlay.toColumn) {
        resolveOptimisticMove(cardId, overlay.optimisticVersion);
      }
    }
  }, [cards, optimisticMoves, resolveOptimisticMove]);

  // Sprint 7B.1 (R2-H4 watchdog): bound the wait so a missing refetch
  // doesn't strand the overlay indefinitely. 5s is generous — covers
  // network jitter on a slow connection but well under the human "did my
  // click work?" threshold. After the watchdog fires, the next refetch
  // (or any other mutation that calls onChanged) will reconcile.
  useEffect(() => {
    if (optimisticMoves.size === 0) return;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const now = Date.now();
    for (const [cardId, overlay] of optimisticMoves) {
      const queuedAt = new Date(overlay.queuedAt).getTime();
      const elapsed = Number.isFinite(queuedAt) ? now - queuedAt : 0;
      const remaining = Math.max(0, 5000 - elapsed);
      timers.push(
        setTimeout(() => {
          resolveOptimisticMove(cardId, overlay.optimisticVersion);
        }, remaining),
      );
    }
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [optimisticMoves, resolveOptimisticMove]);

  // Sprint 7B.1 (R3-H3): label resolvers for the SR announcer. Look up
  // column titles via COLUMN_META and card titles via the cards prop so
  // SR users hear "Moved Refactor login flow to In progress, position 2"
  // instead of "Moved cd9-…-… to in_progress, slot 2".
  const getContainerLabel = useCallback((containerId: string): string => {
    if (!isLobbyCardColumn(containerId)) return containerId;
    return COLUMN_META[containerId].title;
  }, []);
  const getItemLabel = useCallback(
    (itemId: string): string => {
      const card = cards.find((c) => c.id === itemId);
      return card ? card.title : itemId;
    },
    [cards],
  );

  const dnd = useKanbanDnd({
    columnOrder: COLUMN_ORDER,
    itemCounts,
    onDrop,
    canDrag,
    canDrop,
    isDropTargetVisible: isManualDropTarget,
    announce,
    getContainerLabel,
    getItemLabel,
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
        if (mountedRef.current) onChanged();
      } catch (err) {
        if (mountedRef.current) {
          setActionError(describeMutationError(err, "Failed to cancel card"));
        }
      } finally {
        if (mountedRef.current) {
          setBusyCardIds((prev) => removeFrom(prev, card.id));
        }
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
        if (mountedRef.current) onChanged();
      } catch (err) {
        if (mountedRef.current) {
          setActionError(describeMutationError(err, "Failed to retry card"));
        }
      } finally {
        if (mountedRef.current) {
          setBusyCardIds((prev) => removeFrom(prev, card.id));
        }
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
        // Sprint 7B.1 (R3-H8): alert role + destructive copy must use
        // destructive color tokens (red), not amber. Amber-700 on the
        // terminal-cream background also fell short of WCAG AA contrast
        // for body text. Switching to red-700 brings both color semantics
        // and contrast into line.
        <p
          role="alert"
          className="font-mono text-[11px] text-red-700 dark:text-red-300"
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

      {/* Sprint 7B.1 (R3-H4): board landmark. Without role="region" +
          aria-labelledby, an SR user navigating by landmarks (most common
          screen-reader workflow on a complex page) skipped the entire
          kanban surface — there was no anchor to jump to. The visually-
          hidden heading anchors the region without changing the visual
          layout. Horizontal scroll on small screens; columns flex-grow
          on wide. */}
      <h2 id="kanban-board-heading" className="sr-only">
        Card kanban board
      </h2>
      <div
        role="region"
        aria-labelledby="kanban-board-heading"
        className="flex gap-2 overflow-x-auto pb-2"
      >
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
              isReadOnly={!isEditable || !meta.manuallyDroppable}
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
 * in-flight optimistic moves. Canonical cards keep server `position` order;
 * optimistic cards are then inserted at the queued before-card target so the
 * UI mirrors the captain's intended slot while waiting for the refetch.
 */
export function projectColumns(
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
  const optimisticCards: Array<{
    card: LobbyCard;
    toColumn: LobbyCardColumn;
    beforeCardId: string | null;
  }> = [];

  for (const card of cards) {
    const overlay = optimisticMoves.get(card.id);
    if (overlay) {
      const candidate = overlay.toColumn;
      optimisticCards.push({
        card,
        toColumn: isLobbyCardColumn(candidate) ? candidate : "blocked",
        beforeCardId: overlay.beforeCardId,
      });
      continue;
    }

    // Sprint 7B.1 (R4-H3): unknown column id -> drop into `blocked` so
    // the card is still visible but flagged. Silently dropping
    // server-supplied data is worse than parking it somewhere visible.
    const targetCol: LobbyCardColumn = isLobbyCardColumn(card.column)
      ? card.column
      : "blocked";
    buckets[targetCol].push(card);
  }

  for (const col of COLUMN_ORDER) {
    buckets[col].sort((a, b) => a.position - b.position);
  }

  for (const move of optimisticCards) {
    const bucket = buckets[move.toColumn];
    const insertAt = move.beforeCardId
      ? bucket.findIndex((card) => card.id === move.beforeCardId)
      : -1;
    const nextIndex = insertAt >= 0 ? insertAt : bucket.length;
    bucket.splice(nextIndex, 0, move.card);
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
    // Sprint 7B.1 (R1-M5): INVARIANT_VIOLATION mapping. The server-side
    // status↔column consistency check (Sprint 7B.1 P4 / R1-H1) returns
    // INVARIANT_VIOLATION when a captain drops a card into a column that
    // can't hold its current status. Without this branch the captain sees
    // the raw "Column 'review' is not valid for cards with status 'pending'"
    // engineering message, which is correct but unhelpful — the fallback
    // copy + the server message together let them recover (move to a
    // valid column, or wait for the orchestrator to advance status).
    if (err.reason === "INVARIANT_VIOLATION") {
      return err.message || "Card can't be in that column right now.";
    }
    if (err.reason === "FORBIDDEN") {
      return "You don't have permission to modify this card.";
    }
    if (err.reason === "NOT_FOUND") {
      return "This card no longer exists — refreshing.";
    }
    if (err.reason === "TIMEOUT") {
      return "The server is taking too long — please retry.";
    }
    if (err.reason === "NETWORK") {
      return "Network error — check your connection and try again.";
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

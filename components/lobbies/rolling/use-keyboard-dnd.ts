"use client";

/**
 * useKanbanDnd — custom keyboard-first drag-and-drop hook for the
 * Solo Story Mode Kanban board.
 *
 * SPEC §3 #6 forbids `@dnd-kit` and any heavy DnD library; this hook is the
 * replacement. It is intentionally tiny (~200 LOC) and tailored for the
 * Kanban surface: discrete columns, integer drop indices, no nesting, no
 * sorting beyond "drop above slot N / at end of column N".
 *
 * ─── Mental model ──────────────────────────────────────────────────────
 *
 * Two interaction modes share a single state machine. Both end with a call
 * to `onDrop({ itemId, source, target })` — the caller owns optimistic UI
 * (queue/commit/rollback against the UI store).
 *
 *  - Keyboard (primary, accessibility-first):
 *      Space/Enter on a focused card → pick up.
 *      ↑/↓               → move hover within column.
 *      ←/→               → move hover to neighbouring column.
 *      Space/Enter       → commit drop at current hover.
 *      Escape            → cancel.
 *
 *  - Pointer (mouse / touch):
 *      pointerdown on a card  → pick up.
 *      pointerenter on slot   → update hover.
 *      pointerup on slot      → commit drop at that slot.
 *      pointercancel / Escape → cancel.
 *
 * Drop slots are explicit DOM elements (KanbanColumn renders one per
 * insertion index, plus one trailing slot for "end of column"). They carry
 * `data-dnd-target="true"` + `data-dnd-container` + `data-dnd-index` so a
 * future hit-test can resolve a position from coordinates if we ever need
 * a true free-floating ghost.
 *
 * ─── Stale-state hazard (and the `commit(target)` override) ─────────────
 *
 * pointerenter → setHover (queued setState), then pointerup → commit. In
 * React 18 batching, both run before the re-render commits, so a `commit`
 * that reads `state.hover` would see the OLD hover. To avoid that, slot
 * `onPointerUp` calls `commit(target)` with an explicit target — the slot
 * already knows where it is, no stale read needed. Keyboard mode goes
 * through `commit()` (no override) because `moveHover` always flushes
 * before the user presses Space.
 *
 * SPEC §3 #6 (no @dnd-kit). FE Architect §6 (custom DnD).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";

// ─── Types ────────────────────────────────────────────────────────────────

export type DnDPosition = {
  /** Column id (LobbyCardColumn for the Kanban use case). */
  containerId: string;
  /**
   * Insertion index. 0 = before the first item; `count` = after the last.
   * The column always exposes `count + 1` slots so every position is
   * reachable.
   */
  index: number;
};

export type DnDDropArgs = {
  itemId: string;
  source: DnDPosition;
  target: DnDPosition;
};

export type DnDState =
  | { kind: "idle" }
  | {
      kind: "active";
      itemId: string;
      source: DnDPosition;
      hover: DnDPosition;
      mode: "keyboard" | "pointer";
    };

export type UseKanbanDndOptions = {
  /**
   * Ordered column ids (left to right). Required for keyboard horizontal
   * navigation — the hook doesn't introspect the DOM, it walks this list.
   */
  columnOrder: readonly string[];
  /**
   * Live count map per column id. Read on every nav keystroke so the hover
   * index clamps correctly even after an optimistic mutation has shifted
   * the count.
   */
  itemCounts: Readonly<Record<string, number>>;
  /**
   * Drop commit. Resolved Promise = success; thrown = caller surfaces the
   * error. The hook always returns to `idle` after `commit` regardless of
   * outcome — caller is responsible for rolling back any optimistic UI.
   */
  onDrop: (args: DnDDropArgs) => Promise<void>;
  /** Optional pickup gate. Returning false makes the item not draggable. */
  canDrag?: (itemId: string, source: DnDPosition) => boolean;
  /** Optional drop validity check. Drives hover styling + commit gating. */
  canDrop?: (args: DnDDropArgs) => boolean;
  /** Optional visibility gate for drop slots that should not be targetable. */
  isDropTargetVisible?: (target: DnDPosition) => boolean;
  /** Optional ARIA-live announcer. Pass a setter that writes to a `polite` region. */
  announce?: (message: string) => void;
  /**
   * Sprint 7B.1 (R3-H3): label resolvers used by the live-region
   * announcer. Without these, the SR user hears raw column ids and uuids
   * — "in_progress, slot 3", "Picked up cd9-...". Both look fine in a
   * dev tool and make zero sense to a captain. Resolvers turn them into
   * the same labels the captain sees on screen ("In progress, position
   * 3", "Picked up Refactor login flow"). Optional so the hook stays
   * usable in tests with synthetic data.
   */
  getContainerLabel?: (containerId: string) => string;
  getItemLabel?: (itemId: string) => string;
};

export type UseKanbanDndResult = {
  state: DnDState;
  /** Apply to the draggable card root. */
  getItemProps: (args: {
    itemId: string;
    containerId: string;
    index: number;
  }) => DnDItemProps;
  /** Apply to a drop slot inside a column. */
  getDropSlotProps: (target: DnDPosition) => DnDDropSlotProps;
  /** Programmatic cancel (e.g. from a "Cancel" button in the live region). */
  cancel: () => void;
};

/**
 * Props returned by `getItemProps` — spread onto the draggable card root.
 * Exported so consumers (e.g. `KanbanCardTile`) can declare the prop in
 * their own type without re-deriving it.
 *
 * Sprint 7B.1 (R3-H2): WAI-ARIA 1.2 deprecated `aria-grabbed` and
 * `aria-dropeffect` — they were never reliably supported by AT and ARIA's
 * APG now points DnD at the live-region + roving-tabindex pattern. We
 * drop both attributes and rely on `aria-pressed` (toggle button
 * semantics for "card picked up") + the live region in `KanbanBoard` for
 * narration. The `aria-roledescription` stays so AT users hear "draggable
 * card" instead of "button".
 */
export type DnDItemProps = {
  role: "button";
  tabIndex: 0;
  "aria-roledescription": "draggable card";
  "aria-pressed": boolean;
  "aria-disabled"?: true;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  "data-dnd-pickup"?: "true";
};

/**
 * Props returned by `getDropSlotProps` — spread onto a slot element.
 *
 * Sprint 7B.1 (R3-H6): the slot element receives pointer events and a
 * click handler — it's interactive, not presentational. role="button"
 * makes it a real keyboard tabstop and a real SR target. The slot
 * advertises itself with an `aria-label` describing the drop position
 * ("Drop in column X at position N") so the SR user hears the target as
 * focus moves.
 *
 * Sprint 7B.1 (R3-H1): slots accept a `ref` callback so the hook can
 * focus the active hover slot during keyboard nav. Without this, the SR
 * user picks up a card and arrows around with focus stuck on the source
 * tile — they have no idea where the cursor went.
 */
export type DnDDropSlotProps = {
  role: "button";
  tabIndex: number;
  "aria-label": string;
  "aria-disabled": boolean;
  "data-dnd-target": "true";
  "data-dnd-container": string;
  "data-dnd-index": string;
  "data-dnd-hover"?: "true";
  ref: (el: HTMLElement | null) => void;
  onPointerEnter: () => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onClick: () => void;
};

const PICKUP_KEYS = new Set([" ", "Enter"]);

// ─── Hook ────────────────────────────────────────────────────────────────

export function useKanbanDnd(opts: UseKanbanDndOptions): UseKanbanDndResult {
  const [state, setState] = useState<DnDState>({ kind: "idle" });

  // Refs so window-scoped event handlers can read the latest values without
  // re-binding on every state change.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Sprint 7B.1 (R3-H7): stateRef must be updated SYNCHRONOUSLY at every
  // call-site that calls setState — not lazily during render — because the
  // window-level keydown listener registered on mount reads stateRef.current
  // immediately. If we waited for React to commit and then assigned
  // `stateRef.current = state` during render, a fast Space-press in the same
  // tick as a setState would observe stale state. The helper below pairs the
  // two updates so it's impossible to update one without the other.
  const stateRef = useRef<DnDState>({ kind: "idle" });
  const setDndState = useCallback((next: DnDState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // Sprint 7B.1 (R3-H1): one ref per drop slot, keyed by
  // `${containerId}:${index}`. The hook focuses the active hover slot during
  // keyboard nav so SR users hear the cursor's new position instead of
  // having focus stuck on the source tile. Pointer-mode hover does NOT
  // steal focus — the captain is using the mouse and pulling focus would
  // disrupt their flow.
  const slotRefs = useRef(new Map<string, HTMLElement>());
  const slotKey = useCallback(
    (target: DnDPosition) => `${target.containerId}:${target.index}`,
    [],
  );

  const announce = useCallback((msg: string) => {
    optsRef.current.announce?.(msg);
  }, []);

  // Sprint 7B.1 (R3-H3): label helpers for SR announcements. Falls back
  // to the raw id when the consumer didn't supply a resolver, so the
  // hook still works with synthetic test fixtures.
  const labelForContainer = useCallback((containerId: string): string => {
    const fn = optsRef.current.getContainerLabel;
    return fn ? fn(containerId) : containerId;
  }, []);
  const labelForItem = useCallback((itemId: string): string => {
    const fn = optsRef.current.getItemLabel;
    return fn ? fn(itemId) : itemId;
  }, []);

  // ── Cancel / commit ────────────────────────────────────────────────────

  const cancel = useCallback(() => {
    const cur = stateRef.current;
    if (cur.kind !== "active") return;
    setDndState({ kind: "idle" });
    // Sprint 7B.1 (R3-H3): include card title so the SR user hears which
    // gesture was undone (a captain who picked up two cards in a row and
    // hit Esc on one needs the disambiguation).
    announce(`Cancelled drag of ${labelForItem(cur.itemId)}`);
  }, [announce, setDndState, labelForItem]);

  /**
   * `override` lets a slot's pointerup pass its known target directly, so
   * we don't depend on `state.hover` having flushed since pointerenter
   * fired in the same tick (see file-header note).
   */
  const commit = useCallback(
    async (override?: DnDPosition) => {
      const cur = stateRef.current;
      if (cur.kind !== "active") return;
      const target = override ?? cur.hover;
      if (
        target.containerId === cur.source.containerId &&
        target.index === cur.source.index
      ) {
        // No-op drop: pickup → release on same slot.
        setDndState({ kind: "idle" });
        announce(`${labelForItem(cur.itemId)} stayed in place`);
        return;
      }
      if (
        optsRef.current.canDrop &&
        !optsRef.current.canDrop({
          itemId: cur.itemId,
          source: cur.source,
          target,
        })
      ) {
        announce(
          `Cannot drop ${labelForItem(cur.itemId)} in ${labelForContainer(target.containerId)}`,
        );
        return;
      }
      // Clear DnD state immediately so the captain can pick up another card
      // while the network call is still in flight. The caller's optimistic
      // overlay is what visually moves the card; this hook only owns the
      // pickup-to-drop gesture.
      setDndState({ kind: "idle" });
      try {
        await optsRef.current.onDrop({
          itemId: cur.itemId,
          source: cur.source,
          target,
        });
        announce(
          `Moved ${labelForItem(cur.itemId)} to ${labelForContainer(target.containerId)}, position ${target.index + 1}`,
        );
      } catch {
        // Caller is responsible for any rollback + visible error UX.
        announce(`Failed to move ${labelForItem(cur.itemId)}`);
      }
    },
    [announce, setDndState, labelForItem, labelForContainer],
  );

  // ── Keyboard hover navigation ─────────────────────────────────────────

  const moveHover = useCallback(
    (direction: "up" | "down" | "left" | "right") => {
      const cur = stateRef.current;
      if (cur.kind !== "active") return;
      const { columnOrder, itemCounts } = optsRef.current;
      const colIdx = columnOrder.indexOf(cur.hover.containerId);
      if (colIdx === -1) return;

      let nextCol = cur.hover.containerId;
      let nextIndex = cur.hover.index;

      if (direction === "left" || direction === "right") {
        const step = direction === "left" ? -1 : 1;
        let targetIdx = colIdx + step;
        while (targetIdx >= 0 && targetIdx < columnOrder.length) {
          const candidateCol = columnOrder[targetIdx];
          const cap = (itemCounts[candidateCol] ?? 0) + 1;
          const candidateIndex = Math.min(nextIndex, cap - 1);
          const candidate = { containerId: candidateCol, index: candidateIndex };
          if (optsRef.current.isDropTargetVisible?.(candidate) ?? true) {
            nextCol = candidateCol;
            nextIndex = candidateIndex;
            break;
          }
          targetIdx += step;
        }
        if (nextCol === cur.hover.containerId && nextIndex === cur.hover.index) return;
      } else {
        const cap = (itemCounts[nextCol] ?? 0) + 1;
        nextIndex =
          direction === "up"
            ? Math.max(0, cur.hover.index - 1)
            : Math.min(cap - 1, cur.hover.index + 1);
      }

      setDndState({
        ...cur,
        hover: { containerId: nextCol, index: nextIndex },
      });
      announce(`${labelForContainer(nextCol)}, position ${nextIndex + 1}`);
    },
    [announce, setDndState, labelForContainer],
  );

  // ── Mount-time global listeners (read state via stateRef) ─────────────
  //
  // Note: previous design exposed an `activeMode` derivation in the
  // dependency arrays of state-gated effects. With one mount-time listener
  // per concern reading `stateRef`, that derivation became dead code and
  // was removed.

  // Sprint 7B.1 (R3-H7): one mount-time keydown listener replaces the
  // previous state-gated effect. The previous design re-registered the
  // listener every time `state` or `mode` changed — fine in steady state,
  // but a setState followed by a fast key-press in the same tick observed
  // the old listener (which had captured stale `state`). The mount-time
  // listener reads `stateRef.current` so it sees whatever setDndState just
  // wrote, regardless of React's render schedule.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const cur = stateRef.current;
      if (cur.kind !== "active") return;
      // Escape works in both modes.
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
        return;
      }
      // Arrow + commit keys are keyboard-mode only — pointer mode commits
      // via slot pointerup, and we don't want arrow keys to fight the
      // captain's mouse position.
      if (cur.mode !== "keyboard") return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          moveHover("left");
          break;
        case "ArrowRight":
          e.preventDefault();
          moveHover("right");
          break;
        case "ArrowUp":
          e.preventDefault();
          moveHover("up");
          break;
        case "ArrowDown":
          e.preventDefault();
          moveHover("down");
          break;
        case " ":
        case "Enter":
          e.preventDefault();
          void commit();
          break;
        default:
          break;
      }
    }
    // useCapture so we beat any focused button's onKeyDown.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cancel, commit, moveHover]);

  // Sprint 7B.1 (R2-H1): window-level pointerup fallback. Without this,
  // releasing the mouse outside any drop slot left the hook in `active`
  // state forever — the captain would see a phantom hover badge and the
  // next click would commit at the stale hover position. The fallback
  // cancels the drag if no slot's onPointerUp ran first (slots stop the
  // gesture by calling commit, which transitions to idle before this
  // fallback fires).
  //
  // pointercancel handles the OS yanking the gesture (browser tab switch,
  // touch interrupted, etc).
  useEffect(() => {
    function onPointerUp() {
      // Defer one tick so any slot's onPointerUp has a chance to run first
      // (slots → commit → setDndState({ kind: "idle" })). If we still see
      // active state after that, the release happened off-grid and we
      // cancel.
      queueMicrotask(() => {
        const cur = stateRef.current;
        if (cur.kind === "active" && cur.mode === "pointer") {
          cancel();
        }
      });
    }
    function onPointerCancel() {
      const cur = stateRef.current;
      if (cur.kind === "active" && cur.mode === "pointer") {
        cancel();
      }
    }
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    return () => {
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [cancel]);

  // Sprint 7B.1 (R3-H1): focus-follows-hover for keyboard mode. When the
  // captain arrows around with a card picked up, focus has to move to the
  // hover slot — otherwise SR users hear the live-region announcement but
  // their actual cursor stays on the source tile, and the next Tab jumps
  // somewhere unrelated. We only do this in keyboard mode; in pointer mode
  // the captain owns the focus position via mouse.
  useEffect(() => {
    if (state.kind !== "active" || state.mode !== "keyboard") return;
    const key = slotKey(state.hover);
    const el = slotRefs.current.get(key);
    // Only refocus if focus isn't already on the slot (avoids fighting the
    // SR's own virtual cursor when nothing has changed).
    if (el && document.activeElement !== el) {
      el.focus({ preventScroll: false });
    }
  }, [state, slotKey]);

  // ── Public handle factories ──────────────────────────────────────────

  const getItemProps = useCallback<UseKanbanDndResult["getItemProps"]>(
    (args) => {
      const draggable = optsRef.current.canDrag
        ? optsRef.current.canDrag(args.itemId, {
            containerId: args.containerId,
            index: args.index,
          })
        : true;
      const isMe = state.kind === "active" && state.itemId === args.itemId;
      return {
        role: "button",
        tabIndex: 0,
        "aria-roledescription": "draggable card",
        // Sprint 7B.1 (R3-H2): aria-pressed replaces deprecated
        // aria-grabbed. The card behaves as a toggle button — pressed when
        // picked up, released when idle.
        "aria-pressed": isMe,
        ...(draggable ? {} : { "aria-disabled": true as const }),
        onKeyDown: (e) => {
          if (!draggable) return;
          if (stateRef.current.kind !== "idle") return;
          if (!PICKUP_KEYS.has(e.key)) return;
          e.preventDefault();
          const source: DnDPosition = {
            containerId: args.containerId,
            index: args.index,
          };
          setDndState({
            kind: "active",
            itemId: args.itemId,
            source,
            hover: source,
            mode: "keyboard",
          });
          announce(
            `Picked up ${labelForItem(args.itemId)}. Arrow keys to move, space to drop, escape to cancel.`,
          );
        },
        onPointerDown: (e) => {
          if (!draggable) return;
          // Only primary button (mouse left / touch / pen).
          if (e.button !== 0) return;
          if (stateRef.current.kind !== "idle") return;
          // Skip pickup if the click landed on a nested control marked
          // `data-dnd-skip` (e.g. an inline edit / cancel button on the
          // tile). Caller is responsible for marking those.
          const targetEl = e.target as HTMLElement;
          if (targetEl.closest("[data-dnd-skip]")) return;
          const source: DnDPosition = {
            containerId: args.containerId,
            index: args.index,
          };
          setDndState({
            kind: "active",
            itemId: args.itemId,
            source,
            hover: source,
            mode: "pointer",
          });
          // No setPointerCapture — we *want* pointerenter to fire on
          // sibling slots as the captain moves over them.
        },
        ...(isMe ? { "data-dnd-pickup": "true" as const } : {}),
      };
    },
    [state, announce, setDndState, labelForItem],
  );

  const getDropSlotProps = useCallback<UseKanbanDndResult["getDropSlotProps"]>(
    (target) => {
      const isHover =
        state.kind === "active" &&
        state.hover.containerId === target.containerId &&
        state.hover.index === target.index;
      const isActive = state.kind === "active";
      const isVisibleTarget = optsRef.current.isDropTargetVisible?.(target) ?? true;
      const valid =
        isVisibleTarget &&
        (!isActive ||
          (optsRef.current.canDrop?.({
            itemId: state.itemId,
            source: state.source,
            target,
          }) ?? true));
      // Sprint 7B.1 (R3-H6): role="button" makes the slot a real keyboard
      // tabstop and a real SR target. tabIndex is -1 when no drag is
      // active (so the captain doesn't tab through hundreds of empty drop
      // slots), 0 only on the active hover slot during keyboard mode, -1
      // on other slots during a drag (we drive nav via arrow keys, not
      // Tab). We keep slots reachable to programmatic focus via the ref
      // (focus-follows-hover effect).
      const tabIndex = isActive && isHover && state.mode === "keyboard" ? 0 : -1;
      const ariaLabel = `Drop in ${labelForContainer(target.containerId)} at position ${target.index + 1}`;
      const key = slotKey(target);
      return {
        role: "button",
        tabIndex,
        "aria-label": ariaLabel,
        "aria-disabled": !isVisibleTarget || (isActive && !valid),
        "data-dnd-target": "true",
        "data-dnd-container": target.containerId,
        "data-dnd-index": String(target.index),
        ...(isHover ? { "data-dnd-hover": "true" as const } : {}),
        ref: (el: HTMLElement | null) => {
          if (el) {
            slotRefs.current.set(key, el);
          } else {
            slotRefs.current.delete(key);
          }
        },
        onPointerEnter: () => {
          if (!isVisibleTarget) return;
          const cur = stateRef.current;
          if (cur.kind !== "active" || cur.mode !== "pointer") return;
          if (
            cur.hover.containerId === target.containerId &&
            cur.hover.index === target.index
          ) {
            return;
          }
          setDndState({ ...cur, hover: target });
        },
        onPointerUp: (e) => {
          if (!isVisibleTarget) return;
          const cur = stateRef.current;
          if (cur.kind !== "active" || cur.mode !== "pointer") return;
          e.preventDefault();
          // Pass `target` explicitly to dodge the same-tick stale-hover
          // hazard described in the file-header comment.
          void commit(target);
        },
        onClick: () => {
          if (!isVisibleTarget) return;
          const cur = stateRef.current;
          if (cur.kind !== "active" || cur.mode !== "keyboard") return;
          // Mouse-click-on-slot also commits in keyboard mode — supports
          // captains who picked up via keyboard but want to drop with the
          // mouse.
          void commit(target);
        },
      };
    },
    [state, commit, slotKey, setDndState, labelForContainer],
  );

  return useMemo(
    () => ({ state, getItemProps, getDropSlotProps, cancel }),
    [state, getItemProps, getDropSlotProps, cancel],
  );
}

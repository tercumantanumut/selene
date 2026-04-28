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
  /** Optional ARIA-live announcer. Pass a setter that writes to a `polite` region. */
  announce?: (message: string) => void;
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
 */
export type DnDItemProps = {
  role: "button";
  tabIndex: 0;
  "aria-roledescription": "draggable card";
  "aria-grabbed": boolean;
  "aria-disabled"?: true;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  "data-dnd-pickup"?: "true";
};

/**
 * Props returned by `getDropSlotProps` — spread onto a slot element.
 */
export type DnDDropSlotProps = {
  role: "presentation";
  "aria-dropeffect": "move" | "none";
  "data-dnd-target": "true";
  "data-dnd-container": string;
  "data-dnd-index": string;
  "data-dnd-hover"?: "true";
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
  const stateRef = useRef(state);
  stateRef.current = state;

  const announce = useCallback((msg: string) => {
    optsRef.current.announce?.(msg);
  }, []);

  // ── Cancel / commit ────────────────────────────────────────────────────

  const cancel = useCallback(() => {
    if (stateRef.current.kind !== "active") return;
    setState({ kind: "idle" });
    announce("Drag cancelled");
  }, [announce]);

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
        setState({ kind: "idle" });
        announce("Drop cancelled — same position");
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
        announce("Drop not allowed here");
        return;
      }
      // Clear DnD state immediately so the captain can pick up another card
      // while the network call is still in flight. The caller's optimistic
      // overlay is what visually moves the card; this hook only owns the
      // pickup-to-drop gesture.
      setState({ kind: "idle" });
      try {
        await optsRef.current.onDrop({
          itemId: cur.itemId,
          source: cur.source,
          target,
        });
        announce("Card moved");
      } catch {
        // Caller is responsible for any rollback + visible error UX.
        announce("Move failed");
      }
    },
    [announce],
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
        const targetIdx = colIdx + (direction === "left" ? -1 : 1);
        if (targetIdx < 0 || targetIdx >= columnOrder.length) return;
        nextCol = columnOrder[targetIdx];
        // +1 because every column has `count + 1` slots (including the
        // trailing "end of column" slot). Clamp the carried index so we
        // don't land past the end when entering a smaller column.
        const cap = (itemCounts[nextCol] ?? 0) + 1;
        nextIndex = Math.min(nextIndex, cap - 1);
      } else {
        const cap = (itemCounts[nextCol] ?? 0) + 1;
        nextIndex =
          direction === "up"
            ? Math.max(0, cur.hover.index - 1)
            : Math.min(cap - 1, cur.hover.index + 1);
      }

      setState({
        ...cur,
        hover: { containerId: nextCol, index: nextIndex },
      });
      announce(`${nextCol}, slot ${nextIndex + 1}`);
    },
    [announce],
  );

  // ── Window-scoped keyboard handler (active-keyboard mode) ─────────────

  // Pull `mode` out as `null` when idle so the effect deps stay
  // type-safe (state.mode is only present on the `active` variant).
  const activeMode = state.kind === "active" ? state.mode : null;

  useEffect(() => {
    if (state.kind !== "active" || state.mode !== "keyboard") return;
    function onKey(e: KeyboardEvent) {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          cancel();
          break;
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
          // ignore everything else (typing in a focused input shouldn't
          // disturb the drag, but we don't proactively check focus —
          // captain who picks up a card and starts typing gets keystrokes
          // routed here, which is acceptable for a transient gesture).
          break;
      }
    }
    // useCapture so we beat any focused button's onKeyDown.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state.kind, activeMode, cancel, commit, moveHover]);

  // ── Pointer mode: pointercancel + Escape ──────────────────────────────

  useEffect(() => {
    if (state.kind !== "active" || state.mode !== "pointer") return;
    function onCancel() {
      cancel();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    }
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [state.kind, activeMode, cancel]);

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
        "aria-grabbed": isMe,
        ...(draggable ? {} : { "aria-disabled": true as const }),
        onKeyDown: (e) => {
          if (!draggable) return;
          if (state.kind !== "idle") return;
          if (!PICKUP_KEYS.has(e.key)) return;
          e.preventDefault();
          const source: DnDPosition = {
            containerId: args.containerId,
            index: args.index,
          };
          setState({
            kind: "active",
            itemId: args.itemId,
            source,
            hover: source,
            mode: "keyboard",
          });
          announce(
            "Picked up. Arrow keys to move, space to drop, escape to cancel.",
          );
        },
        onPointerDown: (e) => {
          if (!draggable) return;
          // Only primary button (mouse left / touch / pen).
          if (e.button !== 0) return;
          if (state.kind !== "idle") return;
          // Skip pickup if the click landed on a nested control marked
          // `data-dnd-skip` (e.g. an inline edit / cancel button on the
          // tile). Caller is responsible for marking those.
          const targetEl = e.target as HTMLElement;
          if (targetEl.closest("[data-dnd-skip]")) return;
          const source: DnDPosition = {
            containerId: args.containerId,
            index: args.index,
          };
          setState({
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
    [state, announce],
  );

  const getDropSlotProps = useCallback<UseKanbanDndResult["getDropSlotProps"]>(
    (target) => {
      const isHover =
        state.kind === "active" &&
        state.hover.containerId === target.containerId &&
        state.hover.index === target.index;
      // `aria-dropeffect="none"` when the active drag would be rejected
      // here, so screen-readers announce non-droppable slots correctly.
      const valid =
        state.kind !== "active" ||
        (optsRef.current.canDrop?.({
          itemId: state.itemId,
          source: state.source,
          target,
        }) ?? true);
      return {
        role: "presentation",
        "aria-dropeffect": valid ? "move" : "none",
        "data-dnd-target": "true",
        "data-dnd-container": target.containerId,
        "data-dnd-index": String(target.index),
        ...(isHover ? { "data-dnd-hover": "true" as const } : {}),
        onPointerEnter: () => {
          const cur = stateRef.current;
          if (cur.kind !== "active" || cur.mode !== "pointer") return;
          if (
            cur.hover.containerId === target.containerId &&
            cur.hover.index === target.index
          ) {
            return;
          }
          setState({ ...cur, hover: target });
        },
        onPointerUp: (e) => {
          const cur = stateRef.current;
          if (cur.kind !== "active" || cur.mode !== "pointer") return;
          e.preventDefault();
          // Pass `target` explicitly to dodge the same-tick stale-hover
          // hazard described in the file-header comment.
          void commit(target);
        },
        onClick: () => {
          const cur = stateRef.current;
          if (cur.kind !== "active" || cur.mode !== "keyboard") return;
          // Mouse-click-on-slot also commits in keyboard mode — supports
          // captains who picked up via keyboard but want to drop with the
          // mouse.
          void commit(target);
        },
      };
    },
    [state, commit],
  );

  return useMemo(
    () => ({ state, getItemProps, getDropSlotProps, cancel }),
    [state, getItemProps, getDropSlotProps, cancel],
  );
}

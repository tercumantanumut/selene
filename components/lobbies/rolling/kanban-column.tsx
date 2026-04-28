"use client";

/**
 * KanbanColumn — single Kanban column for the rolling phase.
 *
 * Renders a vertical stack of cards interleaved with drop slots:
 *
 *   ┌────────────────────┐
 *   │  ▒ slot 0          │  ← drop above first card
 *   │  KanbanCardTile #0 │
 *   │  ▒ slot 1          │  ← between #0 and #1
 *   │  KanbanCardTile #1 │
 *   │  ▒ slot 2          │  ← end-of-column slot
 *   └────────────────────┘
 *
 * Slots are tiny when idle and expand to a visible drop indicator only
 * during an active drag. The trailing "end" slot is a flex-grow filler so
 * the captain can drop into an empty column or below the last card.
 *
 * Why explicit slots instead of "drop on column / compute index from
 * pointerY"? The slot model is keyboard-friendly (each slot is a
 * navigable position) and avoids fragile bounding-box math during a
 * pointer drag. The trade-off — N+1 DOM nodes per column — is fine for
 * the sizes we expect (≤ 50 cards per lobby per SPEC §3 #3).
 *
 * Empty-column UX: when there are zero cards, a single "Drop here" slot
 * fills the column. Same drop semantics, just visually merged with the
 * column body.
 */

import { Fragment, memo, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

import type {
  DnDDropSlotProps,
  DnDPosition,
  DnDState,
} from "./use-keyboard-dnd";

// ─── Types ────────────────────────────────────────────────────────────────

export type KanbanColumnProps = {
  columnId: string;
  title: string;
  /** Lucide icon component (NOT a rendered element — we instantiate it). */
  icon: LucideIcon;
  /** Subtle description, shown below the title. */
  hint?: string;
  /** Color accent for the column header (Tailwind class). */
  accentClass?: string;
  /**
   * Pre-rendered card tiles in display order. The column doesn't know how
   * to render cards itself — that's KanbanCardTile's job. Instead it
   * receives the rendered nodes plus the per-card metadata (id, ...) it
   * needs to interleave drop slots correctly.
   */
  items: Array<{ id: string; node: ReactNode }>;
  /** Caller's DnD state — drives slot visibility. */
  dndState: DnDState;
  /** Slot prop builder from `useKanbanDnd().getDropSlotProps`. */
  getDropSlotProps: (target: DnDPosition) => DnDDropSlotProps;
  /** True when no card can land in this column (mode mismatch, etc). */
  isReadOnly?: boolean;
};

// ─── Component ───────────────────────────────────────────────────────────

export const KanbanColumn = memo(function KanbanColumn({
  columnId,
  title,
  icon: Icon,
  hint,
  accentClass,
  items,
  dndState,
  getDropSlotProps,
  isReadOnly,
}: KanbanColumnProps) {
  const isDragging = dndState.kind === "active";
  // Hide drop slots in read-only columns to avoid fake affordances.
  const showSlots = isDragging && !isReadOnly;

  return (
    <section
      aria-label={`${title} column, ${items.length} card${items.length === 1 ? "" : "s"}`}
      className={cn(
        "flex flex-col rounded-md border border-terminal-border/40 bg-terminal-cream/30",
        "min-w-[16rem] flex-1",
      )}
    >
      {/* Header */}
      <header
        className={cn(
          "flex items-center justify-between gap-2 border-b border-terminal-border/30 px-3 py-2",
          accentClass,
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <h3 className="font-mono text-xs font-semibold uppercase tracking-wide truncate">
            {title}
          </h3>
        </div>
        <Badge
          variant="outline"
          className="font-mono text-[10px] tabular-nums"
        >
          {items.length}
        </Badge>
      </header>

      {hint && (
        <p className="px-3 pt-1.5 font-mono text-[10px] text-terminal-muted">
          {hint}
        </p>
      )}

      {/* Body — interleaved slots + tiles.

          Sprint 7B.1 (R3-H5): each card AND each drop slot is its own
          <li>. The previous structure nested both inside one <li>, which
          broke SR navigation by list item — JAWS / NVDA list-mode read
          "card + slot" as one entry instead of two distinct positions,
          and `aria-setsize`/`aria-posinset` on cards (added implicitly
          by some SRs from `<ol>`) were misleading because slots inflated
          the count silently. Splitting them gives the SR user one
          navigable position per real screen position. */}
      <ol className="flex-1 flex flex-col gap-1 p-2 min-h-[8rem]">
        {items.length === 0 ? (
          <li className="flex-1">
            {/* Single full-column slot for empty state. */}
            <DropSlot
              props={getDropSlotProps({ containerId: columnId, index: 0 })}
              variant="empty"
              visible={showSlots}
            />
          </li>
        ) : (
          <>
            {/* Slot above first card */}
            <li>
              <DropSlot
                props={getDropSlotProps({ containerId: columnId, index: 0 })}
                variant="between"
                visible={showSlots}
              />
            </li>
            {items.map((item, idx) => (
              <Fragment key={item.id}>
                <li>{item.node}</li>
                <li>
                  <DropSlot
                    props={getDropSlotProps({
                      containerId: columnId,
                      index: idx + 1,
                    })}
                    variant={idx === items.length - 1 ? "trailing" : "between"}
                    visible={showSlots}
                  />
                </li>
              </Fragment>
            ))}
          </>
        )}
      </ol>
    </section>
  );
});

// ─── Drop slot ────────────────────────────────────────────────────────────

type DropSlotProps = {
  props: DnDDropSlotProps;
  /**
   * Visual variant. `between` is a thin line between cards. `trailing` is
   * a flex-grow filler that fills the remaining column height. `empty`
   * fills the column body for zero-card state.
   */
  variant: "between" | "trailing" | "empty";
  /** True while a drag is active. When false, the slot is functionally
   *  inert (no hover styling, no event handlers fire because the hook
   *  guards on state). We still render it so layout doesn't shift on
   *  drag start. */
  visible: boolean;
};

function DropSlot({ props, variant, visible }: DropSlotProps) {
  const isHover = props["data-dnd-hover"] === "true";
  // Sprint 7B.1 (R3-H1): extract the ref callback explicitly. React's
  // createElement intercepts a `ref` key from spread on DOM intrinsics, but
  // relying on that across spread is fragile to readers and to future
  // refactors that might wrap this in another component. Pulling it out
  // makes the focus-follows-hover wiring obvious.
  const { ref, ...domProps } = props;
  const cls = cn(
    "transition-all rounded-md",
    variant === "between" && "h-1",
    variant === "trailing" && "min-h-[4rem] flex-1",
    variant === "empty" && "min-h-[6rem] h-full",
    // Sprint 7B.1 (R3-H6): the slot is now role="button" — strip the
    // browser's default outline only when not focused so keyboard focus
    // remains visible (focus ring is :focus-visible by default in shadcn).
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green",
    visible
      ? cn(
          "bg-terminal-border/30 border border-dashed border-terminal-border/60",
          isHover &&
            "h-3 bg-terminal-green/20 border-terminal-green ring-1 ring-terminal-green/50",
          variant !== "between" && "flex items-center justify-center",
        )
      : "bg-transparent",
  );
  return (
    <div
      {...domProps}
      ref={ref as (el: HTMLDivElement | null) => void}
      className={cls}
    >
      {visible && variant !== "between" && (
        <span className="font-mono text-[10px] uppercase tracking-wider text-terminal-muted">
          {isHover ? "drop here" : "..."}
        </span>
      )}
    </div>
  );
}

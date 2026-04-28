/**
 * Solo Story Mode — shared lobby status badge.
 *
 * Single visual source of truth for lobby status pills. Used by the lobby
 * list page (`/lobbies`) and the detail page header (`/lobbies/[id]`). Keep
 * any future status-pill changes here so the two pages can never drift.
 *
 * The pill exposes its semantic state via `aria-label` (e.g.,
 * "Lobby status: Rolling") so screen readers don't have to infer from color.
 *
 * Color contrast (Sprint 5.1 review): the previous version used the
 * `text-terminal-amber`/`text-terminal-green` colours as foreground on a
 * `/15` tinted background — that fell well below WCAG AA (≈ 1.9–3.7:1) for
 * `font-mono text-xs` (small text, 4.5:1 required). The current version uses
 * `text-terminal-dark` (or `text-white` for the dark/red badges) so the label
 * always meets AA, and lets the tinted background + border carry the colour
 * identity instead.
 */

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { LobbyStatus } from "@/lib/lobbies/types";

const STATUS_CONFIG: Record<LobbyStatus, { label: string; className: string }> = {
  roster: {
    label: "Roster",
    className: "bg-terminal-amber/20 text-terminal-dark border-terminal-amber/50",
  },
  planning: {
    label: "Planning",
    className: "bg-blue-500/15 text-terminal-dark border-blue-500/40 dark:text-blue-200",
  },
  rolling: {
    label: "Rolling",
    className: "bg-terminal-green/20 text-terminal-dark border-terminal-green/50",
  },
  review: {
    label: "Review",
    className: "bg-purple-500/15 text-terminal-dark border-purple-500/40 dark:text-purple-200",
  },
  completed: {
    label: "Completed",
    className: "bg-terminal-muted/20 text-terminal-dark border-terminal-muted/50",
  },
  aborted: {
    label: "Aborted",
    className: "bg-red-500/15 text-red-700 border-red-500/40 dark:text-red-200",
  },
};

export function LobbyStatusBadge({
  status,
  className,
}: {
  status: LobbyStatus;
  className?: string;
}) {
  const cfg = STATUS_CONFIG[status];
  return (
    <Badge
      variant="outline"
      aria-label={`Lobby status: ${cfg.label}`}
      className={cn("font-mono text-xs", cfg.className, className)}
    >
      {cfg.label}
    </Badge>
  );
}

export function getLobbyStatusLabel(status: LobbyStatus): string {
  return STATUS_CONFIG[status].label;
}

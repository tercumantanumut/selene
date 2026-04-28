/**
 * Solo Story Mode — shared lobby status badge.
 *
 * Single visual source of truth for lobby status pills. Used by the lobby
 * list page (`/lobbies`) and the detail page header (`/lobbies/[id]`). Keep
 * any future status-pill changes here so the two pages can never drift.
 *
 * The pill exposes its semantic state via `aria-label` (e.g.,
 * "Lobby status: Rolling") so screen readers don't have to infer from color.
 */

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { LobbyStatus } from "@/lib/lobbies/types";

const STATUS_CONFIG: Record<LobbyStatus, { label: string; className: string }> = {
  roster: {
    label: "Roster",
    className: "bg-terminal-amber/15 text-terminal-amber border-terminal-amber/40",
  },
  planning: {
    label: "Planning",
    className: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  },
  rolling: {
    label: "Rolling",
    className: "bg-terminal-green/15 text-terminal-green border-terminal-green/40",
  },
  review: {
    label: "Review",
    className: "bg-purple-500/15 text-purple-600 border-purple-500/30",
  },
  completed: {
    label: "Completed",
    className: "bg-terminal-muted/15 text-terminal-muted border-terminal-muted/40",
  },
  aborted: {
    label: "Aborted",
    className: "bg-red-500/15 text-red-600 border-red-500/30",
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

"use client";

/**
 * SeatCard — one tile in the SeatGrid.
 *
 * Stateless: receives `seat`, `agent` (resolved by parent via the character
 * lookup table), and the four action callbacks. Local state is limited to
 * the edit-role inline edit (toggle + buffer). Parent owns:
 *   - which seats exist (RosterSection holds the working copy)
 *   - which seat sheet is open (UI store: `seatPanelSeatId`)
 *
 * The scope summary uses a small derived label rather than rendering every
 * tool name — saves vertical space when a seat has many allowed tools and
 * matches the FE Architect's "permission summary" prop shape.
 */

import { useState, type ReactNode } from "react";
import { Bot, Lock, ShieldCheck, Trash2, UserPlus2, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import type { LobbySeat } from "@/lib/db/sqlite-lobbies-schema";
import type { LobbyPermissionScopeV1 } from "@/lib/lobbies/types";
import type { CharacterSummary } from "@/lib/lobbies/client/character-hooks";

export type SeatCardProps = {
  seat: LobbySeat;
  agent: CharacterSummary | null;
  isEditable: boolean;
  onRoleChange: (role: string) => void;
  onPickAgent: () => void;
  onEditScope: () => void;
  onRemove: () => void;
};

/**
 * SPEC §3 / scope-injection.ts: an empty `allowedTools` array is the
 * "no tightening" sentinel — the seat inherits the agent's full enabled-tools
 * surface. Only a non-empty list represents an explicit tightened subset.
 *
 * `deniedTools` is reserved for V1.1+; we report it but don't gate UI on it.
 */
function describePermissionScope(scope: LobbyPermissionScopeV1 | undefined): {
  label: string;
  tightened: boolean;
} {
  const allowed = scope?.allowedTools ?? [];
  const denied = scope?.deniedTools ?? [];
  if (allowed.length === 0 && denied.length === 0) {
    return { label: "Agent default tools", tightened: false };
  }
  const parts: string[] = [];
  if (allowed.length > 0) {
    parts.push(`${allowed.length} tool${allowed.length === 1 ? "" : "s"}`);
  }
  if (denied.length > 0) {
    parts.push(`${denied.length} denied`);
  }
  return {
    label: parts.join(" · "),
    tightened: true,
  };
}

const STATUS_LABEL: Record<LobbySeat["status"], string> = {
  empty: "Empty",
  ready: "Ready",
  busy: "Busy",
  idle: "Idle",
};

export function SeatCard({
  seat,
  agent,
  isEditable,
  onRoleChange,
  onPickAgent,
  onEditScope,
  onRemove,
}: SeatCardProps) {
  const [editingRole, setEditingRole] = useState(false);
  const [roleBuffer, setRoleBuffer] = useState(seat.role);

  const scopeDescription = describePermissionScope(seat.permissionScope);
  const isFilled = seat.agentId !== null && agent !== null;

  function commitRole() {
    setEditingRole(false);
    const trimmed = roleBuffer.trim();
    if (trimmed.length === 0) {
      // Refuse empty role; revert to seat.role.
      setRoleBuffer(seat.role);
      return;
    }
    if (trimmed !== seat.role) onRoleChange(trimmed);
  }

  return (
    <Card className="p-4 space-y-3">
      {/* Role label (editable) ─────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {editingRole && isEditable ? (
            <Input
              autoFocus
              value={roleBuffer}
              onChange={(e) => setRoleBuffer(e.target.value)}
              onBlur={commitRole}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRole();
                } else if (e.key === "Escape") {
                  setRoleBuffer(seat.role);
                  setEditingRole(false);
                }
              }}
              className="font-mono text-sm h-7"
              aria-label="Seat role"
              maxLength={80}
            />
          ) : (
            <button
              type="button"
              onClick={() => isEditable && setEditingRole(true)}
              disabled={!isEditable}
              className="text-left font-mono text-sm font-semibold text-terminal-dark hover:underline disabled:cursor-default disabled:no-underline"
              aria-label={`Edit role for seat ${seat.role}`}
            >
              {seat.role}
            </button>
          )}
          <p className="font-mono text-[11px] text-terminal-muted">
            Position {seat.position + 1} · {STATUS_LABEL[seat.status]}
          </p>
        </div>
        {isEditable && (
          <Button
            variant="ghost"
            size="icon"
            type="button"
            onClick={onRemove}
            aria-label={`Remove seat ${seat.role}`}
            className="h-7 w-7 text-terminal-muted hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Agent assignment ─────────────────────────────────────────────── */}
      <div className="space-y-1">
        {isFilled ? (
          <SeatAgentRow
            label={agent.displayName ?? agent.name}
            tagline={agent.tagline ?? undefined}
            onChange={isEditable ? onPickAgent : undefined}
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={onPickAgent}
            disabled={!isEditable}
            className="w-full justify-start font-mono text-xs"
          >
            <UserPlus2 className="h-3.5 w-3.5 mr-2" />
            Pick an agent for this seat
          </Button>
        )}
      </div>

      {/* Permission scope summary ─────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {scopeDescription.tightened ? (
            <Lock className="h-3 w-3 text-amber-700 dark:text-amber-400 shrink-0" />
          ) : (
            <ShieldCheck className="h-3 w-3 text-terminal-muted shrink-0" />
          )}
          <span className="font-mono text-[11px] text-terminal-muted truncate">
            {scopeDescription.label}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onEditScope}
          disabled={!isEditable || !isFilled}
          className="h-6 px-2 font-mono text-[11px]"
        >
          <Wrench className="h-3 w-3 mr-1" />
          Scope
        </Button>
      </div>
    </Card>
  );
}

function SeatAgentRow({
  label,
  tagline,
  onChange,
}: {
  label: string;
  tagline?: string;
  onChange?: () => void;
}): ReactNode {
  const content = (
    <div className="flex items-center gap-2 min-w-0">
      <Bot className="h-3.5 w-3.5 text-terminal-dark shrink-0" />
      <div className="min-w-0">
        <p className="font-mono text-xs font-semibold text-terminal-dark truncate">
          {label}
        </p>
        {tagline ? (
          <p className="font-mono text-[10px] text-terminal-muted truncate">
            {tagline}
          </p>
        ) : null}
      </div>
    </div>
  );

  if (!onChange) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-terminal-border bg-terminal-cream/40 px-2 py-1.5">
        {content}
        <Badge variant="outline" className="font-mono text-[10px]">
          Locked
        </Badge>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onChange}
      className="w-full flex items-center justify-between gap-2 rounded-md border border-terminal-border bg-terminal-cream/40 px-2 py-1.5 hover:border-terminal-dark hover:bg-terminal-cream/70 transition-colors"
      aria-label={`Change agent for ${label}`}
    >
      {content}
      <span className="font-mono text-[10px] text-terminal-muted">change</span>
    </button>
  );
}

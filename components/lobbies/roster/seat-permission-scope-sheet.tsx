"use client";

/**
 * SeatPermissionScopeSheet — modal for tightening a seat's tool surface.
 *
 * SPEC §3 #11 nails the V1 contract: permission scope is **tool-list only**.
 * This sheet shows the agent's `metadata.enabledTools` as a checklist; the
 * captain unchecks tools they don't want this seat to have. Plugins, MCP
 * servers, and folder scoping are all V1.1+ — out of scope here.
 *
 * Output shape (`LobbyPermissionScopeV1`):
 *   { version: 1, mode: "tool_list", allowedTools: string[] }
 *
 * Default starting point when no scope exists: all of the agent's enabled
 * tools allowed (preserves current behavior — the seat inherits the agent's
 * full surface). Toggling builds the explicit allowlist.
 *
 * The scope is enforced server-side at `buildToolsForRequest` (tool resolver
 * intersection) — see `lib/lobbies/scope-injection.ts`.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2, ShieldCheck, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import type { CharacterSummary } from "@/lib/lobbies/client/character-hooks";
import type { LobbyPermissionScopeV1 } from "@/lib/lobbies/types";

export type SeatPermissionScopeSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seatRole: string;
  agent: CharacterSummary | null;
  /** Existing scope on the seat (undefined → seat inherits agent default). */
  initialScope: LobbyPermissionScopeV1 | undefined;
  saving?: boolean;
  error?: string | null;
  onSave: (scope: LobbyPermissionScopeV1) => void;
};

export function SeatPermissionScopeSheet({
  open,
  onOpenChange,
  seatRole,
  agent,
  initialScope,
  saving = false,
  error = null,
  onSave,
}: SeatPermissionScopeSheetProps) {
  const agentTools = useMemo(
    () => agent?.metadata?.enabledTools ?? [],
    [agent?.metadata?.enabledTools],
  );

  // Build the initial allowed-tool set. Empty `allowedTools` is the
  // server-side inherit-all sentinel, while explicit scopes are interpreted as
  // `allowedTools - deniedTools` so the "None" payload can round-trip.
  function buildInitial(
    scope: LobbyPermissionScopeV1 | undefined,
    tools: string[],
  ): Set<string> {
    return deriveScopeSelection(scope, tools);
  }

  const [allowed, setAllowed] = useState<Set<string>>(() =>
    buildInitial(initialScope, agentTools),
  );

  // Re-seed when the dialog reopens for a different seat / agent. Without
  // this, switching seats while the sheet is mounted carries the previous
  // seat's checkbox state forward — exactly the kind of stale state that
  // causes accidental tightening.
  //
  // Sprint 6.1 (S6 R2 HIGH): only re-seed on the open→true edge. The
  // previous deps `[open, initialScope, agentTools]` triggered a reset on
  // EVERY parent refetch (any sibling mutation produces a new
  // `initialScope` object reference), silently clobbering captain's
  // in-progress checkbox edits. We track `prevOpen` via a ref and only
  // run the seed logic when `open` flips from false → true. The agentTools
  // / initialScope reads inside the effect still pick up the current
  // values, so the seed is correct.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setAllowed(buildInitial(initialScope, agentTools));
    }
    prevOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: edge-only seed
  }, [open]);

  function toggle(tool: string) {
    setAllowed((prev) => {
      const next = new Set(prev);
      if (next.has(tool)) next.delete(tool);
      else next.add(tool);
      return next;
    });
  }

  function setAll(checked: boolean) {
    setAllowed(checked ? new Set(agentTools) : new Set());
  }

  const allChecked =
    agentTools.length > 0 && agentTools.every((tool) => allowed.has(tool));
  const noneChecked = allowed.size === 0;
  // Sprint 6.1 (S6 R3 MEDIUM): stable id for the tool-list group label so
  // the inner <ul> can announce its group context.
  const groupLabelId = useId();

  function handleSave() {
    onSave(buildScopeFromSelection(allowed, agentTools));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-mono text-base flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            Scope tools for{" "}
            <span className="text-terminal-green">{seatRole}</span>
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Uncheck tools you don't want this seat to use. The seat can never
            access tools the agent doesn't already have enabled.
          </DialogDescription>
        </DialogHeader>

        {!agent ? (
          // Sprint 6.1 (S6 R3 HIGH): amber-700 → amber-800 for AA contrast.
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
            <AlertCircle
              className="h-4 w-4 text-amber-800 dark:text-amber-300 mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <p className="font-mono text-xs text-amber-900 dark:text-amber-100">
              Pick an agent for this seat first — scope is anchored to the
              agent's tool surface.
            </p>
          </div>
        ) : agentTools.length === 0 ? (
          <div className="flex items-start gap-2 rounded-md border border-terminal-border/60 bg-terminal-cream/40 p-3">
            <ShieldCheck className="h-4 w-4 text-terminal-muted mt-0.5 shrink-0" />
            <p className="font-mono text-xs text-terminal-muted">
              <span className="font-semibold">
                {agent.displayName ?? agent.name}
              </span>{" "}
              has no enabled tools — there's nothing to scope.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between text-[11px] font-mono text-terminal-muted">
              <span>
                {allowed.size} of {agentTools.length} allowed
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setAll(true)}
                  disabled={allChecked || saving}
                  className="h-6 px-2 font-mono text-[11px]"
                >
                  All
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setAll(false)}
                  disabled={noneChecked || saving}
                  className="h-6 px-2 font-mono text-[11px]"
                >
                  None
                </Button>
              </div>
            </div>

            {/* Sprint 6.1 (S6 R3 MEDIUM): visually-hidden group label so SR
                users hear the scope-tools list as a labelled group. */}
            <span id={groupLabelId} className="sr-only">
              Tools allowed for {seatRole}
            </span>
            <ScrollArea className="flex-1 -mx-6 px-6">
              <ul
                className="space-y-1 py-1"
                role="group"
                aria-labelledby={groupLabelId}
              >
                {agentTools.map((tool) => {
                  const checked = allowed.has(tool);
                  const id = `scope-tool-${tool}`;
                  return (
                    <li key={tool}>
                      <label
                        htmlFor={id}
                        className={cn(
                          "flex items-center gap-3 rounded-md border px-3 py-2 cursor-pointer transition-colors",
                          checked
                            ? "border-terminal-border/60 bg-terminal-cream/40"
                            : "border-dashed border-terminal-border/40 bg-transparent",
                        )}
                      >
                        <Checkbox
                          id={id}
                          checked={checked}
                          onCheckedChange={() => toggle(tool)}
                          disabled={saving}
                        />
                        <span className="font-mono text-xs text-terminal-dark">
                          {tool}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>

            {noneChecked && (
              // Sprint 6.1 (S6 R3 HIGH): amber-700 → amber-800 for AA.
              <p
                role="status"
                className="font-mono text-[11px] text-amber-800 dark:text-amber-300"
              >
                No tools allowed — this seat will run with zero tool access.
              </p>
            )}
          </>
        )}

        {error && (
          // Sprint 6.1 (S6 R3 HIGH): destructive token (#ef4444) on cream
          // is ~3.4:1 (fails AA). Use red-700 (#b91c1c) → ~5.9:1.
          <p
            role="alert"
            className="font-mono text-[11px] text-red-700 dark:text-red-300"
          >
            {error}
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="font-mono text-xs"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={saving || !agent || agentTools.length === 0}
            className="font-mono text-xs"
          >
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                Saving…
              </>
            ) : (
              "Save scope"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function deriveScopeSelection(
  scope: LobbyPermissionScopeV1 | undefined,
  tools: string[],
): Set<string> {
  if (!scope || scope.allowedTools.length === 0) {
    return new Set(tools);
  }
  const available = new Set(tools);
  const denied = new Set(scope.deniedTools ?? []);
  return new Set(
    scope.allowedTools.filter(
      (tool) => available.has(tool) && !denied.has(tool),
    ),
  );
}

export function buildScopeFromSelection(
  allowed: Set<string>,
  tools: string[],
): LobbyPermissionScopeV1 {
  const availableTools = tools.filter((tool) => allowed.has(tool));
  const allChecked =
    tools.length > 0 && availableTools.length === tools.length;

  if (allChecked) {
    return { version: 1, mode: "tool_list", allowedTools: [] };
  }

  if (availableTools.length === 0) {
    return {
      version: 1,
      mode: "tool_list",
      allowedTools: [...tools],
      deniedTools: [...tools],
    };
  }

  return {
    version: 1,
    mode: "tool_list",
    allowedTools: availableTools,
  };
}

"use client";

/**
 * CardDependencyEditor — modal for editing a card's upstream dependencies.
 *
 * Renders a checkbox list of all OTHER cards in the lobby, with each
 * checked entry contributing to the next PUT to
 * `/api/lobbies/:lobbyId/cards/:cardId/dependencies` (replaces the entire
 * dependency set for the card in one transaction). The endpoint owns
 * cycle detection — we only do the cheaply-checkable subset on the
 * client (no self-dep, no obvious 1-hop cycle) so the captain gets fast
 * feedback before clicking save.
 *
 * Server response shape: `{ dependencies: LobbyCardDependency[] }`. The
 * dialog calls `onSaved` and lets the parent refetch the canonical row
 * list.
 *
 * UX nuances:
 *   - When the dialog opens, seed the checkbox state from the existing
 *     `dependencies` array. Re-seed on every `open` change so a closed
 *     dialog reopened on a different card doesn't show stale picks.
 *   - "Optional" toggle per dep — the server schema accepts an
 *     `optional?: boolean` flag (lets the orchestrator skip a dep when
 *     it's marked optional and the upstream failed).
 *   - Block self-selection (the card we're editing).
 *   - Block dependencies that would obviously cycle (the candidate's
 *     own deps already include the editing card). Server still
 *     validates with full DFS — this is just a fast-path UX hint.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import {
  LobbyApiError,
  replaceDependencies,
} from "@/lib/lobbies/client/api";
import type {
  LobbyCard,
  LobbyCardDependency,
} from "@/lib/db/sqlite-lobbies-schema";

// ─── Types ────────────────────────────────────────────────────────────────

export type CardDependencyEditorProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lobbyId: string;
  /** The card whose dependencies we're editing. Null = closed. */
  card: LobbyCard | null;
  /** All cards in the lobby (used to populate the candidate list). */
  allCards: LobbyCard[];
  /** All dependency rows in the lobby — for seeding + cycle prefiltering. */
  allDependencies: LobbyCardDependency[];
  /** Fired after a successful save so the parent can refetch. */
  onSaved: () => void;
};

type DraftDep = {
  cardId: string;
  optional: boolean;
};

// ─── Component ───────────────────────────────────────────────────────────

export function CardDependencyEditor({
  open,
  onOpenChange,
  lobbyId,
  card,
  allCards,
  allDependencies,
  onSaved,
}: CardDependencyEditorProps) {
  const [draft, setDraft] = useState<Map<string, DraftDep>>(() => new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  // Sprint 7B.1 (R1-H4 + R2-H6): the reseed effect's deps used to include
  // `card` and `allDependencies`. `allDependencies` is a fresh array
  // reference on every parent refetch (which fires from SSE-driven
  // `onChanged()` and from sibling kanban drops). Mid-edit, the captain
  // lost every checkbox they toggled. Sprint 7A.1 already shipped this
  // exact fix for `CardEditDialog` — the lesson didn't carry over to the
  // dep editor in Sprint 7B.
  //
  // Fix: depend only on the open→true edge for a stable (id, lockVersion)
  // pair. Read `allDependencies` through a ref so the seed pulls the latest
  // snapshot when the dialog opens, but doesn't re-fire mid-edit.
  const allDependenciesRef = useRef(allDependencies);
  allDependenciesRef.current = allDependencies;

  useEffect(() => {
    if (!open || !card) return;
    const existing = new Map<string, DraftDep>();
    for (const dep of allDependenciesRef.current) {
      if (dep.cardId !== card.id) continue;
      existing.set(dep.dependsOnCardId, {
        cardId: dep.dependsOnCardId,
        optional: dep.optional,
      });
    }
    setDraft(existing);
    setError(null);
  }, [open, card?.id, card?.lockVersion]);

  // Indexes used by the candidate filter.
  const cardById = useMemo(
    () => new Map(allCards.map((c) => [c.id, c])),
    [allCards],
  );
  const depsByCardId = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const dep of allDependencies) {
      const set = map.get(dep.cardId) ?? new Set<string>();
      set.add(dep.dependsOnCardId);
      map.set(dep.cardId, set);
    }
    return map;
  }, [allDependencies]);

  const candidates = useMemo(() => {
    if (!card) return [];
    return allCards
      .filter((c) => c.id !== card.id)
      .map((c) => ({
        card: c,
        // Fast-path: would picking c create an immediate cycle (c
        // already depends on `card`)? Server still validates with
        // full DFS, but this catches the most common 1-hop case.
        wouldImmediateCycle:
          depsByCardId.get(c.id)?.has(card.id) ?? false,
      }))
      .sort((a, b) => a.card.position - b.card.position);
  }, [allCards, card, depsByCardId]);

  function toggle(cardId: string) {
    setDraft((prev) => {
      const next = new Map(prev);
      if (next.has(cardId)) {
        next.delete(cardId);
      } else {
        next.set(cardId, { cardId, optional: false });
      }
      return next;
    });
  }

  function setOptional(cardId: string, optional: boolean) {
    setDraft((prev) => {
      const cur = prev.get(cardId);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(cardId, { ...cur, optional });
      return next;
    });
  }

  async function handleSave() {
    if (!card) return;
    setError(null);
    setSaving(true);
    try {
      await replaceDependencies(lobbyId, card.id, {
        // Sprint 7B.1 (R1-H2): pass card lockVersion so concurrent dep
        // edits 409 instead of silently clobbering. Server bumps the
        // version on success; a stale tab's next save sees VERSION_CONFLICT.
        expectedVersion: card.lockVersion,
        dependencies: Array.from(draft.values()).map((d) => ({
          dependsOnCardId: d.cardId,
          optional: d.optional,
        })),
      });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof LobbyApiError) {
        if (err.reason === "VERSION_CONFLICT") {
          // Sprint 7B.1 (R1-H2): the dialog stays open so the captain's
          // typed-but-unsaved selections aren't lost — calling onSaved
          // refetches; the reseed effect's [open, card.id, lockVersion]
          // deps will fire on the new lockVersion and rebuild the seed
          // from canonical state. Captain re-applies and re-saves.
          setError(
            "Card changed since you opened the editor — refreshing. Re-apply your edit and save again.",
          );
          onSaved();
        } else if (err.reason === "INVARIANT_VIOLATION") {
          // Sprint 7B.1 (R5-M7): the server's cycle path uses card UUIDs
          // (e.g., `Plan has a dependency cycle: 7e3a... -> b21f... ->
          // 7e3a...`). Substitute card titles so the captain can recognize
          // which cards form the loop without consulting the DAG overlay.
          setError(
            humanizeCycleMessage(err.message, allCards) ||
              "These dependencies would create a cycle in the plan.",
          );
        } else if (err.reason === "INVALID_TRANSITION") {
          setError(
            err.message ||
              "Dependencies can't be edited in the current lobby phase.",
          );
        } else {
          setError(err.message);
        }
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to save dependencies.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">
            Dependencies for{" "}
            <span className="text-terminal-green">{card?.title ?? "card"}</span>
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Pick the cards that must finish before this one runs. Mark a
            dependency optional to let the orchestrator skip it when the
            upstream fails.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 -mx-6 px-6">
          {candidates.length === 0 ? (
            <p className="font-mono text-xs text-terminal-muted py-6 text-center">
              No other cards in this lobby yet — add cards first to wire
              up dependencies.
            </p>
          ) : (
            <ul className="space-y-1.5 py-1">
              {candidates.map(({ card: candidate, wouldImmediateCycle }) => {
                const picked = draft.get(candidate.id);
                const isPicked = !!picked;
                const disabled = wouldImmediateCycle && !isPicked;
                return (
                  <li
                    key={candidate.id}
                    className={cn(
                      "rounded-md border px-3 py-2 transition-colors",
                      isPicked
                        ? "border-terminal-green bg-terminal-green/10"
                        : "border-terminal-border/60",
                      disabled && "opacity-60",
                    )}
                  >
                    <label className="flex items-start gap-2 cursor-pointer">
                      <Checkbox
                        checked={isPicked}
                        disabled={disabled || saving}
                        onCheckedChange={() => toggle(candidate.id)}
                        aria-label={`Depend on ${candidate.title}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-sm font-semibold text-terminal-dark truncate">
                          {candidate.title}
                        </p>
                        <p className="font-mono text-[10px] text-terminal-muted">
                          {candidate.column} · {candidate.status}
                        </p>
                        {wouldImmediateCycle && (
                          <p className="font-mono text-[10px] text-amber-700 dark:text-amber-300 mt-0.5 inline-flex items-center gap-1">
                            <AlertCircle
                              className="h-2.5 w-2.5"
                              aria-hidden="true"
                            />
                            Already depends on this card — would cycle.
                          </p>
                        )}
                      </div>
                      {isPicked && (
                        <label className="inline-flex items-center gap-1.5 cursor-pointer shrink-0">
                          <Checkbox
                            checked={picked.optional}
                            disabled={saving}
                            onCheckedChange={(v) =>
                              setOptional(candidate.id, !!v)
                            }
                            aria-label={`Mark ${candidate.title} optional`}
                          />
                          <span className="font-mono text-[10px] text-terminal-muted">
                            optional
                          </span>
                        </label>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>

        {error && (
          <p
            id={errorId}
            role="alert"
            className="font-mono text-[11px] text-red-700 dark:text-red-300 inline-flex items-start gap-2"
          >
            <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="font-mono"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !card}
            // Sprint 7B.1 (R5-L5): aria-busy parity with AcceptPlanButton +
            // TransitionToPlanningButton — assistive tech announces the
            // pending state without relying on the spinner glyph alone.
            // aria-describedby links the button to the latest error so the
            // SR user hears the failure context after a save attempt.
            aria-busy={saving}
            aria-describedby={error ? errorId : undefined}
            className="font-mono"
          >
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" aria-hidden="true" />
                Saving…
              </>
            ) : (
              "Save dependencies"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Sprint 7B.1 (R5-M7): the server's cycle message lives in
 * `services.ts:findDependencyCycle` and looks like
 * `Plan has a dependency cycle: <uuid> -> <uuid> -> <uuid>`. Rewrite
 * each UUID to the corresponding card title so the captain sees
 * "Plan has a dependency cycle: Frontend → Backend → Frontend" instead
 * of three uuids. Falls back to the original message when no UUIDs match
 * (so a service-side message change doesn't silently strip information).
 */
function humanizeCycleMessage(
  message: string | undefined,
  cards: ReadonlyArray<{ id: string; title: string }>,
): string {
  if (!message) return "";
  const titleById = new Map(cards.map((c) => [c.id, c.title]));
  // UUID v4 shape — the server uses crypto.randomUUID() everywhere so this
  // matches every plausible card id.
  const uuidPattern =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  let touched = false;
  const rewritten = message.replace(uuidPattern, (uuid) => {
    const title = titleById.get(uuid);
    if (!title) return uuid;
    touched = true;
    // Quote so multi-word titles read cleanly inside the cycle path.
    return `"${title}"`;
  });
  return touched ? rewritten : message;
}

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

import { useEffect, useMemo, useState } from "react";
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

  // Reseed every time the dialog is (re-)opened with a different card.
  useEffect(() => {
    if (!open || !card) return;
    const existing = new Map<string, DraftDep>();
    for (const dep of allDependencies) {
      if (dep.cardId !== card.id) continue;
      existing.set(dep.dependsOnCardId, {
        cardId: dep.dependsOnCardId,
        optional: dep.optional,
      });
    }
    setDraft(existing);
    setError(null);
  }, [open, card, allDependencies]);

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
        dependencies: Array.from(draft.values()).map((d) => ({
          dependsOnCardId: d.cardId,
          optional: d.optional,
        })),
      });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof LobbyApiError) {
        if (err.reason === "INVARIANT_VIOLATION") {
          setError(
            err.message ||
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
            role="alert"
            className="font-mono text-[11px] text-amber-700 dark:text-amber-300 inline-flex items-start gap-2"
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
            className="font-mono"
          >
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
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

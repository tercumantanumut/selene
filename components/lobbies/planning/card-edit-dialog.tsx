"use client";

/**
 * CardEditDialog — modal for create / edit of a lobby card.
 *
 * Sprint 7A scope:
 *   - title (required, ≤ 200 chars)
 *   - description (optional, ≤ 8000 chars)
 *   - acceptance criteria (list of `{ id, text, required? }` rows)
 *   - assigned seat (single-select dropdown, scoped to this lobby's seats)
 *   - maxAttempts (1..10, defaults to lobby config or 3)
 *
 * Out of scope here (lands in Sprint 7B):
 *   - dependency editor (requires DAG context to prevent cycles in-form)
 *
 * The dialog is mode-aware: pass `card={null}` for create, an existing
 * `LobbyCard` for edit. The two modes share the same body — only the title
 * and the mutation function differ.
 *
 * Why not a separate route + page: the planner-output flow is "see all draft
 * cards in a list, click to edit." A modal keeps the list visible underneath
 * (helps the captain compare cards while editing), and the Sprint 5
 * lobby-page shell already owns the route.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

import {
  LobbyApiError,
  createCard,
  updateCard,
} from "@/lib/lobbies/client/api";
import type { LobbyCard, LobbySeat } from "@/lib/db/sqlite-lobbies-schema";
import type { LobbyCardAcceptanceCriterionV1 } from "@/lib/lobbies/types";

export type CardEditDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lobbyId: string;
  /** `null` → create mode, `LobbyCard` → edit mode. */
  card: LobbyCard | null;
  seats: LobbySeat[];
  /** Default `maxAttempts` for newly-created cards. */
  defaultMaxAttempts: number;
  onSaved: () => void;
};

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 8000;
const AC_TEXT_MAX = 400;

type DraftCriterion = {
  /** Local-only id used as React key; persisted as `id` on save. */
  localId: string;
  text: string;
  required: boolean;
};

function buildLocalId(): string {
  // Cheap unique id good enough for a single dialog instance. Persisted ids
  // come from the existing card row when in edit mode.
  return `ac-${Math.random().toString(36).slice(2, 10)}`;
}

function fromAcceptance(
  ac: LobbyCardAcceptanceCriterionV1[] | null | undefined,
): DraftCriterion[] {
  if (!ac || ac.length === 0) return [];
  return ac.map((c) => ({
    localId: c.id || buildLocalId(),
    text: c.text,
    required: c.required ?? true,
  }));
}

function toAcceptance(
  drafts: DraftCriterion[],
): LobbyCardAcceptanceCriterionV1[] {
  return drafts
    .map((d) => ({
      id: d.localId,
      text: d.text.trim(),
      required: d.required,
    }))
    .filter((c) => c.text.length > 0);
}

export function CardEditDialog({
  open,
  onOpenChange,
  lobbyId,
  card,
  seats,
  defaultMaxAttempts,
  onSaved,
}: CardEditDialogProps) {
  const isEdit = card !== null;

  const [title, setTitle] = useState(card?.title ?? "");
  const [description, setDescription] = useState(card?.description ?? "");
  const [criteria, setCriteria] = useState<DraftCriterion[]>(() =>
    fromAcceptance(card?.acceptanceCriteria),
  );
  const [assignedSeatId, setAssignedSeatId] = useState<string | null>(
    card?.assignedSeatId ?? null,
  );
  const [maxAttempts, setMaxAttempts] = useState<number>(
    card?.maxAttempts ?? defaultMaxAttempts,
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when the dialog opens for a different card (or switches
  // between create and edit modes). Without this, switching cards mid-mount
  // carries stale text / criteria forward.
  useEffect(() => {
    if (!open) return;
    setTitle(card?.title ?? "");
    setDescription(card?.description ?? "");
    setCriteria(fromAcceptance(card?.acceptanceCriteria));
    setAssignedSeatId(card?.assignedSeatId ?? null);
    setMaxAttempts(card?.maxAttempts ?? defaultMaxAttempts);
    setError(null);
  }, [open, card, defaultMaxAttempts]);

  const seatOptions = useMemo(
    () =>
      [...seats].sort((a, b) => a.position - b.position).map((s) => ({
        id: s.id,
        label: `${s.role}${s.agentId ? "" : " (no agent)"}`,
        position: s.position,
      })),
    [seats],
  );

  function addCriterion() {
    setCriteria((prev) => [
      ...prev,
      { localId: buildLocalId(), text: "", required: true },
    ]);
  }

  function updateCriterion(localId: string, patch: Partial<DraftCriterion>) {
    setCriteria((prev) =>
      prev.map((c) => (c.localId === localId ? { ...c, ...patch } : c)),
    );
  }

  function removeCriterion(localId: string) {
    setCriteria((prev) => prev.filter((c) => c.localId !== localId));
  }

  async function handleSave() {
    setError(null);
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Title is required.");
      return;
    }
    const cleanedAc = toAcceptance(criteria);

    setSaving(true);
    try {
      if (isEdit && card) {
        await updateCard(lobbyId, card.id, {
          expectedVersion: card.lockVersion,
          patch: {
            title: trimmedTitle,
            description: description.trim(),
            acceptanceCriteria: cleanedAc,
            assignedSeatId,
            maxAttempts,
          },
        });
      } else {
        await createCard(lobbyId, {
          title: trimmedTitle,
          description: description.trim(),
          acceptanceCriteria: cleanedAc,
          assignedSeatId,
          maxAttempts,
        });
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof LobbyApiError) {
        if (err.reason === "VERSION_CONFLICT") {
          setError(
            "This card was updated since you opened the editor — refreshing latest. Re-apply your edit.",
          );
          // Surface the conflict but also nudge the parent to refetch so
          // the user sees the new version in the list view.
          onSaved();
        } else if (err.reason === "INVALID_TRANSITION") {
          setError(
            err.message ||
              "Card cannot be edited in the current lobby phase.",
          );
        } else {
          setError(err.message);
        }
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to save card.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">
            {isEdit ? "Edit card" : "New card"}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {isEdit
              ? "Update the card. Saved changes are immediately visible to the lobby."
              : "Drafts a new card in the planning phase. The captain can edit until accept_plan fires."}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="space-y-4">
            {/* Title */}
            <div className="space-y-1">
              <label
                htmlFor="card-title"
                className="font-mono text-[11px] uppercase tracking-wide text-terminal-muted"
              >
                Title
              </label>
              <Input
                id="card-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={TITLE_MAX}
                disabled={saving}
                className="font-mono text-sm"
                placeholder="Short, action-oriented title"
              />
            </div>

            {/* Description */}
            <div className="space-y-1">
              <label
                htmlFor="card-description"
                className="font-mono text-[11px] uppercase tracking-wide text-terminal-muted"
              >
                Description
              </label>
              <Textarea
                id="card-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={DESCRIPTION_MAX}
                disabled={saving}
                rows={5}
                className="font-mono text-sm"
                placeholder="What needs to happen, in plain English."
              />
              <p className="font-mono text-[10px] text-terminal-muted text-right">
                {description.length} / {DESCRIPTION_MAX}
              </p>
            </div>

            {/* Acceptance criteria */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="font-mono text-[11px] uppercase tracking-wide text-terminal-muted">
                  Acceptance criteria
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={addCriterion}
                  disabled={saving}
                  className="h-6 px-2 font-mono text-[11px]"
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Add
                </Button>
              </div>
              {criteria.length === 0 ? (
                <p className="font-mono text-[11px] text-terminal-muted italic">
                  No criteria yet — add at least one if the card has a clear
                  done state.
                </p>
              ) : (
                <ul className="space-y-2">
                  {criteria.map((c) => (
                    <li
                      key={c.localId}
                      className="flex items-start gap-2 rounded-md border border-terminal-border/60 bg-terminal-cream/30 p-2"
                    >
                      <Checkbox
                        checked={c.required}
                        onCheckedChange={(checked) =>
                          updateCriterion(c.localId, {
                            required: checked === true,
                          })
                        }
                        disabled={saving}
                        aria-label="Required criterion"
                        className="mt-1"
                      />
                      <Input
                        value={c.text}
                        onChange={(e) =>
                          updateCriterion(c.localId, {
                            text: e.target.value,
                          })
                        }
                        maxLength={AC_TEXT_MAX}
                        disabled={saving}
                        className="font-mono text-xs flex-1"
                        placeholder="What must be true to accept this card"
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => removeCriterion(c.localId)}
                        disabled={saving}
                        aria-label="Remove criterion"
                        className="h-7 w-7 text-terminal-muted hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Assigned seat */}
            <div className="space-y-1">
              <label
                htmlFor="card-seat"
                className="font-mono text-[11px] uppercase tracking-wide text-terminal-muted"
              >
                Assigned seat
              </label>
              <select
                id="card-seat"
                value={assignedSeatId ?? ""}
                onChange={(e) =>
                  setAssignedSeatId(e.target.value || null)
                }
                disabled={saving || seatOptions.length === 0}
                className={cn(
                  "w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                <option value="">— Unassigned —</option>
                {seatOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {`${s.position + 1}. ${s.label}`}
                  </option>
                ))}
              </select>
              {seatOptions.length === 0 && (
                <p className="font-mono text-[11px] text-terminal-muted">
                  No seats yet — add seats in the roster phase first.
                </p>
              )}
            </div>

            {/* Max attempts */}
            <div className="space-y-1">
              <label
                htmlFor="card-attempts"
                className="font-mono text-[11px] uppercase tracking-wide text-terminal-muted"
              >
                Max attempts
              </label>
              <Input
                id="card-attempts"
                type="number"
                min={1}
                max={10}
                value={maxAttempts}
                onChange={(e) => {
                  const next = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(next)) setMaxAttempts(next);
                }}
                disabled={saving}
                className="font-mono text-sm w-24"
              />
              <p className="font-mono text-[10px] text-terminal-muted">
                The orchestrator gives up after this many failures.
              </p>
            </div>
          </div>
        </ScrollArea>

        {error && (
          <p
            role="alert"
            className="font-mono text-[11px] text-destructive"
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
            onClick={() => void handleSave()}
            disabled={saving}
            className="font-mono text-xs"
          >
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                Saving…
              </>
            ) : isEdit ? (
              "Save changes"
            ) : (
              "Create card"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

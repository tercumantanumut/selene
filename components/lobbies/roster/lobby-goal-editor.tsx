"use client";

/**
 * LobbyGoalEditor — inline editable title + goal for the roster phase.
 *
 * Click-to-edit pattern: read-only label by default, switches to inputs on
 * click. Commits to `PATCH /api/lobbies/:id` with `expectedVersion`. On
 * VERSION_CONFLICT (409) the surface refreshes and surfaces a hint so the
 * captain knows their edit was rebased onto the server's newer state.
 *
 * Stays inert (read-only) when `isEditable` is false — the lobby has moved
 * past the roster phase, so the goal is locked.
 *
 * Why two fields here instead of two components: title and goal are siblings
 * in the same PATCH body and almost always edited together (the goal expands
 * on the title). Combining them avoids two `expectedVersion` round-trips and
 * matches the SPEC §6 update shape.
 */

import { useEffect, useState } from "react";
import { Edit3, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { LobbyApiError, updateLobby } from "@/lib/lobbies/client/api";
import type { Lobby } from "@/lib/db/sqlite-lobbies-schema";

export type LobbyGoalEditorProps = {
  lobby: Lobby;
  isEditable: boolean;
  /** Refetch trigger so the parent reloads detail after a successful patch. */
  onSaved: () => void;
};

const TITLE_MAX = 200;
const GOAL_MAX = 4000;

export function LobbyGoalEditor({
  lobby,
  isEditable,
  onSaved,
}: LobbyGoalEditorProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(lobby.title);
  const [goal, setGoal] = useState(lobby.goal);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync the buffer when the canonical lobby row changes underneath us
  // (refetch / SSE / external edit). Only when not actively editing — we
  // don't want to clobber the captain's typing mid-edit.
  useEffect(() => {
    if (!editing) {
      setTitle(lobby.title);
      setGoal(lobby.goal);
    }
  }, [lobby.title, lobby.goal, editing]);

  async function commit() {
    setError(null);
    const trimmedTitle = title.trim();
    const trimmedGoal = goal.trim();

    if (!trimmedTitle) {
      setError("Title cannot be empty.");
      return;
    }
    if (!trimmedGoal) {
      setError("Goal cannot be empty.");
      return;
    }

    // No changes — exit cleanly without a network call.
    if (trimmedTitle === lobby.title && trimmedGoal === lobby.goal) {
      setEditing(false);
      return;
    }

    setSaving(true);
    try {
      const patch: { title?: string; goal?: string } = {};
      if (trimmedTitle !== lobby.title) patch.title = trimmedTitle;
      if (trimmedGoal !== lobby.goal) patch.goal = trimmedGoal;

      await updateLobby(lobby.id, {
        expectedVersion: lobby.lockVersion,
        patch,
      });
      setEditing(false);
      onSaved();
    } catch (err) {
      if (err instanceof LobbyApiError && err.reason === "VERSION_CONFLICT") {
        setError(
          "Another change happened in this lobby — refreshing latest state. Please re-apply your edit.",
        );
        // Refresh detail so the buffer re-sync effect picks up the new
        // canonical title/goal/version on next render.
        onSaved();
      } else {
        setError(
          err instanceof Error ? err.message : "Failed to save lobby goal.",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setEditing(false);
    setTitle(lobby.title);
    setGoal(lobby.goal);
    setError(null);
  }

  if (!editing) {
    return (
      <div className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs uppercase tracking-wide text-terminal-muted">
              Goal
            </p>
            <p className="font-mono text-sm text-terminal-dark whitespace-pre-wrap">
              {lobby.goal}
            </p>
          </div>
          {isEditable && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditing(true)}
              className="font-mono text-xs h-7"
              aria-label="Edit lobby title and goal"
            >
              <Edit3 className="h-3 w-3 mr-1" aria-hidden="true" />
              Edit
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-terminal-border/60 bg-terminal-cream/40 p-3">
      <div className="space-y-1">
        <label
          htmlFor="lobby-edit-title"
          className="font-mono text-[11px] uppercase tracking-wide text-terminal-muted"
        >
          Title
        </label>
        <Input
          id="lobby-edit-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={TITLE_MAX}
          disabled={saving}
          className="font-mono text-sm"
        />
      </div>
      <div className="space-y-1">
        <label
          htmlFor="lobby-edit-goal"
          className="font-mono text-[11px] uppercase tracking-wide text-terminal-muted"
        >
          Goal
        </label>
        <Textarea
          id="lobby-edit-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          maxLength={GOAL_MAX}
          disabled={saving}
          rows={4}
          className="font-mono text-sm"
        />
        <p className="font-mono text-[10px] text-terminal-muted text-right">
          {goal.length} / {GOAL_MAX}
        </p>
      </div>

      {error && (
        // Sprint 6.1 (S6 R3 HIGH): destructive token (#ef4444) on the cream
        // editor background measures ~3.4:1 — fails AA for 11px text. Use
        // red-700 (#b91c1c) → ~5.9:1.
        <p
          role="alert"
          className={cn(
            "font-mono text-[11px]",
            "text-red-700 dark:text-red-300",
          )}
        >
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={cancel}
          disabled={saving}
          className="font-mono text-xs"
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void commit()}
          disabled={saving}
          className="font-mono text-xs"
        >
          {saving ? (
            <>
              <Loader2
                className="h-3 w-3 mr-1 animate-spin"
                aria-hidden="true"
              />
              Saving…
            </>
          ) : (
            "Save"
          )}
        </Button>
      </div>
    </div>
  );
}

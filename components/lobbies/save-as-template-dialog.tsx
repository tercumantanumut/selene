"use client";

/**
 * SaveAsTemplateDialog — capture the current lobby's seat configuration as
 * a private (per-captain) lobby template.
 *
 * Sprint 10: SPEC §6 ships routes 13/14 for templates (GET list, POST create).
 * The POST forces `visibility="private"` server-side, so this dialog never
 * needs to expose a visibility toggle — every save here lands in the
 * captain's own library.
 *
 * What gets saved (per `LobbyTemplateSeatV1` from SPEC §4):
 *   - role, position, required, permissionScope — taken from the live seat.
 *   - agentId is INTENTIONALLY DROPPED. A template is meant to be reusable
 *     across goals, and the captain may want to plug in a different agent
 *     at the next lobby. Templates store roles, not specific characters.
 *     (POST /api/lobbies materializes template seats with `agentId: null`
 *     anyway — see app/api/lobbies/route.ts:184 — so persisting the agent
 *     here would be a no-op even if we did.)
 *
 * Prompts: V1 templates require `planningPrompt` and `synthesisPrompt` (DB
 * NOT NULL). The lobby itself doesn't carry these — they live on the
 * lobby's *source* template (or are inlined at orchestration time). For a
 * captain who started from "No template", we seed sensible defaults that
 * mirror the BLANK starter so the saved template is immediately usable.
 *
 * Why a dialog and not a route? The captain is mid-flow on the lobby page;
 * pushing them to a separate "/lobbies/templates/new" page would lose
 * context. The dialog returns them to the lobby on success with a toast,
 * keeping their place in the workspace shell.
 */

import { Loader2, AlertCircle, Save, BookOpenCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  LobbyApiError,
  createLobbyTemplate,
} from "@/lib/lobbies/client/api";
import type { Lobby, LobbySeat } from "@/lib/db/sqlite-lobbies-schema";
import type { LobbyTemplateSeatV1 } from "@/lib/lobbies/types";

// Defaults shown when the captain didn't author prompts on the source
// lobby. These mirror the BLANK starter in `lib/lobbies/seed-templates.ts`
// — keep them in spirit alignment if you tweak one of them.
const DEFAULT_PLANNING_PROMPT =
  "You are the planner for a Solo Story lobby. Read the captain's goal and produce a kanban of cards that, executed in order respecting their dependencies, will fully achieve that goal. Each card must have a clear title, a one-paragraph description, and 2-5 acceptance criteria. Group related work into cards that fit a single roster seat.";

const DEFAULT_SYNTHESIS_PROMPT =
  "You are the synthesizer for a Solo Story lobby. Read every approved card's output and produce the captain's final artifact. Open with a one-paragraph summary of what was accomplished, followed by the artifact itself. End with a short 'next steps' section if any acceptance criteria were partially met.";

export type SaveAsTemplateDialogProps = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  lobby: Lobby;
  seats: LobbySeat[];
  /** Called after a successful save with the new template's name. */
  onSaved?: (templateName: string) => void;
};

export function SaveAsTemplateDialog({
  open,
  onOpenChange,
  lobby,
  seats,
  onSaved,
}: SaveAsTemplateDialogProps) {
  // Default the template name to a derivative of the lobby title so the
  // captain can tab past it. They almost always want to edit it (the
  // lobby title is goal-specific, the template name should be reusable).
  const [name, setName] = useState(`${lobby.title} (template)`);
  const [description, setDescription] = useState("");
  const [planningPrompt, setPlanningPrompt] = useState(DEFAULT_PLANNING_PROMPT);
  const [synthesisPrompt, setSynthesisPrompt] = useState(
    DEFAULT_SYNTHESIS_PROMPT,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Re-seed name/desc whenever the dialog opens so a previous save doesn't
  // leave stale text in the inputs. Prompts are sticky (the captain may
  // have just edited them and we don't want to overwrite their work).
  useEffect(() => {
    if (open) {
      setName(`${lobby.title} (template)`);
      setDescription("");
      setError(null);
      setSuccess(null);
    }
  }, [open, lobby.title]);

  // Sort seats by position to mirror the captain's roster order in the
  // resulting template. The route accepts any order but the captain reads
  // the saved template top-to-bottom.
  const orderedSeats = useMemo(
    () => [...seats].sort((a, b) => a.position - b.position),
    [seats],
  );

  // Build the LobbyTemplateSeatV1[] payload from the live seats. Drop
  // agentId (templates are character-agnostic) and re-index positions
  // densely so a template saved from a lobby with a hole in the position
  // sequence (rare, but possible) lands as 0..N-1.
  const templateSeats: LobbyTemplateSeatV1[] = useMemo(
    () =>
      orderedSeats.map((s, idx) => ({
        role: s.role,
        // V1 lobbies don't track per-seat `required` — every assigned seat
        // is implicitly required to roll. Default to `true` here so the
        // template's expectation matches V1's runtime behaviour. The
        // captain can edit individual seats inside the new lobby if they
        // need optional ones in V1.x.
        required: true,
        position: idx,
        permissionScope: s.permissionScope,
      })),
    [orderedSeats],
  );

  const canSubmit =
    name.trim().length > 0 &&
    planningPrompt.trim().length > 0 &&
    synthesisPrompt.trim().length > 0 &&
    !submitting;

  async function handleSave() {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await createLobbyTemplate({
        name: name.trim(),
        description: description.trim() || null,
        defaultSeats: templateSeats,
        planningPrompt: planningPrompt.trim(),
        synthesisPrompt: synthesisPrompt.trim(),
      });
      const savedName = result.template.name;
      setSuccess(`Template "${savedName}" saved.`);
      onSaved?.(savedName);
      // Auto-close after a short success window so the captain sees the
      // confirmation before the dialog dismisses. 1.2s is empirically the
      // sweet spot between "obvious" and "annoying".
      window.setTimeout(() => onOpenChange(false), 1_200);
    } catch (err) {
      if (err instanceof LobbyApiError) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to save template.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono flex items-center gap-2">
            <BookOpenCheck className="h-4 w-4 text-terminal-dark" />
            Save lobby as template
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Capture this lobby&apos;s {orderedSeats.length} seat
            {orderedSeats.length === 1 ? "" : "s"} as a reusable private
            template. The next time you create a lobby, this template will
            appear in the starter list.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* ── Name ── */}
          <div className="space-y-1.5">
            <Label htmlFor="template-name" className="font-mono text-sm">
              Name
            </Label>
            <Input
              id="template-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              maxLength={120}
              required
              className="font-mono"
            />
          </div>

          {/* ── Description ── */}
          <div className="space-y-1.5">
            <Label
              htmlFor="template-description"
              className="font-mono text-sm"
            >
              Description{" "}
              <span className="text-terminal-muted">(optional)</span>
            </Label>
            <Textarea
              id="template-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="When should a captain pick this template?"
              rows={2}
              maxLength={2000}
              className="font-mono text-sm"
            />
          </div>

          {/* ── Seat preview ── */}
          <div className="rounded border border-terminal-border/50 bg-terminal-cream/40 p-3">
            <p className="font-mono text-[11px] uppercase tracking-wide text-terminal-muted">
              Seats to capture ({orderedSeats.length})
            </p>
            {orderedSeats.length === 0 ? (
              <p className="mt-1 font-mono text-xs text-terminal-muted italic">
                This lobby has no seats yet — the saved template will be
                empty. Add seats to the roster first if you want a template
                with a starter crew.
              </p>
            ) : (
              <ul className="mt-1.5 space-y-0.5 font-mono text-xs text-terminal-dark">
                {orderedSeats.map((s, idx) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <span className="tabular-nums text-terminal-muted">
                      {idx + 1}.
                    </span>
                    <span className="truncate">{s.role}</span>
                    <span className="text-terminal-muted">
                      ({s.permissionScope.allowedTools.length} tool
                      {s.permissionScope.allowedTools.length === 1 ? "" : "s"})
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 font-mono text-[11px] text-terminal-muted">
              The agent assignment for each seat is intentionally not saved
              — templates capture roles, not specific characters.
            </p>
          </div>

          {/* ── Planning prompt ── */}
          <div className="space-y-1.5">
            <Label htmlFor="template-planning" className="font-mono text-sm">
              Planning prompt
            </Label>
            <Textarea
              id="template-planning"
              value={planningPrompt}
              onChange={(e) => setPlanningPrompt(e.target.value)}
              rows={4}
              required
              className="font-mono text-xs"
            />
            <p className="font-mono text-[11px] text-terminal-muted">
              Sent to the planner subagent at the start of every lobby
              created from this template.
            </p>
          </div>

          {/* ── Synthesis prompt ── */}
          <div className="space-y-1.5">
            <Label
              htmlFor="template-synthesis"
              className="font-mono text-sm"
            >
              Synthesis prompt
            </Label>
            <Textarea
              id="template-synthesis"
              value={synthesisPrompt}
              onChange={(e) => setSynthesisPrompt(e.target.value)}
              rows={4}
              required
              className="font-mono text-xs"
            />
            <p className="font-mono text-[11px] text-terminal-muted">
              Sent to the synthesizer subagent once every card is approved.
            </p>
          </div>

          {/* ── Error / Success banners ── */}
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/5 p-2"
            >
              <AlertCircle
                className="h-3.5 w-3.5 text-red-700 dark:text-red-300 mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <p className="font-mono text-xs text-red-700 dark:text-red-300 break-words">
                {error}
              </p>
            </div>
          )}
          {success && (
            <div
              role="status"
              aria-live="polite"
              className="rounded border border-terminal-green/40 bg-terminal-green/5 p-2 font-mono text-xs text-terminal-green"
            >
              {success}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="font-mono"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={!canSubmit}
            className={cn("font-mono")}
          >
            {submitting ? (
              <Loader2
                className="mr-1.5 h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            )}
            Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

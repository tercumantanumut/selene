"use client";

/**
 * ReviewActions — captain controls for cards in terminal-ish states.
 *
 * Covers the four post-run captain actions:
 *
 *   - Approve  (awaiting_review → approved)        notes optional
 *   - Reject   (awaiting_review → rejected)        notes REQUIRED (server-enforced)
 *   - Retry    (failed | rejected | cancelled → pending)
 *               with optional `overrideAttemptCap` when the card has
 *               exhausted `maxAttempts`.
 *   - Reopen   (approved → pending)
 *               with optional `cancelDependents` when downstream cards
 *               have already started.
 *
 * Cancel of a `running` card lives on the Kanban tile (Sprint 7B), not
 * here — the running surface needs a one-click action at the card level
 * for fast triage.
 *
 * SPEC §5 Card state machine governs which buttons render for which status.
 *
 * Server contract:
 *   - All transitions go through `transitionCard(lobbyId, cardId, body)`
 *     with `expectedVersion: card.lockVersion`.
 *   - 409 (`VERSION_CONFLICT`) means the captain raced an SSE update; we
 *     surface a "row was updated, refresh and retry" hint and call
 *     `onChanged()` so the parent re-fetches.
 *   - 422 (`INVALID_TRANSITION` / `INVARIANT_VIOLATION`) carries server
 *     prose; surface verbatim — the server knows the rule, we don't
 *     re-derive it client-side.
 */

import { useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Repeat,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { LobbyApiError, transitionCard } from "@/lib/lobbies/client/api";
import type { LobbyCard } from "@/lib/db/sqlite-lobbies-schema";

// ─── Types ────────────────────────────────────────────────────────────────

export type ReviewActionsProps = {
  lobbyId: string;
  card: LobbyCard;
  /** True while the lobby is in `rolling` or `review`; gates buttons. */
  isEditable: boolean;
  /** Fires after a successful mutation so the parent can refetch. */
  onChanged: () => void;
  /** Layout density. `compact` is for inline kanban use; `full` for the modal. */
  variant?: "compact" | "full";
};

const NOTES_MAX = 500;

// ─── Component ───────────────────────────────────────────────────────────

export function ReviewActions({
  lobbyId,
  card,
  isEditable,
  onChanged,
  variant = "full",
}: ReviewActionsProps) {
  // Per-action UI state. Each section is self-contained — collapsing the
  // notes textarea for approve / reject when the captain hasn't committed
  // to the action keeps the surface from looking like a long form.
  const [pendingAction, setPendingAction] = useState<
    "approve" | "reject" | "retry" | "reopen" | null
  >(null);
  const [notes, setNotes] = useState("");
  const [overrideAttemptCap, setOverrideAttemptCap] = useState(false);
  const [cancelDependents, setCancelDependents] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canApprove = isEditable && card.status === "awaiting_review";
  const canReject = isEditable && card.status === "awaiting_review";
  const canRetry =
    isEditable &&
    (card.status === "failed" ||
      card.status === "rejected" ||
      card.status === "cancelled");
  const canReopen = isEditable && card.status === "approved";

  const atAttemptCap = card.attemptCount >= card.maxAttempts;

  if (!canApprove && !canReject && !canRetry && !canReopen) {
    // No applicable action. Render nothing — the parent decides whether to
    // show fallback copy.
    return null;
  }

  function reset() {
    setPendingAction(null);
    setNotes("");
    setOverrideAttemptCap(false);
    setCancelDependents(false);
    setError(null);
  }

  async function submit(action: "approve" | "reject" | "retry" | "reopen") {
    setSubmitting(true);
    setError(null);
    try {
      const expectedVersion = card.lockVersion;
      switch (action) {
        case "approve":
          await transitionCard(lobbyId, card.id, {
            action: "approve",
            expectedVersion,
            notes: notes.trim() || undefined,
          });
          break;
        case "reject":
          // Server-side guard requires `notes` to be non-empty for reject.
          // Mirror that here (we already disable the button when empty,
          // but trust-but-verify).
          await transitionCard(lobbyId, card.id, {
            action: "reject",
            expectedVersion,
            notes: notes.trim(),
          });
          break;
        case "retry":
          await transitionCard(lobbyId, card.id, {
            action: "retry",
            expectedVersion,
            overrideAttemptCap: atAttemptCap ? overrideAttemptCap : undefined,
          });
          break;
        case "reopen":
          await transitionCard(lobbyId, card.id, {
            action: "reopen",
            expectedVersion,
            cancelDependents: cancelDependents || undefined,
          });
          break;
      }
      onChanged();
      reset();
    } catch (err) {
      if (err instanceof LobbyApiError) {
        if (err.reason === "VERSION_CONFLICT") {
          setError(
            "This card was updated since you opened the panel. Refreshing — re-apply your action.",
          );
          // Trigger a parent refetch even on conflict so the captain sees
          // the latest state. The dialog stays open so the captain doesn't
          // lose their typed notes.
          onChanged();
        } else if (
          err.reason === "INVALID_TRANSITION" ||
          err.reason === "INVARIANT_VIOLATION"
        ) {
          setError(
            err.message ||
              "The server rejected this action — the card state may have changed.",
          );
        } else {
          setError(err.message);
        }
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to submit action.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ─── UI ─────────────────────────────────────────────────────────────

  // The compact variant is a single row of icon-buttons — used inline in
  // the review section's per-card row when the modal isn't open.
  if (variant === "compact" && pendingAction === null) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {canApprove && (
          <CompactButton
            label="Approve"
            tone="success"
            icon={Check}
            onClick={() => setPendingAction("approve")}
          />
        )}
        {canReject && (
          <CompactButton
            label="Reject"
            tone="danger"
            icon={XCircle}
            onClick={() => setPendingAction("reject")}
          />
        )}
        {canRetry && (
          <CompactButton
            label="Retry"
            tone="neutral"
            icon={Repeat}
            onClick={() => setPendingAction("retry")}
          />
        )}
        {canReopen && (
          <CompactButton
            label="Reopen"
            tone="neutral"
            icon={RefreshCw}
            onClick={() => setPendingAction("reopen")}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border p-3",
        pendingAction === "approve" &&
          "border-emerald-500/40 bg-emerald-500/5",
        pendingAction === "reject" && "border-red-500/40 bg-red-500/5",
        pendingAction === "retry" && "border-sky-500/40 bg-sky-500/5",
        pendingAction === "reopen" && "border-amber-500/40 bg-amber-500/5",
        pendingAction === null && "border-terminal-border/40 bg-terminal-cream/30",
      )}
    >
      {pendingAction === null && (
        <div className="flex flex-wrap items-center gap-2">
          {canApprove && (
            <Button
              type="button"
              size="sm"
              onClick={() => setPendingAction("approve")}
              className="font-mono"
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              Approve
            </Button>
          )}
          {canReject && (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => setPendingAction("reject")}
              className="font-mono"
            >
              <XCircle className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              Reject
            </Button>
          )}
          {canRetry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setPendingAction("retry")}
              className="font-mono"
            >
              <Repeat className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              Retry
            </Button>
          )}
          {canReopen && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setPendingAction("reopen")}
              className="font-mono"
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              Reopen
            </Button>
          )}
        </div>
      )}

      {(pendingAction === "approve" || pendingAction === "reject") && (
        <ApproveRejectForm
          mode={pendingAction}
          notes={notes}
          setNotes={setNotes}
          submitting={submitting}
          onCancel={reset}
          onSubmit={() => void submit(pendingAction)}
        />
      )}

      {pendingAction === "retry" && (
        <RetryForm
          card={card}
          atAttemptCap={atAttemptCap}
          overrideAttemptCap={overrideAttemptCap}
          setOverrideAttemptCap={setOverrideAttemptCap}
          submitting={submitting}
          onCancel={reset}
          onSubmit={() => void submit("retry")}
        />
      )}

      {pendingAction === "reopen" && (
        <ReopenForm
          cancelDependents={cancelDependents}
          setCancelDependents={setCancelDependents}
          submitting={submitting}
          onCancel={reset}
          onSubmit={() => void submit("reopen")}
        />
      )}

      {error && (
        <p
          role="alert"
          className="font-mono text-[11px] text-red-700 dark:text-red-300 inline-flex items-start gap-1.5"
        >
          <AlertCircle
            className="h-3 w-3 mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

// ─── Sub-forms ───────────────────────────────────────────────────────────

function ApproveRejectForm({
  mode,
  notes,
  setNotes,
  submitting,
  onCancel,
  onSubmit,
}: {
  mode: "approve" | "reject";
  notes: string;
  setNotes: (v: string) => void;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const isReject = mode === "reject";
  const trimmed = notes.trim();
  const canSubmit = isReject ? trimmed.length > 0 : true;

  return (
    <div className="space-y-2">
      <Label
        htmlFor="review-notes"
        className="font-mono text-[11px] uppercase tracking-wide text-terminal-muted"
      >
        Notes
        {isReject && (
          <span aria-hidden="true" className="text-red-700 ml-0.5">
            *
          </span>
        )}
        {!isReject && <span className="ml-1 text-terminal-muted">(optional)</span>}
      </Label>
      <Textarea
        id="review-notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value.slice(0, NOTES_MAX))}
        rows={3}
        disabled={submitting}
        required={isReject}
        aria-required={isReject}
        placeholder={
          isReject
            ? "Why is this card being rejected? (Required.)"
            : "Optional approval note for the run record."
        }
        className="font-mono text-sm"
      />
      <p className="font-mono text-[10px] text-terminal-muted text-right">
        {notes.length}/{NOTES_MAX}
      </p>
      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={submitting}
          className="font-mono"
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant={isReject ? "destructive" : "default"}
          onClick={onSubmit}
          disabled={submitting || !canSubmit}
          aria-busy={submitting}
          className="font-mono"
        >
          {submitting ? (
            <>
              <Loader2
                className="h-3.5 w-3.5 mr-1.5 animate-spin"
                aria-hidden="true"
              />
              {isReject ? "Rejecting…" : "Approving…"}
            </>
          ) : isReject ? (
            "Confirm reject"
          ) : (
            "Confirm approve"
          )}
        </Button>
      </div>
    </div>
  );
}

function RetryForm({
  card,
  atAttemptCap,
  overrideAttemptCap,
  setOverrideAttemptCap,
  submitting,
  onCancel,
  onSubmit,
}: {
  card: LobbyCard;
  atAttemptCap: boolean;
  overrideAttemptCap: boolean;
  setOverrideAttemptCap: (v: boolean) => void;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  // Server-side guard: retry without override is rejected when attemptCount
  // >= maxAttempts. We mirror that here so the captain has to opt in
  // explicitly — surprise overrides shouldn't sneak past in the UI.
  return (
    <div className="space-y-2">
      <p className="font-mono text-[11px] text-terminal-dark">
        Retry "{card.title}"? The card will return to{" "}
        <code className="px-1 bg-terminal-cream/80 rounded">pending</code>{" "}
        and the orchestrator will pick it up when its dependencies are met.
      </p>
      <p className="font-mono text-[11px] text-terminal-muted">
        Attempts: {card.attemptCount} of {card.maxAttempts}.
      </p>
      {atAttemptCap && (
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <Checkbox
            checked={overrideAttemptCap}
            disabled={submitting}
            onCheckedChange={(v) => setOverrideAttemptCap(!!v)}
            aria-label="Override attempt cap"
          />
          <span className="font-mono text-[11px] text-terminal-dark">
            Override attempt cap (this card has used all its retries).
          </span>
        </label>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={submitting}
          className="font-mono"
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onSubmit}
          disabled={submitting || (atAttemptCap && !overrideAttemptCap)}
          aria-busy={submitting}
          className="font-mono"
        >
          {submitting ? (
            <>
              <Loader2
                className="h-3.5 w-3.5 mr-1.5 animate-spin"
                aria-hidden="true"
              />
              Queuing…
            </>
          ) : (
            "Confirm retry"
          )}
        </Button>
      </div>
    </div>
  );
}

function ReopenForm({
  cancelDependents,
  setCancelDependents,
  submitting,
  onCancel,
  onSubmit,
}: {
  cancelDependents: boolean;
  setCancelDependents: (v: boolean) => void;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-2">
      <p className="font-mono text-[11px] text-terminal-dark">
        Reopen this approved card? Its output will be marked stale and
        downstream cards that already used it may need re-running.
      </p>
      <label className="inline-flex items-center gap-2 cursor-pointer">
        <Checkbox
          checked={cancelDependents}
          disabled={submitting}
          onCheckedChange={(v) => setCancelDependents(!!v)}
          aria-label="Cancel running dependents"
        />
        <span className="font-mono text-[11px] text-terminal-dark">
          Cancel any downstream cards that are running.
        </span>
      </label>
      <p className="font-mono text-[10px] text-terminal-muted">
        Without this, the server refuses if any downstream card is running.
      </p>
      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={submitting}
          className="font-mono"
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onSubmit}
          disabled={submitting}
          aria-busy={submitting}
          className="font-mono"
        >
          {submitting ? (
            <>
              <Loader2
                className="h-3.5 w-3.5 mr-1.5 animate-spin"
                aria-hidden="true"
              />
              Reopening…
            </>
          ) : (
            "Confirm reopen"
          )}
        </Button>
      </div>
    </div>
  );
}

// ─── Compact button (used in the inline variant) ─────────────────────────

function CompactButton({
  label,
  tone,
  icon: Icon,
  onClick,
}: {
  label: string;
  tone: "success" | "danger" | "neutral";
  icon: typeof Check;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={tone === "success" ? "default" : tone === "danger" ? "destructive" : "outline"}
      onClick={onClick}
      className="h-7 px-2.5 font-mono text-[11px]"
    >
      <Icon className="h-3 w-3 mr-1" aria-hidden="true" />
      {label}
    </Button>
  );
}

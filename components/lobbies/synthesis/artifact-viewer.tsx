"use client";

/**
 * ArtifactViewer — final-output surface for a `completed` lobby.
 *
 * SPEC §3 #15 defines card output JSON, but the *lobby's* final artifact
 * (`lobbies.output_artifact_id`) is intentionally opaque in V1: the column
 * is plain `text` with no FK, no schema constraint, and no resolver
 * registered with this surface. The orchestration layer chooses what the
 * id refers to (a chat message, a saved file, an agent_runs row holding
 * the synthesizer's transcript, etc.). That decision was deferred so V1
 * could ship without picking a winner across the storage backends Selene
 * already has.
 *
 * Consequence for this component: we cannot dereference the id into rich
 * content here. We render an honest placeholder instead — the synthesis
 * run is over, the lobby is `completed`, here is the id the captain can
 * carry into a future "open artifact" surface (Sprint 10+ candidate).
 *
 * "Errors should never pass silently" applies even to missing data: when
 * `outputArtifactId` is null on a `completed` lobby we render a banner
 * (with `role="status"`) instead of an empty section. That state is a
 * data integrity bug — `completeSynthesis` requires the id — but the UI
 * shouldn't pretend it's fine.
 */

import { CheckCircle2, Copy, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
// Sprint 9.1 (R4 M5): import row shapes from `@/lib/lobbies/types` so the
// component doesn't depend on the drizzle schema module path.
import type { Lobby } from "@/lib/lobbies/types";
import { cn } from "@/lib/utils";

/**
 * Compact ISO → "YYYY-MM-DD HH:MM" formatter local to this surface.
 * The codebase has no shared `formatTimestamp` (lib/utils/timestamp only
 * exposes duration helpers), so we keep the formatting honest and local
 * rather than introducing a new util just for this one banner.
 */
function formatCompletedAt(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}`;
}

export type ArtifactViewerProps = {
  lobby: Lobby;
  className?: string;
};

export function ArtifactViewer({ lobby, className }: ArtifactViewerProps) {
  const [copied, setCopied] = useState(false);

  // Sprint 9.1 (R2 H2): the previous implementation called `setCopied(true)`
  // and then `window.setTimeout(... setCopied(false), 1500)` without
  // tracking the timer or guarding the post-await setState. Two leaks:
  //   1. If the component unmounted within 1.5s of the click, the deferred
  //      setCopied(false) fires on a dead component (React 18 swallows
  //      the warning, but the closure still holds a render reference).
  //   2. Repeated clicks stacked timers — each one would tick down
  //      independently and flip the flag back, causing a brief
  //      "Copy → Copied → Copy → Copied" flicker.
  // Track the timer id and the mount flag in refs; clear on unmount and
  // before scheduling a new tick.
  const mountedRef = useRef(true);
  const copyTimerRef = useRef<number | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  const artifactId = lobby.outputArtifactId;
  const completedAt = lobby.completedAt;

  // Defensive: a `completed` lobby without an `outputArtifactId` should be
  // unreachable (`completeSynthesis` validates it server-side) — but if
  // schema drift or a hand-edited row produces this state we want the
  // captain to see it instead of staring at a blank panel.
  if (!artifactId) {
    return (
      <Card
        role="status"
        aria-live="polite"
        className={cn(
          "p-3 flex items-start gap-3 border-amber-500/40 bg-amber-500/5",
          className,
        )}
      >
        <Sparkles
          className="h-4 w-4 text-amber-700 dark:text-amber-300 mt-0.5 shrink-0"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-semibold text-amber-700 dark:text-amber-300">
            Synthesis finished — artifact id missing.
          </p>
          <p className="font-mono text-xs text-terminal-muted mt-0.5">
            The lobby is marked `completed` but no `outputArtifactId` was
            stored. This is a server-side data integrity bug; the
            synthesizer's transcript may still be readable in the chat
            session for this lobby.
          </p>
        </div>
      </Card>
    );
  }

  async function handleCopy() {
    if (!artifactId) return;
    try {
      await navigator.clipboard.writeText(artifactId);
      if (!mountedRef.current) return;
      setCopied(true);
      // Cancel any in-flight reset timer so back-to-back clicks don't
      // trigger an early setCopied(false) for the second click.
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) setCopied(false);
        copyTimerRef.current = null;
      }, 1_500);
    } catch (err) {
      // Clipboard failures are non-fatal — log and move on. The captain
      // can still select-and-copy the visible string.
      console.error("[artifact-viewer] clipboard write failed", err);
    }
  }

  return (
    <Card
      className={cn(
        "p-4 flex flex-col gap-3 border-terminal-green/40 bg-terminal-green/5",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <CheckCircle2
          className="h-5 w-5 text-terminal-green mt-0.5 shrink-0"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-semibold text-terminal-dark">
            Synthesis complete
          </p>
          <p className="font-mono text-xs text-terminal-muted mt-0.5">
            The synthesizer produced the final artifact for this lobby.
            {completedAt && (
              <> Completed {formatCompletedAt(completedAt)}.</>
            )}
          </p>
        </div>
      </div>

      <div className="rounded border border-terminal-border/50 bg-terminal-cream/50 p-3">
        <p className="font-mono text-[11px] uppercase tracking-wide text-terminal-muted">
          Artifact id
        </p>
        <div className="mt-1 flex items-center gap-2">
          <code className="flex-1 font-mono text-xs text-terminal-dark break-all">
            {artifactId}
          </code>
          {/*
            Sprint 9.1 (R3 M1): the previous aria-label flipped from "Copy
            artifact id to clipboard" to "Copied" on success — but flipping
            an `aria-label` is a *visual* change to the AT user; some
            screen readers re-announce the entire button on every focus,
            others stay silent. Keep the aria-label stable (it's the
            persistent description of the control's purpose) and emit the
            "Copied" success through a hidden polite live region. AT users
            now hear "Copied" exactly once, when the action succeeds.
          */}
          <span className="sr-only" role="status" aria-live="polite">
            {copied ? "Copied to clipboard" : ""}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void handleCopy()}
            className="h-7 px-2 font-mono text-[11px] shrink-0"
            aria-label="Copy artifact id to clipboard"
          >
            <Copy className="h-3 w-3 mr-1" aria-hidden="true" />
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>

      {/*
        Honest scope note. The captain may expect a rich artifact preview
        ("open the document"); V1 doesn't have an artifact resolver. We
        say so plainly rather than render a button that would 404. A
        future sprint can plug in a typed resolver registry and replace
        this hint with the actual content.
      */}
      <p className="font-mono text-[11px] text-terminal-muted">
        Artifact rendering is intentionally minimal in V1. The synthesizer's
        transcript is preserved in this lobby's chat session — open it from
        the sessions list to read the full output.
      </p>
    </Card>
  );
}

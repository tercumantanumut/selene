"use client";

/**
 * Sprint 5.3 — segment-level error boundary for `/lobbies/*`.
 *
 * Catches uncaught React errors that escape the lobby pages (e.g. a render
 * crash inside `lobby-detail-client`, a hook throw, or a thrown server
 * action) and shows a contained recovery UI without trashing the root
 * layout (sidebar, theme, providers all survive).
 *
 * `reset` re-renders the segment's server component tree — softer than a
 * full reload, and the right thing for transient render errors. The catch
 * is intentionally segment-scoped: anything thrown from
 *   /lobbies, /lobbies/new, /lobbies/[id]
 * is captured here. A failure inside `requireAuth` on a server page still
 * lands here too, but the visible message stays generic — we don't echo
 * `error.message` back to the captain because thrown error strings can
 * include DB / file paths (SPEC §3 #7 — no info-leak).
 *
 * Reviewer (Sprint 5.2) flagged the absence as a HIGH-impact MEDIUM:
 * without this file, any unhandled lobby render error escalates straight
 * to `app/global-error.tsx`, which destroys the root layout (no shell,
 * no toasts, no nav). With it, the captain sees a contained banner with
 * "Try again" / "Back to lobbies" and can recover without a reload.
 *
 * No `useTranslations` — the rest of the lobby surface uses plain English
 * + `font-mono` / `text-terminal-*`. Adding next-intl here would be an
 * isolated wire-up that diverges from the surrounding pages; will fold in
 * when (if) the lobby surface gets translated wholesale.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, RefreshCw, ArrowLeft } from "lucide-react";

import { Shell } from "@/components/layout/shell";
import { Button } from "@/components/ui/button";

export default function LobbiesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  // Log the actual error message + stack to the console for the captain
  // / dev to inspect via DevTools. The visible UI stays generic.
  useEffect(() => {
    console.error("[lobbies] route-level error caught:", error);
    if (error.digest) {
      console.error("[lobbies] error digest:", error.digest);
    }
  }, [error]);

  return (
    <Shell>
      <div className="flex h-full items-center justify-center p-6">
        <div
          role="alert"
          aria-live="assertive"
          className="max-w-md rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-center"
        >
          <AlertCircle
            className="mx-auto h-8 w-8 text-red-500"
            aria-hidden="true"
          />
          <p className="mt-3 font-mono text-sm font-medium text-terminal-dark">
            Something went wrong loading this lobby page.
          </p>
          <p className="mt-2 font-mono text-xs text-terminal-muted">
            The lobby itself is unaffected — this is a UI error. Try again,
            or head back to the lobby list.
          </p>
          {error.digest && (
            <p className="mt-3 font-mono text-[11px] text-terminal-muted">
              Reference: {error.digest}
            </p>
          )}
          <div className="mt-4 flex justify-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="font-mono"
              onClick={() => router.push("/lobbies")}
            >
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Back to lobbies
            </Button>
            <Button size="sm" className="font-mono" onClick={reset}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Try again
            </Button>
          </div>
        </div>
      </div>
    </Shell>
  );
}

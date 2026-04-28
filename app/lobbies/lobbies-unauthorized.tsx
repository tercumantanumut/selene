/**
 * Server-rendered "session missing" banner used by every lobby page that
 * fails the `requireAuth` gate. Kept in its own file so all three lobby
 * routes (list / detail / new) can render the same fallback without
 * duplicating the JSX.
 *
 * This is intentionally minimal: Selene is a local-first desktop app, so
 * the only path back to a valid session is restarting the app (which
 * re-runs `initializeAuth`).
 */

import { Shell } from "@/components/layout/shell";
import { AlertCircle } from "lucide-react";

export function LobbiesUnauthorized({
  message = "Your Selene session is missing or expired.",
}: {
  message?: string;
}) {
  return (
    <Shell>
      <div className="flex h-full items-center justify-center p-6">
        <div
          role="alert"
          aria-live="polite"
          className="max-w-md rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-center"
        >
          <AlertCircle
            className="mx-auto h-8 w-8 text-red-500"
            aria-hidden="true"
          />
          <p className="mt-3 font-mono text-sm font-medium text-terminal-dark">
            Sign-in required
          </p>
          <p className="mt-1 font-mono text-xs text-terminal-muted">
            {message}
          </p>
          <p className="mt-3 font-mono text-[11px] text-terminal-muted/80">
            Restart Selene to refresh your local session.
          </p>
        </div>
      </div>
    </Shell>
  );
}

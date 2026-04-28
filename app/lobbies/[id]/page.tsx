/**
 * `/lobbies/[id]` — server-component shell with auth guard.
 *
 * See `app/lobbies/page.tsx` for the rationale: do `requireAuth` at the
 * page boundary so the client UI never has to render in an unauthenticated
 * state. The actual interactive shell lives in `lobby-detail-client.tsx`.
 *
 * Note: we do NOT pre-fetch the lobby on the server. The detail client
 * still owns the fetch (`useLobbyDetail`) so refreshes, refetches, and the
 * SSE recovery path all flow through one code path. Server-side fetch
 * would also need a per-render cookie-forwarded fetch, which adds latency
 * for a UI that already streams in.
 */

import { headers } from "next/headers";

import { requireAuth } from "@/lib/auth/local-auth";

import LobbyDetailClient from "./lobby-detail-client";
import {
  LobbiesUnauthorized,
  isUnauthorizedError,
} from "../lobbies-unauthorized";

// Static fallback title — the client effect overrides this with the real
// lobby title once the detail fetch resolves (no server-side fetch here so
// we can't `generateMetadata` cleanly without a redundant DB hit).
export const metadata = {
  title: "Lobby — Selene",
};

export default async function LobbyDetailPage() {
  try {
    const reqHeaders = await headers();
    await requireAuth({ headers: reqHeaders } as unknown as Request);
  } catch (err) {
    // See `app/lobbies/page.tsx` — narrow on auth message strings, rethrow
    // everything else so DB outages don't masquerade as "session expired".
    if (!isUnauthorizedError(err)) throw err;
    return <LobbiesUnauthorized />;
  }
  return <LobbyDetailClient />;
}

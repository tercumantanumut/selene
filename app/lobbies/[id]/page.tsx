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
import { LobbiesUnauthorized } from "../lobbies-unauthorized";

export default async function LobbyDetailPage() {
  try {
    const reqHeaders = await headers();
    await requireAuth({ headers: reqHeaders } as unknown as Request);
  } catch {
    return <LobbiesUnauthorized />;
  }
  return <LobbyDetailClient />;
}

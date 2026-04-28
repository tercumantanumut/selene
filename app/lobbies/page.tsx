/**
 * `/lobbies` — server-component shell with auth guard.
 *
 * Mirrors the pattern in `app/chat/[id]/page.tsx`: do the cookie-session
 * lookup at the page boundary so the client UI never has to render in an
 * unauthenticated state. If the session is missing or invalid, the request
 * shows a single "Unauthorized" banner — Selene runs as a local desktop
 * app and there is no /login route to redirect to (first-launch creates
 * the user via `local-auth.ts`), so a clear failure is the right UX.
 *
 * Auth-pass path: render the client component, which mounts the actual UI
 * (filter tabs, lobby rows, refetch loop).
 */

import { headers } from "next/headers";

import { requireAuth } from "@/lib/auth/local-auth";

import LobbiesListClient from "./lobbies-list-client";
import { LobbiesUnauthorized } from "./lobbies-unauthorized";

export const metadata = {
  title: "Lobbies — Selene",
};

export default async function LobbiesPage() {
  try {
    const reqHeaders = await headers();
    await requireAuth({ headers: reqHeaders } as unknown as Request);
  } catch {
    // requireAuth throws for "Unauthorized" / "Invalid session" — both render
    // the same "please restart Selene" banner since there's no /login route.
    return <LobbiesUnauthorized />;
  }
  return <LobbiesListClient />;
}

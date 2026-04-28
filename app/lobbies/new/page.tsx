/**
 * `/lobbies/new` — server-component shell with auth guard.
 *
 * Same pattern as `/lobbies` and `/lobbies/[id]`: do `requireAuth` at the
 * page boundary so the form never renders for an unauthenticated user.
 */

import { headers } from "next/headers";

import { requireAuth } from "@/lib/auth/local-auth";

import NewLobbyClient from "./new-lobby-client";
import { LobbiesUnauthorized } from "../lobbies-unauthorized";

export const metadata = {
  title: "New lobby — Selene",
};

export default async function NewLobbyPage() {
  try {
    const reqHeaders = await headers();
    await requireAuth({ headers: reqHeaders } as unknown as Request);
  } catch {
    return <LobbiesUnauthorized />;
  }
  return <NewLobbyClient />;
}

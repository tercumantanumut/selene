/**
 * Route 15 — Paginated lobby event log.
 *
 *   GET /api/lobbies/:lobbyId/events?afterSequence=N&limit=M
 *
 * Returns events ordered by monotonic sequence (allocated by
 * `appendLobbyEvent` inside the same transaction as the source mutation —
 * see SPEC §3 #9). The frontend uses this to bootstrap on lobby load and
 * to recover from a dropped SSE stream by polling `afterSequence=lastSeen`.
 *
 * SPEC §6.
 */

import { NextResponse } from "next/server";

import { listLobbyEvents } from "@/lib/lobbies/queries";
import {
  assertLobbyOwnershipAndVersion,
  errorResponse,
  isAuthResponse,
  withLobbyAuth,
} from "@/lib/lobbies/api-helpers";

type RouteParams = { params: Promise<{ lobbyId: string }> };

export async function GET(req: Request, { params }: RouteParams) {
  const ctx = await withLobbyAuth(req);
  if (isAuthResponse(ctx)) return ctx;

  try {
    const { lobbyId } = await params;

    const ownership = await assertLobbyOwnershipAndVersion({
      lobbyId,
      userId: ctx.userId,
    });
    if (!ownership.ok) return ownership.response;

    const url = new URL(req.url);
    const afterRaw = url.searchParams.get("afterSequence");
    const limitRaw = url.searchParams.get("limit");

    let afterSequence: number | undefined;
    if (afterRaw !== null) {
      const n = Number(afterRaw);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        return NextResponse.json(
          { error: "afterSequence must be a non-negative integer." },
          { status: 400 },
        );
      }
      afterSequence = n;
    }

    let limit: number | undefined;
    if (limitRaw !== null) {
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
        return NextResponse.json(
          { error: "limit must be a positive integer." },
          { status: 400 },
        );
      }
      limit = n;
    }

    const events = await listLobbyEvents({
      lobbyId,
      afterSequence,
      limit,
    });

    return NextResponse.json({ events });
  } catch (error) {
    return errorResponse(error, "Failed to list lobby events");
  }
}

/**
 * Routes 3, 4 — Single lobby detail + edit.
 *
 *   GET   /api/lobbies/:lobbyId   Full detail (lobby + seats + cards + deps).
 *   PATCH /api/lobbies/:lobbyId   Edit title/goal/config (optimistic).
 *
 * SPEC §6.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  getLobbyDetailForUser,
  updateLobby,
} from "@/lib/lobbies/queries";
import {
  errorResponse,
  expectedVersionField,
  isAuthResponse,
  lobbyConfigV1Schema,
  mapMutationResult,
  parseBody,
  withLobbyAuth,
} from "@/lib/lobbies/api-helpers";

type RouteParams = { params: Promise<{ lobbyId: string }> };

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(req: Request, { params }: RouteParams) {
  const ctx = await withLobbyAuth(req);
  if (isAuthResponse(ctx)) return ctx;

  try {
    const { lobbyId } = await params;
    const detail = await getLobbyDetailForUser(lobbyId, ctx.userId);
    if (!detail) {
      return NextResponse.json(
        { error: `Lobby ${lobbyId} not found.` },
        { status: 404 },
      );
    }
    return NextResponse.json(detail);
  } catch (error) {
    return errorResponse(error, "Failed to load lobby");
  }
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

const patchLobbyBodySchema = z.object({
  expectedVersion: expectedVersionField,
  patch: z
    .object({
      title: z.string().min(1).max(200).optional(),
      goal: z.string().min(1).optional(),
      config: lobbyConfigV1Schema.optional(),
    })
    .refine((p) => Object.keys(p).length > 0, {
      message: "patch must contain at least one field.",
    }),
});

export async function PATCH(req: Request, { params }: RouteParams) {
  const ctx = await withLobbyAuth(req);
  if (isAuthResponse(ctx)) return ctx;

  try {
    const { lobbyId } = await params;
    const parsed = await parseBody(req, patchLobbyBodySchema);
    if (!parsed.ok) return parsed.response;

    const result = await updateLobby({
      lobbyId,
      userId: ctx.userId,
      expectedVersion: parsed.data.expectedVersion,
      patch: parsed.data.patch,
    });

    return mapMutationResult(result, {
      success: (lobby) => ({ lobby }),
    });
  } catch (error) {
    return errorResponse(error, "Failed to update lobby");
  }
}

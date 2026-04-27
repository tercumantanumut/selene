/**
 * Route 7 — Single seat patch.
 *
 *   PATCH /api/lobbies/:lobbyId/seats/:seatId
 *     { expectedVersion, patch: { role?, agentId?, position?,
 *                                 permissionScope?, status? } }
 *
 * Captain edits one seat at a time (the bulk path is `PUT /seats`). Service
 * layer (`updateSeat` in queries.ts) does the version check and consistency
 * fixups (status flips when agent_id changes); the route does ownership
 * preflight via `assertSeatInLobbyForUser` because `updateSeat` doesn't
 * accept a `userId`.
 *
 * SPEC §6.
 */

import { z } from "zod";

import { updateSeat } from "@/lib/lobbies/queries";
import {
  assertSeatInLobbyForUser,
  errorResponse,
  expectedVersionField,
  isAuthResponse,
  mapMutationResult,
  parseBody,
  permissionScopeV1Schema,
  withLobbyAuth,
} from "@/lib/lobbies/api-helpers";

type RouteParams = { params: Promise<{ lobbyId: string; seatId: string }> };

const seatStatusSchema = z.enum(["empty", "ready", "busy", "idle"]);

const patchSeatBodySchema = z.object({
  expectedVersion: expectedVersionField,
  patch: z
    .object({
      role: z.string().min(1).max(80).optional(),
      agentId: z.string().min(1).nullable().optional(),
      position: z.number().int().nonnegative().optional(),
      permissionScope: permissionScopeV1Schema.optional(),
      status: seatStatusSchema.optional(),
    })
    .refine((p) => Object.keys(p).length > 0, {
      message: "patch must include at least one field.",
    }),
});

export async function PATCH(req: Request, { params }: RouteParams) {
  const ctx = await withLobbyAuth(req);
  if (isAuthResponse(ctx)) return ctx;

  try {
    const { lobbyId, seatId } = await params;

    const ownership = await assertSeatInLobbyForUser({
      lobbyId,
      seatId,
      userId: ctx.userId,
    });
    if (!ownership.ok) return ownership.response;

    const parsed = await parseBody(req, patchSeatBodySchema);
    if (!parsed.ok) return parsed.response;

    const result = await updateSeat({
      seatId,
      expectedVersion: parsed.data.expectedVersion,
      patch: parsed.data.patch,
    });

    return mapMutationResult(result, { success: (seat) => ({ seat }) });
  } catch (error) {
    return errorResponse(error, "Failed to update seat");
  }
}

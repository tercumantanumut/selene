/**
 * Route 6 — Bulk replace lobby seats.
 *
 *   PUT /api/lobbies/:lobbyId/seats
 *     { expectedLobbyVersion, seats: [...] }
 *
 * Only allowed when the lobby is in `roster` status. Cards already
 * referencing seats block the operation; reassign cards first.
 *
 * SPEC §6.
 */

import { z } from "zod";

import { replaceSeats } from "@/lib/lobbies/queries";
import {
  errorResponse,
  expectedVersionField,
  isAuthResponse,
  mapMutationResult,
  parseBody,
  permissionScopeV1Schema,
  withLobbyAuth,
} from "@/lib/lobbies/api-helpers";

type RouteParams = { params: Promise<{ lobbyId: string }> };

const seatStatusSchema = z.enum(["empty", "ready", "busy", "idle"]);

// Sprint 5.3: `.strict()` on envelope and nested seat element. Without it, a
// typo'd `permssionScope` would be silently dropped and the seat would be
// created without a permission scope. Same rationale as every other lobby
// route — Sprint 5.3 reviewer flagged this as the missed PUT/PATCH/transition
// follow-up to Sprint 5.2's POST-only `.strict()` rollout.
//
// Sprint 6.1 (S6 R1 MEDIUM): refine on `seats` to reject duplicate `position`
// values up-front. The DB layer (queries.ts `replaceSeats`) walks the input
// to compute next-position assignments and would otherwise silently overwrite
// the duplicate slot. The captain saw the seats they typed but the persisted
// roster collapsed two seats into one. Surfacing as 400 here makes the
// mistake actionable instead of silent.
const replaceSeatsBodySchema = z
  .object({
    expectedLobbyVersion: expectedVersionField,
    seats: z
      .array(
        z
          .object({
            role: z.string().min(1).max(80),
            position: z.number().int().nonnegative(),
            agentId: z.string().min(1).nullable().optional(),
            permissionScope: permissionScopeV1Schema.optional(),
            status: seatStatusSchema.optional(),
          })
          .strict(),
      )
      .refine(
        (seats) => {
          const positions = seats.map((s) => s.position);
          return new Set(positions).size === positions.length;
        },
        { message: "Seat positions must be unique within the roster." },
      ),
  })
  .strict();

export async function PUT(req: Request, { params }: RouteParams) {
  const ctx = await withLobbyAuth(req);
  if (isAuthResponse(ctx)) return ctx;

  try {
    const { lobbyId } = await params;
    const parsed = await parseBody(req, replaceSeatsBodySchema);
    if (!parsed.ok) return parsed.response;

    const result = await replaceSeats({
      lobbyId,
      userId: ctx.userId,
      expectedLobbyVersion: parsed.data.expectedLobbyVersion,
      seats: parsed.data.seats.map((s) => ({
        role: s.role,
        position: s.position,
        agentId: s.agentId ?? null,
        permissionScope: s.permissionScope,
        status: s.status,
      })),
    });

    return mapMutationResult(result);
  } catch (error) {
    return errorResponse(error, "Failed to replace seats");
  }
}

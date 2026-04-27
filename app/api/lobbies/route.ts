/**
 * Routes 1, 2 — Solo Story Mode lobby root.
 *
 *   GET  /api/lobbies     List captain's lobbies (paginated, status filter).
 *   POST /api/lobbies     Create lobby + backing chat session + default seats
 *                         (from optional template).
 *
 * SPEC §6.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  createLobby,
  createSeat,
  getLobbyTemplate,
  listLobbiesForUser,
} from "@/lib/lobbies/queries";
import {
  errorResponse,
  isAuthResponse,
  lobbyConfigV1Schema,
  parseBody,
  permissionScopeV1Schema,
  withLobbyAuth,
} from "@/lib/lobbies/api-helpers";
import { createSession } from "@/lib/db/queries-sessions";

// ---------------------------------------------------------------------------
// GET /api/lobbies
// ---------------------------------------------------------------------------

// SPEC §5: review → review for `start_synthesis` (the lobby stays in
// `review` while the synthesizer runs; `synthesis_run_id` tracks it).
// There is no separate `synthesis` lobby status — keep this enum in
// lockstep with `LobbyStatus` in lib/lobbies/types.ts.
const lobbyStatusSchema = z.enum([
  "roster",
  "planning",
  "rolling",
  "review",
  "completed",
  "aborted",
]);

export async function GET(req: NextRequest) {
  const ctx = await withLobbyAuth(req);
  if (isAuthResponse(ctx)) return ctx;

  try {
    const url = req.nextUrl;
    const statusParam = url.searchParams.get("status");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limitRaw = url.searchParams.get("limit");

    let status: z.infer<typeof lobbyStatusSchema> | undefined;
    if (statusParam !== null) {
      const parsed = lobbyStatusSchema.safeParse(statusParam);
      if (!parsed.success) {
        return NextResponse.json(
          { error: `Invalid 'status' query parameter: ${statusParam}` },
          { status: 400 },
        );
      }
      status = parsed.data;
    }

    let limit: number | undefined;
    if (limitRaw !== null) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        return NextResponse.json(
          { error: "'limit' must be an integer 1..100." },
          { status: 400 },
        );
      }
      limit = n;
    }

    const result = await listLobbiesForUser({
      userId: ctx.userId,
      status,
      cursor,
      limit,
    });

    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, "Failed to list lobbies");
  }
}

// ---------------------------------------------------------------------------
// POST /api/lobbies
// ---------------------------------------------------------------------------

const createLobbyBodySchema = z.object({
  title: z.string().min(1).max(200),
  goal: z.string().min(1),
  templateId: z.string().min(1).optional(),
  config: lobbyConfigV1Schema.optional(),
  /**
   * Optional initial seats. When `templateId` is also given, these override
   * the template's `defaultSeats`. When neither is given, the lobby starts
   * with zero seats and the captain adds them in the roster phase.
   */
  seats: z
    .array(
      z.object({
        role: z.string().min(1),
        position: z.number().int().nonnegative(),
        agentId: z.string().min(1).optional(),
        permissionScope: permissionScopeV1Schema.optional(),
      }),
    )
    .optional(),
});

export async function POST(req: Request) {
  const ctx = await withLobbyAuth(req);
  if (isAuthResponse(ctx)) return ctx;

  try {
    const parsed = await parseBody(req, createLobbyBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    // Resolve template (optional) so we can copy default seats.
    let template: Awaited<ReturnType<typeof getLobbyTemplate>> = null;
    if (body.templateId) {
      template = await getLobbyTemplate(body.templateId);
      if (!template) {
        return NextResponse.json(
          { error: `Template ${body.templateId} not found.` },
          { status: 404 },
        );
      }
      // Visibility check: private templates must belong to the captain.
      if (template.visibility === "private" && template.userId !== ctx.userId) {
        return NextResponse.json(
          { error: "Forbidden: this template is not yours." },
          { status: 403 },
        );
      }
    }

    // SPEC §3 #4: every lobby has a backing session row so chat history
    // (planner deliberations, captain freeform notes) lives in the existing
    // sessions/messages tables.
    const session = await createSession({
      userId: ctx.userId,
      title: body.title,
      status: "active",
      metadata: {},
    });

    const lobby = await createLobby({
      userId: ctx.userId,
      sessionId: session.id,
      title: body.title,
      goal: body.goal,
      templateId: body.templateId ?? null,
      config: body.config ?? { version: 1 },
    });

    // Materialize seats: explicit > template defaults > none.
    const seatsToCreate = body.seats?.length
      ? body.seats.map((s) => ({
          role: s.role,
          position: s.position,
          agentId: s.agentId ?? null,
          permissionScope: s.permissionScope,
        }))
      : (template?.defaultSeats ?? []).map((s, idx) => ({
          role: s.role,
          position: idx,
          agentId: null as string | null,
          permissionScope: s.permissionScope,
        }));

    const createdSeats = [];
    for (const s of seatsToCreate) {
      const seat = await createSeat({
        lobbyId: lobby.id,
        role: s.role,
        position: s.position,
        agentId: s.agentId,
        permissionScope: s.permissionScope,
      });
      createdSeats.push(seat);
    }

    return NextResponse.json(
      { lobby, seats: createdSeats, sessionId: session.id },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error, "Failed to create lobby");
  }
}

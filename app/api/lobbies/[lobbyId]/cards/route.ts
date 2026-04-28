/**
 * Routes 8 & 9 — List + create cards within a lobby.
 *
 *   GET  /api/lobbies/:lobbyId/cards?status=...&column=...
 *   POST /api/lobbies/:lobbyId/cards
 *     { title, description?, acceptanceCriteria?, assignedSeatId?,
 *       position?, column?, status?, maxAttempts? }
 *
 * Captain-created cards default to `created_by: "human"`. The planner agent
 * uses an internal path that sets `created_by: "planner"` (see Sprint 4
 * — orchestration).
 *
 * SPEC §6.
 */

import crypto from "node:crypto";
import { z } from "zod";

import {
  createCard,
  listCardsForLobby,
} from "@/lib/lobbies/queries";
import {
  acceptanceCriterionV1Schema,
  assertLobbyOwnershipAndVersion,
  cardColumnFilterSchema,
  cardStatusFilterSchema,
  errorResponse,
  expectedVersionField,
  isAuthResponse,
  parseBody,
  withLobbyAuth,
} from "@/lib/lobbies/api-helpers";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ lobbyId: string }> };

// ---------------------------------------------------------------------------
// GET — list cards (optional filters).
// ---------------------------------------------------------------------------

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
    const statusRaw = url.searchParams.get("status");
    const columnRaw = url.searchParams.get("column");

    const filter: { status?: ReturnType<typeof cardStatusFilterSchema.parse>;
                    column?: ReturnType<typeof cardColumnFilterSchema.parse> } =
      {};
    if (statusRaw) {
      const parsed = cardStatusFilterSchema.safeParse(statusRaw);
      if (!parsed.success) {
        return NextResponse.json(
          { error: `Invalid status filter: ${statusRaw}` },
          { status: 400 },
        );
      }
      filter.status = parsed.data;
    }
    if (columnRaw) {
      const parsed = cardColumnFilterSchema.safeParse(columnRaw);
      if (!parsed.success) {
        return NextResponse.json(
          { error: `Invalid column filter: ${columnRaw}` },
          { status: 400 },
        );
      }
      filter.column = parsed.data;
    }

    const cards = await listCardsForLobby(lobbyId, filter);
    return NextResponse.json({ cards });
  } catch (error) {
    return errorResponse(error, "Failed to list cards");
  }
}

// ---------------------------------------------------------------------------
// POST — create card.
// ---------------------------------------------------------------------------

// `.strict()` — Sprint 5.3: same rule as every other lobby route. Unknown
// keys 400 instead of being silently dropped on the way to the DB.
const createCardBodySchema = z
  .object({
    expectedVersion: expectedVersionField,
    title: z.string().min(1).max(200),
    description: z.string().max(8000).optional(),
    acceptanceCriteria: z.array(acceptanceCriterionV1Schema).optional(),
    assignedSeatId: z.string().min(1).nullable().optional(),
    position: z.number().int().nonnegative().optional(),
    column: cardColumnFilterSchema.optional(),
    status: cardStatusFilterSchema.optional(),
    maxAttempts: z.number().int().positive().max(20).optional(),
  })
  .strict();

export async function POST(req: Request, { params }: RouteParams) {
  const ctx = await withLobbyAuth(req);
  if (isAuthResponse(ctx)) return ctx;

  try {
    const { lobbyId } = await params;

    const parsed = await parseBody(req, createCardBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const ownership = await assertLobbyOwnershipAndVersion({
      lobbyId,
      userId: ctx.userId,
      expectedVersion: body.expectedVersion,
    });
    if (!ownership.ok) return ownership.response;
    if (ownership.lobby.status !== "planning") {
      return NextResponse.json(
        { error: `Cannot create cards while lobby is '${ownership.lobby.status}'. Required: 'planning'.` },
        { status: 422 },
      );
    }

    // Acceptance criteria need stable ids so the synthesizer can refer to
    // specific bullets across cards. Mint a UUID when the captain didn't
    // provide one.
    const acceptanceCriteria = (body.acceptanceCriteria ?? []).map((c) => ({
      id: c.id ?? crypto.randomUUID(),
      text: c.text,
      required: c.required,
    }));

    if (body.assignedSeatId) {
      const { getSeat } = await import("@/lib/lobbies/queries");
      const seat = await getSeat(body.assignedSeatId);
      if (!seat || seat.lobbyId !== lobbyId) {
        return NextResponse.json(
          { error: `Seat ${body.assignedSeatId} is not in lobby ${lobbyId}.`, reason: "INVARIANT_VIOLATION" },
          { status: 422 },
        );
      }
    }

    const card = await createCard({
      lobbyId,
      title: body.title,
      description: body.description,
      acceptanceCriteria,
      assignedSeatId: body.assignedSeatId ?? null,
      position: body.position,
      column: body.column,
      status: body.status,
      maxAttempts: body.maxAttempts,
      createdBy: "human",
    });

    return NextResponse.json({ card }, { status: 201 });
  } catch (error) {
    return errorResponse(error, "Failed to create card");
  }
}

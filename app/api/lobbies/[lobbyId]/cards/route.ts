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

const createCardBodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(8000).optional(),
  acceptanceCriteria: z.array(acceptanceCriterionV1Schema).optional(),
  assignedSeatId: z.string().min(1).nullable().optional(),
  position: z.number().int().nonnegative().optional(),
  column: cardColumnFilterSchema.optional(),
  status: cardStatusFilterSchema.optional(),
  maxAttempts: z.number().int().positive().max(20).optional(),
});

export async function POST(req: Request, { params }: RouteParams) {
  const ctx = await withLobbyAuth(req);
  if (isAuthResponse(ctx)) return ctx;

  try {
    const { lobbyId } = await params;

    const ownership = await assertLobbyOwnershipAndVersion({
      lobbyId,
      userId: ctx.userId,
    });
    if (!ownership.ok) return ownership.response;

    const parsed = await parseBody(req, createCardBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    // Acceptance criteria need stable ids so the synthesizer can refer to
    // specific bullets across cards. Mint a UUID when the captain didn't
    // provide one.
    const acceptanceCriteria = (body.acceptanceCriteria ?? []).map((c) => ({
      id: c.id ?? crypto.randomUUID(),
      text: c.text,
      required: c.required,
    }));

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

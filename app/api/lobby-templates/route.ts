/**
 * Routes 13 & 14 — Lobby templates.
 *
 *   GET  /api/lobby-templates           — list templates visible to user
 *                                          (own private + all public).
 *   POST /api/lobby-templates           — create a private template
 *                                          (visibility forced to "private";
 *                                          public templates are seeded
 *                                          server-side, not via API).
 *
 * SPEC §6 + §4 (template visibility rules: private requires user_id; public
 * requires user_id NULL).
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  createLobbyTemplate,
  listLobbyTemplatesForUser,
} from "@/lib/lobbies/queries";
import {
  errorResponse,
  isAuthResponse,
  lobbyConfigV1Schema,
  parseBody,
  permissionScopeV1Schema,
  withLobbyAuth,
} from "@/lib/lobbies/api-helpers";

// ---------------------------------------------------------------------------
// GET — list visible templates.
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  const ctx = await withLobbyAuth(req);
  if (isAuthResponse(ctx)) return ctx;

  try {
    const templates = await listLobbyTemplatesForUser(ctx.userId);
    return NextResponse.json({ templates });
  } catch (error) {
    return errorResponse(error, "Failed to list lobby templates");
  }
}

// ---------------------------------------------------------------------------
// POST — create a private template.
// ---------------------------------------------------------------------------

const templateSeatV1Schema = z.object({
  role: z.string().min(1).max(80),
  required: z.boolean(),
  position: z.number().int().nonnegative(),
  agentId: z.string().min(1).optional(),
  permissionScope: permissionScopeV1Schema,
});

const createTemplateBodySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  defaultSeats: z.array(templateSeatV1Schema),
  planningPrompt: z.string().min(1),
  synthesisPrompt: z.string().min(1),
  config: lobbyConfigV1Schema.partial().optional(),
});

export async function POST(req: Request) {
  const ctx = await withLobbyAuth(req);
  if (isAuthResponse(ctx)) return ctx;

  try {
    const parsed = await parseBody(req, createTemplateBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const template = await createLobbyTemplate({
      userId: ctx.userId,
      name: body.name,
      description: body.description ?? null,
      defaultSeats: body.defaultSeats,
      planningPrompt: body.planningPrompt,
      synthesisPrompt: body.synthesisPrompt,
      visibility: "private",
      config: body.config,
    });

    return NextResponse.json({ template }, { status: 201 });
  } catch (error) {
    return errorResponse(error, "Failed to create lobby template");
  }
}

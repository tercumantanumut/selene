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

// `.strict()` on every nested object — same rationale as
// `createLobbyBodySchema` in app/api/lobbies/route.ts. A typo in `agnetId`
// would otherwise be silently dropped and the template would persist with
// `agentId: undefined` on the affected seat instead of returning 400.
const templateSeatV1Schema = z
  .object({
    role: z.string().min(1).max(80),
    required: z.boolean(),
    position: z.number().int().nonnegative(),
    agentId: z.string().min(1).optional(),
    permissionScope: permissionScopeV1Schema,
  })
  .strict();

// `lobbyConfigV1Schema.partial()` preserves the `.strict()` flag in zod v3,
// but we wrap it again here to make the intent explicit at the call site —
// future zod upgrades or partial-derivative tweaks would otherwise change
// validation behavior silently.
const createTemplateBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).nullable().optional(),
    defaultSeats: z.array(templateSeatV1Schema),
    planningPrompt: z.string().min(1),
    synthesisPrompt: z.string().min(1),
    config: lobbyConfigV1Schema.partial().strict().optional(),
  })
  .strict();

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

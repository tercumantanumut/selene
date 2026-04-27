/**
 * Route 12 — Replace a card's dependency list.
 *
 *   PUT /api/lobbies/:lobbyId/cards/:cardId/dependencies
 *     { dependencies: [{ dependsOnCardId, optional? }, ...] }
 *
 * Replaces the entire dependency set for the card in one transaction.
 * Service guards (SPEC §3 #6/#13):
 *   - self-cycle rejected,
 *   - all `dependsOnCardId` must belong to the same lobby,
 *   - cycle detection lives in `replaceDependenciesForCardWithCycleCheck`
 *     (services.ts) — Sprint 1 implemented the iterative DFS there. The
 *     repository-layer `replaceDependenciesForCard` does the bulk swap.
 *
 * The route uses the cycle-checked variant from services.ts.
 *
 * SPEC §6.
 */

import { z } from "zod";

import { replaceDependenciesForCardWithCycleCheck } from "@/lib/lobbies/services";
import {
  assertCardInLobbyForUser,
  errorResponse,
  isAuthResponse,
  mapMutationResult,
  parseBody,
  withLobbyAuth,
} from "@/lib/lobbies/api-helpers";

type RouteParams = { params: Promise<{ lobbyId: string; cardId: string }> };

const replaceDependenciesBodySchema = z.object({
  dependencies: z.array(
    z.object({
      dependsOnCardId: z.string().min(1),
      optional: z.boolean().optional(),
    }),
  ),
});

export async function PUT(req: Request, { params }: RouteParams) {
  const ctx = await withLobbyAuth(req);
  if (isAuthResponse(ctx)) return ctx;

  try {
    const { lobbyId, cardId } = await params;

    const ownership = await assertCardInLobbyForUser({
      lobbyId,
      cardId,
      userId: ctx.userId,
    });
    if (!ownership.ok) return ownership.response;

    const parsed = await parseBody(req, replaceDependenciesBodySchema);
    if (!parsed.ok) return parsed.response;

    const result = await replaceDependenciesForCardWithCycleCheck({
      lobbyId,
      cardId,
      dependencies: parsed.data.dependencies,
    });

    return mapMutationResult(result, {
      success: (deps) => ({ dependencies: deps }),
    });
  } catch (error) {
    return errorResponse(error, "Failed to replace card dependencies");
  }
}

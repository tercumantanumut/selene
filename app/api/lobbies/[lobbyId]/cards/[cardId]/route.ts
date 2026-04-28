/**
 * Route 10 — Single card patch.
 *
 *   PATCH /api/lobbies/:lobbyId/cards/:cardId
 *     { expectedVersion, patch: { title?, description?,
 *                                 acceptanceCriteria?,
 *                                 assignedSeatId?, position?,
 *                                 column?, maxAttempts? } }
 *
 * Free-form structural edit. The service layer rejects edits when the card
 * is `running` (see SPEC §3 #13). Status transitions (start/cancel/approve/
 * reject/retry/reopen) go through `/cards/:cardId/transition`, NOT here.
 *
 * SPEC §6.
 */

import crypto from "node:crypto";
import { z } from "zod";

import { updateCard, type UpdateCardInput } from "@/lib/lobbies/queries";
import type { LobbyCardAcceptanceCriterionV1 } from "@/lib/lobbies/types";
import {
  acceptanceCriterionV1Schema,
  assertCardInLobbyForUser,
  cardColumnFilterSchema,
  errorResponse,
  expectedVersionField,
  isAuthResponse,
  mapMutationResult,
  parseBody,
  withLobbyAuth,
} from "@/lib/lobbies/api-helpers";

type RouteParams = { params: Promise<{ lobbyId: string; cardId: string }> };

// Sprint 5.3: `.strict()` on envelope and inner patch — same rationale as
// `patchLobbyBodySchema`. Without it, a typo'd field gets dropped and the
// `.refine()` then 400s on "zero patch keys" instead of pointing at the
// actual mistake.
const patchCardBodySchema = z
  .object({
    expectedVersion: expectedVersionField,
    patch: z
      .object({
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(8000).optional(),
        acceptanceCriteria: z.array(acceptanceCriterionV1Schema).optional(),
        assignedSeatId: z.string().min(1).nullable().optional(),
        position: z.number().int().nonnegative().optional(),
        column: cardColumnFilterSchema.optional(),
        maxAttempts: z.number().int().positive().max(20).optional(),
      })
      .strict()
      .refine((p) => Object.keys(p).length > 0, {
        message: "patch must include at least one field.",
      }),
  })
  .strict();

export async function PATCH(req: Request, { params }: RouteParams) {
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

    const parsed = await parseBody(req, patchCardBodySchema);
    if (!parsed.ok) return parsed.response;
    const { expectedVersion, patch } = parsed.data;

    // Re-shape acceptance criteria with stable ids if provided. We pull
    // `acceptanceCriteria` out of `patch` before spreading so the spread
    // doesn't carry the loose zod-inferred shape (where `id` is optional)
    // into the strictly-typed `UpdateCardInput["patch"]`.
    const { acceptanceCriteria: rawCriteria, ...rest } = patch;
    const normalizedPatch: UpdateCardInput["patch"] = { ...rest };
    if (rawCriteria) {
      normalizedPatch.acceptanceCriteria = rawCriteria.map(
        (c): LobbyCardAcceptanceCriterionV1 => ({
          id: c.id ?? crypto.randomUUID(),
          text: c.text,
          required: c.required,
        }),
      );
    }

    const result = await updateCard({
      cardId,
      expectedVersion,
      patch: normalizedPatch,
    });

    return mapMutationResult(result, { success: (card) => ({ card }) });
  } catch (error) {
    return errorResponse(error, "Failed to update card");
  }
}

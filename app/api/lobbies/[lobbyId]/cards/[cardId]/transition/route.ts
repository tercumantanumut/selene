/**
 * Route 11 — Card state transition.
 *
 *   POST /api/lobbies/:lobbyId/cards/:cardId/transition
 *     { action: "start" | "cancel" | "approve" | "reject"
 *             | "retry" | "reopen",
 *       expectedVersion: number,
 *       ...action-specific params }
 *
 * Captain-callable subset of card transitions. The internal-only transitions
 * (`applyCardRunSucceeded`, `applyCardRunFailed`) are NOT exposed here —
 * those fire from the run completion callback in Sprint 4.
 *
 * Service-layer guards (SPEC §5):
 *   - start:   pending + ready column + assigned seat + attempts left.
 *   - cancel:  any non-terminal status.
 *   - approve: awaiting_review only.
 *   - reject:  awaiting_review only; `notes` required + non-empty.
 *   - retry:   rejected | failed; honors max_attempts unless overridden.
 *   - reopen:  approved only; optionally cancels running dependents.
 */

import { z } from "zod";

import {
  transitionCardApprove,
  transitionCardCancel,
  transitionCardReject,
  transitionCardReopen,
  transitionCardRetry,
  transitionCardStart,
} from "@/lib/lobbies/services";
import {
  assertCardInLobbyForUser,
  errorResponse,
  expectedVersionField,
  isAuthResponse,
  mapMutationResult,
  parseBody,
  withLobbyAuth,
} from "@/lib/lobbies/api-helpers";

type RouteParams = { params: Promise<{ lobbyId: string; cardId: string }> };

// ---------------------------------------------------------------------------
// Body schema — discriminated union per action.
// ---------------------------------------------------------------------------

const baseFields = {
  expectedVersion: expectedVersionField,
};

// Sprint 5.3: every arm is `.strict()`. Without it a `cancelDependants` typo
// on `reopen` would be silently dropped and the captain would think they
// cancelled in-flight dependents when they didn't. Strict surfaces the typo
// as a 400 on the field name.
const transitionBodySchema = z.discriminatedUnion("action", [
  z
    .object({
      ...baseFields,
      action: z.literal("start"),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      action: z.literal("cancel"),
      reason: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      action: z.literal("approve"),
      notes: z.string().max(4000).optional(),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      action: z.literal("reject"),
      notes: z.string().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      action: z.literal("retry"),
      overrideAttemptCap: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      action: z.literal("reopen"),
      cancelDependents: z.boolean().optional(),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------

export async function POST(req: Request, { params }: RouteParams) {
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

    const parsed = await parseBody(req, transitionBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    switch (body.action) {
      case "start": {
        const result = await transitionCardStart({
          cardId,
          expectedCardVersion: body.expectedVersion,
        });
        return mapMutationResult(result);
      }
      case "cancel": {
        const result = await transitionCardCancel({
          cardId,
          expectedCardVersion: body.expectedVersion,
          reason: body.reason,
        });
        return mapMutationResult(result);
      }
      case "approve": {
        const result = await transitionCardApprove({
          cardId,
          expectedCardVersion: body.expectedVersion,
          userId: ctx.userId,
          notes: body.notes,
        });
        return mapMutationResult(result);
      }
      case "reject": {
        const result = await transitionCardReject({
          cardId,
          expectedCardVersion: body.expectedVersion,
          userId: ctx.userId,
          notes: body.notes,
        });
        return mapMutationResult(result, { success: (card) => ({ card }) });
      }
      case "retry": {
        const result = await transitionCardRetry({
          cardId,
          expectedCardVersion: body.expectedVersion,
          userId: ctx.userId,
          overrideAttemptCap: body.overrideAttemptCap,
        });
        return mapMutationResult(result);
      }
      case "reopen": {
        const result = await transitionCardReopen({
          cardId,
          expectedCardVersion: body.expectedVersion,
          userId: ctx.userId,
          cancelDependents: body.cancelDependents,
        });
        return mapMutationResult(result);
      }
    }
  } catch (error) {
    return errorResponse(error, "Failed to transition card");
  }
}

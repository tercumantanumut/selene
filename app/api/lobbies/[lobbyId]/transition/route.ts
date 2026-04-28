/**
 * Route 5 — Lobby state transition.
 *
 *   POST /api/lobbies/:lobbyId/transition
 *     { action: "ready_roster" | "accept_plan" | "enter_review"
 *             | "start_synthesis" | "complete_synthesis"
 *             | "abort",
 *       expectedVersion: number,
 *       ...action-specific params }
 *
 * The action discriminator selects which `transitionLobby...` service to
 * invoke. Service layer enforces every guard from SPEC §5.
 *
 * Note: `planner_succeeded` is NOT exposed here — it's an internal
 * orchestrator transition triggered from the planner's run completion
 * callback (see Sprint 4).
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { INTERNAL_API_SECRET } from "@/lib/config/internal-api-secret";
import { queueSoloStoryAgentRun } from "@/lib/lobbies/orchestrator";
import {
  completeSynthesis,
  transitionLobbyAbort,
  transitionLobbyAcceptPlan,
  transitionLobbyEnterReview,
  transitionLobbyReadyRoster,
  transitionLobbyStartSynthesis,
} from "@/lib/lobbies/services";
import {
  assertLobbyOwnershipAndVersion,
  errorResponse,
  expectedVersionField,
  isAuthResponse,
  mapMutationResult,
  parseBody,
  permissionScopeV1Schema,
  withLobbyAuth,
} from "@/lib/lobbies/api-helpers";

type RouteParams = { params: Promise<{ lobbyId: string }> };

// ---------------------------------------------------------------------------
// Body schemas — one per action so zod can do structural validation.
// ---------------------------------------------------------------------------

const baseFields = {
  expectedVersion: expectedVersionField,
};

// Sprint 5.3: every arm is `.strict()`. The discriminated union doesn't reject
// unknown fields by default — a typo'd `plannerScop` on `ready_roster` would
// silently drop, the planner would launch with the default scope, and the
// captain would never know their override didn't take effect. Strict surfaces
// the typo as a 400 with the field name.
const transitionBodySchema = z.discriminatedUnion("action", [
  z
    .object({
      ...baseFields,
      action: z.literal("ready_roster"),
      plannerScope: permissionScopeV1Schema.optional(),
      plannerCharacterId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      action: z.literal("accept_plan"),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      action: z.literal("enter_review"),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      action: z.literal("start_synthesis"),
      synthesizerScope: permissionScopeV1Schema.optional(),
      synthesizerCharacterId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      action: z.literal("complete_synthesis"),
      synthesisRunId: z.string().min(1),
      /**
       * SPEC §5: complete_synthesis stores the final artifact id on the
       * lobby. The orchestration layer (Sprint 4) creates the artifact and
       * passes its id here. Required.
       */
      outputArtifactId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...baseFields,
      action: z.literal("abort"),
      /**
       * SPEC §5: cancel = stop now; wait = drain then stop; abandon =
       * mark aborted and ignore late callbacks.
       */
      mode: z.enum(["cancel", "wait", "abandon"]).default("cancel"),
      reason: z.string().max(500).optional(),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { lobbyId } = await params;
    const parsed = await parseBody(req, transitionBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    if (body.action === "complete_synthesis") {
      if (req.headers.get("X-Internal-Auth") !== INTERNAL_API_SECRET) {
        return NextResponse.json(
          { error: "complete_synthesis is internal-only.", reason: "FORBIDDEN" },
          { status: 403 },
        );
      }
      const result = await completeSynthesis({
        lobbyId,
        synthesisRunId: body.synthesisRunId,
        outputArtifactId: body.outputArtifactId,
      });
      return mapMutationResult(result);
    }

    const ctx = await withLobbyAuth(req);
    if (isAuthResponse(ctx)) return ctx;

    switch (body.action) {
      case "ready_roster": {
        const result = await transitionLobbyReadyRoster({
          lobbyId,
          userId: ctx.userId,
          expectedLobbyVersion: body.expectedVersion,
          plannerScope: body.plannerScope,
          plannerCharacterId: body.plannerCharacterId,
        });
        return mapMutationResult(result);
      }
      case "accept_plan": {
        const result = await transitionLobbyAcceptPlan({
          lobbyId,
          userId: ctx.userId,
          expectedLobbyVersion: body.expectedVersion,
        });
        return mapMutationResult(result);
      }
      case "enter_review": {
        // The service layer doesn't take userId/expectedVersion (it's
        // shared with the orchestrator). Gate ownership + version here.
        const ownership = await assertLobbyOwnershipAndVersion({
          lobbyId,
          userId: ctx.userId,
          expectedVersion: body.expectedVersion,
        });
        if (!ownership.ok) return ownership.response;
        const result = await transitionLobbyEnterReview({
          lobbyId,
          actorUserId: ctx.userId,
        });
        return mapMutationResult(result);
      }
      case "start_synthesis": {
        const result = await transitionLobbyStartSynthesis({
          lobbyId,
          userId: ctx.userId,
          expectedLobbyVersion: body.expectedVersion,
          synthesizerScope: body.synthesizerScope,
          synthesizerCharacterId: body.synthesizerCharacterId,
        });
        if (result.ok) {
          void queueSoloStoryAgentRun(result.row.synthesisRun.id);
        }
        return mapMutationResult(result);
      }
      case "abort": {
        const result = await transitionLobbyAbort({
          lobbyId,
          userId: ctx.userId,
          expectedLobbyVersion: body.expectedVersion,
          mode: body.mode,
          reason: body.reason,
        });
        return mapMutationResult(result);
      }
    }
  } catch (error) {
    return errorResponse(error, "Failed to transition lobby");
  }
}

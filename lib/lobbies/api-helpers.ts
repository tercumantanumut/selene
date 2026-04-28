/**
 * Solo Story Mode — API helpers.
 *
 * Shared boilerplate for all 15 routes under app/api/lobbies/* and
 * app/api/lobby-templates/*:
 *
 *   - `withLobbyAuth(req)` resolves `requireAuth` + `getOrCreateLocalUser` so
 *     route handlers don't repeat the same 4 lines and so we have ONE place
 *     to swap in workspace-scoped auth later.
 *
 *   - `mapMutationResult(result)` translates a `MutationResult<T>` (canonical
 *     home: `lib/lobbies/types.ts`; consumed by `lib/lobbies/queries.ts`
 *     and `lib/lobbies/services.ts`) into a `NextResponse` with the right
 *     HTTP status:
 *
 *       - `ok: true`                    → 200 `{ ...row }` (or whatever the
 *                                          caller maps via the `success`
 *                                          callback).
 *       - `reason: NOT_FOUND`           → 404
 *       - `reason: VERSION_CONFLICT`    → 409 `{ error, currentVersion }`
 *       - `reason: INVALID_TRANSITION`  → 422
 *       - `reason: INVARIANT_VIOLATION` → 422
 *       - `reason: FORBIDDEN`           → 403
 *
 *     This is the SINGLE place that knows the HTTP mapping. If you add a
 *     new `MutationFailureReason`, add the case here and the API layer
 *     stays consistent.
 *
 *   - `errorResponse(error)` is the catch-block escape hatch. 401 for auth
 *     errors so the frontend can redirect to login; 500 otherwise.
 *
 *   - `parseBody(req, schema)` runs zod and returns either parsed data or
 *     a 400 NextResponse. Saves a try/catch + safeParse dance per route.
 *
 * SPEC §6: every route requires auth + uses expectedVersion for mutations.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/local-auth";
import { getOrCreateLocalUser } from "@/lib/db/queries";
import { loadSettings } from "@/lib/settings/settings-manager";

// Import the mutation envelope from the canonical types module — `queries.ts`
// re-exports them for convenience but pulling them directly from `types.ts`
// avoids dragging the drizzle bundle into the route layer's type graph and
// keeps the dependency direction one-way (route → types, never route →
// queries → types).
import type {
  MutationResult,
  MutationFailureReason,
} from "@/lib/lobbies/types";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type LobbyAuthContext = {
  /** Local user id used as `lobbies.user_id`, `lobby_seats.<>`, etc. */
  userId: string;
};

/**
 * Standard auth gate for every lobby/template route.
 *
 * Returns either an authenticated context or a NextResponse to short-circuit
 * the handler with 401.
 */
export async function withLobbyAuth(
  req: Request,
): Promise<LobbyAuthContext | NextResponse> {
  try {
    const authUserId = await requireAuth(req);
    const settings = loadSettings();
    const dbUser = await getOrCreateLocalUser(
      authUserId,
      settings.localUserEmail,
    );
    return { userId: dbUser.id };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unauthorized";
    if (message === "Unauthorized" || message === "Invalid session") {
      // Auth-shaped failure — safe to echo back. The two strings above are
      // the only ones `requireAuth` itself throws, and both are content-free.
      return NextResponse.json({ error: message }, { status: 401 });
    }
    // Anything else came from `getOrCreateLocalUser` (DB outage, drizzle
    // wrapping a sqlite error, schema mismatch, etc.). The raw `error.message`
    // from drizzle/sqlite regularly contains file paths, schema fragments,
    // and bound parameter values — never echo it to the client. Sprint 5.3
    // reviewer flagged this as a HIGH information-leak risk.
    console.error("[lobbies] auth error:", error);
    return NextResponse.json(
      { error: "Authentication system unavailable" },
      { status: 500 },
    );
  }
}

// Type guard so callers can do `if (isAuthResponse(ctx)) return ctx`.
export function isAuthResponse(
  ctx: LobbyAuthContext | NextResponse,
): ctx is NextResponse {
  return ctx instanceof NextResponse;
}

// ---------------------------------------------------------------------------
// Ownership + version preflight
// ---------------------------------------------------------------------------

/**
 * Some service-layer transitions (`transitionLobbyEnterReview`,
 * `completeSynthesis`) intentionally don't take userId/expectedVersion —
 * they're shared between captain-initiated and orchestrator-initiated
 * code paths. The route layer is responsible for the ownership +
 * concurrency check before calling those services.
 *
 * Returns either the loaded lobby or a NextResponse to short-circuit.
 *
 * Pass `expectedVersion: undefined` to skip the version check (e.g., for
 * read-only routes).
 */
export async function assertLobbyOwnershipAndVersion(args: {
  lobbyId: string;
  userId: string;
  expectedVersion?: number;
}): Promise<
  | { ok: true; lobby: import("@/lib/db/sqlite-lobbies-schema").Lobby }
  | { ok: false; response: NextResponse }
> {
  const { getLobbyForUser } = await import("@/lib/lobbies/queries");
  const lobby = await getLobbyForUser(args.lobbyId, args.userId);
  if (!lobby) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Lobby ${args.lobbyId} not found.` },
        { status: 404 },
      ),
    };
  }
  if (
    args.expectedVersion !== undefined &&
    lobby.lockVersion !== args.expectedVersion
  ) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `Lobby ${args.lobbyId} is at version ${lobby.lockVersion}, expected ${args.expectedVersion}.`,
          reason: "VERSION_CONFLICT",
          currentVersion: lobby.lockVersion,
        },
        { status: 409 },
      ),
    };
  }
  return { ok: true, lobby };
}

/**
 * Sub-resource ownership preflight for routes operating on a single seat
 * (PATCH /api/lobbies/:lobbyId/seats/:seatId). Verifies:
 *
 *   1. the seat exists,
 *   2. the seat actually belongs to `lobbyId` (URL consistency),
 *   3. the lobby is owned by `userId`.
 *
 * Returns the loaded seat on success, or a NextResponse to short-circuit
 * the handler.
 */
export async function assertSeatInLobbyForUser(args: {
  lobbyId: string;
  seatId: string;
  userId: string;
}): Promise<
  | { ok: true; seat: import("@/lib/db/sqlite-lobbies-schema").LobbySeat }
  | { ok: false; response: NextResponse }
> {
  const { getSeat, getLobbyForUser } = await import("@/lib/lobbies/queries");
  const seat = await getSeat(args.seatId);
  if (!seat || seat.lobbyId !== args.lobbyId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Seat ${args.seatId} not found in lobby ${args.lobbyId}.` },
        { status: 404 },
      ),
    };
  }
  const lobby = await getLobbyForUser(args.lobbyId, args.userId);
  if (!lobby) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Lobby ${args.lobbyId} not found.` },
        { status: 404 },
      ),
    };
  }
  return { ok: true, seat };
}

/**
 * Sub-resource ownership preflight for routes operating on a single card
 * (PATCH/POST /api/lobbies/:lobbyId/cards/:cardId/...). Same shape as
 * `assertSeatInLobbyForUser`.
 */
export async function assertCardInLobbyForUser(args: {
  lobbyId: string;
  cardId: string;
  userId: string;
}): Promise<
  | { ok: true; card: import("@/lib/db/sqlite-lobbies-schema").LobbyCard }
  | { ok: false; response: NextResponse }
> {
  const { getCard, getLobbyForUser } = await import("@/lib/lobbies/queries");
  const card = await getCard(args.cardId);
  if (!card || card.lobbyId !== args.lobbyId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Card ${args.cardId} not found in lobby ${args.lobbyId}.` },
        { status: 404 },
      ),
    };
  }
  const lobby = await getLobbyForUser(args.lobbyId, args.userId);
  if (!lobby) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Lobby ${args.lobbyId} not found.` },
        { status: 404 },
      ),
    };
  }
  return { ok: true, card };
}

// ---------------------------------------------------------------------------
// MutationResult → NextResponse
// ---------------------------------------------------------------------------

const REASON_TO_STATUS: Record<MutationFailureReason, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  VERSION_CONFLICT: 409,
  INVALID_TRANSITION: 422,
  INVARIANT_VIOLATION: 422,
};

/**
 * Convert a `MutationResult<T>` into a `NextResponse`. The default success
 * mapping is `200 { ...row }`; pass a `success` callback to override (e.g.,
 * to wrap in `{ lobby }`).
 */
export function mapMutationResult<T>(
  result: MutationResult<T>,
  options?: {
    success?: (row: T) => unknown;
    successStatus?: number;
  },
): NextResponse {
  if (result.ok) {
    const body = options?.success ? options.success(result.row) : result.row;
    return NextResponse.json(body, { status: options?.successStatus ?? 200 });
  }
  const status = REASON_TO_STATUS[result.reason] ?? 500;
  const payload: Record<string, unknown> = {
    error: result.message,
    reason: result.reason,
  };
  if (
    result.reason === "VERSION_CONFLICT" &&
    result.currentVersion !== undefined
  ) {
    payload.currentVersion = result.currentVersion;
  }
  return NextResponse.json(payload, { status });
}

// ---------------------------------------------------------------------------
// Generic error response
// ---------------------------------------------------------------------------

/**
 * Catch-block escape hatch for lobby route handlers. We log the full error
 * server-side (including the stack and any drizzle internals) but return a
 * generic message to the browser — `error.message` from drizzle / sqlite can
 * include schema details, file paths, and bound parameters that we don't
 * want leaking into the response body.
 *
 * Use `mapMutationResult` for the typed-failure path; this is the catch-all
 * for anything the service layer didn't already classify.
 */
export function errorResponse(error: unknown, fallbackMessage: string) {
  console.error(`[lobbies] ${fallbackMessage}:`, error);
  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}

// ---------------------------------------------------------------------------
// Body parser with zod
// ---------------------------------------------------------------------------

export async function parseBody<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 },
      ),
    };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

// ---------------------------------------------------------------------------
// Reusable zod fragments
// ---------------------------------------------------------------------------

export const expectedVersionField = z
  .number()
  .int()
  .nonnegative({ message: "expectedVersion must be a non-negative integer." });

export const permissionScopeV1Schema = z
  .object({
    version: z.literal(1),
    mode: z.literal("tool_list"),
    allowedTools: z.array(z.string()),
    deniedTools: z.array(z.string()).optional(),
    allowedFolderIds: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Acceptance-criterion input shape for create/patch routes. The on-disk
 * shape (`LobbyCardAcceptanceCriterionV1`) requires `id` + `text`; captains
 * POSTing through the UI shouldn't have to mint ids — routes normalize by
 * minting a UUID when `id` is missing.
 *
 * No `version` field on input. Storage rows are V1 today; future versions
 * will go through a separate input schema.
 */
export const acceptanceCriterionV1Schema = z
  .object({
    id: z.string().min(1).optional(),
    text: z.string().min(1).max(2000),
    required: z.boolean().optional(),
  })
  .strict();

/**
 * MUST stay in lockstep with `LobbyConfigV1` in lib/lobbies/types.ts.
 * `.strict()` is critical here — a typo in a config field would otherwise be
 * silently dropped and the captain would think they'd persisted a setting
 * (e.g., a planner character override) when the server just used defaults.
 */
export const lobbyConfigV1Schema = z
  .object({
    version: z.literal(1),
    maxParallel: z.number().int().positive().optional(),
    defaultMaxAttempts: z.number().int().positive().optional(),
    plannerCharacterId: z.string().optional(),
    synthesizerCharacterId: z.string().optional(),
    plannerPromptOverride: z.string().optional(),
    synthesisPromptOverride: z.string().optional(),
  })
  .strict();

export const cardStatusFilterSchema = z.enum([
  "pending",
  "running",
  "awaiting_review",
  "approved",
  "rejected",
  "failed",
  "cancelled",
]);

export const cardColumnFilterSchema = z.enum([
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
  "blocked",
]);

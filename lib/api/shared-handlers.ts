/**
 * Shared API handler utilities used across multiple route files.
 * Centralizes common boilerplate: auth+session resolution, validation error
 * responses, schedule ownership checks, and channel connection lookups.
 */

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import { getOrCreateLocalUser, getChannelConnection } from "@/lib/db/queries";
import { loadSettings } from "@/lib/settings/settings-manager";
import { validateSessionOwnership } from "@/lib/session/session-ownership";
import { db } from "@/lib/db/sqlite-client";
import { scheduledTasks } from "@/lib/db/sqlite-schedule-schema";
import { eq, and } from "drizzle-orm";
import type { ChannelConnection, Session } from "@/lib/db/sqlite-schema";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Auth route response helpers
// ---------------------------------------------------------------------------

/**
 * Standard 500 response shape used by auth routes (`success: false`).
 */
export function authRouteErrorResponse(message: string, status = 500): NextResponse {
  return NextResponse.json({ success: false, error: message }, { status });
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the authenticated DB user from a request.
 * Returns a NextResponse error if auth fails, otherwise returns the DB user.
 */
export async function resolveAuthUser(req: Request) {
  const userId = await requireAuth(req);
  const settings = loadSettings();
  const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);
  return dbUser;
}

/**
 * Standard auth error response for routes that catch Unauthorized/Invalid session errors.
 */
function authErrorResponse(error: unknown): NextResponse | null {
  if (
    error instanceof Error &&
    (error.message === "Unauthorized" || error.message === "Invalid session")
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Zod validation helper
// ---------------------------------------------------------------------------

/**
 * Returns a 400 NextResponse for a failed zod safeParse result, or null if it passed.
 */
export function validationErrorResponse(
  result: z.ZodSafeParseResult<unknown>
): NextResponse | null {
  if (!result.success) {
    return NextResponse.json(
      { error: "Invalid input", details: result.error.flatten() },
      { status: 400 }
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session auth + ownership helper
// ---------------------------------------------------------------------------

type SessionAuthResult =
  | { session: Session; dbUserId: string }
  | { errorResponse: NextResponse };

/**
 * Authenticates the request, resolves the DB user, and verifies session ownership.
 * Returns `{ session, dbUserId }` on success, or `{ errorResponse }` on failure.
 */
export async function resolveSessionAuth(
  req: Request,
  sessionId: string
): Promise<SessionAuthResult> {
  const userId = await requireAuth(req);
  const settings = loadSettings();
  const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);

  const ownershipResult = await validateSessionOwnership(sessionId, dbUser.id);
  if ("error" in ownershipResult) {
    return {
      errorResponse: NextResponse.json(
        { error: ownershipResult.error },
        { status: ownershipResult.status }
      ),
    };
  }

  return { session: ownershipResult.session, dbUserId: dbUser.id };
}

// ---------------------------------------------------------------------------
// Schedule ownership helper
// ---------------------------------------------------------------------------

type ScheduleOwnershipResult =
  | { task: typeof scheduledTasks.$inferSelect }
  | { errorResponse: NextResponse };

/**
 * Verifies that a schedule task exists and is owned by the given user.
 * Returns the task on success, or a ready-to-return NextResponse on failure.
 */
export async function resolveScheduleOwnership(
  scheduleId: string,
  dbUserId: string
): Promise<ScheduleOwnershipResult> {
  const task = await db.query.scheduledTasks.findFirst({
    where: and(
      eq(scheduledTasks.id, scheduleId),
      eq(scheduledTasks.userId, dbUserId)
    ),
  });

  if (!task) {
    return {
      errorResponse: NextResponse.json(
        { error: "Schedule not found" },
        { status: 404 }
      ),
    };
  }

  return { task };
}

// ---------------------------------------------------------------------------
// Channel connection ownership helper
// ---------------------------------------------------------------------------

type ChannelOwnershipResult =
  | { connection: ChannelConnection }
  | { errorResponse: NextResponse };

/**
 * Verifies that a channel connection exists and is owned by the given user.
 * Returns the connection on success, or a ready-to-return NextResponse on failure.
 */
export async function resolveChannelOwnership(
  connectionId: string,
  dbUserId: string
): Promise<ChannelOwnershipResult> {
  const connection = await getChannelConnection(connectionId);

  if (!connection) {
    return {
      errorResponse: NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      ),
    };
  }

  if (connection.userId !== dbUserId) {
    return {
      errorResponse: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { connection };
}

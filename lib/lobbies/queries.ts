/**
 * Solo Story Mode — repository layer.
 *
 * Pure data access for the six lobby tables. Every mutation that takes part in
 * a state machine accepts an `expectedVersion` and increments `lock_version`;
 * mismatch returns a structured `VERSION_CONFLICT` envelope so the API layer
 * can map to HTTP 409 without leaking internals.
 *
 * Reads return the drizzle row types directly (or `null`). Mutations return
 * a discriminated `MutationResult<T>` so callers never have to read a row's
 * `lock_version` and re-issue blindly.
 *
 * Event sequencing: `appendLobbyEvent` runs inside a transaction and allocates
 * the next monotonic sequence by incrementing `lobbies.event_sequence`. This
 * is the ONLY allocator — never write to `lobby_events` directly.
 *
 * No side effects beyond DB writes. Subagent kickoff, SSE broadcast, etc.
 * live in `lib/lobbies/services.ts`.
 *
 * See lib/lobbies/SPEC.md §3 (constraints) and §4 (data model).
 */

import { db } from "@/lib/db/sqlite-client";
import {
  lobbies,
  lobbyTemplates,
  lobbySeats,
  lobbyCards,
  lobbyCardDependencies,
  lobbyEvents,
  type Lobby,
  type LobbyTemplate,
  type LobbySeat,
  type LobbyCard,
  type LobbyCardDependency,
  type LobbyEvent,
} from "@/lib/db/sqlite-lobbies-schema";
import type {
  LobbyCardAcceptanceCriterionV1,
  LobbyCardColumn,
  LobbyCardCreator,
  LobbyCardOutputV1,
  LobbyCardStatus,
  LobbyConfigV1,
  LobbyEventActor,
  LobbyPermissionScopeV1,
  LobbySeatStatus,
  LobbyStatus,
  LobbyTemplateSeatV1,
  LobbyTemplateVisibility,
} from "@/lib/lobbies/types";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Mutation result envelope.
// ---------------------------------------------------------------------------

export type MutationFailureReason =
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "FORBIDDEN"
  | "INVALID_TRANSITION"
  | "INVARIANT_VIOLATION";

export type MutationResult<T> =
  | { ok: true; row: T }
  | {
      ok: false;
      reason: MutationFailureReason;
      message: string;
      currentVersion?: number;
    };

export type MutationFailure = Extract<MutationResult<unknown>, { ok: false }>;

// ---------------------------------------------------------------------------
// Lobby — reads
// ---------------------------------------------------------------------------

export async function getLobby(lobbyId: string): Promise<Lobby | null> {
  const row = await db.query.lobbies.findFirst({
    where: eq(lobbies.id, lobbyId),
  });
  return row ?? null;
}

export async function getLobbyForUser(
  lobbyId: string,
  userId: string,
): Promise<Lobby | null> {
  const row = await db.query.lobbies.findFirst({
    where: and(eq(lobbies.id, lobbyId), eq(lobbies.userId, userId)),
  });
  return row ?? null;
}

export type LobbyDetail = {
  lobby: Lobby;
  seats: LobbySeat[];
  cards: LobbyCard[];
  dependencies: LobbyCardDependency[];
};

/**
 * Single-shot detail load: lobby + seats + cards + deps. Returns null when
 * the lobby doesn't exist or the user doesn't own it.
 */
export async function getLobbyDetailForUser(
  lobbyId: string,
  userId: string,
): Promise<LobbyDetail | null> {
  const lobby = await getLobbyForUser(lobbyId, userId);
  if (!lobby) return null;

  const [seats, cards, dependencies] = await Promise.all([
    db
      .select()
      .from(lobbySeats)
      .where(eq(lobbySeats.lobbyId, lobbyId))
      .orderBy(asc(lobbySeats.position)),
    db
      .select()
      .from(lobbyCards)
      .where(eq(lobbyCards.lobbyId, lobbyId))
      .orderBy(asc(lobbyCards.position)),
    db
      .select()
      .from(lobbyCardDependencies)
      .where(eq(lobbyCardDependencies.lobbyId, lobbyId)),
  ]);

  return { lobby, seats, cards, dependencies };
}

export type ListLobbiesParams = {
  userId: string;
  status?: LobbyStatus;
  cursor?: string;
  limit?: number;
};

export type ListLobbiesResult = {
  lobbies: Lobby[];
  nextCursor: string | null;
};

export async function listLobbiesForUser(
  params: ListLobbiesParams,
): Promise<ListLobbiesResult> {
  const pageSize = Math.min(Math.max(params.limit ?? 20, 1), 100);

  const conditions = [eq(lobbies.userId, params.userId)];
  if (params.status) conditions.push(eq(lobbies.status, params.status));
  if (params.cursor) conditions.push(sql`${lobbies.updatedAt} < ${params.cursor}`);

  const rows = await db
    .select()
    .from(lobbies)
    .where(and(...conditions))
    .orderBy(desc(lobbies.updatedAt))
    .limit(pageSize + 1);

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const nextCursor = hasMore
    ? page[page.length - 1]?.updatedAt ?? null
    : null;

  return { lobbies: page, nextCursor };
}

// ---------------------------------------------------------------------------
// Lobby — writes
// ---------------------------------------------------------------------------

export type CreateLobbyInput = {
  userId: string;
  sessionId: string;
  title: string;
  goal: string;
  templateId?: string | null;
  config?: LobbyConfigV1;
};

export async function createLobby(input: CreateLobbyInput): Promise<Lobby> {
  const [row] = await db
    .insert(lobbies)
    .values({
      userId: input.userId,
      sessionId: input.sessionId,
      title: input.title,
      goal: input.goal,
      templateId: input.templateId ?? null,
      config: input.config ?? { version: 1 },
    })
    .returning();
  return row;
}

export type UpdateLobbyInput = {
  lobbyId: string;
  userId: string;
  expectedVersion: number;
  patch: {
    title?: string;
    goal?: string;
    config?: LobbyConfigV1;
  };
};

export async function updateLobby(
  input: UpdateLobbyInput,
): Promise<MutationResult<Lobby>> {
  return runOptimisticUpdate({
    lobbyId: input.lobbyId,
    userId: input.userId,
    expectedVersion: input.expectedVersion,
    apply: (tx, current) => {
      const next = {
        ...input.patch,
        lockVersion: current.lockVersion + 1,
        updatedAt: nowIso(),
      };
      const [row] = tx
        .update(lobbies)
        .set(next)
        .where(eq(lobbies.id, input.lobbyId))
        .returning()
        .all();
      return row;
    },
  });
}

/**
 * Internal helper: load the lobby for `(lobbyId, userId)`, verify the version,
 * mutate inside a transaction, return the new row. Always bumps `lock_version`
 * + `updated_at`. The caller's `apply` MUST include those bumps in its update.
 */
async function runOptimisticUpdate(params: {
  lobbyId: string;
  userId: string;
  expectedVersion: number;
  apply: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    current: Lobby,
  ) => Lobby | undefined;
}): Promise<MutationResult<Lobby>> {
  return db.transaction((tx): MutationResult<Lobby> => {
    const [current] = tx
      .select()
      .from(lobbies)
      .where(
        and(eq(lobbies.id, params.lobbyId), eq(lobbies.userId, params.userId)),
      )
      .limit(1)
      .all();

    if (!current) {
      return {
        ok: false,
        reason: "NOT_FOUND",
        message: `Lobby ${params.lobbyId} not found.`,
      };
    }

    if (current.lockVersion !== params.expectedVersion) {
      return {
        ok: false,
        reason: "VERSION_CONFLICT",
        message: `Lobby ${params.lobbyId} is at version ${current.lockVersion}, expected ${params.expectedVersion}.`,
        currentVersion: current.lockVersion,
      };
    }

    const next = params.apply(tx, current);
    if (!next) {
      // Apply rolled back via undefined return; treat as no-op.
      return { ok: true, row: current };
    }
    return { ok: true, row: next };
  });
}

/**
 * Bump only `lock_version` + `updated_at`. Used by side-channel writes that
 * still need to invalidate optimistic locks (e.g. setting planning_run_id
 * after the planner subagent starts).
 */
export async function bumpLobbyVersion(
  lobbyId: string,
  expectedVersion: number,
): Promise<MutationResult<Lobby>> {
  return db.transaction((tx): MutationResult<Lobby> => {
    const [current] = tx
      .select()
      .from(lobbies)
      .where(eq(lobbies.id, lobbyId))
      .limit(1)
      .all();
    if (!current) {
      return { ok: false, reason: "NOT_FOUND", message: `Lobby ${lobbyId} not found.` };
    }
    if (current.lockVersion !== expectedVersion) {
      return {
        ok: false,
        reason: "VERSION_CONFLICT",
        message: `Lobby ${lobbyId} is at version ${current.lockVersion}, expected ${expectedVersion}.`,
        currentVersion: current.lockVersion,
      };
    }
    const [row] = tx
      .update(lobbies)
      .set({ lockVersion: current.lockVersion + 1, updatedAt: nowIso() })
      .where(eq(lobbies.id, lobbyId))
      .returning()
      .all();
    return { ok: true, row };
  });
}

// ---------------------------------------------------------------------------
// Lobby seats
// ---------------------------------------------------------------------------

export async function getSeat(seatId: string): Promise<LobbySeat | null> {
  const row = await db.query.lobbySeats.findFirst({
    where: eq(lobbySeats.id, seatId),
  });
  return row ?? null;
}

export async function listSeatsForLobby(lobbyId: string): Promise<LobbySeat[]> {
  return db
    .select()
    .from(lobbySeats)
    .where(eq(lobbySeats.lobbyId, lobbyId))
    .orderBy(asc(lobbySeats.position));
}

export type CreateSeatInput = {
  lobbyId: string;
  role: string;
  position: number;
  agentId?: string | null;
  permissionScope?: LobbyPermissionScopeV1;
  status?: LobbySeatStatus;
};

export async function createSeat(input: CreateSeatInput): Promise<LobbySeat> {
  const [row] = await db
    .insert(lobbySeats)
    .values({
      lobbyId: input.lobbyId,
      role: input.role,
      position: input.position,
      agentId: input.agentId ?? null,
      permissionScope:
        input.permissionScope ?? {
          version: 1,
          mode: "tool_list",
          allowedTools: [],
        },
      status:
        input.status ?? (input.agentId ? "ready" : "empty"),
    })
    .returning();
  return row;
}

export type UpdateSeatInput = {
  seatId: string;
  expectedVersion: number;
  patch: {
    role?: string;
    agentId?: string | null;
    permissionScope?: LobbyPermissionScopeV1;
    position?: number;
    status?: LobbySeatStatus;
  };
};

export async function updateSeat(
  input: UpdateSeatInput,
): Promise<MutationResult<LobbySeat>> {
  return db.transaction((tx): MutationResult<LobbySeat> => {
    const [current] = tx
      .select()
      .from(lobbySeats)
      .where(eq(lobbySeats.id, input.seatId))
      .limit(1)
      .all();

    if (!current) {
      return {
        ok: false,
        reason: "NOT_FOUND",
        message: `Seat ${input.seatId} not found.`,
      };
    }
    if (current.lockVersion !== input.expectedVersion) {
      return {
        ok: false,
        reason: "VERSION_CONFLICT",
        message: `Seat ${input.seatId} is at version ${current.lockVersion}, expected ${input.expectedVersion}.`,
        currentVersion: current.lockVersion,
      };
    }

    const merged: Partial<LobbySeat> = { ...input.patch };

    // Status / agent_id consistency: an empty seat has no agent.
    if (merged.agentId !== undefined) {
      if (merged.agentId === null) {
        merged.status = "empty";
      } else if (current.status === "empty") {
        merged.status = "ready";
      }
    }

    const [row] = tx
      .update(lobbySeats)
      .set({
        ...merged,
        lockVersion: current.lockVersion + 1,
        updatedAt: nowIso(),
      })
      .where(eq(lobbySeats.id, input.seatId))
      .returning()
      .all();
    return { ok: true, row };
  });
}

/**
 * Replace ALL seats for a lobby in one transaction. Used by the bulk
 * roster-edit route. Drops cards' seat assignments via FK ON DELETE RESTRICT
 * is unsafe — so we delete only seats with no assigned cards. Callers that
 * need to wipe occupied seats must first reassign cards.
 */
export type ReplaceSeatsInput = {
  lobbyId: string;
  expectedLobbyVersion: number;
  userId: string;
  seats: Array<{
    role: string;
    position: number;
    agentId?: string | null;
    permissionScope?: LobbyPermissionScopeV1;
    status?: LobbySeatStatus;
  }>;
};

export type ReplaceSeatsResult = MutationResult<{
  lobby: Lobby;
  seats: LobbySeat[];
}>;

export async function replaceSeats(
  input: ReplaceSeatsInput,
): Promise<ReplaceSeatsResult> {
  return db.transaction((tx): ReplaceSeatsResult => {
    const [lobby] = tx
      .select()
      .from(lobbies)
      .where(
        and(eq(lobbies.id, input.lobbyId), eq(lobbies.userId, input.userId)),
      )
      .limit(1)
      .all();
    if (!lobby) {
      return {
        ok: false,
        reason: "NOT_FOUND",
        message: `Lobby ${input.lobbyId} not found.`,
      };
    }
    if (lobby.lockVersion !== input.expectedLobbyVersion) {
      return {
        ok: false,
        reason: "VERSION_CONFLICT",
        message: `Lobby ${input.lobbyId} is at version ${lobby.lockVersion}, expected ${input.expectedLobbyVersion}.`,
        currentVersion: lobby.lockVersion,
      };
    }

    if (lobby.status !== "roster") {
      return {
        ok: false,
        reason: "INVALID_TRANSITION",
        message: `Cannot replace seats while lobby is in status '${lobby.status}'. Only 'roster' allows bulk edits.`,
      };
    }

    // Reject any seat row currently referenced by a card. Callers must
    // reassign cards first.
    const referencedSeats = tx
      .select({ seatId: lobbyCards.assignedSeatId })
      .from(lobbyCards)
      .where(
        and(
          eq(lobbyCards.lobbyId, input.lobbyId),
          sql`${lobbyCards.assignedSeatId} IS NOT NULL`,
        ),
      )
      .all();

    if (referencedSeats.length > 0) {
      return {
        ok: false,
        reason: "INVARIANT_VIOLATION",
        message:
          "Cannot replace seats while any card is assigned to a seat. Unassign cards first.",
      };
    }

    tx.delete(lobbySeats).where(eq(lobbySeats.lobbyId, input.lobbyId)).run();

    const inserted: LobbySeat[] = [];
    for (const seat of input.seats) {
      const [row] = tx
        .insert(lobbySeats)
        .values({
          lobbyId: input.lobbyId,
          role: seat.role,
          position: seat.position,
          agentId: seat.agentId ?? null,
          permissionScope:
            seat.permissionScope ?? {
              version: 1,
              mode: "tool_list",
              allowedTools: [],
            },
          status: seat.status ?? (seat.agentId ? "ready" : "empty"),
        })
        .returning()
        .all();
      inserted.push(row);
    }

    const [nextLobby] = tx
      .update(lobbies)
      .set({ lockVersion: lobby.lockVersion + 1, updatedAt: nowIso() })
      .where(eq(lobbies.id, input.lobbyId))
      .returning()
      .all();

    return { ok: true, row: { lobby: nextLobby, seats: inserted } };
  });
}

export async function deleteSeat(
  seatId: string,
  expectedVersion: number,
): Promise<MutationResult<LobbySeat>> {
  return db.transaction((tx): MutationResult<LobbySeat> => {
    const [current] = tx
      .select()
      .from(lobbySeats)
      .where(eq(lobbySeats.id, seatId))
      .limit(1)
      .all();
    if (!current) {
      return { ok: false, reason: "NOT_FOUND", message: `Seat ${seatId} not found.` };
    }
    if (current.lockVersion !== expectedVersion) {
      return {
        ok: false,
        reason: "VERSION_CONFLICT",
        message: `Seat ${seatId} is at version ${current.lockVersion}, expected ${expectedVersion}.`,
        currentVersion: current.lockVersion,
      };
    }
    const [card] = tx
      .select()
      .from(lobbyCards)
      .where(eq(lobbyCards.assignedSeatId, seatId))
      .limit(1)
      .all();
    if (card) {
      return {
        ok: false,
        reason: "INVARIANT_VIOLATION",
        message: `Seat ${seatId} is referenced by card ${card.id}. Unassign first.`,
      };
    }
    tx.delete(lobbySeats).where(eq(lobbySeats.id, seatId)).run();
    return { ok: true, row: current };
  });
}

// ---------------------------------------------------------------------------
// Lobby cards
// ---------------------------------------------------------------------------

export async function getCard(cardId: string): Promise<LobbyCard | null> {
  const row = await db.query.lobbyCards.findFirst({
    where: eq(lobbyCards.id, cardId),
  });
  return row ?? null;
}

export async function listCardsForLobby(
  lobbyId: string,
  filter?: { status?: LobbyCardStatus; column?: LobbyCardColumn },
): Promise<LobbyCard[]> {
  const conditions = [eq(lobbyCards.lobbyId, lobbyId)];
  if (filter?.status) conditions.push(eq(lobbyCards.status, filter.status));
  if (filter?.column) conditions.push(eq(lobbyCards.column, filter.column));
  return db
    .select()
    .from(lobbyCards)
    .where(and(...conditions))
    .orderBy(asc(lobbyCards.column), asc(lobbyCards.position));
}

export type CreateCardInput = {
  lobbyId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: LobbyCardAcceptanceCriterionV1[];
  assignedSeatId?: string | null;
  position?: number;
  column?: LobbyCardColumn;
  status?: LobbyCardStatus;
  maxAttempts?: number;
  createdBy: LobbyCardCreator;
};

export async function createCard(input: CreateCardInput): Promise<LobbyCard> {
  const [row] = await db
    .insert(lobbyCards)
    .values({
      lobbyId: input.lobbyId,
      title: input.title,
      description: input.description ?? "",
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      assignedSeatId: input.assignedSeatId ?? null,
      position: input.position ?? 0,
      column: input.column ?? "backlog",
      status: input.status ?? "pending",
      maxAttempts: input.maxAttempts ?? 3,
      createdBy: input.createdBy,
    })
    .returning();
  return row;
}

export type UpdateCardInput = {
  cardId: string;
  expectedVersion: number;
  patch: {
    title?: string;
    description?: string;
    acceptanceCriteria?: LobbyCardAcceptanceCriterionV1[];
    assignedSeatId?: string | null;
    position?: number;
    column?: LobbyCardColumn;
    maxAttempts?: number;
  };
};

/**
 * Free-form card edit. Rejected when the card is `running` to honor the
 * "block structural edits to running cards" constraint (SPEC §3 #13).
 */
export async function updateCard(
  input: UpdateCardInput,
): Promise<MutationResult<LobbyCard>> {
  return db.transaction((tx): MutationResult<LobbyCard> => {
    const [current] = tx
      .select()
      .from(lobbyCards)
      .where(eq(lobbyCards.id, input.cardId))
      .limit(1)
      .all();
    if (!current) {
      return { ok: false, reason: "NOT_FOUND", message: `Card ${input.cardId} not found.` };
    }
    if (current.lockVersion !== input.expectedVersion) {
      return {
        ok: false,
        reason: "VERSION_CONFLICT",
        message: `Card ${input.cardId} is at version ${current.lockVersion}, expected ${input.expectedVersion}.`,
        currentVersion: current.lockVersion,
      };
    }
    if (current.status === "running") {
      return {
        ok: false,
        reason: "INVALID_TRANSITION",
        message: `Cannot edit running card ${input.cardId}. Cancel and retry instead.`,
      };
    }
    const [row] = tx
      .update(lobbyCards)
      .set({
        ...input.patch,
        lockVersion: current.lockVersion + 1,
        updatedAt: nowIso(),
      })
      .where(eq(lobbyCards.id, input.cardId))
      .returning()
      .all();
    return { ok: true, row };
  });
}

export async function deleteCard(
  cardId: string,
  expectedVersion: number,
): Promise<MutationResult<LobbyCard>> {
  return db.transaction((tx): MutationResult<LobbyCard> => {
    const [current] = tx
      .select()
      .from(lobbyCards)
      .where(eq(lobbyCards.id, cardId))
      .limit(1)
      .all();
    if (!current) {
      return { ok: false, reason: "NOT_FOUND", message: `Card ${cardId} not found.` };
    }
    if (current.lockVersion !== expectedVersion) {
      return {
        ok: false,
        reason: "VERSION_CONFLICT",
        message: `Card ${cardId} is at version ${current.lockVersion}, expected ${expectedVersion}.`,
        currentVersion: current.lockVersion,
      };
    }
    if (current.status === "running") {
      return {
        ok: false,
        reason: "INVALID_TRANSITION",
        message: `Cannot delete running card ${cardId}. Cancel first.`,
      };
    }
    // Dependencies cascade via FK ON DELETE CASCADE.
    tx.delete(lobbyCards).where(eq(lobbyCards.id, cardId)).run();
    return { ok: true, row: current };
  });
}

// ---------------------------------------------------------------------------
// Card dependencies
// ---------------------------------------------------------------------------

export async function listDependenciesForLobby(
  lobbyId: string,
): Promise<LobbyCardDependency[]> {
  return db
    .select()
    .from(lobbyCardDependencies)
    .where(eq(lobbyCardDependencies.lobbyId, lobbyId));
}

export async function listDependenciesForCard(
  cardId: string,
): Promise<LobbyCardDependency[]> {
  return db
    .select()
    .from(lobbyCardDependencies)
    .where(eq(lobbyCardDependencies.cardId, cardId));
}

export type ReplaceDependenciesInput = {
  lobbyId: string;
  cardId: string;
  dependencies: Array<{ dependsOnCardId: string; optional?: boolean }>;
};

export async function replaceDependenciesForCard(
  input: ReplaceDependenciesInput,
): Promise<MutationResult<LobbyCardDependency[]>> {
  return db.transaction((tx): MutationResult<LobbyCardDependency[]> => {
    const [card] = tx
      .select()
      .from(lobbyCards)
      .where(
        and(
          eq(lobbyCards.id, input.cardId),
          eq(lobbyCards.lobbyId, input.lobbyId),
        ),
      )
      .limit(1)
      .all();
    if (!card) {
      return {
        ok: false,
        reason: "NOT_FOUND",
        message: `Card ${input.cardId} not found in lobby ${input.lobbyId}.`,
      };
    }

    // Self-cycle + same-lobby check.
    for (const dep of input.dependencies) {
      if (dep.dependsOnCardId === input.cardId) {
        return {
          ok: false,
          reason: "INVARIANT_VIOLATION",
          message: `Card ${input.cardId} cannot depend on itself.`,
        };
      }
    }

    if (input.dependencies.length > 0) {
      const ids = input.dependencies.map((d) => d.dependsOnCardId);
      const targets = tx
        .select()
        .from(lobbyCards)
        .where(
          and(
            eq(lobbyCards.lobbyId, input.lobbyId),
            inArray(lobbyCards.id, ids),
          ),
        )
        .all();
      if (targets.length !== new Set(ids).size) {
        return {
          ok: false,
          reason: "INVARIANT_VIOLATION",
          message:
            "One or more dependency targets are not cards in the same lobby.",
        };
      }
    }

    tx.delete(lobbyCardDependencies)
      .where(eq(lobbyCardDependencies.cardId, input.cardId))
      .run();

    const inserted: LobbyCardDependency[] = [];
    for (const dep of input.dependencies) {
      const [row] = tx
        .insert(lobbyCardDependencies)
        .values({
          lobbyId: input.lobbyId,
          cardId: input.cardId,
          dependsOnCardId: dep.dependsOnCardId,
          optional: dep.optional ?? false,
        })
        .returning()
        .all();
      inserted.push(row);
    }

    return { ok: true, row: inserted };
  });
}

// ---------------------------------------------------------------------------
// Lobby events — append + read with monotonic per-lobby sequence
// ---------------------------------------------------------------------------

export type AppendEventInput = {
  lobbyId: string;
  type: string;
  actor: LobbyEventActor;
  payload?: Record<string, unknown>;
  actorUserId?: string | null;
  actorAgentId?: string | null;
  cardId?: string | null;
  seatId?: string | null;
  agentRunId?: string | null;
};

/**
 * Allocate the next monotonic sequence atomically and write the event.
 *
 * SPEC §3 #9: timestamp ordering is unsafe under parallel completion. The
 * sequence is allocated by incrementing `lobbies.event_sequence` in the
 * SAME transaction as the insert, so every consumer sees a strict order
 * with no gaps and no duplicates.
 *
 * Returns null when the lobby doesn't exist (FK guard — should never happen
 * because callers always hold a valid lobbyId).
 */
export async function appendLobbyEvent(
  input: AppendEventInput,
): Promise<LobbyEvent | null> {
  return db.transaction((tx): LobbyEvent | null => {
    const [lobby] = tx
      .select()
      .from(lobbies)
      .where(eq(lobbies.id, input.lobbyId))
      .limit(1)
      .all();
    if (!lobby) return null;

    const nextSequence = lobby.eventSequence + 1;

    tx.update(lobbies)
      .set({ eventSequence: nextSequence, updatedAt: nowIso() })
      .where(eq(lobbies.id, input.lobbyId))
      .run();

    const [row] = tx
      .insert(lobbyEvents)
      .values({
        lobbyId: input.lobbyId,
        sequence: nextSequence,
        type: input.type,
        payload: input.payload ?? {},
        actor: input.actor,
        actorUserId: input.actorUserId ?? null,
        actorAgentId: input.actorAgentId ?? null,
        cardId: input.cardId ?? null,
        seatId: input.seatId ?? null,
        agentRunId: input.agentRunId ?? null,
      })
      .returning()
      .all();
    return row;
  });
}

export type ListEventsParams = {
  lobbyId: string;
  afterSequence?: number;
  limit?: number;
};

export async function listLobbyEvents(
  params: ListEventsParams,
): Promise<LobbyEvent[]> {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const conditions = [eq(lobbyEvents.lobbyId, params.lobbyId)];
  if (params.afterSequence !== undefined) {
    conditions.push(gt(lobbyEvents.sequence, params.afterSequence));
  }
  return db
    .select()
    .from(lobbyEvents)
    .where(and(...conditions))
    .orderBy(asc(lobbyEvents.sequence))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Lobby templates
// ---------------------------------------------------------------------------

export type CreateTemplateInput = {
  userId: string | null;
  name: string;
  description?: string | null;
  defaultSeats: LobbyTemplateSeatV1[];
  planningPrompt: string;
  synthesisPrompt: string;
  visibility?: LobbyTemplateVisibility;
  config?: Partial<LobbyConfigV1>;
};

export async function createLobbyTemplate(
  input: CreateTemplateInput,
): Promise<LobbyTemplate> {
  // SPEC §4: private requires user_id; public requires user_id NULL.
  const visibility = input.visibility ?? (input.userId ? "private" : "public");
  if (visibility === "private" && !input.userId) {
    throw new Error("Private templates require a user_id.");
  }
  if (visibility === "public" && input.userId) {
    throw new Error("Public templates must have user_id = null.");
  }

  const [row] = await db
    .insert(lobbyTemplates)
    .values({
      userId: input.userId,
      name: input.name,
      description: input.description ?? null,
      defaultSeats: input.defaultSeats,
      planningPrompt: input.planningPrompt,
      synthesisPrompt: input.synthesisPrompt,
      visibility,
      config: input.config ?? {},
    })
    .returning();
  return row;
}

export async function getLobbyTemplate(
  templateId: string,
): Promise<LobbyTemplate | null> {
  const row = await db.query.lobbyTemplates.findFirst({
    where: eq(lobbyTemplates.id, templateId),
  });
  return row ?? null;
}

/**
 * List templates the user can see: private templates they own + all public
 * templates. Built-in/public templates have user_id = null.
 */
export async function listLobbyTemplatesForUser(
  userId: string,
): Promise<LobbyTemplate[]> {
  const rows = await db
    .select()
    .from(lobbyTemplates)
    .where(
      sql`(${lobbyTemplates.userId} = ${userId} AND ${lobbyTemplates.visibility} = 'private')
          OR ${lobbyTemplates.visibility} = 'public'`,
    )
    .orderBy(desc(lobbyTemplates.createdAt));
  return rows;
}

// ---------------------------------------------------------------------------
// Internal helpers — exported only for services.ts to share consistency rules
// ---------------------------------------------------------------------------

/**
 * Card status → expected column. Mirrors SPEC §4 table. The state machine in
 * services.ts uses this to keep the kanban column in lockstep with status.
 *
 * `pending` returns `ready` only when callers know the deps are met; the
 * neutral default for `pending` is `backlog` (or `blocked` when deps are
 * unmet). See `transitionCard` for context-aware column choice.
 */
export function defaultColumnForStatus(
  status: LobbyCardStatus,
): LobbyCardColumn {
  switch (status) {
    case "pending":
      return "backlog";
    case "running":
      return "in_progress";
    case "awaiting_review":
      return "review";
    case "approved":
      return "done";
    case "rejected":
    case "failed":
    case "cancelled":
      return "blocked";
  }
}

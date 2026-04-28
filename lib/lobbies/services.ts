/**
 * Solo Story Mode — service layer.
 *
 * State machine transitions on top of `lib/lobbies/queries.ts`. Every public
 * function:
 *   - takes a captain (`userId`) plus an `expectedVersion` for the row(s) it
 *     mutates;
 *   - validates guards listed in lib/lobbies/SPEC.md §5;
 *   - performs the underlying write atomically inside a `db.transaction()`;
 *   - allocates a monotonic `lobby_events` row via `appendLobbyEvent` so SSE
 *     consumers see a strict order (SPEC §3 #9);
 *   - returns a structured `MutationResult<...>` so the API layer can map
 *     `VERSION_CONFLICT` → 409, `INVALID_TRANSITION` → 422, etc., without
 *     leaking internals.
 *
 * What this layer does NOT do:
 *   - It never invokes a subagent or hits a network. The `agent_runs` row is
 *     written here (so `planning_run_id`, `synthesis_run_id`, and
 *     `agent_run_id` are populated atomically), but actual subagent kickoff
 *     is the orchestration layer's job (Sprint 4 wiring).
 *   - It never broadcasts SSE events. The /api/tasks/events extension (also
 *     Sprint 4) reads `lobby_events` + `agent_runs.metadata.soloStory` to
 *     project the right payload.
 *
 * Reading order:
 *   1. SPEC §5 — state-machine tables. Every function maps to one row.
 *   2. SPEC §3 — hard constraints. Look for the matching #N call-out.
 */

import { db } from "@/lib/db/sqlite-client";
import {
  agentRuns,
  type AgentRun,
} from "@/lib/db/sqlite-observability-schema";
import {
  lobbies,
  lobbyCards,
  lobbyCardDependencies,
  lobbySeats,
  type Lobby,
  type LobbyCard,
  type LobbyCardDependency,
  type LobbySeat,
} from "@/lib/db/sqlite-lobbies-schema";
import { appendLobbyEvent } from "@/lib/lobbies/queries";
// Sprint 5.3: `MutationResult` flipped to its canonical home in
// `@/lib/lobbies/types`. Same fix that landed in `api-helpers.ts` during
// Sprint 5.2 — keeping the type import on `queries` would re-introduce
// the (route|service) → queries → drizzle dependency chain that the
// types-as-canonical-source split was meant to break.
import type {
  LobbyCardOutputV1,
  LobbyPermissionScopeV1,
  MutationResult,
  SoloStoryRunMetadata,
  SoloStoryRunRole,
} from "@/lib/lobbies/types";
import { and, eq, inArray } from "drizzle-orm";

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Permission scope snapshot
// ---------------------------------------------------------------------------

/**
 * Build the metadata snapshot to attach to `agent_runs.metadata`. Stored
 * verbatim so mid-execution edits to `lobby_seats.permission_scope` cannot
 * affect an in-flight run (SPEC §3 #8 + #12).
 *
 * Workers snapshot their seat's `permission_scope` directly. Planner /
 * synthesizer roles do not have a per-seat scope — they snapshot an empty
 * tool-list scope which Sprint 3's injection treats as "no tightening"
 * (planner/synthesizer use the character's own enabled tools).
 */
export function buildSoloStoryRunMetadata(input: {
  lobbyId: string;
  cardId?: string;
  seatId?: string;
  role: SoloStoryRunRole;
  scope: LobbyPermissionScopeV1;
}): SoloStoryRunMetadata {
  return {
    soloStory: {
      lobbyId: input.lobbyId,
      cardId: input.cardId,
      seatId: input.seatId,
      role: input.role,
      permissionScope: input.scope,
      permissionScopeSnapshotAt: nowIso(),
    },
  };
}

// ---------------------------------------------------------------------------
// DAG validation
// ---------------------------------------------------------------------------

/**
 * Detect a cycle in the dependency graph. Returns the offending card chain
 * or `null` when the graph is acyclic. Iterative DFS — safe for large DAGs.
 */
export function findDependencyCycle(
  cards: Pick<LobbyCard, "id">[],
  dependencies: Pick<LobbyCardDependency, "cardId" | "dependsOnCardId">[],
): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const c of cards) adjacency.set(c.id, []);
  for (const d of dependencies) {
    const list = adjacency.get(d.cardId);
    if (!list) continue;
    list.push(d.dependsOnCardId);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const c of cards) color.set(c.id, WHITE);

  for (const start of cards) {
    if (color.get(start.id) !== WHITE) continue;
    const stack: Array<{ id: string; pathIndex: number }> = [
      { id: start.id, pathIndex: 0 },
    ];
    const path: string[] = [];

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.pathIndex === 0) {
        color.set(top.id, GRAY);
        path.push(top.id);
      }

      const neighbors = adjacency.get(top.id) ?? [];
      if (top.pathIndex < neighbors.length) {
        const next = neighbors[top.pathIndex];
        top.pathIndex += 1;
        const nextColor = color.get(next);
        if (nextColor === GRAY) {
          // Found a back-edge — slice the cycle out of the active path.
          const cycleStart = path.indexOf(next);
          const cycle = path.slice(cycleStart);
          cycle.push(next);
          return cycle;
        }
        if (nextColor === WHITE) {
          stack.push({ id: next, pathIndex: 0 });
        }
        // BLACK → already fully explored, skip.
      } else {
        color.set(top.id, BLACK);
        path.pop();
        stack.pop();
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Replace dependencies + cycle check (transactional)
// ---------------------------------------------------------------------------

/**
 * Sentinel thrown from inside the cycle-checked dep replacement to roll
 * back the transaction. Caught at the boundary and converted to a
 * structured `INVARIANT_VIOLATION` envelope.
 */
export class DependencyCycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(" -> ")}`);
    this.name = "DependencyCycleError";
  }
}

/**
 * Atomically replace a card's dependency list AND verify the resulting
 * graph stays acyclic. The two operations MUST happen in the same
 * transaction; otherwise a concurrent reader could observe a transient
 * cyclic state, and rolling back via a follow-up "restore" write opens a
 * write-skew window.
 *
 * Guards (SPEC §3 implicit + #13 — DAG correctness is a data-model
 * invariant rather than a numbered hard constraint, but #13 — block
 * structural edits to running cards — applies because dependency edits
 * are structural):
 *   - card belongs to lobby,
 *   - no self-dependency,
 *   - all `dependsOnCardId` belong to the same lobby,
 *   - resulting graph is acyclic.
 *
 * Cycle detection runs against the projected post-swap graph; on a cycle
 * we throw `DependencyCycleError` to roll back the in-tx DELETE and
 * convert it to `INVARIANT_VIOLATION` outside the transaction.
 *
 * Note: dependency edits don't emit a dedicated `dependencies.replaced`
 * event in V1 (the next state-affecting transition will fire its own
 * event). Add one here later if the UI needs to react in real time.
 *
 * Sprint 7B.1:
 *   - R1-H2: require `expectedVersion`. Compare to `card.lockVersion`,
 *     return VERSION_CONFLICT on mismatch, bump on success. Without this,
 *     concurrent dep edits silently clobbered each other (SPEC §3 #10).
 *   - R1-H3: block dep edits while the card is `running`. Dependency
 *     edits ARE structural per SPEC §3 #13 — the file header acknowledges
 *     it but the gate was missing. Captain must cancel + edit + retry.
 */
export async function replaceDependenciesForCardWithCycleCheck(input: {
  lobbyId: string;
  cardId: string;
  expectedVersion: number;
  dependencies: Array<{ dependsOnCardId: string; optional?: boolean }>;
}): Promise<MutationResult<LobbyCardDependency[]>> {
  try {
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

      // R1-H2: optimistic-concurrency check. SPEC §3 #10.
      if (card.lockVersion !== input.expectedVersion) {
        return {
          ok: false,
          reason: "VERSION_CONFLICT",
          message: `Card ${input.cardId} is at version ${card.lockVersion}, expected ${input.expectedVersion}.`,
          currentVersion: card.lockVersion,
        };
      }

      // R1-H3: SPEC §3 #13 — block structural edits to running cards.
      if (card.status === "running") {
        return {
          ok: false,
          reason: "INVALID_TRANSITION",
          message: `Cannot edit dependencies of running card ${input.cardId}. Cancel first, then edit and retry.`,
        };
      }

      // Self-dependency check.
      for (const dep of input.dependencies) {
        if (dep.dependsOnCardId === input.cardId) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Card ${input.cardId} cannot depend on itself.`,
          };
        }
      }

      // Same-lobby check for every target.
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

      // Drop existing deps for this card so the cycle check sees the
      // candidate post-swap graph.
      tx.delete(lobbyCardDependencies)
        .where(eq(lobbyCardDependencies.cardId, input.cardId))
        .run();

      const remainingDeps = tx
        .select()
        .from(lobbyCardDependencies)
        .where(eq(lobbyCardDependencies.lobbyId, input.lobbyId))
        .all();

      const projectedDeps = [
        ...remainingDeps,
        ...input.dependencies.map((d) => ({
          cardId: input.cardId,
          dependsOnCardId: d.dependsOnCardId,
        })),
      ];

      const allCards = tx
        .select({ id: lobbyCards.id })
        .from(lobbyCards)
        .where(eq(lobbyCards.lobbyId, input.lobbyId))
        .all();

      const cycle = findDependencyCycle(allCards, projectedDeps);
      if (cycle) {
        // Throw to roll back the DELETE we already issued.
        throw new DependencyCycleError(cycle);
      }

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

      // R1-H2: bump card.lockVersion so concurrent dep PUTs from a stale
      // tab see VERSION_CONFLICT on their next attempt.
      tx.update(lobbyCards)
        .set({
          lockVersion: card.lockVersion + 1,
          updatedAt: nowIso(),
        })
        .where(eq(lobbyCards.id, input.cardId))
        .run();

      return { ok: true, row: inserted };
    });
  } catch (err) {
    if (err instanceof DependencyCycleError) {
      return {
        ok: false,
        reason: "INVARIANT_VIOLATION",
        message: err.message,
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Card readiness recomputation
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Mark every `pending` card whose required deps are all `approved` (and whose
 * optional deps are `approved | failed | cancelled`) as ready-to-run. The
 * card row itself stays `pending` (status); only the kanban `column` flips
 * to `ready`. Side effect: emits `card.ready` events for the cards that
 * transitioned.
 *
 * Runs inside the caller's transaction — pass the `tx` handle. If you need
 * to call this outside a transaction, wrap it: `db.transaction((tx) => recomputeReadyCards({lobbyId, tx}))`.
 */
function recomputeReadyCardsInTx(input: {
  tx: Tx;
  lobbyId: string;
}): { promotedCardIds: string[] } {
  const { tx, lobbyId } = input;

  const allCards = tx
    .select()
    .from(lobbyCards)
    .where(eq(lobbyCards.lobbyId, lobbyId))
    .all();
  const allDeps = tx
    .select()
    .from(lobbyCardDependencies)
    .where(eq(lobbyCardDependencies.lobbyId, lobbyId))
    .all();

  const cardById = new Map<string, LobbyCard>();
  for (const c of allCards) cardById.set(c.id, c);

  const depsByCard = new Map<string, LobbyCardDependency[]>();
  for (const d of allDeps) {
    const list = depsByCard.get(d.cardId) ?? [];
    list.push(d);
    depsByCard.set(d.cardId, list);
  }

  const promotedCardIds: string[] = [];

  for (const card of allCards) {
    if (card.status !== "pending") continue;
    if (card.column === "ready") continue;

    const deps = depsByCard.get(card.id) ?? [];
    let satisfied = true;
    for (const dep of deps) {
      const depCard = cardById.get(dep.dependsOnCardId);
      if (!depCard) {
        // Orphan FK — skip; FK should prevent this.
        satisfied = false;
        break;
      }
      if (dep.optional) {
        // Optional deps unblock as long as they've reached a terminal state.
        if (
          !["approved", "failed", "cancelled"].includes(depCard.status)
        ) {
          satisfied = false;
          break;
        }
      } else {
        if (depCard.status !== "approved") {
          satisfied = false;
          break;
        }
      }
    }

    if (satisfied) {
      tx.update(lobbyCards)
        .set({
          column: "ready",
          lockVersion: card.lockVersion + 1,
          updatedAt: nowIso(),
        })
        .where(eq(lobbyCards.id, card.id))
        .run();
      promotedCardIds.push(card.id);
    }
  }

  return { promotedCardIds };
}

// ---------------------------------------------------------------------------
// agent_runs helpers
// ---------------------------------------------------------------------------

type CreateSoloStoryRunInput = {
  tx: Tx;
  lobbyId: string;
  sessionId: string;
  userId: string;
  characterId?: string | null;
  pipelineName: string;
  triggerType: "chat" | "api" | "job" | "cron" | "webhook" | "tool";
  cardId?: string;
  seatId?: string;
  role: SoloStoryRunRole;
  scope: LobbyPermissionScopeV1;
};

function insertSoloStoryRunInTx(input: CreateSoloStoryRunInput): AgentRun {
  const metadata = buildSoloStoryRunMetadata({
    lobbyId: input.lobbyId,
    cardId: input.cardId,
    seatId: input.seatId,
    role: input.role,
    scope: input.scope,
  });
  const [row] = input.tx
    .insert(agentRuns)
    .values({
      sessionId: input.sessionId,
      userId: input.userId,
      characterId: input.characterId ?? null,
      pipelineName: input.pipelineName,
      triggerType: input.triggerType,
      status: "running",
      metadata,
    })
    .returning()
    .all();
  return row;
}

// ---------------------------------------------------------------------------
// Lobby transitions
// ---------------------------------------------------------------------------

/**
 * `ready_roster`: roster → planning. Validates the captain has built a
 * non-empty roster with valid permission scopes, then creates the planner's
 * agent_runs row and stores its id on the lobby.
 *
 * Side effect: orchestration layer must subsequently invoke the planner
 * subagent against `result.row.lobby.planningRunId`.
 */
export async function transitionLobbyReadyRoster(input: {
  lobbyId: string;
  userId: string;
  expectedLobbyVersion: number;
  /**
   * Permission scope used for the planner's `agent_runs.metadata`. Defaults
   * to an empty tool-list, which Sprint 3 interprets as "no tightening" for
   * planner/synthesizer roles.
   */
  plannerScope?: LobbyPermissionScopeV1;
  plannerCharacterId?: string | null;
}): Promise<MutationResult<{ lobby: Lobby; planningRun: AgentRun }>> {
  const plannerScope =
    input.plannerScope ?? {
      version: 1,
      mode: "tool_list",
      allowedTools: [],
    };

  const result = db.transaction(
    (tx): MutationResult<{ lobby: Lobby; planningRun: AgentRun }> => {
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
          message: `Cannot ready_roster from status '${lobby.status}'. Required: 'roster'.`,
        };
      }

      const seats = tx
        .select()
        .from(lobbySeats)
        .where(eq(lobbySeats.lobbyId, input.lobbyId))
        .all();

      const readySeats = seats.filter(
        (s) => s.agentId !== null && s.status === "ready",
      );
      if (readySeats.length === 0) {
        return {
          ok: false,
          reason: "INVARIANT_VIOLATION",
          message:
            "Cannot start planning without at least one ready seat assigned to an agent.",
        };
      }

      for (const seat of readySeats) {
        const scope = seat.permissionScope;
        if (
          !scope ||
          scope.version !== 1 ||
          scope.mode !== "tool_list" ||
          !Array.isArray(scope.allowedTools)
        ) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Seat ${seat.id} has an invalid permission_scope. Expected tool_list V1.`,
          };
        }
      }

      // Create the planner's agent_runs row up-front so its id can land on
      // the lobby in the same transaction.
      const planningRun = insertSoloStoryRunInTx({
        tx,
        lobbyId: lobby.id,
        sessionId: lobby.sessionId,
        userId: lobby.userId,
        characterId: input.plannerCharacterId ?? null,
        pipelineName: "solo_story.planner",
        triggerType: "api",
        role: "planner",
        scope: plannerScope,
      });

      const [nextLobby] = tx
        .update(lobbies)
        .set({
          status: "planning",
          planningRunId: planningRun.id,
          lockVersion: lobby.lockVersion + 1,
          updatedAt: nowIso(),
        })
        .where(eq(lobbies.id, lobby.id))
        .returning()
        .all();

      return {
        ok: true,
        row: { lobby: nextLobby, planningRun },
      };
    },
  );
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.lobby.id,
      type: "lobby.roster_ready",
      actor: "captain",
      actorUserId: input.userId,
      agentRunId: result.row.planningRun.id,
      payload: { plannerRunId: result.row.planningRun.id },
    });
  }
  return result;
}

/**
 * `planner_succeeded`: planning → planning. The planner's output is parsed
 * into cards + dependencies and inserted in a single transaction. Idempotent:
 * if `planning_run_id` already has cards attached (replay) the operation
 * no-ops and returns the existing card set.
 *
 * Called by the orchestration layer once the planner subagent completes.
 */
export async function applyPlannerOutput(input: {
  lobbyId: string;
  plannerRunId: string;
  cards: Array<{
    title: string;
    description?: string;
    acceptanceCriteria?: LobbyCardOutputV1["artifacts"] extends infer A
      ? unknown
      : never;
    assignedSeatId?: string | null;
    column?: "backlog" | "ready" | "blocked";
    maxAttempts?: number;
    /** Stable client-side id so dependency edges can reference it. */
    clientId?: string;
  }>;
  dependencies: Array<{
    /** References either a freshly inserted card's `clientId` OR an existing card id. */
    fromClientId: string;
    toClientId: string;
    optional?: boolean;
  }>;
}): Promise<
  MutationResult<{
    lobby: Lobby;
    cards: LobbyCard[];
    dependencies: LobbyCardDependency[];
  }>
> {
  const result = db
    .transaction(
      (
        tx,
      ): MutationResult<{
        lobby: Lobby;
        cards: LobbyCard[];
        dependencies: LobbyCardDependency[];
      }> => {
        const [lobby] = tx
          .select()
          .from(lobbies)
          .where(eq(lobbies.id, input.lobbyId))
          .limit(1)
          .all();
        if (!lobby) {
          return {
            ok: false,
            reason: "NOT_FOUND",
            message: `Lobby ${input.lobbyId} not found.`,
          };
        }
        if (lobby.status !== "planning") {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message: `Cannot apply planner output from status '${lobby.status}'. Required: 'planning'.`,
          };
        }
        if (lobby.planningRunId !== input.plannerRunId) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Lobby ${input.lobbyId} planning_run_id (${lobby.planningRunId ?? "null"}) does not match plannerRunId (${input.plannerRunId}).`,
          };
        }

        // Idempotency: if planner cards already exist for this lobby, skip.
        const existing = tx
          .select()
          .from(lobbyCards)
          .where(eq(lobbyCards.lobbyId, input.lobbyId))
          .all();
        if (existing.length > 0) {
          const existingDeps = tx
            .select()
            .from(lobbyCardDependencies)
            .where(eq(lobbyCardDependencies.lobbyId, input.lobbyId))
            .all();
          return {
            ok: true,
            row: { lobby, cards: existing, dependencies: existingDeps },
          };
        }

        const insertedCards: LobbyCard[] = [];
        const clientIdMap = new Map<string, string>();

        for (let i = 0; i < input.cards.length; i++) {
          const c = input.cards[i];
          const [row] = tx
            .insert(lobbyCards)
            .values({
              lobbyId: input.lobbyId,
              title: c.title,
              description: c.description ?? "",
              acceptanceCriteria: Array.isArray(c.acceptanceCriteria)
                ? (c.acceptanceCriteria as never)
                : [],
              assignedSeatId: c.assignedSeatId ?? null,
              position: i,
              column: c.column ?? "backlog",
              status: "pending",
              maxAttempts: c.maxAttempts ?? 3,
              createdBy: "planner",
            })
            .returning()
            .all();
          insertedCards.push(row);
          if (c.clientId) clientIdMap.set(c.clientId, row.id);
        }

        const insertedDeps: LobbyCardDependency[] = [];
        for (const dep of input.dependencies) {
          const cardId = clientIdMap.get(dep.fromClientId) ?? dep.fromClientId;
          const dependsOnId =
            clientIdMap.get(dep.toClientId) ?? dep.toClientId;
          if (cardId === dependsOnId) {
            return {
              ok: false,
              reason: "INVARIANT_VIOLATION",
              message: `Card ${cardId} cannot depend on itself.`,
            };
          }
          const [row] = tx
            .insert(lobbyCardDependencies)
            .values({
              lobbyId: input.lobbyId,
              cardId,
              dependsOnCardId: dependsOnId,
              optional: dep.optional ?? false,
            })
            .returning()
            .all();
          insertedDeps.push(row);
        }

        // Acyclic guard.
        const cycle = findDependencyCycle(insertedCards, insertedDeps);
        if (cycle) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Planner produced a dependency cycle: ${cycle.join(" -> ")}.`,
          };
        }

        const [nextLobby] = tx
          .update(lobbies)
          .set({
            lockVersion: lobby.lockVersion + 1,
            updatedAt: nowIso(),
          })
          .where(eq(lobbies.id, lobby.id))
          .returning()
          .all();

        return {
          ok: true,
          row: {
            lobby: nextLobby,
            cards: insertedCards,
            dependencies: insertedDeps,
          },
        };
      },
    );
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.lobby.id,
      type: "lobby.plan_generated",
      actor: "agent",
      agentRunId: input.plannerRunId,
      payload: {
        cardCount: result.row.cards.length,
        dependencyCount: result.row.dependencies.length,
      },
    });
  }
  return result;
}

/**
 * `accept_plan`: planning → rolling. Validates the DAG, every card has a
 * valid same-lobby seat, and every assigned seat is in `ready` or `idle`.
 * Side effect: marks root cards' kanban column as `ready` and emits
 * `lobby.rolling_started`. Subagent kickoff for the eligible cards is the
 * orchestration layer's job.
 */
export async function transitionLobbyAcceptPlan(input: {
  lobbyId: string;
  userId: string;
  expectedLobbyVersion: number;
}): Promise<
  MutationResult<{ lobby: Lobby; readyCardIds: string[] }>
> {
  const result = db
    .transaction(
      (tx): MutationResult<{ lobby: Lobby; readyCardIds: string[] }> => {
        const [lobby] = tx
          .select()
          .from(lobbies)
          .where(
            and(
              eq(lobbies.id, input.lobbyId),
              eq(lobbies.userId, input.userId),
            ),
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
        if (lobby.status !== "planning") {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message: `Cannot accept_plan from status '${lobby.status}'. Required: 'planning'.`,
          };
        }

        const cards = tx
          .select()
          .from(lobbyCards)
          .where(eq(lobbyCards.lobbyId, input.lobbyId))
          .all();
        if (cards.length === 0) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: "Cannot accept an empty plan. Generate cards first.",
          };
        }

        const deps = tx
          .select()
          .from(lobbyCardDependencies)
          .where(eq(lobbyCardDependencies.lobbyId, input.lobbyId))
          .all();
        const cycle = findDependencyCycle(cards, deps);
        if (cycle) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Plan has a dependency cycle: ${cycle.join(" -> ")}.`,
          };
        }

        const seats = tx
          .select()
          .from(lobbySeats)
          .where(eq(lobbySeats.lobbyId, input.lobbyId))
          .all();
        const seatById = new Map<string, LobbySeat>();
        for (const s of seats) seatById.set(s.id, s);

        for (const card of cards) {
          if (!card.assignedSeatId) continue;
          const seat = seatById.get(card.assignedSeatId);
          if (!seat) {
            return {
              ok: false,
              reason: "INVARIANT_VIOLATION",
              message: `Card ${card.id} references seat ${card.assignedSeatId} not in lobby.`,
            };
          }
          if (!["ready", "idle"].includes(seat.status)) {
            return {
              ok: false,
              reason: "INVARIANT_VIOLATION",
              message: `Card ${card.id} is assigned to seat ${seat.id} in status '${seat.status}'. Required: 'ready' or 'idle'.`,
            };
          }
        }

        const [nextLobby] = tx
          .update(lobbies)
          .set({
            status: "rolling",
            startedAt: nowIso(),
            lockVersion: lobby.lockVersion + 1,
            updatedAt: nowIso(),
          })
          .where(eq(lobbies.id, lobby.id))
          .returning()
          .all();

        const { promotedCardIds } = recomputeReadyCardsInTx({
          tx,
          lobbyId: input.lobbyId,
        });

        return {
          ok: true,
          row: { lobby: nextLobby, readyCardIds: promotedCardIds },
        };
      },
    );
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.lobby.id,
      type: "lobby.rolling_started",
      actor: "captain",
      actorUserId: input.userId,
      payload: {
        readyCardIds: result.row.readyCardIds,
        totalReady: result.row.readyCardIds.length,
      },
    });
  }
  return result;
}

/**
 * `enter_review`: rolling → review. No-op when there are still running cards
 * or runnable pending cards. Idempotent if the lobby is already in review.
 *
 * Called by the orchestration layer after every card completion to detect the
 * "all work settled" condition.
 */
export async function transitionLobbyEnterReview(input: {
  lobbyId: string;
  /** When set, the captain can force-enter review even if work remains. */
  forced?: boolean;
  actorUserId?: string;
}): Promise<MutationResult<Lobby>> {
  const result = db
    .transaction((tx): MutationResult<Lobby> => {
      const [lobby] = tx
        .select()
        .from(lobbies)
        .where(eq(lobbies.id, input.lobbyId))
        .limit(1)
        .all();
      if (!lobby) {
        return {
          ok: false,
          reason: "NOT_FOUND",
          message: `Lobby ${input.lobbyId} not found.`,
        };
      }
      if (lobby.status === "review") {
        return { ok: true, row: lobby };
      }
      if (lobby.status !== "rolling") {
        return {
          ok: false,
          reason: "INVALID_TRANSITION",
          message: `Cannot enter_review from status '${lobby.status}'. Required: 'rolling'.`,
        };
      }

      if (!input.forced) {
        const cards = tx
          .select()
          .from(lobbyCards)
          .where(eq(lobbyCards.lobbyId, input.lobbyId))
          .all();
        const hasRunning = cards.some((c) => c.status === "running");
        if (hasRunning) {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message: "Cannot enter review while cards are still running.",
          };
        }
        const hasReadyPending = cards.some(
          (c) => c.status === "pending" && c.column === "ready",
        );
        if (hasReadyPending) {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message:
              "Cannot enter review while pending cards are still runnable.",
          };
        }
      }

      const [nextLobby] = tx
        .update(lobbies)
        .set({
          status: "review",
          lockVersion: lobby.lockVersion + 1,
          updatedAt: nowIso(),
        })
        .where(eq(lobbies.id, lobby.id))
        .returning()
        .all();
      return { ok: true, row: nextLobby };
    });
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.id,
      type: "lobby.review_started",
      actor: input.actorUserId ? "captain" : "system",
      actorUserId: input.actorUserId ?? null,
      payload: { forced: input.forced ?? false },
    });
  }
  return result;
}

/**
 * `start_synthesis`: review → review (no status change). Validates every
 * required card is approved, then creates the synthesizer's agent_runs row
 * and stores its id on the lobby.
 *
 * The synthesizer-finished hook (`completeSynthesis`) flips status to
 * `completed`.
 */
export async function transitionLobbyStartSynthesis(input: {
  lobbyId: string;
  userId: string;
  expectedLobbyVersion: number;
  synthesizerScope?: LobbyPermissionScopeV1;
  synthesizerCharacterId?: string | null;
}): Promise<MutationResult<{ lobby: Lobby; synthesisRun: AgentRun }>> {
  const synthesizerScope =
    input.synthesizerScope ?? {
      version: 1,
      mode: "tool_list",
      allowedTools: [],
    };

  const result = db
    .transaction(
      (tx): MutationResult<{ lobby: Lobby; synthesisRun: AgentRun }> => {
        const [lobby] = tx
          .select()
          .from(lobbies)
          .where(
            and(
              eq(lobbies.id, input.lobbyId),
              eq(lobbies.userId, input.userId),
            ),
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
        if (lobby.status !== "review") {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message: `Cannot start_synthesis from status '${lobby.status}'. Required: 'review'.`,
          };
        }
        if (lobby.synthesisRunId) {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message: `Lobby ${input.lobbyId} already has a synthesis run.`,
          };
        }

        const cards = tx
          .select()
          .from(lobbyCards)
          .where(eq(lobbyCards.lobbyId, input.lobbyId))
          .all();
        const required = cards; // V1: all cards required (no per-card "required" flag yet).
        const unapproved = required.filter((c) => c.status !== "approved");
        if (unapproved.length > 0) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Cannot synthesize until all cards are approved. ${unapproved.length} unapproved.`,
          };
        }

        const synthesisRun = insertSoloStoryRunInTx({
          tx,
          lobbyId: lobby.id,
          sessionId: lobby.sessionId,
          userId: lobby.userId,
          characterId: input.synthesizerCharacterId ?? null,
          pipelineName: "solo_story.synthesizer",
          triggerType: "api",
          role: "synthesizer",
          scope: synthesizerScope,
        });

        const [nextLobby] = tx
          .update(lobbies)
          .set({
            synthesisRunId: synthesisRun.id,
            lockVersion: lobby.lockVersion + 1,
            updatedAt: nowIso(),
          })
          .where(eq(lobbies.id, lobby.id))
          .returning()
          .all();

        return { ok: true, row: { lobby: nextLobby, synthesisRun } };
      },
    );
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.lobby.id,
      type: "lobby.synthesis_started",
      actor: "captain",
      actorUserId: input.userId,
      agentRunId: result.row.synthesisRun.id,
      payload: { synthesisRunId: result.row.synthesisRun.id },
    });
  }
  return result;
}

/**
 * `complete_synthesis`: review → completed. Called by the orchestration
 * layer once the synthesizer subagent finishes successfully.
 */
export async function completeSynthesis(input: {
  lobbyId: string;
  synthesisRunId: string;
  outputArtifactId: string;
}): Promise<MutationResult<Lobby>> {
  const result = db
    .transaction((tx): MutationResult<Lobby> => {
      const [lobby] = tx
        .select()
        .from(lobbies)
        .where(eq(lobbies.id, input.lobbyId))
        .limit(1)
        .all();
      if (!lobby) {
        return {
          ok: false,
          reason: "NOT_FOUND",
          message: `Lobby ${input.lobbyId} not found.`,
        };
      }
      if (lobby.status !== "review") {
        return {
          ok: false,
          reason: "INVALID_TRANSITION",
          message: `Cannot complete_synthesis from status '${lobby.status}'. Required: 'review'.`,
        };
      }
      if (lobby.synthesisRunId !== input.synthesisRunId) {
        return {
          ok: false,
          reason: "INVARIANT_VIOLATION",
          message: `Synthesis run id mismatch (lobby: ${lobby.synthesisRunId ?? "null"}, supplied: ${input.synthesisRunId}).`,
        };
      }

      const [nextLobby] = tx
        .update(lobbies)
        .set({
          status: "completed",
          completedAt: nowIso(),
          outputArtifactId: input.outputArtifactId,
          lockVersion: lobby.lockVersion + 1,
          updatedAt: nowIso(),
        })
        .where(eq(lobbies.id, lobby.id))
        .returning()
        .all();
      return { ok: true, row: nextLobby };
    });
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.id,
      type: "lobby.completed",
      actor: "system",
      agentRunId: input.synthesisRunId,
      payload: { outputArtifactId: input.outputArtifactId },
    });
  }
  return result;
}

/**
 * `abort`: any non-terminal → aborted. Captain-driven. Marks all running
 * cards as `cancelled`, marks the lobby as `aborted`. The orchestration
 * layer is responsible for cancelling in-flight subagent runs (drain mode
 * in particular is enforced by the orchestrator, not here).
 */
export async function transitionLobbyAbort(input: {
  lobbyId: string;
  userId: string;
  expectedLobbyVersion: number;
  mode?: "cancel" | "wait" | "abandon";
  reason?: string;
}): Promise<
  MutationResult<{
    lobby: Lobby;
    cancelledCardIds: string[];
  }>
> {
  const result = db
    .transaction(
      (
        tx,
      ): MutationResult<{ lobby: Lobby; cancelledCardIds: string[] }> => {
        const [lobby] = tx
          .select()
          .from(lobbies)
          .where(
            and(
              eq(lobbies.id, input.lobbyId),
              eq(lobbies.userId, input.userId),
            ),
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
        if (["completed", "aborted"].includes(lobby.status)) {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message: `Cannot abort from terminal status '${lobby.status}'.`,
          };
        }

        const runningCards = tx
          .select()
          .from(lobbyCards)
          .where(
            and(
              eq(lobbyCards.lobbyId, input.lobbyId),
              eq(lobbyCards.status, "running"),
            ),
          )
          .all();

        const cancelledCardIds: string[] = [];
        for (const card of runningCards) {
          tx.update(lobbyCards)
            .set({
              status: "cancelled",
              column: "blocked",
              completedAt: nowIso(),
              lockVersion: card.lockVersion + 1,
              updatedAt: nowIso(),
            })
            .where(eq(lobbyCards.id, card.id))
            .run();
          cancelledCardIds.push(card.id);

          // Free the seat.
          if (card.assignedSeatId) {
            const [seat] = tx
              .select()
              .from(lobbySeats)
              .where(eq(lobbySeats.id, card.assignedSeatId))
              .limit(1)
              .all();
            if (seat && seat.status === "busy") {
              tx.update(lobbySeats)
                .set({
                  status: "idle",
                  lockVersion: seat.lockVersion + 1,
                  updatedAt: nowIso(),
                })
                .where(eq(lobbySeats.id, seat.id))
                .run();
            }
          }
        }

        const [nextLobby] = tx
          .update(lobbies)
          .set({
            status: "aborted",
            abortedAt: nowIso(),
            lockVersion: lobby.lockVersion + 1,
            updatedAt: nowIso(),
          })
          .where(eq(lobbies.id, lobby.id))
          .returning()
          .all();

        return { ok: true, row: { lobby: nextLobby, cancelledCardIds } };
      },
    );
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.lobby.id,
      type: "lobby.aborted",
      actor: "captain",
      actorUserId: input.userId,
      payload: {
        mode: input.mode ?? "cancel",
        reason: input.reason ?? null,
        cancelledCardIds: result.row.cancelledCardIds,
      },
    });
    for (const cancelledId of result.row.cancelledCardIds) {
      await appendLobbyEvent({
        lobbyId: result.row.lobby.id,
        type: "card.cancelled_by_lobby",
        actor: "system",
        cardId: cancelledId,
        payload: {},
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Card transitions
// ---------------------------------------------------------------------------

/**
 * `start`: pending → running. Snapshots the seat's permission scope into a
 * fresh agent_runs row, marks the seat busy, and increments attempt count.
 *
 * The orchestration layer must subsequently invoke the worker subagent with
 * `result.row.agentRun.id` so it inherits the seat's character and snapshot
 * scope.
 */
export async function transitionCardStart(input: {
  cardId: string;
  expectedCardVersion: number;
}): Promise<
  MutationResult<{ card: LobbyCard; seat: LobbySeat; agentRun: AgentRun }>
> {
  const result = db
    .transaction(
      (
        tx,
      ): MutationResult<{
        card: LobbyCard;
        seat: LobbySeat;
        agentRun: AgentRun;
      }> => {
        const [card] = tx
          .select()
          .from(lobbyCards)
          .where(eq(lobbyCards.id, input.cardId))
          .limit(1)
          .all();
        if (!card) {
          return {
            ok: false,
            reason: "NOT_FOUND",
            message: `Card ${input.cardId} not found.`,
          };
        }
        if (card.lockVersion !== input.expectedCardVersion) {
          return {
            ok: false,
            reason: "VERSION_CONFLICT",
            message: `Card ${input.cardId} is at version ${card.lockVersion}, expected ${input.expectedCardVersion}.`,
            currentVersion: card.lockVersion,
          };
        }
        if (card.status !== "pending") {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message: `Cannot start card in status '${card.status}'. Required: 'pending'.`,
          };
        }
        if (card.column !== "ready") {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Card ${input.cardId} is not in 'ready' column. Wait for deps_met.`,
          };
        }
        if (!card.assignedSeatId) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Card ${input.cardId} has no assigned seat.`,
          };
        }
        if (card.attemptCount >= card.maxAttempts) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Card ${input.cardId} has reached its max attempt count (${card.maxAttempts}).`,
          };
        }

        const [lobby] = tx
          .select()
          .from(lobbies)
          .where(eq(lobbies.id, card.lobbyId))
          .limit(1)
          .all();
        if (!lobby) {
          return {
            ok: false,
            reason: "NOT_FOUND",
            message: `Lobby ${card.lobbyId} not found.`,
          };
        }
        if (lobby.status !== "rolling") {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message: `Cannot start cards while lobby is in status '${lobby.status}'. Required: 'rolling'.`,
          };
        }

        const [seat] = tx
          .select()
          .from(lobbySeats)
          .where(eq(lobbySeats.id, card.assignedSeatId))
          .limit(1)
          .all();
        if (!seat) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Seat ${card.assignedSeatId} not found.`,
          };
        }
        if (!["ready", "idle"].includes(seat.status)) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Seat ${seat.id} is in status '${seat.status}'. Required: 'ready' or 'idle'.`,
          };
        }

        const agentRun = insertSoloStoryRunInTx({
          tx,
          lobbyId: lobby.id,
          sessionId: lobby.sessionId,
          userId: lobby.userId,
          characterId: seat.agentId,
          pipelineName: "solo_story.worker",
          triggerType: "api",
          cardId: card.id,
          seatId: seat.id,
          role: "worker",
          scope: seat.permissionScope,
        });

        const [nextCard] = tx
          .update(lobbyCards)
          .set({
            status: "running",
            column: "in_progress",
            agentRunId: agentRun.id,
            attemptCount: card.attemptCount + 1,
            startedAt: nowIso(),
            failureReason: null,
            reviewNotes: null,
            reviewedByUserId: null,
            reviewedAt: null,
            lockVersion: card.lockVersion + 1,
            updatedAt: nowIso(),
          })
          .where(eq(lobbyCards.id, card.id))
          .returning()
          .all();

        const [nextSeat] = tx
          .update(lobbySeats)
          .set({
            status: "busy",
            lockVersion: seat.lockVersion + 1,
            updatedAt: nowIso(),
          })
          .where(eq(lobbySeats.id, seat.id))
          .returning()
          .all();

        return {
          ok: true,
          row: { card: nextCard, seat: nextSeat, agentRun },
        };
      },
    );
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.card.lobbyId,
      type: "card.run_started",
      actor: "system",
      cardId: result.row.card.id,
      seatId: result.row.seat.id,
      agentRunId: result.row.agentRun.id,
      payload: { attemptCount: result.row.card.attemptCount },
    });
  }
  return result;
}

/**
 * `run_succeeded`: running → awaiting_review. Called by the orchestration
 * layer once the worker subagent finishes successfully. Idempotent: a second
 * call with the same `agentRunId` returns the current row.
 */
export async function applyCardRunSucceeded(input: {
  cardId: string;
  agentRunId: string;
  output: LobbyCardOutputV1;
}): Promise<MutationResult<{ card: LobbyCard; seat: LobbySeat | null }>> {
  const result = db
    .transaction(
      (
        tx,
      ): MutationResult<{ card: LobbyCard; seat: LobbySeat | null }> => {
        const [card] = tx
          .select()
          .from(lobbyCards)
          .where(eq(lobbyCards.id, input.cardId))
          .limit(1)
          .all();
        if (!card) {
          return {
            ok: false,
            reason: "NOT_FOUND",
            message: `Card ${input.cardId} not found.`,
          };
        }
        if (card.agentRunId !== input.agentRunId) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Card ${input.cardId} agent_run_id (${card.agentRunId ?? "null"}) does not match supplied (${input.agentRunId}).`,
          };
        }
        if (card.status === "awaiting_review") {
          // Idempotent replay.
          const seat = card.assignedSeatId
            ? tx
                .select()
                .from(lobbySeats)
                .where(eq(lobbySeats.id, card.assignedSeatId))
                .limit(1)
                .all()[0] ?? null
            : null;
          return { ok: true, row: { card, seat } };
        }
        if (card.status !== "running") {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message: `Card ${input.cardId} is in status '${card.status}'. Required: 'running'.`,
          };
        }

        const [nextCard] = tx
          .update(lobbyCards)
          .set({
            status: "awaiting_review",
            column: "review",
            output: input.output,
            completedAt: nowIso(),
            lockVersion: card.lockVersion + 1,
            updatedAt: nowIso(),
          })
          .where(eq(lobbyCards.id, card.id))
          .returning()
          .all();

        let nextSeat: LobbySeat | null = null;
        if (card.assignedSeatId) {
          const [seat] = tx
            .select()
            .from(lobbySeats)
            .where(eq(lobbySeats.id, card.assignedSeatId))
            .limit(1)
            .all();
          if (seat && seat.status === "busy") {
            const [updated] = tx
              .update(lobbySeats)
              .set({
                status: "idle",
                lockVersion: seat.lockVersion + 1,
                updatedAt: nowIso(),
              })
              .where(eq(lobbySeats.id, seat.id))
              .returning()
              .all();
            nextSeat = updated;
          } else {
            nextSeat = seat ?? null;
          }
        }

        return { ok: true, row: { card: nextCard, seat: nextSeat } };
      },
    );
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.card.lobbyId,
      type: "card.awaiting_review",
      actor: "system",
      cardId: result.row.card.id,
      seatId: result.row.seat?.id ?? null,
      agentRunId: input.agentRunId,
      payload: { hasOutput: input.output !== undefined },
    });
  }
  return result;
}

/**
 * `run_failed`: running → failed. Called by the orchestration layer.
 * Idempotent.
 */
export async function applyCardRunFailed(input: {
  cardId: string;
  agentRunId: string;
  failureReason: string;
}): Promise<MutationResult<{ card: LobbyCard; seat: LobbySeat | null }>> {
  const result = db
    .transaction(
      (
        tx,
      ): MutationResult<{ card: LobbyCard; seat: LobbySeat | null }> => {
        const [card] = tx
          .select()
          .from(lobbyCards)
          .where(eq(lobbyCards.id, input.cardId))
          .limit(1)
          .all();
        if (!card) {
          return {
            ok: false,
            reason: "NOT_FOUND",
            message: `Card ${input.cardId} not found.`,
          };
        }
        if (card.agentRunId !== input.agentRunId) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Card ${input.cardId} agent_run_id (${card.agentRunId ?? "null"}) does not match supplied (${input.agentRunId}).`,
          };
        }
        if (card.status === "failed") {
          const seat = card.assignedSeatId
            ? tx
                .select()
                .from(lobbySeats)
                .where(eq(lobbySeats.id, card.assignedSeatId))
                .limit(1)
                .all()[0] ?? null
            : null;
          return { ok: true, row: { card, seat } };
        }
        if (card.status !== "running") {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message: `Card ${input.cardId} is in status '${card.status}'. Required: 'running'.`,
          };
        }

        const [nextCard] = tx
          .update(lobbyCards)
          .set({
            status: "failed",
            column: "blocked",
            failureReason: input.failureReason,
            completedAt: nowIso(),
            lockVersion: card.lockVersion + 1,
            updatedAt: nowIso(),
          })
          .where(eq(lobbyCards.id, card.id))
          .returning()
          .all();

        let nextSeat: LobbySeat | null = null;
        if (card.assignedSeatId) {
          const [seat] = tx
            .select()
            .from(lobbySeats)
            .where(eq(lobbySeats.id, card.assignedSeatId))
            .limit(1)
            .all();
          if (seat && seat.status === "busy") {
            const [updated] = tx
              .update(lobbySeats)
              .set({
                status: "idle",
                lockVersion: seat.lockVersion + 1,
                updatedAt: nowIso(),
              })
              .where(eq(lobbySeats.id, seat.id))
              .returning()
              .all();
            nextSeat = updated;
          } else {
            nextSeat = seat ?? null;
          }
        }

        return { ok: true, row: { card: nextCard, seat: nextSeat } };
      },
    );
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.card.lobbyId,
      type: "card.failed",
      actor: "system",
      cardId: result.row.card.id,
      seatId: result.row.seat?.id ?? null,
      agentRunId: input.agentRunId,
      payload: { failureReason: input.failureReason },
    });
  }
  return result;
}

/**
 * `cancel`: any non-terminal → cancelled. Used by the captain (and lobby
 * abort, but that path goes through `transitionLobbyAbort`).
 */
export async function transitionCardCancel(input: {
  cardId: string;
  expectedCardVersion: number;
  reason?: string;
}): Promise<MutationResult<{ card: LobbyCard; seat: LobbySeat | null }>> {
  const result = db
    .transaction(
      (
        tx,
      ): MutationResult<{ card: LobbyCard; seat: LobbySeat | null }> => {
        const [card] = tx
          .select()
          .from(lobbyCards)
          .where(eq(lobbyCards.id, input.cardId))
          .limit(1)
          .all();
        if (!card) {
          return {
            ok: false,
            reason: "NOT_FOUND",
            message: `Card ${input.cardId} not found.`,
          };
        }
        if (card.lockVersion !== input.expectedCardVersion) {
          return {
            ok: false,
            reason: "VERSION_CONFLICT",
            message: `Card ${input.cardId} is at version ${card.lockVersion}, expected ${input.expectedCardVersion}.`,
            currentVersion: card.lockVersion,
          };
        }
        if (
          ["approved", "rejected", "failed", "cancelled"].includes(card.status)
        ) {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message: `Cannot cancel card in terminal status '${card.status}'.`,
          };
        }

        const [nextCard] = tx
          .update(lobbyCards)
          .set({
            status: "cancelled",
            column: "blocked",
            failureReason: input.reason ?? null,
            completedAt: nowIso(),
            lockVersion: card.lockVersion + 1,
            updatedAt: nowIso(),
          })
          .where(eq(lobbyCards.id, card.id))
          .returning()
          .all();

        let nextSeat: LobbySeat | null = null;
        if (card.assignedSeatId) {
          const [seat] = tx
            .select()
            .from(lobbySeats)
            .where(eq(lobbySeats.id, card.assignedSeatId))
            .limit(1)
            .all();
          if (seat && seat.status === "busy") {
            const [updated] = tx
              .update(lobbySeats)
              .set({
                status: "idle",
                lockVersion: seat.lockVersion + 1,
                updatedAt: nowIso(),
              })
              .where(eq(lobbySeats.id, seat.id))
              .returning()
              .all();
            nextSeat = updated;
          } else {
            nextSeat = seat ?? null;
          }
        }

        return { ok: true, row: { card: nextCard, seat: nextSeat } };
      },
    );
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.card.lobbyId,
      type: "card.cancelled",
      actor: "captain",
      cardId: result.row.card.id,
      seatId: result.row.seat?.id ?? null,
      payload: { reason: input.reason ?? null },
    });
  }
  return result;
}

/**
 * `approve`: awaiting_review → approved. Captain-driven. After approval,
 * downstream cards may become ready — runs `recomputeReadyCardsInTx` and
 * emits `card.ready` events for any newly promoted cards.
 */
export async function transitionCardApprove(input: {
  cardId: string;
  expectedCardVersion: number;
  userId: string;
  notes?: string;
}): Promise<
  MutationResult<{ card: LobbyCard; readyCardIds: string[] }>
> {
  const result = db
    .transaction(
      (tx): MutationResult<{ card: LobbyCard; readyCardIds: string[] }> => {
        const [card] = tx
          .select()
          .from(lobbyCards)
          .where(eq(lobbyCards.id, input.cardId))
          .limit(1)
          .all();
        if (!card) {
          return {
            ok: false,
            reason: "NOT_FOUND",
            message: `Card ${input.cardId} not found.`,
          };
        }
        if (card.lockVersion !== input.expectedCardVersion) {
          return {
            ok: false,
            reason: "VERSION_CONFLICT",
            message: `Card ${input.cardId} is at version ${card.lockVersion}, expected ${input.expectedCardVersion}.`,
            currentVersion: card.lockVersion,
          };
        }
        if (card.status !== "awaiting_review") {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message: `Cannot approve card in status '${card.status}'. Required: 'awaiting_review'.`,
          };
        }

        const [nextCard] = tx
          .update(lobbyCards)
          .set({
            status: "approved",
            column: "done",
            reviewNotes: input.notes ?? null,
            reviewedByUserId: input.userId,
            reviewedAt: nowIso(),
            lockVersion: card.lockVersion + 1,
            updatedAt: nowIso(),
          })
          .where(eq(lobbyCards.id, card.id))
          .returning()
          .all();

        const { promotedCardIds } = recomputeReadyCardsInTx({
          tx,
          lobbyId: card.lobbyId,
        });

        return {
          ok: true,
          row: { card: nextCard, readyCardIds: promotedCardIds },
        };
      },
    );
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.card.lobbyId,
      type: "card.approved",
      actor: "captain",
      actorUserId: input.userId,
      cardId: result.row.card.id,
      payload: { notes: input.notes ?? null },
    });
    for (const cardId of result.row.readyCardIds) {
      await appendLobbyEvent({
        lobbyId: result.row.card.lobbyId,
        type: "card.ready",
        actor: "system",
        cardId,
        payload: {},
      });
    }
  }
  return result;
}

/**
 * `reject`: awaiting_review → rejected. Captain-driven. Review notes are
 * required (V1 — captains must explain rejections so the agent can iterate).
 */
export async function transitionCardReject(input: {
  cardId: string;
  expectedCardVersion: number;
  userId: string;
  notes: string;
}): Promise<MutationResult<LobbyCard>> {
  if (!input.notes.trim()) {
    return {
      ok: false,
      reason: "INVARIANT_VIOLATION",
      message: "Reject requires non-empty review notes.",
    };
  }

  const result = db
    .transaction((tx): MutationResult<LobbyCard> => {
      const [card] = tx
        .select()
        .from(lobbyCards)
        .where(eq(lobbyCards.id, input.cardId))
        .limit(1)
        .all();
      if (!card) {
        return {
          ok: false,
          reason: "NOT_FOUND",
          message: `Card ${input.cardId} not found.`,
        };
      }
      if (card.lockVersion !== input.expectedCardVersion) {
        return {
          ok: false,
          reason: "VERSION_CONFLICT",
          message: `Card ${input.cardId} is at version ${card.lockVersion}, expected ${input.expectedCardVersion}.`,
          currentVersion: card.lockVersion,
        };
      }
      if (card.status !== "awaiting_review") {
        return {
          ok: false,
          reason: "INVALID_TRANSITION",
          message: `Cannot reject card in status '${card.status}'. Required: 'awaiting_review'.`,
        };
      }

      const [nextCard] = tx
        .update(lobbyCards)
        .set({
          status: "rejected",
          column: "blocked",
          reviewNotes: input.notes,
          reviewedByUserId: input.userId,
          reviewedAt: nowIso(),
          lockVersion: card.lockVersion + 1,
          updatedAt: nowIso(),
        })
        .where(eq(lobbyCards.id, card.id))
        .returning()
        .all();
      return { ok: true, row: nextCard };
    });
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.lobbyId,
      type: "card.rejected",
      actor: "captain",
      actorUserId: input.userId,
      cardId: result.row.id,
      payload: { notes: input.notes },
    });
  }
  return result;
}

/**
 * `retry`: rejected | failed → pending. Captain-driven. Clears terminal
 * fields and re-evaluates readiness via `recomputeReadyCardsInTx`.
 */
export async function transitionCardRetry(input: {
  cardId: string;
  expectedCardVersion: number;
  userId: string;
  /** When true, ignores the max_attempts cap. */
  overrideAttemptCap?: boolean;
}): Promise<MutationResult<{ card: LobbyCard; promotedToReady: boolean }>> {
  const result = db
    .transaction(
      (
        tx,
      ): MutationResult<{ card: LobbyCard; promotedToReady: boolean }> => {
        const [card] = tx
          .select()
          .from(lobbyCards)
          .where(eq(lobbyCards.id, input.cardId))
          .limit(1)
          .all();
        if (!card) {
          return {
            ok: false,
            reason: "NOT_FOUND",
            message: `Card ${input.cardId} not found.`,
          };
        }
        if (card.lockVersion !== input.expectedCardVersion) {
          return {
            ok: false,
            reason: "VERSION_CONFLICT",
            message: `Card ${input.cardId} is at version ${card.lockVersion}, expected ${input.expectedCardVersion}.`,
            currentVersion: card.lockVersion,
          };
        }
        if (!["rejected", "failed"].includes(card.status)) {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message: `Cannot retry card in status '${card.status}'. Required: 'rejected' or 'failed'.`,
          };
        }
        if (
          !input.overrideAttemptCap &&
          card.attemptCount >= card.maxAttempts
        ) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Card ${input.cardId} has reached its max attempt count (${card.maxAttempts}). Override required.`,
          };
        }
        if (!card.assignedSeatId) {
          return {
            ok: false,
            reason: "INVARIANT_VIOLATION",
            message: `Card ${input.cardId} has no assigned seat.`,
          };
        }

        const [nextCard] = tx
          .update(lobbyCards)
          .set({
            status: "pending",
            column: "backlog",
            failureReason: null,
            reviewNotes: null,
            reviewedByUserId: null,
            reviewedAt: null,
            output: null,
            agentRunId: null,
            startedAt: null,
            completedAt: null,
            lockVersion: card.lockVersion + 1,
            updatedAt: nowIso(),
          })
          .where(eq(lobbyCards.id, card.id))
          .returning()
          .all();

        const { promotedCardIds } = recomputeReadyCardsInTx({
          tx,
          lobbyId: card.lobbyId,
        });

        return {
          ok: true,
          row: {
            card: nextCard,
            promotedToReady: promotedCardIds.includes(nextCard.id),
          },
        };
      },
    );
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.card.lobbyId,
      type: "card.retry_requested",
      actor: "captain",
      actorUserId: input.userId,
      cardId: result.row.card.id,
      payload: { promotedToReady: result.row.promotedToReady },
    });
  }
  return result;
}

/**
 * `reopen`: approved → pending. Captain-driven. Marks downstream approved
 * cards as `stale` so the synthesizer (and the captain) know their outputs
 * may no longer be consistent. Use `cancelDependents=true` to also cancel
 * any currently running dependents.
 */
export async function transitionCardReopen(input: {
  cardId: string;
  expectedCardVersion: number;
  userId: string;
  cancelDependents?: boolean;
}): Promise<
  MutationResult<{ card: LobbyCard; staledCardIds: string[] }>
> {
  const result = db
    .transaction(
      (tx): MutationResult<{ card: LobbyCard; staledCardIds: string[] }> => {
        const [card] = tx
          .select()
          .from(lobbyCards)
          .where(eq(lobbyCards.id, input.cardId))
          .limit(1)
          .all();
        if (!card) {
          return {
            ok: false,
            reason: "NOT_FOUND",
            message: `Card ${input.cardId} not found.`,
          };
        }
        if (card.lockVersion !== input.expectedCardVersion) {
          return {
            ok: false,
            reason: "VERSION_CONFLICT",
            message: `Card ${input.cardId} is at version ${card.lockVersion}, expected ${input.expectedCardVersion}.`,
            currentVersion: card.lockVersion,
          };
        }
        if (card.status !== "approved") {
          return {
            ok: false,
            reason: "INVALID_TRANSITION",
            message: `Cannot reopen card in status '${card.status}'. Required: 'approved'.`,
          };
        }

        // Find direct + transitive dependents.
        const allDeps = tx
          .select()
          .from(lobbyCardDependencies)
          .where(eq(lobbyCardDependencies.lobbyId, card.lobbyId))
          .all();
        const dependentsByTarget = new Map<string, string[]>();
        for (const d of allDeps) {
          const list = dependentsByTarget.get(d.dependsOnCardId) ?? [];
          list.push(d.cardId);
          dependentsByTarget.set(d.dependsOnCardId, list);
        }

        const reachable = new Set<string>();
        const stack = [card.id];
        while (stack.length > 0) {
          const id = stack.pop()!;
          const deps = dependentsByTarget.get(id) ?? [];
          for (const depCard of deps) {
            if (!reachable.has(depCard)) {
              reachable.add(depCard);
              stack.push(depCard);
            }
          }
        }

        if (reachable.size > 0) {
          const reachableArr = Array.from(reachable);
          const dependents = tx
            .select()
            .from(lobbyCards)
            .where(inArray(lobbyCards.id, reachableArr))
            .all();
          for (const dep of dependents) {
            if (dep.status === "running" && !input.cancelDependents) {
              return {
                ok: false,
                reason: "INVARIANT_VIOLATION",
                message: `Card ${dep.id} (dependent on ${input.cardId}) is currently running. Pass cancelDependents=true to force.`,
              };
            }
          }
        }

        const staledCardIds: string[] = [];
        if (reachable.size > 0) {
          const reachableArr = Array.from(reachable);
          const dependents = tx
            .select()
            .from(lobbyCards)
            .where(inArray(lobbyCards.id, reachableArr))
            .all();
          for (const dep of dependents) {
            if (dep.status === "approved") {
              const stamped: LobbyCardOutputV1 = {
                ...((dep.output as LobbyCardOutputV1 | null) ?? {}),
                stale: true,
              };
              tx.update(lobbyCards)
                .set({
                  output: stamped,
                  lockVersion: dep.lockVersion + 1,
                  updatedAt: nowIso(),
                })
                .where(eq(lobbyCards.id, dep.id))
                .run();
              staledCardIds.push(dep.id);
            }
            if (dep.status === "running" && input.cancelDependents) {
              tx.update(lobbyCards)
                .set({
                  status: "cancelled",
                  column: "blocked",
                  completedAt: nowIso(),
                  lockVersion: dep.lockVersion + 1,
                  updatedAt: nowIso(),
                })
                .where(eq(lobbyCards.id, dep.id))
                .run();
            }
          }
        }

        const [nextCard] = tx
          .update(lobbyCards)
          .set({
            status: "pending",
            column: "backlog",
            output: null,
            failureReason: null,
            reviewNotes: null,
            reviewedByUserId: null,
            reviewedAt: null,
            agentRunId: null,
            startedAt: null,
            completedAt: null,
            lockVersion: card.lockVersion + 1,
            updatedAt: nowIso(),
          })
          .where(eq(lobbyCards.id, card.id))
          .returning()
          .all();

        recomputeReadyCardsInTx({ tx, lobbyId: card.lobbyId });

        return { ok: true, row: { card: nextCard, staledCardIds } };
      },
    );
  if (result.ok) {
    await appendLobbyEvent({
      lobbyId: result.row.card.lobbyId,
      type: "card.reopened",
      actor: "captain",
      actorUserId: input.userId,
      cardId: result.row.card.id,
      payload: {
        cancelDependents: input.cancelDependents ?? false,
        staledCardIds: result.row.staledCardIds,
      },
    });
  }
  return result;
}

/**
 * Solo Story Mode — shared TypeScript contracts.
 *
 * Single source of truth for the JSON shapes stored in the lobby tables and
 * for the metadata snapshot attached to `agent_runs.metadata.soloStory`.
 *
 * All shapes are versioned so future migrations can fan out without breaking
 * existing rows. V1 is the only shape that ships with this feature.
 *
 * Constraints (from lib/lobbies/SPEC.md §3):
 *   - Permission scope V1 is tool-list only.
 *   - Card output is JSON in the LobbyCardOutputV1 shape — the synthesizer
 *     reads this exact shape across all approved cards.
 *   - Seat permission scope is snapshotted into `agent_runs.metadata.soloStory`
 *     at card start so mid-execution scope changes don't affect in-flight runs.
 */

/**
 * Per-seat permission scope V1.
 *
 * Mirrors `permissionScopeV1Schema` in lib/lobbies/api-helpers.ts. The route
 * layer validates with zod; this type is what TS code actually uses to
 * read/write the field.
 *
 * - `allowedFolderIds`: schema stub for V1.1+ folder scoping (SPEC §3 #6).
 *   Stored in V1, not yet enforced by the tool gate.
 */
export type LobbyPermissionScopeV1 = {
  version: 1;
  mode: "tool_list";
  allowedTools: string[];
  deniedTools?: string[];
  allowedFolderIds?: string[];
};

/**
 * Lobby configuration JSON stored at `lobbies.config`.
 *
 * Field names MUST match `lobbyConfigV1Schema` in lib/lobbies/api-helpers.ts —
 * any drift here breaks the route validator silently (zod strips unknown
 * fields and the server falls back to defaults).
 *
 * - `maxParallel`: max in-flight `running` cards in the rolling phase.
 * - `defaultMaxAttempts`: default `attempts` cap when a card is created
 *   without an explicit `maxAttempts`.
 * - `plannerCharacterId` / `synthesizerCharacterId`: pin which Selene
 *   character drives the planner / synthesizer runs (Selene's table is
 *   `characters`, not `agents` — keep the name canonical here).
 * - `plannerPromptOverride` / `synthesisPromptOverride`: optional prompt
 *   override strings; consumed by services.ts when starting the planner /
 *   synthesizer runs.
 */
export type LobbyConfigV1 = {
  version: 1;
  maxParallel?: number;
  defaultMaxAttempts?: number;
  plannerCharacterId?: string;
  synthesizerCharacterId?: string;
  plannerPromptOverride?: string;
  synthesisPromptOverride?: string;
};

/**
 * Note on `agentId` vs `characterId` (Sprint 5.1 review reconciliation):
 *
 * `LobbyConfigV1` was renamed `plannerAgentId → plannerCharacterId` and
 * `synthesizerAgentId → synthesizerCharacterId` to match Selene's actual
 * `characters` table. The seat surface, however, deliberately keeps
 * `agentId` here because:
 *
 *   1. The underlying SQL column is `lobby_seats.agent_id` (`characters.id` FK).
 *      Renaming the field without renaming the column would diverge the TS
 *      shape from the DB schema — worse than the half-migrated terminology.
 *   2. Migration cost: the column is referenced in queries, services, scope
 *      injection, and a future seat-history table; a rename ripples.
 *
 * The field IS a character id — the name is a legacy nod to the column.
 * A future migration may rename `lobby_seats.agent_id` to `character_id` and
 * flip this field with it. Until then, this is the agreed compromise.
 */
export type LobbyTemplateSeatV1 = {
  role: string;
  required: boolean;
  position: number;
  /** FK → `characters.id`; field name matches `lobby_seats.agent_id`. */
  agentId?: string;
  permissionScope: LobbyPermissionScopeV1;
};

export type LobbyCardAcceptanceCriterionV1 = {
  id: string;
  text: string;
  required?: boolean;
};

export type LobbyCardArtifactV1 = {
  id?: string;
  kind: "text" | "file" | "url" | "image" | "other";
  title?: string;
  url?: string;
  metadata?: Record<string, unknown>;
};

export type LobbyCardOutputV1 = {
  summary?: string;
  artifacts?: LobbyCardArtifactV1[];
  raw?: unknown;
  /**
   * Set when an upstream card is reopened/retried after this card has already
   * been approved — signals the synthesizer (and the captain) that this card's
   * output may no longer be consistent with its dependencies.
   */
  stale?: boolean;
};

export type SoloStoryRunRole = "planner" | "worker" | "synthesizer";

/**
 * Snapshot stored at `agent_runs.metadata.soloStory` for every Solo Story
 * run. Captures everything needed to (1) route SSE events back to the lobby
 * and (2) enforce the seat's permission scope without re-reading the live
 * `lobby_seats.permission_scope` (which may have changed mid-run).
 */
export type SoloStoryRunMetadata = {
  soloStory: {
    lobbyId: string;
    cardId?: string;
    seatId?: string;
    role: SoloStoryRunRole;
    permissionScope: LobbyPermissionScopeV1;
    permissionScopeSnapshotAt: string;
  };
};

// ---------------------------------------------------------------------------
// Enum string-literal unions — match the CHECK constraints in
// lib/db/migrations/lobbies-tables.ts AND the `enum: [...]` lists in
// lib/db/sqlite-lobbies-schema.ts. Keep all three in lockstep.
// ---------------------------------------------------------------------------

export type LobbyStatus =
  | "roster"
  | "planning"
  | "rolling"
  | "review"
  | "completed"
  | "aborted";

export type LobbyTemplateVisibility = "private" | "public";

export type LobbySeatStatus = "empty" | "ready" | "busy" | "idle";

export type LobbyCardColumn =
  | "backlog"
  | "ready"
  | "in_progress"
  | "review"
  | "done"
  | "blocked";

export type LobbyCardStatus =
  | "pending"
  | "running"
  | "awaiting_review"
  | "approved"
  | "rejected"
  | "failed"
  | "cancelled";

export type LobbyCardCreator = "planner" | "human";

export type LobbyEventActor = "captain" | "agent" | "system";

// ---------------------------------------------------------------------------
// Mutation result envelope — shared between the repository layer
// (lib/lobbies/queries.ts), the route layer (lib/lobbies/api-helpers.ts), and
// the client typed-fetcher layer (lib/lobbies/client/api.ts).
//
// Hoisted here so the client never has to import from `queries.ts` (which
// would pull the drizzle bundle into the browser chunk graph).
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

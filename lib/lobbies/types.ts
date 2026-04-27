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

export type LobbyPermissionScopeV1 = {
  version: 1;
  mode: "tool_list";
  allowedTools: string[];
  deniedTools?: string[];
  notes?: string;
};

export type LobbyConfigV1 = {
  version: 1;
  maxParallelCards?: number;
  plannerAgentId?: string;
  synthesizerAgentId?: string;
  plannerPromptOverride?: string;
  synthesisPromptOverride?: string;
};

export type LobbyTemplateSeatV1 = {
  role: string;
  required: boolean;
  position: number;
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

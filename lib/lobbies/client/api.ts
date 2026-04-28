/**
 * Solo Story Mode — typed fetcher wrappers around the lobby API routes.
 *
 * One thin function per route. All errors are surfaced as a structured
 * `LobbyApiError` (with `reason`, `currentVersion?`, `status`) so callers can
 * distinguish a 409 VERSION_CONFLICT from a 404 NOT_FOUND without re-parsing
 * envelopes. Successful calls return the route's typed payload.
 *
 * Why we layer on `resilientFetch`:
 *   - Auto timeout + exponential backoff retry for 5xx and network blips.
 *   - Single place that handles JSON parse failures.
 *   - Lets us forward an external `AbortSignal` from `useEffect` cleanup.
 *
 * SPEC §6 (route table) and §3 (HARD CONSTRAINT: no TanStack Query / SWR).
 */
import {
  resilientFetch,
  resilientPost,
  resilientPatch,
  resilientPut,
} from "@/lib/utils/resilient-fetch";
import type {
  Lobby,
  LobbyCard,
  LobbyCardDependency,
  LobbyEvent,
  LobbySeat,
  LobbyTemplate,
} from "@/lib/db/sqlite-lobbies-schema";
import type {
  LobbyCardAcceptanceCriterionV1,
  LobbyCardColumn,
  LobbyCardStatus,
  LobbyConfigV1,
  LobbyPermissionScopeV1,
  LobbyStatus,
  LobbyTemplateSeatV1,
} from "@/lib/lobbies/types";
import type { MutationFailureReason } from "@/lib/lobbies/queries";

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/**
 * Thrown by every helper in this file when the underlying request did not
 * succeed. Mirrors the server-side `MutationFailure` shape so the caller can
 * react to specific failure reasons (e.g., 409 → refetch and retry).
 */
export class LobbyApiError extends Error {
  readonly reason: MutationFailureReason | "NETWORK" | "TIMEOUT" | "UNKNOWN";
  readonly status?: number;
  readonly currentVersion?: number;

  constructor(opts: {
    message: string;
    reason: MutationFailureReason | "NETWORK" | "TIMEOUT" | "UNKNOWN";
    status?: number;
    currentVersion?: number;
  }) {
    super(opts.message);
    this.name = "LobbyApiError";
    this.reason = opts.reason;
    this.status = opts.status;
    this.currentVersion = opts.currentVersion;
  }
}

type ResilientResult<T> = Awaited<ReturnType<typeof resilientFetch<T>>>;

function classifyStatus(status: number | undefined): LobbyApiError["reason"] {
  if (status === undefined) return "NETWORK";
  if (status === 404) return "NOT_FOUND";
  if (status === 403) return "FORBIDDEN";
  if (status === 409) return "VERSION_CONFLICT";
  if (status === 422) return "INVALID_TRANSITION";
  return "UNKNOWN";
}

/**
 * Inspect the server's JSON envelope (when present) to recover the structured
 * `MutationFailure` shape — the route layer's `mapMutationResult` writes
 * `{ error, reason, currentVersion? }` for 409s and similar.
 */
async function unwrap<T>(
  promise: Promise<ResilientResult<T | LobbyEnvelopeFailure>>,
  fallbackMessage: string,
): Promise<T> {
  const result = await promise;
  if (result.error === null && result.data !== null) {
    return result.data as T;
  }
  if (result.error === null && result.data === null) {
    // 204/empty body — caller didn't expect this. Treat as unknown.
    throw new LobbyApiError({
      message: fallbackMessage,
      reason: "UNKNOWN",
      status: result.status,
    });
  }
  if (result.timedOut) {
    throw new LobbyApiError({
      message: result.error ?? "Request timed out",
      reason: "TIMEOUT",
    });
  }
  // Try to extract structured failure from data
  const envelope = (result.data ?? null) as LobbyEnvelopeFailure | null;
  const reason: LobbyApiError["reason"] =
    envelope?.reason ?? classifyStatus(result.status);
  throw new LobbyApiError({
    message: result.error ?? envelope?.error ?? fallbackMessage,
    reason,
    status: result.status,
    currentVersion: envelope?.currentVersion,
  });
}

/** Server failure envelope shape (mirrors `mapMutationResult`). */
type LobbyEnvelopeFailure = {
  error?: string;
  reason?: MutationFailureReason;
  currentVersion?: number;
};

// ---------------------------------------------------------------------------
// Types returned by the routes
// ---------------------------------------------------------------------------

export type LobbyDetailResponse = {
  lobby: Lobby;
  seats: LobbySeat[];
  cards: LobbyCard[];
  dependencies: LobbyCardDependency[];
};

export type ListLobbiesResponse = {
  lobbies: Lobby[];
  nextCursor: string | null;
};

export type ListEventsResponse = {
  events: LobbyEvent[];
};

export type CreateLobbyResponse = {
  lobby: Lobby;
  seats: LobbySeat[];
  sessionId: string;
};

export type ListTemplatesResponse = {
  templates: LobbyTemplate[];
};

export type CreateTemplateResponse = { template: LobbyTemplate };

// ---------------------------------------------------------------------------
// Lobby root
// ---------------------------------------------------------------------------

export type ListLobbiesParams = {
  status?: LobbyStatus;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
};

export async function listLobbies(
  params: ListLobbiesParams = {},
): Promise<ListLobbiesResponse> {
  const url = new URL("/api/lobbies", window.location.origin);
  if (params.status) url.searchParams.set("status", params.status);
  if (params.cursor) url.searchParams.set("cursor", params.cursor);
  if (params.limit !== undefined)
    url.searchParams.set("limit", String(params.limit));

  return unwrap(
    resilientFetch<ListLobbiesResponse>(url.toString(), {
      method: "GET",
      signal: params.signal,
    }),
    "Failed to list lobbies",
  );
}

export type CreateLobbyBody = {
  title: string;
  goal: string;
  templateId?: string;
  config?: LobbyConfigV1;
  seats?: Array<{
    role: string;
    position: number;
    agentId?: string;
    permissionScope?: LobbyPermissionScopeV1;
  }>;
};

export async function createLobby(
  body: CreateLobbyBody,
): Promise<CreateLobbyResponse> {
  return unwrap(
    resilientPost<CreateLobbyResponse>("/api/lobbies", body),
    "Failed to create lobby",
  );
}

// ---------------------------------------------------------------------------
// Lobby detail
// ---------------------------------------------------------------------------

export async function getLobbyDetail(
  lobbyId: string,
  signal?: AbortSignal,
): Promise<LobbyDetailResponse> {
  return unwrap(
    resilientFetch<LobbyDetailResponse>(`/api/lobbies/${lobbyId}`, {
      method: "GET",
      signal,
    }),
    "Failed to load lobby",
  );
}

export type UpdateLobbyBody = {
  expectedVersion: number;
  patch: {
    title?: string;
    goal?: string;
    config?: LobbyConfigV1;
  };
};

export async function updateLobby(
  lobbyId: string,
  body: UpdateLobbyBody,
): Promise<{ lobby: Lobby }> {
  return unwrap(
    resilientPatch<{ lobby: Lobby }>(`/api/lobbies/${lobbyId}`, body),
    "Failed to update lobby",
  );
}

// ---------------------------------------------------------------------------
// Lobby transition
// ---------------------------------------------------------------------------

export type LobbyTransitionBody =
  | {
      action: "ready_roster";
      expectedVersion: number;
      plannerScope?: LobbyPermissionScopeV1;
      plannerCharacterId?: string;
    }
  | { action: "accept_plan"; expectedVersion: number }
  | { action: "enter_review"; expectedVersion: number }
  | {
      action: "start_synthesis";
      expectedVersion: number;
      synthesizerScope?: LobbyPermissionScopeV1;
      synthesizerCharacterId?: string;
    }
  | {
      action: "complete_synthesis";
      expectedVersion: number;
      synthesisRunId: string;
      outputArtifactId: string;
    }
  | {
      action: "abort";
      expectedVersion: number;
      mode?: "cancel" | "wait" | "abandon";
      reason?: string;
    };

export async function transitionLobby(
  lobbyId: string,
  body: LobbyTransitionBody,
): Promise<unknown> {
  return unwrap(
    resilientPost<unknown>(
      `/api/lobbies/${lobbyId}/transition`,
      body,
    ),
    "Failed to transition lobby",
  );
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

export type ReplaceSeatsBody = {
  expectedLobbyVersion: number;
  seats: Array<{
    role: string;
    position: number;
    agentId?: string | null;
    permissionScope?: LobbyPermissionScopeV1;
    status?: "empty" | "ready" | "busy" | "idle";
  }>;
};

export async function replaceSeats(
  lobbyId: string,
  body: ReplaceSeatsBody,
): Promise<{ seats: LobbySeat[]; lobby: Lobby }> {
  return unwrap(
    resilientPut<{ seats: LobbySeat[]; lobby: Lobby }>(
      `/api/lobbies/${lobbyId}/seats`,
      body,
    ),
    "Failed to replace seats",
  );
}

export type UpdateSeatBody = {
  expectedVersion: number;
  patch: {
    role?: string;
    agentId?: string | null;
    position?: number;
    permissionScope?: LobbyPermissionScopeV1;
    status?: "empty" | "ready" | "busy" | "idle";
  };
};

export async function updateSeat(
  lobbyId: string,
  seatId: string,
  body: UpdateSeatBody,
): Promise<{ seat: LobbySeat }> {
  return unwrap(
    resilientPatch<{ seat: LobbySeat }>(
      `/api/lobbies/${lobbyId}/seats/${seatId}`,
      body,
    ),
    "Failed to update seat",
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export type ListCardsParams = {
  status?: LobbyCardStatus;
  column?: LobbyCardColumn;
  signal?: AbortSignal;
};

export async function listCards(
  lobbyId: string,
  params: ListCardsParams = {},
): Promise<{ cards: LobbyCard[] }> {
  const url = new URL(
    `/api/lobbies/${lobbyId}/cards`,
    window.location.origin,
  );
  if (params.status) url.searchParams.set("status", params.status);
  if (params.column) url.searchParams.set("column", params.column);

  return unwrap(
    resilientFetch<{ cards: LobbyCard[] }>(url.toString(), {
      method: "GET",
      signal: params.signal,
    }),
    "Failed to list cards",
  );
}

export type CreateCardBody = {
  title: string;
  description?: string;
  acceptanceCriteria?: LobbyCardAcceptanceCriterionV1[];
  assignedSeatId?: string | null;
  position?: number;
  column?: LobbyCardColumn;
  status?: LobbyCardStatus;
  maxAttempts?: number;
};

export async function createCard(
  lobbyId: string,
  body: CreateCardBody,
): Promise<{ card: LobbyCard }> {
  return unwrap(
    resilientPost<{ card: LobbyCard }>(
      `/api/lobbies/${lobbyId}/cards`,
      body,
    ),
    "Failed to create card",
  );
}

export type UpdateCardBody = {
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

export async function updateCard(
  lobbyId: string,
  cardId: string,
  body: UpdateCardBody,
): Promise<{ card: LobbyCard }> {
  return unwrap(
    resilientPatch<{ card: LobbyCard }>(
      `/api/lobbies/${lobbyId}/cards/${cardId}`,
      body,
    ),
    "Failed to update card",
  );
}

export type CardTransitionBody =
  | { action: "start"; expectedVersion: number }
  | {
      action: "cancel";
      expectedVersion: number;
      reason?: string;
    }
  | { action: "approve"; expectedVersion: number; notes?: string }
  | { action: "reject"; expectedVersion: number; notes: string }
  | {
      action: "retry";
      expectedVersion: number;
      overrideAttemptCap?: boolean;
    }
  | {
      action: "reopen";
      expectedVersion: number;
      cancelDependents?: boolean;
    };

export async function transitionCard(
  lobbyId: string,
  cardId: string,
  body: CardTransitionBody,
): Promise<unknown> {
  return unwrap(
    resilientPost<unknown>(
      `/api/lobbies/${lobbyId}/cards/${cardId}/transition`,
      body,
    ),
    "Failed to transition card",
  );
}

export type ReplaceDependenciesBody = {
  dependencies: Array<{ dependsOnCardId: string; optional?: boolean }>;
};

export async function replaceDependencies(
  lobbyId: string,
  cardId: string,
  body: ReplaceDependenciesBody,
): Promise<{ dependencies: LobbyCardDependency[] }> {
  return unwrap(
    resilientPut<{ dependencies: LobbyCardDependency[] }>(
      `/api/lobbies/${lobbyId}/cards/${cardId}/dependencies`,
      body,
    ),
    "Failed to replace card dependencies",
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ListEventsParams = {
  afterSequence?: number;
  limit?: number;
  signal?: AbortSignal;
};

export async function listLobbyEvents(
  lobbyId: string,
  params: ListEventsParams = {},
): Promise<ListEventsResponse> {
  const url = new URL(
    `/api/lobbies/${lobbyId}/events`,
    window.location.origin,
  );
  if (params.afterSequence !== undefined)
    url.searchParams.set("afterSequence", String(params.afterSequence));
  if (params.limit !== undefined)
    url.searchParams.set("limit", String(params.limit));

  return unwrap(
    resilientFetch<ListEventsResponse>(url.toString(), {
      method: "GET",
      signal: params.signal,
    }),
    "Failed to list lobby events",
  );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listLobbyTemplates(
  signal?: AbortSignal,
): Promise<ListTemplatesResponse> {
  return unwrap(
    resilientFetch<ListTemplatesResponse>("/api/lobby-templates", {
      method: "GET",
      signal,
    }),
    "Failed to list lobby templates",
  );
}

export type CreateTemplateBody = {
  name: string;
  description?: string | null;
  defaultSeats: LobbyTemplateSeatV1[];
  planningPrompt: string;
  synthesisPrompt: string;
  config?: Partial<LobbyConfigV1>;
};

export async function createLobbyTemplate(
  body: CreateTemplateBody,
): Promise<CreateTemplateResponse> {
  return unwrap(
    resilientPost<CreateTemplateResponse>("/api/lobby-templates", body),
    "Failed to create lobby template",
  );
}

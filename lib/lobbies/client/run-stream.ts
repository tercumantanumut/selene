"use client";

/**
 * useLobbyRunStream — page-scoped SSE consumer for the lobby workspace.
 *
 * SPEC §3 #7 + §8: we reuse `/api/tasks/events` instead of creating a
 * lobby-specific endpoint. The shared event stream tags Solo Story tasks
 * with `lobbyId` (and `cardId` for worker runs); this hook subscribes once
 * per active lobby page and routes the relevant events into a per-card
 * `RunStreamState` map that the rolling/review UIs can consume.
 *
 * Why a separate EventSource and not a piggy-back on `useTaskNotifications`?
 *
 *   - That hook lives at the app shell level. It maintains
 *     `useUnifiedTasksStore`, which only keeps the *latest* task snapshot —
 *     no fragment history. A captain reviewing a 30-message worker run
 *     needs the timeline, not just "current activity".
 *   - The browser allows multiple EventSources to the same URL. The server
 *     subscribes each connection independently; the only cost is duplicate
 *     bandwidth, which is bounded (server already throttles progress at
 *     300ms per run).
 *   - Keeping the lobby's SSE pipeline a leaf hook with no global side
 *     effects means an unmounted lobby page tears its subscription down
 *     immediately — no leaked closures into the shell store.
 *
 * Reconnect is intentionally lighter than `useTaskNotifications`: that
 * hook handles app-level reconnect with exponential backoff + reconciliation
 * against `/api/tasks/active`. Here we reconnect after a small delay on
 * `onerror` and rely on the parent's `useLobbyDetail.refetch` to reconcile
 * any state we missed during the gap (the parent already calls refetch on
 * card completion via `onCardCompleted`).
 *
 * No `useUnifiedTasksStore` mutations from this hook — that's the shell's
 * job. Stay in our lane.
 */

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  TaskEvent,
  TaskProgressEvent,
  UnifiedTask,
} from "@/lib/background-tasks/types";
import type {
  SoloStoryLobbyLevelRole,
  SoloStoryRunRole,
} from "@/lib/lobbies/types";

/**
 * Sprint 9.1 (R4 H1): runtime allow-list for {@link SoloStoryRunRole}. Used
 * to validate the role string we read from `task.metadata.soloStory.role`,
 * which crosses a wire boundary (server → SSE → JSON.parse → here) and
 * therefore cannot be trusted on its TypeScript type alone. A typo or
 * server-side schema drift would otherwise route the slot under an
 * invalid key and silently strand the live transcript forever.
 */
const VALID_ROLES = new Set<SoloStoryRunRole>([
  "planner",
  "worker",
  "synthesizer",
]);

// ─── Types ────────────────────────────────────────────────────────────────

export type RunStreamPhase =
  | "idle"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RunStreamFragment = {
  /** Stable id within this stream — `${runId}:${seq}`. */
  id: string;
  /** Server timestamp (ISO). Falls back to client `Date.now()` if missing. */
  timestamp: string;
  /** Latest `progressText` for this fragment. */
  text?: string;
  /**
   * 0..1. Optional. Captain UI only renders this when the worker emits
   * meaningful percent updates (rare for chat workers).
   */
  percent?: number;
  /**
   * Number of underlying chat-content parts that backed this progress
   * snapshot. Surfaced as "+N events" so the captain sees the run is
   * making progress even when `text` is empty (e.g. silent tool calls).
   */
  contentCount?: number;
};

export type RunStreamState = {
  /** Run row id (from `agent_runs.runId`). */
  runId: string;
  /** Lobby id this run belongs to. Sanity check; always equals `lobbyId`. */
  lobbyId: string;
  /**
   * Card id this run is executing. Undefined for lobby-level runs (planner
   * and synthesizer): those are tagged with `lobbyId` only.
   */
  cardId?: string;
  /**
   * Solo Story role for this run. Lobby-level runs (no `cardId`) use this
   * to bucket into `byRole`. Worker runs (with `cardId`) carry "worker".
   */
  role?: SoloStoryRunRole;
  /** Lifecycle phase. Mapped from TaskStatus. */
  phase: RunStreamPhase;
  /** First-seen-at timestamp (ISO). */
  startedAt: string;
  /** Last event-at timestamp (ISO). */
  lastEventAt: string;
  /** Latest progress text — convenience pointer at `fragments[last].text`. */
  latestText?: string;
  /** Ordered fragment timeline. Newest at the end. */
  fragments: RunStreamFragment[];
  /** Final error message when phase = failed. */
  error?: string;
};

export type LobbyRunStreamHandle = {
  /** Map<cardId, RunStreamState>. Snapshot — render against this directly. */
  byCardId: ReadonlyMap<string, RunStreamState>;
  /**
   * Lobby-level runs keyed by Solo Story role. The planner banner and the
   * synthesis section subscribe to this slice. Worker runs are NOT mirrored
   * here — they live in `byCardId` (a single lobby can have many concurrent
   * worker runs, one per card; planner/synthesizer are singletons per phase).
   */
  /**
   * Sprint 9.1 (R4 M1): narrowed from `SoloStoryRunRole` to
   * {@link SoloStoryLobbyLevelRole} so consumers can't accidentally call
   * `byRole.get("worker")` and silently get `undefined`. Worker runs always
   * live in `byCardId`; the type now matches that invariant.
   */
  byRole: ReadonlyMap<SoloStoryLobbyLevelRole, RunStreamState>;
  /** True when the EventSource is open. */
  isConnected: boolean;
  /** Number of completed runs since mount (informational; not for refetch gating). */
  completedCount: number;
};

export type UseLobbyRunStreamOptions = {
  /** Latest persisted lobby.synthesisRunId, used to recover role routing on reconnect. */
  synthesisRunId?: string | null;
  /**
   * Fired once per `task:completed` for a worker run (carrying `cardId`).
   * The parent should call `useLobbyDetail.refetch()` here so card status /
   * output / lockVersion land authoritatively. We deliberately don't
   * refetch from inside the hook to keep server fetch ownership in the
   * parent (SPEC §3 #6 = no global refetch authority).
   */
  onCardCompleted?: (cardId: string, runId: string, succeeded: boolean) => void;
  /**
   * Fired once per `task:completed` for a lobby-level run (planner or
   * synthesizer — `cardId` absent). The parent typically refetches here
   * too: planner completion creates new card rows; synthesizer completion
   * may flip the lobby to `completed`.
   */
  onRoleRunCompleted?: (
    role: SoloStoryLobbyLevelRole,
    runId: string,
    succeeded: boolean,
  ) => void;
};

// ─── Internal: SSE wire shape ─────────────────────────────────────────────

type SseEnvelope = {
  type:
    | "connected"
    | "heartbeat"
    | "task:started"
    | "task:completed"
    | "task:progress";
  data?: TaskEvent;
  timestamp?: string;
};

const LOBBY_LEVEL_ROLES = new Set<SoloStoryLobbyLevelRole>([
  "planner",
  "synthesizer",
]);

// Task statuses we treat as "finished" for `phase` mapping.
const FINISHED_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "stale",
]);

// Reconnect baseline — much shorter than the shell's 30s ceiling because we
// expect the lobby page to be focused and the captain wants "fresh".
const RECONNECT_DELAY_MS = 2_000;
const MAX_FRAGMENTS_PER_RUN = 200; // ring buffer; prevents long runs from leaking memory.

// ─── Helpers ──────────────────────────────────────────────────────────────

function mapTaskStatusToPhase(
  status: UnifiedTask["status"] | undefined,
): RunStreamPhase {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "stale":
      // `stale` means "we lost track of the run" — treat as failed so the UI
      // surfaces a CTA. Server will reconcile via `enter_review` guard later.
      return "failed";
    case "running":
      return "running";
    case "queued":
      return "starting";
    default:
      return "idle";
  }
}

/**
 * Extract the Solo Story role from a UnifiedTask's metadata. The lobby
 * runtime stores the role at `metadata.soloStory.role`. Falls back to a
 * conservative role inference based on whether the task carries a
 * `cardId` — present ⇒ worker; absent ⇒ no inference (we can't tell
 * planner from synthesizer without metadata, so callers must use the
 * runId→slot lookup helper for `task:progress` events whose envelope
 * lacks the full task record).
 *
 * Sprint 9.1 (R4 H1): the metadata.role string crosses a wire boundary
 * (server → SSE → JSON.parse → here). The cast at the read site is type-
 * level only; we validate against {@link VALID_ROLES} before returning so
 * a typo or schema drift can't strand a slot under an unknown key.
 */
function extractRole(
  task: UnifiedTask | undefined,
  hasCardId: boolean,
): SoloStoryRunRole | undefined {
  if (task?.metadata && typeof task.metadata === "object") {
    const meta = task.metadata as { soloStory?: { role?: unknown } };
    const candidate = meta.soloStory?.role;
    if (
      typeof candidate === "string" &&
      VALID_ROLES.has(candidate as SoloStoryRunRole)
    ) {
      return candidate as SoloStoryRunRole;
    }
  }
  // Inference fallback: a worker run always carries cardId; a lobby-level
  // run never does. We can't disambiguate planner vs synthesizer without
  // the metadata, so leave it undefined and let the caller resolve via
  // the runId→slot lookup it now holds.
  if (hasCardId) return "worker";
  return undefined;
}

function fragmentFromProgress(event: TaskProgressEvent): RunStreamFragment {
  const timestamp = event.timestamp ?? new Date().toISOString();
  const seq = `${event.runId}:${timestamp}`;
  return {
    id: seq,
    timestamp,
    text: event.progressText,
    percent:
      typeof event.progressPercent === "number"
        ? event.progressPercent
        : undefined,
    contentCount: Array.isArray(event.progressContent)
      ? event.progressContent.length
      : undefined,
  };
}

function getEventRunId(event: TaskEvent): string {
  return event.eventType === "task:progress" ? event.runId : event.task.runId;
}

function isStaleForExistingRun(
  existing: RunStreamState | undefined,
  event: TaskEvent,
): boolean {
  return !!existing && existing.runId !== getEventRunId(event);
}

function isLobbyLevelRole(
  role: SoloStoryRunRole | undefined,
): role is SoloStoryLobbyLevelRole {
  return !!role && LOBBY_LEVEL_ROLES.has(role as SoloStoryLobbyLevelRole);
}

export function inferLobbyLevelRoleForEvent(args: {
  event: TaskEvent;
  existingByRole: ReadonlyMap<SoloStoryLobbyLevelRole, RunStreamState>;
  synthesisRunId?: string | null;
}): SoloStoryLobbyLevelRole | undefined {
  const { event, existingByRole, synthesisRunId } = args;
  const runId = getEventRunId(event);
  const eventCardId =
    event.eventType === "task:progress" ? event.cardId : event.task.cardId;

  const taskForRole =
    event.eventType === "task:progress" ? undefined : event.task;
  const metadataRole = extractRole(taskForRole, !!eventCardId);
  if (isLobbyLevelRole(metadataRole)) return metadataRole;

  for (const [role, state] of existingByRole) {
    if (state.runId === runId) return role;
  }

  if (event.eventType !== "task:started" && runId === synthesisRunId) {
    return "synthesizer";
  }

  return undefined;
}

export function applyTaskEventToRunStreamState(args: {
  byCardId: ReadonlyMap<string, RunStreamState>;
  byRole: ReadonlyMap<SoloStoryLobbyLevelRole, RunStreamState>;
  event: TaskEvent;
  expectedLobbyId: string;
  synthesisRunId?: string | null;
}): {
  byCardId: ReadonlyMap<string, RunStreamState>;
  byRole: ReadonlyMap<SoloStoryLobbyLevelRole, RunStreamState>;
} {
  const { event, expectedLobbyId, synthesisRunId } = args;
  const eventLobbyId =
    event.eventType === "task:progress" ? event.lobbyId : event.task.lobbyId;
  if (eventLobbyId !== expectedLobbyId) return args;

  const eventCardId =
    event.eventType === "task:progress" ? event.cardId : event.task.cardId;
  let nextCardId = args.byCardId;
  let nextRole = args.byRole;

  if (eventCardId) {
    updateCardSlot({
      setByCardId: (updater) => {
        nextCardId =
          typeof updater === "function" ? updater(nextCardId) : updater;
      },
      event,
      eventCardId,
      expectedLobbyId,
      inferredRole:
        event.eventType === "task:progress"
          ? "worker"
          : extractRole(event.task, true),
      onCompletedRef: { current: undefined },
      setCompletedCount: () => undefined,
    });
    return { byCardId: nextCardId, byRole: nextRole };
  }

  const role = inferLobbyLevelRoleForEvent({
    event,
    existingByRole: nextRole,
    synthesisRunId,
  });
  if (!role) return args;

  updateRoleSlot({
    setByRole: (updater) => {
      nextRole = typeof updater === "function" ? updater(nextRole) : updater;
    },
    event,
    role,
    expectedLobbyId,
    onRoleCompletedRef: { current: undefined },
    setCompletedCount: () => undefined,
  });
  return { byCardId: nextCardId, byRole: nextRole };
}

/**
 * Apply a single SSE event to the worker-run map (`byCardId`). Pulled out
 * of the hook body so the lobby-level (`byRole`) variant can mirror its
 * shape without duplicating the started/progress/completed switch.
 *
 * Side-effects:
 *   - calls `setByCardId` with a new Map.
 *   - on `task:completed` for a finished status, fires the parent's
 *     `onCardCompleted` callback (via microtask) and increments the
 *     completed-count.
 */
function updateCardSlot(args: {
  setByCardId: Dispatch<SetStateAction<ReadonlyMap<string, RunStreamState>>>;
  event: TaskEvent;
  eventCardId: string;
  expectedLobbyId: string;
  inferredRole: SoloStoryRunRole | undefined;
  onCompletedRef: MutableRefObject<UseLobbyRunStreamOptions["onCardCompleted"]>;
  setCompletedCount: Dispatch<SetStateAction<number>>;
}) {
  const {
    setByCardId,
    event,
    eventCardId,
    expectedLobbyId,
    inferredRole,
    onCompletedRef,
    setCompletedCount,
  } = args;

  setByCardId((prev) => {
    const next = new Map(prev);
    const existing = next.get(eventCardId);

    switch (event.eventType) {
      case "task:started": {
        const task = event.task;
        // Sprint 9.1 (R1 M2): a duplicate `task:started` for the SAME runId
        // (SSE reconnect replay, server retransmission) must not wipe the
        // fragments we've already collected. Only replace the slot wholesale
        // when the runId is new — that's the retry case the comment below
        // talks about.
        if (existing && existing.runId === task.runId) {
          next.set(eventCardId, {
            ...existing,
            phase: mapTaskStatusToPhase(task.status),
            lastEventAt: event.timestamp,
            // Preserve fragments + latestText that landed before the dup.
          });
          return next;
        }
        const startedState: RunStreamState = {
          runId: task.runId,
          lobbyId: expectedLobbyId,
          cardId: eventCardId,
          role: inferredRole ?? "worker",
          phase: mapTaskStatusToPhase(task.status),
          startedAt: task.startedAt ?? event.timestamp,
          lastEventAt: event.timestamp,
          fragments: [],
        };
        // If we already have fragments for this card from a prior run
        // (retry case), the server emits a NEW runId — replace the slot
        // wholesale so the captain sees a clean timeline.
        next.set(eventCardId, startedState);
        return next;
      }

      case "task:progress": {
        const fragment = fragmentFromProgress(event);
        if (!existing) {
          // We missed the started event (race or reconnect). Fabricate a
          // running state so the captain still sees activity. The runId
          // arrives on the next started/completed event — store it now so
          // we can correlate.
          next.set(eventCardId, {
            runId: event.runId,
            lobbyId: expectedLobbyId,
            cardId: eventCardId,
            role: inferredRole ?? "worker",
            phase: "running",
            startedAt: event.startedAt ?? event.timestamp,
            lastEventAt: event.timestamp,
            fragments: [fragment],
            latestText: fragment.text,
          });
          return next;
        }
        // Drop stale events that belong to a previous run for this card.
        // Server emits monotonically per (runId), so a runId mismatch is
        // an in-flight retry.
        if (existing.runId !== event.runId) return next;
        next.set(eventCardId, pushFragment(existing, fragment));
        return next;
      }

      case "task:completed": {
        if (isStaleForExistingRun(existing, event)) return next;
        const task = event.task;
        const phase = mapTaskStatusToPhase(task.status);
        const isFinished = FINISHED_STATUSES.has(task.status);
        const completedState: RunStreamState = existing
          ? {
              ...existing,
              phase,
              lastEventAt: event.timestamp,
              error: task.error ?? existing.error,
            }
          : {
              runId: task.runId,
              lobbyId: expectedLobbyId,
              cardId: eventCardId,
              role: inferredRole ?? "worker",
              phase,
              startedAt: task.startedAt ?? event.timestamp,
              lastEventAt: event.timestamp,
              fragments: [],
              error: task.error,
            };
        next.set(eventCardId, completedState);

        if (isFinished) {
          // Defer the parent callback to a microtask so we don't fire it
          // inside React's setState callback (which can cause cascading
          // updates if the parent triggers a re-render path that loops
          // back here). The completedCount setter below is independent.
          queueMicrotask(() => {
            onCompletedRef.current?.(
              eventCardId,
              task.runId,
              task.status === "succeeded",
            );
          });
          queueMicrotask(() => setCompletedCount((c) => c + 1));
        }
        return next;
      }

      default:
        return next;
    }
  });
}

/**
 * Apply a single SSE event to the lobby-level role map (`byRole`). Same
 * shape as `updateCardSlot` but keyed on `SoloStoryRunRole` ("planner" |
 * "synthesizer") and without the `cardId` slot.
 */
function updateRoleSlot(args: {
  setByRole: Dispatch<
    SetStateAction<ReadonlyMap<SoloStoryLobbyLevelRole, RunStreamState>>
  >;
  event: TaskEvent;
  role: SoloStoryLobbyLevelRole;
  expectedLobbyId: string;
  onRoleCompletedRef: MutableRefObject<
    UseLobbyRunStreamOptions["onRoleRunCompleted"]
  >;
  setCompletedCount: Dispatch<SetStateAction<number>>;
}) {
  const {
    setByRole,
    event,
    role,
    expectedLobbyId,
    onRoleCompletedRef,
    setCompletedCount,
  } = args;

  setByRole((prev) => {
    const next = new Map(prev);
    const existing = next.get(role);

    switch (event.eventType) {
      case "task:started": {
        const task = event.task;
        // Sprint 9.1 (R1 M2): mirror the per-card guard — same runId =
        // duplicate started event = preserve fragments. Different runId =
        // legitimate retry under a new agent_run = wholesale replace.
        if (existing && existing.runId === task.runId) {
          next.set(role, {
            ...existing,
            phase: mapTaskStatusToPhase(task.status),
            lastEventAt: event.timestamp,
          });
          return next;
        }
        next.set(role, {
          runId: task.runId,
          lobbyId: expectedLobbyId,
          role,
          phase: mapTaskStatusToPhase(task.status),
          startedAt: task.startedAt ?? event.timestamp,
          lastEventAt: event.timestamp,
          fragments: [],
        });
        return next;
      }

      case "task:progress": {
        const fragment = fragmentFromProgress(event);
        if (!existing) {
          next.set(role, {
            runId: event.runId,
            lobbyId: expectedLobbyId,
            role,
            phase: "running",
            startedAt: event.startedAt ?? event.timestamp,
            lastEventAt: event.timestamp,
            fragments: [fragment],
            latestText: fragment.text,
          });
          return next;
        }
        if (existing.runId !== event.runId) return next;
        next.set(role, pushFragment(existing, fragment));
        return next;
      }

      case "task:completed": {
        if (isStaleForExistingRun(existing, event)) return next;
        const task = event.task;
        const phase = mapTaskStatusToPhase(task.status);
        const isFinished = FINISHED_STATUSES.has(task.status);
        const completedState: RunStreamState = existing
          ? {
              ...existing,
              phase,
              lastEventAt: event.timestamp,
              error: task.error ?? existing.error,
            }
          : {
              runId: task.runId,
              lobbyId: expectedLobbyId,
              role,
              phase,
              startedAt: task.startedAt ?? event.timestamp,
              lastEventAt: event.timestamp,
              fragments: [],
              error: task.error,
            };
        next.set(role, completedState);

        if (isFinished) {
          queueMicrotask(() => {
            onRoleCompletedRef.current?.(
              role,
              task.runId,
              task.status === "succeeded",
            );
          });
          queueMicrotask(() => setCompletedCount((c) => c + 1));
        }
        return next;
      }

      default:
        return next;
    }
  });
}

function pushFragment(
  state: RunStreamState,
  fragment: RunStreamFragment,
): RunStreamState {
  // Replace last fragment when timestamp matches (the server throttles
  // progress events; back-to-back updates within the same throttle window
  // produce the same `timestamp`). This stops the timeline from showing
  // duplicate-looking rows.
  const last = state.fragments[state.fragments.length - 1];
  let next = state.fragments;
  if (last && last.id === fragment.id) {
    next = [...state.fragments.slice(0, -1), fragment];
  } else {
    next = [...state.fragments, fragment];
  }
  // Cap to the last MAX_FRAGMENTS_PER_RUN entries. Keeps long-running cards
  // from blowing up the in-memory timeline; the captain can always refer
  // back to the persisted `agent_runs.metadata` after the run.
  if (next.length > MAX_FRAGMENTS_PER_RUN) {
    next = next.slice(next.length - MAX_FRAGMENTS_PER_RUN);
  }
  return {
    ...state,
    fragments: next,
    latestText: fragment.text ?? state.latestText,
    lastEventAt: fragment.timestamp,
  };
}

// ─── Hook ────────────────────────────────────────────────────────────────

export function useLobbyRunStream(
  lobbyId: string | null,
  options: UseLobbyRunStreamOptions = {},
): LobbyRunStreamHandle {
  // Single Map kept in state. Mutations always produce a NEW Map so React
  // sees the change (Maps are reference-equal by default).
  const [byCardId, setByCardId] = useState<ReadonlyMap<string, RunStreamState>>(
    () => new Map(),
  );
  const [byRole, setByRole] = useState<
    ReadonlyMap<SoloStoryLobbyLevelRole, RunStreamState>
  >(() => new Map());
  const [isConnected, setIsConnected] = useState(false);
  const [completedCount, setCompletedCount] = useState(0);

  // Sprint 9.1 (R1 BLOCKER B1 / R5 BLOCKER B1): `task:progress` envelopes
  // for lobby-level runs (planner, synthesizer) carry only the routing
  // fields — no `task` record, hence no `metadata.soloStory.role`. The
  // previous discard at the routing site silently dropped every progress
  // event for the synthesizer, so the live transcript surface
  // (`SynthesisRunProgress`) was guaranteed empty in practice.
  //
  // Fix: when `extractRole` returns undefined and there's no `cardId`, we
  // walk the existing byRole slots and reuse the role of whichever slot
  // already owns this `runId`. The slot was populated at `task:started`
  // (which DOES carry full metadata), so the lookup is reliable from the
  // moment the run begins. The ref keeps the lookup synchronous to setState
  // schedules without bloating the `handleEvent` useCallback's dep array
  // (which must stay empty so the EventSource doesn't reconnect on every
  // map mutation).
  const byRoleRef =
    useRef<ReadonlyMap<SoloStoryLobbyLevelRole, RunStreamState>>(byRole);
  useEffect(() => {
    byRoleRef.current = byRole;
  }, [byRole]);

  // Hold the latest `onCardCompleted` / `onRoleRunCompleted` in refs so
  // consumers can pass inline closures without restarting the EventSource
  // on every render.
  const onCompletedRef = useRef(options.onCardCompleted);
  useEffect(() => {
    onCompletedRef.current = options.onCardCompleted;
  }, [options.onCardCompleted]);

  const onRoleCompletedRef = useRef(options.onRoleRunCompleted);
  useEffect(() => {
    onRoleCompletedRef.current = options.onRoleRunCompleted;
  }, [options.onRoleRunCompleted]);

  const lobbyIdRef = useRef(lobbyId);
  useEffect(() => {
    lobbyIdRef.current = lobbyId;
  }, [lobbyId]);

  const synthesisRunIdRef = useRef(options.synthesisRunId ?? null);
  useEffect(() => {
    synthesisRunIdRef.current = options.synthesisRunId ?? null;
  }, [options.synthesisRunId]);

  // Reset the Maps when the lobbyId changes (or the page unmounts the hook).
  useEffect(() => {
    setByCardId(new Map());
    setByRole(new Map());
    setCompletedCount(0);
  }, [lobbyId]);

  const handleEvent = useCallback((envelope: SseEnvelope) => {
    if (!envelope.data) return;
    const expectedLobbyId = lobbyIdRef.current;
    if (!expectedLobbyId) return;

    const event = envelope.data;

    // Pull lobbyId / cardId / role off the event in a discriminator-aware
    // way. Started/completed carry the full task record (with metadata);
    // progress events carry only the routing fields.
    const eventLobbyId =
      event.eventType === "task:progress" ? event.lobbyId : event.task.lobbyId;
    if (eventLobbyId !== expectedLobbyId) return;

    const eventCardId =
      event.eventType === "task:progress" ? event.cardId : event.task.cardId;

    // Role inference: prefer the metadata stamped at run-start over our
    // cardId-based fallback. Progress events don't carry full task
    // metadata, so for those we fall through to the runId→slot lookup
    // below (Sprint 9.1 BLOCKER B1 fix).
    const taskForRole =
      event.eventType === "task:progress" ? undefined : event.task;
    let inferredRole = extractRole(taskForRole, !!eventCardId);

    if (eventCardId) {
      // Worker run — route into byCardId.
      updateCardSlot({
        setByCardId,
        event,
        eventCardId,
        expectedLobbyId,
        inferredRole,
        onCompletedRef,
        setCompletedCount,
      });
      return;
    }

    // Lobby-level run (planner or synthesizer). When the metadata path
    // didn't yield a role (typical for `task:progress` envelopes — they
    // carry no task record), look up the role from the existing slot
    // whose `runId` matches this event's `runId`. The slot was populated
    // at `task:started`, which DOES carry metadata, so the lookup is
    // reliable from the moment the run begins.
    if (!inferredRole) {
      const runId =
        event.eventType === "task:progress" ? event.runId : event.task.runId;
      for (const [role, state] of byRoleRef.current) {
        if (state.runId === runId) {
          inferredRole = role;
          break;
        }
      }
    }

    if (!inferredRole) {
      inferredRole = inferLobbyLevelRoleForEvent({
        event,
        existingByRole: byRoleRef.current,
        synthesisRunId: synthesisRunIdRef.current,
      });
    }

    // Still no role? The event predates any `task:started` we've seen
    // (e.g. SSE reconnected mid-run after the started replay window
    // expired) and does not match the known synthesis run id fallback. We
    // can't safely bucket it — drop it. The parent's refetch on
    // `onRoleRunCompleted` and the captain's manual Refresh remain the
    // recovery paths for this edge case.
    if (!inferredRole || inferredRole === "worker") return;

    updateRoleSlot({
      setByRole,
      event,
      role: inferredRole,
      expectedLobbyId,
      onRoleCompletedRef,
      setCompletedCount,
    });
  }, []);

  // ─── EventSource lifecycle ──────────────────────────────────────────────
  useEffect(() => {
    if (!lobbyId) return;
    if (typeof window === "undefined") return; // SSR guard.

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      es = new EventSource("/api/tasks/events");

      es.onopen = () => {
        if (cancelled) return;
        setIsConnected(true);
      };

      es.onmessage = (ev) => {
        if (cancelled) return;
        try {
          const envelope = JSON.parse(ev.data) as SseEnvelope;
          if (envelope.type === "connected" || envelope.type === "heartbeat") {
            return;
          }
          handleEvent(envelope);
        } catch (err) {
          // Don't escalate — a malformed event from the server shouldn't
          // tear the run-stream down. Errors should never pass silently
          // (project rule), so log loudly so the captain has a breadcrumb
          // if their console is open.
          console.error("[lobby-run-stream] failed to parse SSE event", err);
        }
      };

      es.onerror = () => {
        if (cancelled) return;
        setIsConnected(false);
        es?.close();
        es = null;
        // Best-effort reconnect. The shell's `useTaskNotifications` already
        // handles app-level reconnect/reconciliation; here we just need the
        // live transcript to recover for the lobby page.
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (es) {
        es.close();
        es = null;
      }
      setIsConnected(false);
    };
  }, [lobbyId, handleEvent]);

  return { byCardId, byRole, isConnected, completedCount };
}

/**
 * Lightweight selector helper for components that only care about a single
 * card's state. Stays a plain function (not a hook) so callers can pick up
 * the slice directly from a parent-provided handle without subscribing the
 * whole component tree to the Map's reference identity.
 */
export function getRunStateForCard(
  handle: LobbyRunStreamHandle,
  cardId: string,
): RunStreamState | undefined {
  return handle.byCardId.get(cardId);
}

/**
 * Symmetric helper for {@link getRunStateForCard} — pulls a slice for the
 * planner or synthesizer slot. Sprint 9.1 (R4 N1) added this so consumers
 * (`SynthesisSection`, future planner banner) don't have to inline
 * `byRole.get(...)` and the typed key narrows misuse at the call site.
 */
export function getRunStateForRole(
  handle: LobbyRunStreamHandle,
  role: SoloStoryLobbyLevelRole,
): RunStreamState | undefined {
  return handle.byRole.get(role);
}

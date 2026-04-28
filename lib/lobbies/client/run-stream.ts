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

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  TaskEvent,
  TaskProgressEvent,
  UnifiedTask,
} from "@/lib/background-tasks/types";

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
  /** Card id this run is executing. */
  cardId: string;
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
  /** True when the EventSource is open. */
  isConnected: boolean;
  /** Number of completed runs since mount (informational; not for refetch gating). */
  completedCount: number;
};

export type UseLobbyRunStreamOptions = {
  /**
   * Fired once per `task:completed` for this lobby. The parent should
   * call `useLobbyDetail.refetch()` here so card status / output / lockVersion
   * land authoritatively. We deliberately don't refetch from inside the hook
   * to keep server fetch ownership in the parent (SPEC §3 #6 = no global
   * refetch authority).
   */
  onCardCompleted?: (cardId: string, runId: string, succeeded: boolean) => void;
};

// ─── Internal: SSE wire shape ─────────────────────────────────────────────

type SseEnvelope = {
  type: "connected" | "heartbeat" | "task:started" | "task:completed" | "task:progress";
  data?: TaskEvent;
  timestamp?: string;
};

// Task statuses we treat as "finished" for `phase` mapping.
const FINISHED_STATUSES = new Set(["succeeded", "failed", "cancelled", "stale"]);

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

function fragmentFromProgress(event: TaskProgressEvent): RunStreamFragment {
  const seq = `${event.runId}:${event.timestamp}`;
  return {
    id: seq,
    timestamp: event.timestamp ?? new Date().toISOString(),
    text: event.progressText,
    percent:
      typeof event.progressPercent === "number" ? event.progressPercent : undefined,
    contentCount: Array.isArray(event.progressContent)
      ? event.progressContent.length
      : undefined,
  };
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
  const [isConnected, setIsConnected] = useState(false);
  const [completedCount, setCompletedCount] = useState(0);

  // Hold the latest `onCardCompleted` in a ref so consumers can pass an
  // inline closure without restarting the EventSource on every render.
  const onCompletedRef = useRef(options.onCardCompleted);
  useEffect(() => {
    onCompletedRef.current = options.onCardCompleted;
  }, [options.onCardCompleted]);

  const lobbyIdRef = useRef(lobbyId);
  useEffect(() => {
    lobbyIdRef.current = lobbyId;
  }, [lobbyId]);

  // Reset the Map when the lobbyId changes (or the page unmounts the hook).
  useEffect(() => {
    setByCardId(new Map());
    setCompletedCount(0);
  }, [lobbyId]);

  const handleEvent = useCallback((envelope: SseEnvelope) => {
    if (!envelope.data) return;
    const expectedLobbyId = lobbyIdRef.current;
    if (!expectedLobbyId) return;

    const event = envelope.data;

    // Pull lobbyId / cardId off the event in a discriminator-aware way. For
    // started/completed it's on `task`, for progress it's on the event root.
    const eventLobbyId =
      event.eventType === "task:progress"
        ? event.lobbyId
        : event.task.lobbyId;
    if (eventLobbyId !== expectedLobbyId) return;

    const eventCardId =
      event.eventType === "task:progress"
        ? event.cardId
        : event.task.cardId;
    // Planner / synthesizer runs carry lobbyId but no cardId — ignore here;
    // those land on the planner banner (Sprint 7A) and synthesis surface
    // (Sprint 9).
    if (!eventCardId) return;

    setByCardId((prev) => {
      const next = new Map(prev);
      const existing = next.get(eventCardId);

      switch (event.eventType) {
        case "task:started": {
          const task = event.task;
          const startedState: RunStreamState = {
            runId: task.runId,
            lobbyId: expectedLobbyId,
            cardId: eventCardId,
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
            // Increment the completed counter outside this setter — same
            // microtask is fine.
            queueMicrotask(() => setCompletedCount((c) => c + 1));
          }
          return next;
        }

        default:
          return next;
      }
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

  return { byCardId, isConnected, completedCount };
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

/**
 * Solo Story Mode — client data hooks.
 *
 * Plain `useEffect` + `useState` fetch hooks. SPEC §3 #6 explicitly forbids
 * TanStack Query / SWR — manual hooks keep the bundle slim and make every
 * refetch / abort path obvious.
 *
 * Each hook:
 *   - aborts in-flight requests on unmount or arg change,
 *   - tracks `loading`, `error`, and `data`,
 *   - exposes a `refetch` callback so callers can refresh after a mutation,
 *   - never swallows the error — `LobbyApiError` (or string) lands in `error`.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getLobbyDetail,
  listLobbies,
  listLobbyEvents,
  listLobbyTemplates,
  type ListLobbiesParams,
  type ListLobbiesResponse,
  type LobbyDetailResponse,
  type ListEventsResponse,
  type ListTemplatesResponse,
} from "./api";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type AsyncResource<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
};

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return fallback;
}

// ---------------------------------------------------------------------------
// useLobbyList
// ---------------------------------------------------------------------------

export type LobbyListResource = AsyncResource<ListLobbiesResponse> & {
  loadingMore: boolean;
  loadMore: () => Promise<void>;
};

export function useLobbyList(
  params: { status?: ListLobbiesParams["status"]; limit?: number } = {},
): LobbyListResource {
  const [data, setData] = useState<ListLobbiesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  // Capture primitive args so identity-stable callers don't trigger refetches.
  const status = params.status;
  const limit = params.limit;

  const run = useCallback(async () => {
    abortRef.current?.abort();
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setLoadingMore(false);
    setError(null);
    try {
      const result = await listLobbies({
        status,
        limit,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setData(result);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(getErrorMessage(err, "Failed to load lobbies"));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [status, limit]);

  const loadMore = useCallback(async () => {
    const cursor = data?.nextCursor;
    if (!cursor || loading || loadingMore) return;

    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;

    setLoadingMore(true);
    setError(null);
    try {
      const result = await listLobbies({
        status,
        limit,
        cursor,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setData((prev) => {
        const seen = new Set<string>();
        const lobbies = [...(prev?.lobbies ?? []), ...result.lobbies].filter(
          (lobby) => {
            if (seen.has(lobby.id)) return false;
            seen.add(lobby.id);
            return true;
          },
        );
        return { lobbies, nextCursor: result.nextCursor };
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(getErrorMessage(err, "Failed to load more lobbies"));
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }, [data?.nextCursor, loading, loadingMore, status, limit]);

  useEffect(() => {
    void run();
    return () => {
      abortRef.current?.abort();
      loadMoreAbortRef.current?.abort();
    };
  }, [run]);

  return { data, loading, loadingMore, error, refetch: run, loadMore };
}

// ---------------------------------------------------------------------------
// useLobbyDetail
// ---------------------------------------------------------------------------

export function useLobbyDetail(
  lobbyId: string | null,
): AsyncResource<LobbyDetailResponse> {
  const [data, setData] = useState<LobbyDetailResponse | null>(null);
  const [loading, setLoading] = useState(lobbyId !== null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Sprint 5.3: track which `lobbyId` the current `data` came from, so we
   * can clear stale data on lobby change. Without this, navigating from
   * lobby A to lobby B briefly renders B's page header / phase rail with
   * A's status — every consumer downstream of `data.lobby.status` would
   * paint the wrong phase for one tick before the new fetch resolves.
   */
  const dataLobbyIdRef = useRef<string | null>(null);

  const run = useCallback(async () => {
    if (!lobbyId) {
      setData(null);
      dataLobbyIdRef.current = null;
      setLoading(false);
      setError(null);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Sprint 5.3: drop stale data BEFORE issuing the new fetch so consumers
    // see the loading state instead of the previous lobby's snapshot.
    if (dataLobbyIdRef.current !== lobbyId) {
      setData(null);
      dataLobbyIdRef.current = null;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await getLobbyDetail(lobbyId, controller.signal);
      if (!controller.signal.aborted) {
        setData(result);
        dataLobbyIdRef.current = lobbyId;
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(getErrorMessage(err, "Failed to load lobby"));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [lobbyId]);

  useEffect(() => {
    void run();
    return () => abortRef.current?.abort();
  }, [run]);

  return { data, loading, error, refetch: run };
}

// ---------------------------------------------------------------------------
// useLobbyEvents — bootstrapping fetch + cursor-based incremental polling
// helper. SSE wiring (Sprint 4 extended `/api/tasks/events` with lobbyId)
// lives separately; this hook is the recovery path used when the SSE
// stream drops or hasn't connected yet.
// ---------------------------------------------------------------------------

export function useLobbyEvents(
  lobbyId: string | null,
  options: { initialLimit?: number; afterSequence?: number } = {},
): AsyncResource<ListEventsResponse> & {
  appendFromAfter: (afterSequence: number) => Promise<void>;
} {
  const [data, setData] = useState<ListEventsResponse | null>(null);
  const [loading, setLoading] = useState(lobbyId !== null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Separate controller for the incremental `appendFromAfter` requests so
   * navigating away from the lobby aborts in-flight cursor catch-up calls.
   * Without this, late `setData` writes would land after unmount and either
   * pollute the next mount's cache or trip a "set state on unmounted
   * component" warning in dev.
   */
  const appendAbortRef = useRef<AbortController | null>(null);
  /**
   * Tracks whether the hook is still mounted for the current lobby. Flipped
   * to false on unmount / lobby change so the trailing `setError` of an
   * in-flight `appendFromAfter` is dropped instead of leaking into the next
   * lobby's UI.
   */
  const mountedRef = useRef(true);
  /**
   * Sprint 5.3: monotonically-incrementing generation token. The mount /
   * lobbyId-change effect bumps it; every async closure (`run`,
   * `appendFromAfter`) captures the value at call time and bails on
   * resolve if the live generation has moved past it. AbortController
   * already covers the strict in-flight case, but a captain who fires
   * `appendFromAfter(cursor)` from a setTimeout/SSE callback is past the
   * abort window — without this token, that response could land in the
   * NEXT lobby's data after a lobby change.
   *
   * Generation also guards the post-merge sort: events arriving from the
   * cursor request might be older than already-merged SSE events when the
   * server replays the boundary, so re-sort by `sequence` after dedup so
   * consumers can render in the right order.
   */
  const generationRef = useRef(0);

  const initialLimit = options.initialLimit;
  const afterSequence = options.afterSequence;

  const run = useCallback(async () => {
    if (!lobbyId) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const myGen = generationRef.current;

    setLoading(true);
    setError(null);
    try {
      const result = await listLobbyEvents(lobbyId, {
        limit: initialLimit,
        afterSequence,
        signal: controller.signal,
      });
      if (controller.signal.aborted || generationRef.current !== myGen) return;
      setData(result);
    } catch (err) {
      if (controller.signal.aborted || generationRef.current !== myGen) return;
      setError(getErrorMessage(err, "Failed to load events"));
    } finally {
      if (!controller.signal.aborted && generationRef.current === myGen) {
        setLoading(false);
      }
    }
  }, [lobbyId, initialLimit, afterSequence]);

  /**
   * Pull events newer than `afterSequence` and append. Used by SSE-recovery
   * paths so we don't lose events while the stream reconnects.
   *
   * Aborts the previous append request before starting a new one, captures
   * the generation token at call time, and bails on resolve if either the
   * abort fired or the live generation moved on (e.g., the captain navigated
   * to a different lobby between our request and its response).
   */
  const appendFromAfter = useCallback(
    async (cursor: number) => {
      if (!lobbyId) return;
      appendAbortRef.current?.abort();
      const controller = new AbortController();
      appendAbortRef.current = controller;
      const myGen = generationRef.current;

      try {
        const result = await listLobbyEvents(lobbyId, {
          afterSequence: cursor,
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          !mountedRef.current ||
          generationRef.current !== myGen
        ) {
          return;
        }
        setData((prev) => {
          const merged = [...(prev?.events ?? []), ...result.events];
          // De-dup on (lobbyId, sequence) — server allocator guarantees
          // uniqueness but reconnect races can replay the boundary event.
          const seen = new Set<number>();
          const unique = [];
          for (const e of merged) {
            if (seen.has(e.sequence)) continue;
            seen.add(e.sequence);
            unique.push(e);
          }
          // Sprint 5.3: sort by sequence after dedup. SSE may have already
          // appended events newer than the cursor's response by the time it
          // resolves, so a naive concat leaves the timeline out of order
          // (`unique = [old SSE batch, …, late cursor batch]`). Consumers
          // (e.g., the activity rail) render in array order, so we re-sort
          // to keep the timeline monotonically increasing.
          unique.sort((a, b) => a.sequence - b.sequence);
          return { events: unique };
        });
        // Sprint 5.4 (R2-M2): clear any stale error from a prior failed
        // append. Without this, a transient network blip leaves an error
        // visible even after the next append succeeds. `run` already
        // resets via `setError(null)`; mirror the contract here so the
        // two refresh paths agree.
        setError(null);
      } catch (err) {
        if (
          controller.signal.aborted ||
          !mountedRef.current ||
          generationRef.current !== myGen
        ) {
          return;
        }
        setError(getErrorMessage(err, "Failed to append events"));
      }
    },
    [lobbyId],
  );

  useEffect(() => {
    mountedRef.current = true;
    generationRef.current += 1;
    void run();
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      appendAbortRef.current?.abort();
    };
  }, [run]);

  return { data, loading, error, refetch: run, appendFromAfter };
}

// ---------------------------------------------------------------------------
// useLobbyTemplates
// ---------------------------------------------------------------------------

export function useLobbyTemplates(): AsyncResource<ListTemplatesResponse> {
  const [data, setData] = useState<ListTemplatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const result = await listLobbyTemplates(controller.signal);
      if (!controller.signal.aborted) setData(result);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(getErrorMessage(err, "Failed to load templates"));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
    return () => abortRef.current?.abort();
  }, [run]);

  return { data, loading, error, refetch: run };
}

/**
 * Solo Story Mode — client data hooks.
 *
 * Plain `useEffect` + `useState` fetch hooks. SPEC §3 #14 explicitly forbids
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

export function useLobbyList(
  params: { status?: ListLobbiesParams["status"]; limit?: number } = {},
): AsyncResource<ListLobbiesResponse> {
  const [data, setData] = useState<ListLobbiesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Capture primitive args so identity-stable callers don't trigger refetches.
  const status = params.status;
  const limit = params.limit;

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
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

  useEffect(() => {
    void run();
    return () => abortRef.current?.abort();
  }, [run]);

  return { data, loading, error, refetch: run };
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

    setLoading(true);
    setError(null);
    try {
      const result = await getLobbyDetail(lobbyId, controller.signal);
      if (!controller.signal.aborted) setData(result);
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

    setLoading(true);
    setError(null);
    try {
      const result = await listLobbyEvents(lobbyId, {
        limit: initialLimit,
        afterSequence,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setData(result);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(getErrorMessage(err, "Failed to load events"));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [lobbyId, initialLimit, afterSequence]);

  /**
   * Pull events newer than `afterSequence` and append. Used by SSE-recovery
   * paths so we don't lose events while the stream reconnects.
   */
  const appendFromAfter = useCallback(
    async (cursor: number) => {
      if (!lobbyId) return;
      try {
        const result = await listLobbyEvents(lobbyId, {
          afterSequence: cursor,
        });
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
          return { events: unique };
        });
      } catch (err) {
        setError(getErrorMessage(err, "Failed to append events"));
      }
    },
    [lobbyId],
  );

  useEffect(() => {
    void run();
    return () => abortRef.current?.abort();
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

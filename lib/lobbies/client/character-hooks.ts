/**
 * Solo Story Mode — character/agent fetch hook for the roster phase.
 *
 * `/api/characters` returns the captain's full agent library. The roster's
 * AgentPickerSheet needs a thin subset of fields (id, displayName, name,
 * tagline, metadata.enabledTools) so the seat permission scope sheet can
 * display the agent's tool surface without importing the full character UI.
 *
 * Same fetch shape as the lobby hooks in `./hooks.ts` — manual `useEffect`
 * with abort. SPEC §3 #14 (no TanStack Query / SWR).
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type CharacterSummary = {
  id: string;
  name: string;
  displayName: string | null;
  tagline: string | null;
  status: "draft" | "active" | "archived";
  isDefault: boolean;
  metadata: {
    enabledTools?: string[];
    purpose?: string;
    [key: string]: unknown;
  };
};

type CharactersResponse = {
  characters: CharacterSummary[];
};

export type CharactersResource = {
  characters: CharacterSummary[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
};

/**
 * Fetches the captain's character library for use in the AgentPickerSheet.
 * Filters out archived/draft entries by default — only `active` agents are
 * eligible to fill seats.
 */
export function useCharacters(options: {
  includeNonActive?: boolean;
} = {}): CharactersResource {
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const includeNonActive = options.includeNonActive ?? false;

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/characters", {
        method: "GET",
        credentials: "same-origin",
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Failed to load agents (${res.status})`);
      }

      const body = (await res.json()) as CharactersResponse;
      if (controller.signal.aborted) return;

      const filtered = includeNonActive
        ? body.characters
        : body.characters.filter((c) => c.status === "active");

      setCharacters(filtered);
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : "Failed to load agents";
      setError(message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [includeNonActive]);

  useEffect(() => {
    void run();
    return () => abortRef.current?.abort();
  }, [run]);

  return { characters, loading, error, refetch: run };
}

/**
 * Returns a stable lookup table keyed by character.id. Useful for SeatCard
 * to render the agent label without a per-card fetch.
 */
export function indexCharactersById(
  characters: CharacterSummary[],
): Record<string, CharacterSummary> {
  const out: Record<string, CharacterSummary> = {};
  for (const c of characters) out[c.id] = c;
  return out;
}

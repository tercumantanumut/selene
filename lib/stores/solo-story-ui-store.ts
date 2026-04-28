/**
 * Solo Story Mode — UI-only Zustand store.
 *
 * Holds *cross-component UI coordination state* for the lobby page. Never
 * holds canonical lobby/seat/card data — those live on the server and are
 * fetched/refreshed via the lobby data hooks. The optimistic-move map below
 * is the ONLY exception: it tracks in-flight kanban drops that have not yet
 * been confirmed by the server. Server response always wins (rollback or
 * confirm based on the response shape).
 *
 * Pattern source: `lib/stores/unified-tasks-store.ts`. Same shape (`create`
 * + immutable Map clone for updates). Selectors via `useShallow` keep
 * subscribers cheap.
 *
 * SPEC §3 & §6 (FE Architect report). Solo Story Mode UI guidance:
 *   - server-authoritative state (lobby, seats, cards, deps, events)
 *   - Zustand UI-only store (this file)
 *   - optimistic overlay map (this file, scoped to kanban moves)
 */

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LobbyPhaseSection =
  | "roster"
  | "planning"
  | "rolling"
  | "review"
  | "synthesis";

export type OptimisticCardMove = {
  cardId: string;
  fromColumn: string;
  toColumn: string;
  beforeCardId: string | null;
  /**
   * Monotonic counter assigned at queue time. Lets us drop stale rollbacks if
   * a newer move replaces the same card before the server reply lands.
   */
  optimisticVersion: number;
  queuedAt: string;
};

interface SoloStoryUiState {
  // ─── Active page coordination ──────────────────────────────────────────
  /**
   * Which lobby is currently mounted in the page. Null when on `/lobbies`
   * list view. Set from `[id]/page.tsx` mount/unmount effect.
   */
  activeLobbyId: string | null;

  /** Section the captain has scrolled to / focused. */
  activeSection: LobbyPhaseSection;

  /** Which phases the captain has manually expanded/collapsed. */
  expandedSections: Record<LobbyPhaseSection, boolean>;

  // ─── Card / run focus ──────────────────────────────────────────────────
  /** Currently selected card (for keyboard nav, side panels, etc.). */
  selectedCardId: string | null;

  /** Card whose run transcript is open in fullscreen modal. */
  fullscreenRunCardId: string | null;

  /** Cards whose inline transcripts are expanded. */
  expandedCardTranscripts: Set<string>;

  // ─── Optimistic kanban moves ───────────────────────────────────────────
  /**
   * Map of `cardId → OptimisticCardMove`. Cleared on server confirm or
   * rollback. UI projects this overlay onto the server card list.
   */
  optimisticMoves: Map<string, OptimisticCardMove>;

  /** Allocator for `optimisticVersion`. */
  optimisticVersionCounter: number;

  // ─── Actions ──────────────────────────────────────────────────────────

  setActiveLobbyId: (lobbyId: string | null) => void;
  setActiveSection: (section: LobbyPhaseSection) => void;
  toggleSection: (section: LobbyPhaseSection) => void;
  setSectionExpanded: (section: LobbyPhaseSection, expanded: boolean) => void;

  setSelectedCardId: (cardId: string | null) => void;
  openFullscreenRun: (cardId: string) => void;
  closeFullscreenRun: () => void;

  toggleCardTranscript: (cardId: string) => void;
  collapseAllCardTranscripts: () => void;

  queueOptimisticMove: (
    move: Omit<OptimisticCardMove, "optimisticVersion" | "queuedAt">,
  ) => OptimisticCardMove;
  resolveOptimisticMove: (cardId: string, optimisticVersion: number) => void;
  rollbackOptimisticMove: (cardId: string, optimisticVersion: number) => void;
  clearOptimisticMoves: () => void;

  /** Reset everything when the captain leaves the lobby page. */
  resetForLobbyChange: (nextLobbyId: string | null) => void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_EXPANDED: Record<LobbyPhaseSection, boolean> = {
  roster: true,
  planning: true,
  rolling: true,
  review: true,
  synthesis: true,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSoloStoryUiStore = create<SoloStoryUiState>((set) => ({
  activeLobbyId: null,
  activeSection: "roster",
  expandedSections: { ...DEFAULT_EXPANDED },

  selectedCardId: null,
  fullscreenRunCardId: null,
  expandedCardTranscripts: new Set<string>(),

  optimisticMoves: new Map<string, OptimisticCardMove>(),
  optimisticVersionCounter: 0,

  setActiveLobbyId: (lobbyId) => set({ activeLobbyId: lobbyId }),

  setActiveSection: (section) => set({ activeSection: section }),

  toggleSection: (section) =>
    set((state) => ({
      expandedSections: {
        ...state.expandedSections,
        [section]: !state.expandedSections[section],
      },
    })),

  setSectionExpanded: (section, expanded) =>
    set((state) => ({
      expandedSections: { ...state.expandedSections, [section]: expanded },
    })),

  setSelectedCardId: (cardId) => set({ selectedCardId: cardId }),

  openFullscreenRun: (cardId) => set({ fullscreenRunCardId: cardId }),

  closeFullscreenRun: () => set({ fullscreenRunCardId: null }),

  toggleCardTranscript: (cardId) =>
    set((state) => {
      const next = new Set(state.expandedCardTranscripts);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return { expandedCardTranscripts: next };
    }),

  collapseAllCardTranscripts: () =>
    set({ expandedCardTranscripts: new Set<string>() }),

  queueOptimisticMove: (partial) => {
    let queued: OptimisticCardMove = {
      ...partial,
      optimisticVersion: 0,
      queuedAt: "",
    };
    set((state) => {
      const optimisticVersion = state.optimisticVersionCounter + 1;
      queued = {
        ...partial,
        optimisticVersion,
        queuedAt: new Date().toISOString(),
      };
      const next = new Map(state.optimisticMoves);
      next.set(partial.cardId, queued);
      return {
        optimisticMoves: next,
        optimisticVersionCounter: optimisticVersion,
      };
    });
    return queued;
  },

  resolveOptimisticMove: (cardId, optimisticVersion) =>
    set((state) => {
      const existing = state.optimisticMoves.get(cardId);
      // Drop only if this resolve is for the latest queued version.
      if (!existing || existing.optimisticVersion !== optimisticVersion) {
        return state;
      }
      const next = new Map(state.optimisticMoves);
      next.delete(cardId);
      return { optimisticMoves: next };
    }),

  rollbackOptimisticMove: (cardId, optimisticVersion) =>
    set((state) => {
      const existing = state.optimisticMoves.get(cardId);
      if (!existing || existing.optimisticVersion !== optimisticVersion) {
        return state;
      }
      const next = new Map(state.optimisticMoves);
      next.delete(cardId);
      return { optimisticMoves: next };
    }),

  clearOptimisticMoves: () =>
    set({ optimisticMoves: new Map<string, OptimisticCardMove>() }),

  resetForLobbyChange: (nextLobbyId) =>
    set({
      activeLobbyId: nextLobbyId,
      activeSection: "roster",
      expandedSections: { ...DEFAULT_EXPANDED },
      selectedCardId: null,
      fullscreenRunCardId: null,
      expandedCardTranscripts: new Set<string>(),
      optimisticMoves: new Map<string, OptimisticCardMove>(),
      // counter intentionally NOT reset — keeps rollbacks unambiguous if a
      // late server reply arrives after navigation.
    }),
}));

// ---------------------------------------------------------------------------
// Convenience selectors
// ---------------------------------------------------------------------------

/** Pick a single phase's expanded boolean without re-rendering on others. */
export function useIsSectionExpanded(section: LobbyPhaseSection): boolean {
  return useSoloStoryUiStore((s) => s.expandedSections[section]);
}

/** All expanded transcript ids as a stable Set reference. */
export function useExpandedCardTranscripts(): Set<string> {
  return useSoloStoryUiStore((s) => s.expandedCardTranscripts);
}

/** Optimistic move for a single card, or undefined. */
export function useOptimisticMoveFor(cardId: string): OptimisticCardMove | undefined {
  return useSoloStoryUiStore((s) => s.optimisticMoves.get(cardId));
}

/** Subset of phase actions, memoized for components that render controls. */
export function useSectionControls() {
  return useSoloStoryUiStore(
    useShallow((s) => ({
      activeSection: s.activeSection,
      expandedSections: s.expandedSections,
      setActiveSection: s.setActiveSection,
      toggleSection: s.toggleSection,
      setSectionExpanded: s.setSectionExpanded,
    })),
  );
}

/** Subset of card-focus actions. */
export function useCardFocusControls() {
  return useSoloStoryUiStore(
    useShallow((s) => ({
      selectedCardId: s.selectedCardId,
      fullscreenRunCardId: s.fullscreenRunCardId,
      setSelectedCardId: s.setSelectedCardId,
      openFullscreenRun: s.openFullscreenRun,
      closeFullscreenRun: s.closeFullscreenRun,
      toggleCardTranscript: s.toggleCardTranscript,
    })),
  );
}

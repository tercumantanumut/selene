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

import type { LobbyStatus } from "@/lib/lobbies/types";

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

  /**
   * The lobbyId we have already seeded `expandedSections` / `activeSection`
   * defaults for. `seedDefaultsForStatus` is a no-op when this matches the
   * incoming lobbyId — that's how user-driven section toggles between mount
   * and data-load survive the late status reseed (HIGH finding, Sprint 5.1
   * review). Cleared on lobby change.
   */
  seededForLobbyId: string | null;

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

  /**
   * Hard reset triggered when the captain navigates between lobbies (or
   * leaves the lobby page entirely). Wipes per-lobby UI state — selected
   * card, fullscreen run, expanded transcripts, optimistic moves — and
   * sets `expandedSections` to a neutral all-collapsed baseline. Does NOT
   * seed status-aware expansion: that's `seedDefaultsForStatus`'s job
   * (called separately, once per lobbyId, after the initial detail fetch
   * resolves). Splitting these two concerns is what stops the late reseed
   * from clobbering user toggles + optimistic moves issued during the
   * initial loading window (HIGH finding, Sprint 5.1 review).
   */
  resetForLobbyChange: (nextLobbyId: string | null) => void;

  /**
   * Idempotent default-section seed, called once per lobbyId after the
   * detail fetch resolves so the captain lands on a sensible section for
   * the lobby's current status. No-op when `seededForLobbyId === lobbyId`,
   * so subsequent calls (e.g. after an SSE-driven status flip, or React
   * 18 strict-mode double invoke) cannot blow away user toggles. The
   * destructive reset is `resetForLobbyChange`.
   */
  seedDefaultsForStatus: (lobbyId: string, status: LobbyStatus) => void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Neutral, all-collapsed baseline used while the page is *waiting* for the
 * detail fetch to resolve (so the captain's first paint after `loading=false`
 * never flashes the wrong sections expanded). Once `seedDefaultsForStatus`
 * fires with a real status, the right sections expand.
 *
 * Was previously `roster: true, planning: true, ...` — that caused a visible
 * flicker for non-roster lobbies between the loading skeleton and the
 * status-aware reseed (HIGH finding, Sprint 5.1 review).
 */
const ALL_COLLAPSED: Record<LobbyPhaseSection, boolean> = {
  roster: false,
  planning: false,
  rolling: false,
  review: false,
  synthesis: false,
};

/**
 * Status-aware default expansion. Auto-expands the section the lobby is
 * currently in plus the one before it (so the captain sees what's been
 * done leading into the current phase). Synthesis only expands once the
 * lobby has reached `review` *and* a synth run has been kicked off — the
 * caller must override `synthesis: true` when `hasSynthesisRun` is true.
 *
 * SPEC §3 #11 (progressive reveal): never collapse the active phase.
 */
function defaultExpandedForStatus(
  status: LobbyStatus,
): Record<LobbyPhaseSection, boolean> {
  switch (status) {
    case "roster":
      return { roster: true, planning: false, rolling: false, review: false, synthesis: false };
    case "planning":
      return { roster: true, planning: true, rolling: false, review: false, synthesis: false };
    case "rolling":
      return { roster: false, planning: true, rolling: true, review: false, synthesis: false };
    case "review":
      return { roster: false, planning: false, rolling: true, review: true, synthesis: false };
    case "completed":
      return { roster: false, planning: false, rolling: false, review: true, synthesis: true };
    case "aborted":
      return { roster: false, planning: false, rolling: true, review: true, synthesis: false };
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSoloStoryUiStore = create<SoloStoryUiState>((set) => ({
  activeLobbyId: null,
  seededForLobbyId: null,
  activeSection: "roster",
  expandedSections: { ...ALL_COLLAPSED },

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
      seededForLobbyId: null,
      activeSection: "roster",
      expandedSections: { ...ALL_COLLAPSED },
      selectedCardId: null,
      fullscreenRunCardId: null,
      expandedCardTranscripts: new Set<string>(),
      optimisticMoves: new Map<string, OptimisticCardMove>(),
      // counter intentionally NOT reset — keeps rollbacks unambiguous if a
      // late server reply arrives after navigation.
    }),

  seedDefaultsForStatus: (lobbyId, status) =>
    set((state) => {
      // No-op if we've already seeded for this lobbyId. Anything the
      // captain has toggled in the meantime survives. Also covers React
      // 18 strict-mode double invoke and SSE-driven status flips.
      if (state.seededForLobbyId === lobbyId) return state;
      return {
        seededForLobbyId: lobbyId,
        activeSection: pickInitialSection(status),
        expandedSections: defaultExpandedForStatus(status),
      };
    }),
}));

/**
 * Pick the section the page should scroll-anchor to on first paint, derived
 * from the lobby's current status. Falls back to roster when status hasn't
 * loaded yet (the page will still snap to the right section once data lands
 * because the detail page calls `setActiveSection` after the first fetch).
 */
function pickInitialSection(
  status: LobbyStatus | undefined,
): LobbyPhaseSection {
  switch (status) {
    case "planning":
      return "planning";
    case "rolling":
      return "rolling";
    case "review":
    case "completed":
    case "aborted":
      return "review";
    case "roster":
    default:
      return "roster";
  }
}

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

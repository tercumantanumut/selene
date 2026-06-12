/**
 * Session Sync Store
 *
 * Zustand store for synchronizing session metadata across components.
 * This ensures the Chat History sidebar and Homepage Active Sessions
 * always display consistent, up-to-date information.
 */

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { SessionInfo, SessionChannelType } from "@/components/chat/chat-sidebar/types";

/**
 * Lightweight session metadata for sync purposes.
 * Contains only the fields needed for display indicators.
 */
export interface SessionSyncData {
  id: string;
  title: string | null;
  characterId?: string | null;
  updatedAt: string;
  lastMessageAt?: string | null;
  messageCount?: number | null;
  totalTokenCount?: number | null;
  channelType?: SessionChannelType | null;
  hasActiveRun?: boolean;
}

export type SessionActivityKind =
  | "run"
  | "tool"
  | "hook"
  | "skill"
  | "delegation"
  | "workspace"
  | "pr"
  | "context"
  | "success"
  | "error";

export type SessionActivityTone = "neutral" | "info" | "warning" | "critical" | "success";

export interface SessionActivityIndicator {
  key: string;
  kind: SessionActivityKind;
  label: string;
  detail?: string;
  tone: SessionActivityTone;
}

export interface SessionActivityState {
  sessionId: string;
  runId?: string;
  indicators: SessionActivityIndicator[];
  progressText?: string;
  isRunning: boolean;
  updatedAt: number;
}

export interface SessionContextStatusState {
  status: "warning" | "critical" | "exceeded";
  percentage: number;
  updatedAt: number;
}

/**
 * Event types for session updates
 */
export type SessionUpdateEvent =
  | { type: "message_added"; sessionId: string; messageCount: number }
  | { type: "title_changed"; sessionId: string; title: string }
  | { type: "session_created"; session: SessionSyncData }
  | { type: "session_deleted"; sessionId: string }
  | { type: "session_updated"; session: Partial<SessionSyncData> & { id: string } }
  | { type: "run_started"; sessionId: string; runId: string }
  | { type: "run_completed"; sessionId: string; runId: string }
  | { type: "bulk_refresh"; characterId?: string };

type SessionUpdateListener = (event: SessionUpdateEvent) => void;

interface SessionSyncState {
  // Session data indexed by session ID for O(1) lookups
  sessionsById: Map<string, SessionSyncData>;

  // Sessions grouped by character for efficient filtering
  sessionsByCharacter: Map<string, Set<string>>;

  // Active runs tracking
  activeRuns: Map<string, string>; // sessionId -> runId

  // Rich per-session activity indicators for active task UI
  sessionActivityById: Map<string, SessionActivityState>;

  // Context pressure indicators by session
  sessionContextStatusById: Map<string, SessionContextStatusState>;

  // Last global refresh timestamp
  lastRefreshAt: number;

  // Listeners for session updates (for components that need to react)
  listeners: Set<SessionUpdateListener>;

  // Actions
  setSession: (session: SessionSyncData) => void;
  setSessions: (sessions: SessionSyncData[], characterId?: string) => void;
  updateSession: (sessionId: string, updates: Partial<SessionSyncData>) => void;
  removeSession: (sessionId: string) => void;
  setActiveRun: (sessionId: string, runId: string | null) => void;
  setSessionActivity: (sessionId: string, activity: SessionActivityState | null) => void;
  setSessionContextStatus: (
    sessionId: string,
    status: SessionContextStatusState | null
  ) => void;
  markSessionUpdated: (sessionId: string) => void;
  triggerRefresh: (characterId?: string) => void;

  // Subscription
  subscribe: (listener: SessionUpdateListener) => () => void;
  emit: (event: SessionUpdateEvent) => void;

  // Selectors
  getSession: (sessionId: string) => SessionSyncData | undefined;
  getSessionsByCharacter: (characterId: string) => SessionSyncData[];
  hasActiveRun: (sessionId: string) => boolean;
  getSessionActivity: (sessionId: string) => SessionActivityState | undefined;
  getSessionContextStatus: (sessionId: string) => SessionContextStatusState | undefined;
}

function areIndicatorsEqual(
  left: SessionActivityIndicator[] | undefined,
  right: SessionActivityIndicator[] | undefined
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) return false;

  for (let index = 0; index < a.length; index += 1) {
    if (
      a[index].key !== b[index].key ||
      a[index].kind !== b[index].kind ||
      a[index].label !== b[index].label ||
      a[index].detail !== b[index].detail ||
      a[index].tone !== b[index].tone
    ) {
      return false;
    }
  }

  return true;
}

function areActivitiesEqual(
  left: SessionActivityState | undefined,
  right: SessionActivityState | undefined
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;

  return (
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.progressText === right.progressText &&
    left.isRunning === right.isRunning &&
    areIndicatorsEqual(left.indicators, right.indicators)
  );
}

function areContextStatusesEqual(
  left: SessionContextStatusState | undefined,
  right: SessionContextStatusState | undefined
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;

  return (
    left.status === right.status &&
    Math.round(left.percentage) === Math.round(right.percentage)
  );
}

function parseSessionSortTimestamp(value: string | null | undefined): number {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getSessionSortTimestamp(session: Pick<SessionSyncData, "lastMessageAt" | "updatedAt">): string {
  return session.lastMessageAt ?? session.updatedAt;
}

export const useSessionSyncStore = create<SessionSyncState>((set, get) => ({
  sessionsById: new Map(),
  sessionsByCharacter: new Map(),
  activeRuns: new Map(),
  sessionActivityById: new Map(),
  sessionContextStatusById: new Map(),
  lastRefreshAt: Date.now(),
  listeners: new Set(),

  setSession: (session) => {
    set((state) => {
      const newSessionsById = new Map(state.sessionsById);
      newSessionsById.set(session.id, session);

      const newSessionsByCharacter = new Map(state.sessionsByCharacter);
      if (session.characterId) {
        const characterSessions =
          newSessionsByCharacter.get(session.characterId) || new Set();
        characterSessions.add(session.id);
        newSessionsByCharacter.set(session.characterId, characterSessions);
      }

      return {
        sessionsById: newSessionsById,
        sessionsByCharacter: newSessionsByCharacter,
      };
    });

    get().emit({ type: "session_updated", session });
  },

  setSessions: (sessions, characterId) => {
    set((state) => {
      const newSessionsById = new Map(state.sessionsById);
      const newSessionsByCharacter = new Map(state.sessionsByCharacter);

      // If characterId is provided, clear existing sessions for that character
      if (characterId) {
        const existingIds = state.sessionsByCharacter.get(characterId);
        if (existingIds) {
          for (const id of existingIds) {
            newSessionsById.delete(id);
          }
        }
        newSessionsByCharacter.set(characterId, new Set());
      }

      // Add new sessions, preserving hasActiveRun from in-memory activeRuns if available
      for (const session of sessions) {
        // If we have an active run in memory for this session, prefer that over DB-derived flag
        const hasInMemoryActiveRun = state.activeRuns.has(session.id);
        const mergedSession = {
          ...session,
          // Prefer in-memory activeRuns over DB-derived hasActiveRun to avoid stale data
          hasActiveRun: hasInMemoryActiveRun || session.hasActiveRun,
        };
        newSessionsById.set(session.id, mergedSession);
        if (session.characterId) {
          const characterSessions =
            newSessionsByCharacter.get(session.characterId) || new Set();
          characterSessions.add(session.id);
          newSessionsByCharacter.set(session.characterId, characterSessions);
        }
      }

      return {
        sessionsById: newSessionsById,
        sessionsByCharacter: newSessionsByCharacter,
        lastRefreshAt: Date.now(),
      };
    });

    get().emit({ type: "bulk_refresh", characterId });
  },

  updateSession: (sessionId, updates) => {
    set((state) => {
      const existing = state.sessionsById.get(sessionId);
      if (!existing) return state;

      const updated = { ...existing, ...updates };
      const newSessionsById = new Map(state.sessionsById);
      newSessionsById.set(sessionId, updated);

      return { sessionsById: newSessionsById };
    });

    get().emit({ type: "session_updated", session: { id: sessionId, ...updates } });
  },

  removeSession: (sessionId) => {
    set((state) => {
      const session = state.sessionsById.get(sessionId);
      const newSessionsById = new Map(state.sessionsById);
      newSessionsById.delete(sessionId);

      const newSessionsByCharacter = new Map(state.sessionsByCharacter);
      if (session?.characterId) {
        const characterSessions = newSessionsByCharacter.get(session.characterId);
        if (characterSessions) {
          characterSessions.delete(sessionId);
          newSessionsByCharacter.set(session.characterId, characterSessions);
        }
      }

      const newActiveRuns = new Map(state.activeRuns);
      newActiveRuns.delete(sessionId);

      const newSessionActivityById = new Map(state.sessionActivityById);
      newSessionActivityById.delete(sessionId);

      const newSessionContextStatusById = new Map(state.sessionContextStatusById);
      newSessionContextStatusById.delete(sessionId);

      return {
        sessionsById: newSessionsById,
        sessionsByCharacter: newSessionsByCharacter,
        activeRuns: newActiveRuns,
        sessionActivityById: newSessionActivityById,
        sessionContextStatusById: newSessionContextStatusById,
      };
    });

    get().emit({ type: "session_deleted", sessionId });
  },

  setActiveRun: (sessionId, runId) => {
    const current = get().activeRuns.get(sessionId);
    // Skip no-op: same runId already set, or clearing when already absent
    if (runId ? current === runId : !current) return;

    set((state) => {
      const newActiveRuns = new Map(state.activeRuns);
      if (runId) {
        newActiveRuns.set(sessionId, runId);
      } else {
        newActiveRuns.delete(sessionId);
      }

      const existingSession = state.sessionsById.get(sessionId);
      const nextSessionsById = new Map(state.sessionsById);
      if (existingSession && existingSession.hasActiveRun !== Boolean(runId)) {
        nextSessionsById.set(sessionId, {
          ...existingSession,
          hasActiveRun: Boolean(runId),
        });
      }

      return {
        activeRuns: newActiveRuns,
        sessionsById: nextSessionsById,
      };
    });

    if (runId) {
      get().emit({ type: "run_started", sessionId, runId });
    } else {
      get().emit({ type: "run_completed", sessionId, runId: current ?? "" });
    }
  },

  setSessionActivity: (sessionId, activity) => {
    set((state) => {
      const existing = state.sessionActivityById.get(sessionId);
      const next = activity ?? undefined;
      if (areActivitiesEqual(existing, next)) {
        return state;
      }

      const newSessionActivityById = new Map(state.sessionActivityById);
      if (activity) {
        newSessionActivityById.set(sessionId, activity);
      } else {
        newSessionActivityById.delete(sessionId);
      }
      return { sessionActivityById: newSessionActivityById };
    });
  },

  setSessionContextStatus: (sessionId, status) => {
    set((state) => {
      const existing = state.sessionContextStatusById.get(sessionId);
      const next = status ?? undefined;
      if (areContextStatusesEqual(existing, next)) {
        return state;
      }

      const newSessionContextStatusById = new Map(state.sessionContextStatusById);
      if (status) {
        newSessionContextStatusById.set(sessionId, status);
      } else {
        newSessionContextStatusById.delete(sessionId);
      }
      return { sessionContextStatusById: newSessionContextStatusById };
    });
  },

  markSessionUpdated: (sessionId) => {
    const now = new Date().toISOString();
    get().updateSession(sessionId, { updatedAt: now });
  },

  triggerRefresh: (characterId) => {
    set({ lastRefreshAt: Date.now() });
    get().emit({ type: "bulk_refresh", characterId });
  },

  subscribe: (listener) => {
    set((state) => ({
      listeners: new Set([...state.listeners, listener]),
    }));

    return () => {
      set((state) => {
        const newListeners = new Set(state.listeners);
        newListeners.delete(listener);
        return { listeners: newListeners };
      });
    };
  },

  emit: (event) => {
    const { listeners } = get();
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[SessionSync] Listener error:", error);
      }
    }
  },

  getSession: (sessionId) => get().sessionsById.get(sessionId),

  getSessionsByCharacter: (characterId) => {
    const { sessionsById, sessionsByCharacter } = get();
    const sessionIds = sessionsByCharacter.get(characterId);
    if (!sessionIds) return [];

    const sessions: SessionSyncData[] = [];
    for (const id of sessionIds) {
      const session = sessionsById.get(id);
      if (session) sessions.push(session);
    }

    return sessions.sort((a, b) => {
      const activityDiff =
        parseSessionSortTimestamp(getSessionSortTimestamp(b)) -
        parseSessionSortTimestamp(getSessionSortTimestamp(a));
      if (activityDiff !== 0) {
        return activityDiff;
      }

      const updatedDiff = parseSessionSortTimestamp(b.updatedAt) - parseSessionSortTimestamp(a.updatedAt);
      if (updatedDiff !== 0) {
        return updatedDiff;
      }

      return b.id.localeCompare(a.id);
    });
  },

  hasActiveRun: (sessionId) => get().activeRuns.has(sessionId),
  getSessionActivity: (sessionId) => get().sessionActivityById.get(sessionId),
  getSessionContextStatus: (sessionId) => get().sessionContextStatusById.get(sessionId),
}));

// ============================================================================
// Selector Hooks
// ============================================================================

/**
 * Get a single session by ID with reactive updates
 */
export const useSessionData = (sessionId: string | null | undefined) =>
  useSessionSyncStore(
    useShallow((state) => (sessionId ? state.sessionsById.get(sessionId) : undefined))
  );

/**
 * Get all sessions for a character with reactive updates
 */
const useCharacterSessions = (characterId: string | null | undefined) =>
  useSessionSyncStore(
    useShallow((state) => {
      if (!characterId) return [];
      return state.getSessionsByCharacter(characterId);
    })
  );

/**
 * Check if a session has an active run
 *
 * Priority order:
 * 1. In-memory activeRuns Map (most up-to-date)
 * 2. DB-derived hasActiveRun flag from sessionsById
 *
 * This dual-check ensures indicators remain visible even during race conditions
 * where DB queries might be stale or session data is being refreshed.
 */
export const useSessionHasActiveRun = (sessionId: string | null | undefined) =>
  useSessionSyncStore((state) => {
    if (!sessionId) return false;
    // Prefer explicit in-memory run tracking (most reliable), but fall back to DB-derived flag.
    return state.activeRuns.has(sessionId) || state.sessionsById.get(sessionId)?.hasActiveRun === true;
  });

export const useSessionActivity = (sessionId: string | null | undefined) =>
  useSessionSyncStore((state) =>
    sessionId ? state.sessionActivityById.get(sessionId) : undefined
  );

export const useSessionContextStatus = (sessionId: string | null | undefined) =>
  useSessionSyncStore((state) =>
    sessionId ? state.sessionContextStatusById.get(sessionId) : undefined
  );

/**
 * Get the last refresh timestamp (useful for triggering re-fetches)
 */
const useSessionSyncRefreshTrigger = () =>
  useSessionSyncStore((state) => state.lastRefreshAt);

/**
 * Get session sync actions (stable references)
 */
export const useSessionSyncActions = () =>
  useSessionSyncStore(
    useShallow((state) => ({
      setSession: state.setSession,
      setSessions: state.setSessions,
      updateSession: state.updateSession,
      removeSession: state.removeSession,
      setActiveRun: state.setActiveRun,
      setSessionActivity: state.setSessionActivity,
      setSessionContextStatus: state.setSessionContextStatus,
      markSessionUpdated: state.markSessionUpdated,
      triggerRefresh: state.triggerRefresh,
      subscribe: state.subscribe,
    }))
  );

// ============================================================================
// Utility: Convert SessionInfo to SessionSyncData
// ============================================================================

function sessionInfoToSyncData(session: SessionInfo): SessionSyncData {
  return {
    id: session.id,
    title: session.title,
    characterId: session.characterId ?? session.metadata?.characterId,
    updatedAt: session.updatedAt,
    lastMessageAt: session.lastMessageAt,
    messageCount: session.messageCount,
    totalTokenCount: session.totalTokenCount,
    channelType: session.channelType ?? session.metadata?.channelType,
    hasActiveRun: session.hasActiveRun,
  };
}

/**
 * Convert array of SessionInfo to SessionSyncData
 */
export function sessionInfoArrayToSyncData(sessions: SessionInfo[]): SessionSyncData[] {
  return sessions.map(sessionInfoToSyncData);
}

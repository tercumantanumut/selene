import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  ClaudeCodeSubagentActivity,
  ClaudeCodeSubagentEvent,
  ClaudeCodeSubagentSnapshot,
} from "@/lib/claudecode/subagent-activity-types";

// Stable fallback so selectors that return "no events" don't hand a fresh
// array reference to React on every render — zustand's default Object.is
// equality would treat each call as a change and loop until React #185.
const EMPTY_EVENTS: readonly ClaudeCodeSubagentEvent[] = Object.freeze([]);

interface ClaudeCodeSubagentActivityState {
  activitiesById: Record<string, ClaudeCodeSubagentActivity>;
  eventsByActivityId: Record<string, ClaudeCodeSubagentEvent[]>;
  setSnapshot: (snapshot: ClaudeCodeSubagentSnapshot) => void;
  upsertActivity: (activity: ClaudeCodeSubagentActivity) => void;
  appendEvent: (event: ClaudeCodeSubagentEvent, activity?: ClaudeCodeSubagentActivity) => void;
}

export const useClaudeCodeSubagentActivityStore = create<ClaudeCodeSubagentActivityState>((set) => ({
  activitiesById: {},
  eventsByActivityId: {},
  setSnapshot: (snapshot) => set(() => {
    const activitiesById: Record<string, ClaudeCodeSubagentActivity> = {};
    for (const activity of snapshot.activities) {
      activitiesById[activity.id] = activity;
    }
    return {
      activitiesById,
      eventsByActivityId: snapshot.eventsByActivityId,
    };
  }),
  upsertActivity: (activity) => set((state) => ({
    activitiesById: {
      ...state.activitiesById,
      [activity.id]: activity,
    },
  })),
  appendEvent: (event, activity) => set((state) => {
    const currentEvents = state.eventsByActivityId[event.activityId] ?? [];
    return {
      activitiesById: activity
        ? { ...state.activitiesById, [activity.id]: activity }
        : state.activitiesById,
      eventsByActivityId: {
        ...state.eventsByActivityId,
        [event.activityId]: [...currentEvents, event].slice(-160),
      },
    };
  }),
}));

export function useClaudeCodeSubagentActivities(sessionId?: string) {
  return useClaudeCodeSubagentActivityStore(
    useShallow((state) =>
      Object.values(state.activitiesById)
        .filter((activity) => !sessionId || activity.sessionId === sessionId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    ),
  );
}

export function useClaudeCodeSubagentEvents(activityId?: string) {
  return useClaudeCodeSubagentActivityStore((state) =>
    activityId
      ? state.eventsByActivityId[activityId] ?? (EMPTY_EVENTS as ClaudeCodeSubagentEvent[])
      : (EMPTY_EVENTS as ClaudeCodeSubagentEvent[]),
  );
}

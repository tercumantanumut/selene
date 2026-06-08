"use client";

import { startTransition, useEffect } from "react";
import { useClaudeCodeSubagentActivityStore } from "@/lib/stores/claudecode-subagent-activity-store";
import type {
  ClaudeCodeSubagentActivity,
  ClaudeCodeSubagentEvent,
  ClaudeCodeSubagentSnapshot,
} from "@/lib/claudecode/subagent-activity-types";

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function deferStoreUpdate(update: () => void) {
  queueMicrotask(() => {
    startTransition(update);
  });
}

export function useClaudeCodeSubagentEvents(sessionId?: string | null) {
  const setSnapshot = useClaudeCodeSubagentActivityStore((state) => state.setSnapshot);
  const appendEvent = useClaudeCodeSubagentActivityStore((state) => state.appendEvent);

  useEffect(() => {
    if (!sessionId) return;

    const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/claudecode-subagents/events`);

    const handleSnapshot = (event: MessageEvent<string>) => {
      const snapshot = parseJson<ClaudeCodeSubagentSnapshot>(event.data);
      if (snapshot) deferStoreUpdate(() => setSnapshot(snapshot));
    };

    const handleActivity = (event: MessageEvent<string>) => {
      const payload = parseJson<{ event: ClaudeCodeSubagentEvent; activity: ClaudeCodeSubagentActivity }>(event.data);
      if (payload?.event) deferStoreUpdate(() => appendEvent(payload.event, payload.activity));
    };

    source.addEventListener("snapshot", handleSnapshot as EventListener);
    for (const name of [
      "subagent-started",
      "subagent-activity",
      "subagent-completed",
      "subagent-failed",
      "subagent-stale",
      "stream-unavailable",
    ]) {
      source.addEventListener(name, handleActivity as EventListener);
    }

    return () => source.close();
  }, [appendEvent, sessionId, setSnapshot]);
}

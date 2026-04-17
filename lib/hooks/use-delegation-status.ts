import { useMemo } from "react";
import { useUnifiedTasksStore } from "@/lib/stores/unified-tasks-store";

interface DelegationInfo {
  delegationId: string;
  sessionId: string;
  delegateAgentId: string;
  delegateAgent: string;
  task: string;
  running: boolean;
  elapsed: number;
}

interface DelegationStatus {
  delegations: DelegationInfo[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Derives delegation status from the unified tasks store (SSE-fed)
 * instead of polling /api/delegations/status every 5 seconds.
 */
export function useDelegationStatus(characterId: string | null): DelegationStatus {
  const tasks = useUnifiedTasksStore((s) => s.tasks);

  const delegations = useMemo(() => {
    if (!characterId) return [];
    return tasks
      .filter((t) => {
        const meta = t.metadata as Record<string, unknown> | undefined;
        return meta?.isDelegation === true && meta?.parentAgentId === characterId;
      })
      .map((t) => {
        const meta = t.metadata as Record<string, unknown> | undefined;
        return {
          delegationId: t.runId,
          sessionId: t.sessionId ?? "",
          delegateAgentId: t.characterId ?? "",
          delegateAgent: (meta?.characterName as string) ?? "Agent",
          task: (meta?.delegationTask as string) ?? "",
          running: t.status === "running",
          elapsed: Date.now() - new Date(t.startedAt).getTime(),
        };
      });
  }, [characterId, tasks]);

  return { delegations, isLoading: false, error: null };
}

import { useMemo } from "react";
import { useUnifiedTasksStore } from "@/lib/stores/unified-tasks-store";

interface DelegationInfo {
  delegationId: string;
  sessionId: string;
  initiatorSessionId?: string;
  rootSessionId?: string;
  delegateAgentId: string;
  delegateAgent: string;
  task: string;
  running: boolean;
  elapsed: number;
}

interface DelegationStatusOptions {
  initiatorSessionId?: string;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
export function useDelegationStatus(
  characterId: string | null,
  options: DelegationStatusOptions = {},
): DelegationStatus {
  const tasks = useUnifiedTasksStore((s) => s.tasks);
  const { initiatorSessionId } = options;

  const delegations = useMemo(() => {
    if (!characterId) return [];
    return tasks
      .filter((t) => {
        const meta = t.metadata as Record<string, unknown> | undefined;
        if (meta?.isDelegation !== true || meta?.parentAgentId !== characterId) {
          return false;
        }

        if (!initiatorSessionId) {
          return true;
        }

        const taskInitiatorSessionId = metadataString(meta, "initiatorSessionId");
        const taskRootSessionId = metadataString(meta, "rootSessionId");
        return taskInitiatorSessionId === initiatorSessionId || taskRootSessionId === initiatorSessionId;
      })
      .map((t) => {
        const meta = t.metadata as Record<string, unknown> | undefined;
        return {
          delegationId: t.runId,
          sessionId: t.sessionId ?? "",
          initiatorSessionId: metadataString(meta, "initiatorSessionId"),
          rootSessionId: metadataString(meta, "rootSessionId"),
          delegateAgentId: t.characterId ?? "",
          delegateAgent: metadataString(meta, "characterName") ?? "Agent",
          task: metadataString(meta, "delegationTask") ?? "",
          running: t.status === "running",
          elapsed: Date.now() - new Date(t.startedAt).getTime(),
        };
      });
  }, [characterId, initiatorSessionId, tasks]);

  return { delegations, isLoading: false, error: null };
}

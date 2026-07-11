export interface DelegationCompletion {
  delegationId: string;
  delegateName: string;
  sessionId: string;
  initiatorSessionId: string;
  characterId: string;
  completedAt: number;
  status?: "completed" | "failed" | "stopped";
  error?: string;
  /**
   * The full delegation result content (e.g. `<delegation-result>` XML).
   * Populated when the live prompt queue is not active (run ended) so the
   * result can be injected by prepareStep in the next turn.
   */
  resultContent?: string;
  resultVersion?: number;
  deliveryId?: string;
  resultHash?: string;
  deliveredAt?: number;
}

type DelegationCompletionStore = Map<string, DelegationCompletion[]>;

const DELEGATION_COMPLETION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const globalForDelegationCompletions = globalThis as typeof globalThis & {
  delegationCompletions?: DelegationCompletionStore;
};

function getStore(): DelegationCompletionStore {
  if (!globalForDelegationCompletions.delegationCompletions) {
    globalForDelegationCompletions.delegationCompletions = new Map();
  }
  return globalForDelegationCompletions.delegationCompletions;
}

function pruneExpiredEntries(now = Date.now()): void {
  const store = getStore();
  for (const [sessionId, completions] of store.entries()) {
    const fresh = completions.filter((completion) => now - completion.completedAt <= DELEGATION_COMPLETION_TTL_MS);
    if (fresh.length === 0) {
      store.delete(sessionId);
      continue;
    }
    if (fresh.length !== completions.length) {
      store.set(sessionId, fresh);
    }
  }
}

export function addDelegationCompletion(completion: DelegationCompletion): void {
  pruneExpiredEntries();
  const store = getStore();
  const existing = store.get(completion.initiatorSessionId) ?? [];
  store.set(completion.initiatorSessionId, [...existing, completion]);
}

export function peekDelegationCompletions(initiatorSessionId: string): DelegationCompletion[] {
  pruneExpiredEntries();
  return [...(getStore().get(initiatorSessionId) ?? [])];
}

export function clearDelegationCompletions(initiatorSessionId: string): void {
  getStore().delete(initiatorSessionId);
}

export function drainDelegationCompletions(initiatorSessionId: string): DelegationCompletion[] {
  const completions = peekDelegationCompletions(initiatorSessionId);
  clearDelegationCompletions(initiatorSessionId);
  return completions;
}

export function hasPendingDelegationCompletions(initiatorSessionId: string): boolean {
  return peekDelegationCompletions(initiatorSessionId).length > 0;
}

/**
 * Remove a single delegation completion by ID from the store.
 * Called when observe() returns a completed result — the notification
 * is already consumed and must not be re-delivered via system prompt.
 */
export function removeDelegationCompletionById(
  initiatorSessionId: string,
  delegationId: string,
): boolean {
  const store = getStore();
  const existing = store.get(initiatorSessionId);
  if (!existing || existing.length === 0) return false;
  const filtered = existing.filter((c) => c.delegationId !== delegationId);
  if (filtered.length === existing.length) return false;
  if (filtered.length === 0) {
    store.delete(initiatorSessionId);
  } else {
    store.set(initiatorSessionId, filtered);
  }
  return true;
}

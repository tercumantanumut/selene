import { createHash } from "node:crypto";

const DELEGATION_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DelegationDeliveryRecord {
  delegationId: string;
  resultVersion: number;
  deliveryId: string;
  resultHash: string;
  deliveredAt: number;
  channel: "live-prompt" | "completion-store";
}

type DelegationDeliveryStore = Map<string, DelegationDeliveryRecord>;

const globalForDelegationDeliveries = globalThis as typeof globalThis & {
  delegationDeliveries?: DelegationDeliveryStore;
};

function getStore(): DelegationDeliveryStore {
  if (!globalForDelegationDeliveries.delegationDeliveries) {
    globalForDelegationDeliveries.delegationDeliveries = new Map();
  }
  return globalForDelegationDeliveries.delegationDeliveries;
}

function deliveryKey(delegationId: string, resultVersion: number): string {
  return `${delegationId}:${resultVersion}`;
}

function pruneExpiredDeliveries(now = Date.now()): void {
  const store = getStore();
  for (const [key, record] of store.entries()) {
    if (now - record.deliveredAt > DELEGATION_DELIVERY_TTL_MS) {
      store.delete(key);
    }
  }
}

export function hashDelegationResult(resultContent: string): string {
  return createHash("sha256").update(resultContent).digest("hex");
}

export function buildDelegationDeliveryMetadata(input: {
  delegationId: string;
  resultVersion: number;
  resultContent: string;
  deliveredAt?: number;
}): Omit<DelegationDeliveryRecord, "channel"> {
  const deliveredAt = input.deliveredAt ?? Date.now();
  const resultHash = hashDelegationResult(input.resultContent);
  return {
    delegationId: input.delegationId,
    resultVersion: input.resultVersion,
    deliveryId: `deleg-delivery-${input.delegationId}-v${input.resultVersion}`,
    resultHash,
    deliveredAt,
  };
}

export function markDelegationResultDelivered(
  record: DelegationDeliveryRecord,
): DelegationDeliveryRecord {
  pruneExpiredDeliveries();
  getStore().set(deliveryKey(record.delegationId, record.resultVersion), record);
  return record;
}

export function getDelegationDeliveryRecord(
  delegationId: string,
  resultVersion: number,
): DelegationDeliveryRecord | undefined {
  pruneExpiredDeliveries();
  return getStore().get(deliveryKey(delegationId, resultVersion));
}

export function clearDelegationDeliveryRecords(): void {
  getStore().clear();
}

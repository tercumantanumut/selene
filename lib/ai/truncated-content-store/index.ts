/**
 * Truncated Content Store — public barrel.
 *
 * Preserves the original sync API (`storeFullContent`, `retrieveFullContent`,
 * `listStoredContent`, `sessionHasTruncatedContent`, `clearTruncatedContentSession`)
 * so all 20+ call sites across the chat pipeline continue to work unchanged.
 *
 * The backing store is selected by `CONTENT_STORE_BACKEND`:
 *  - `sqlite` (default): persistent SQLite table, survives Electron restart.
 *  - `memory`: in-memory Map, process-scoped (used by the older behavior and
 *    by tests that want to avoid touching the DB).
 *
 * Either backend can fail (disk full, DB locked, FK violation on an unknown
 * session). `storeFullContent` now returns `string | null` — callers may
 * degrade to an inline preview when null is returned.
 */

import { CLEANUP_INTERVAL_MS } from "./types";
import { InMemoryContentStore } from "./in-memory";
import { SqliteContentStore } from "./sqlite";
import type {
  ContentStore,
  StoredContentSummary,
  TruncatedContentEntry,
} from "./types";

// Re-export shared types so callers can `import { TruncatedContentEntry } from ".../truncated-content-store"`.
export type { ContentStore, StoredContentSummary, TruncatedContentEntry };
export { InMemoryContentStore };

type Backend = "sqlite" | "memory";

function resolveBackend(): Backend {
  const raw = process.env.CONTENT_STORE_BACKEND?.toLowerCase();
  if (raw === "memory") return "memory";
  if (raw === "sqlite") return "sqlite";
  // Default: sqlite in production/development, memory only when explicitly opted in.
  return "sqlite";
}

let activeStore: ContentStore | null = null;

function getStore(): ContentStore {
  if (activeStore) return activeStore;
  const backend = resolveBackend();
  activeStore =
    backend === "memory" ? new InMemoryContentStore() : new SqliteContentStore();
  return activeStore;
}

/**
 * Test-only: swap the active store. Used by integration tests that want
 * to point the store at an alternate backend (or reset state between tests).
 */
export function setContentStoreForTesting(store: ContentStore | null): void {
  activeStore = store;
}

/**
 * Store full content and return a reference ID, or null if the backend
 * is unavailable. The caller decides how to degrade — most stub-builders
 * omit the contentId and embed an inline preview when null is returned.
 */
export function storeFullContent(
  sessionId: string,
  context: string,
  fullContent: string,
  truncatedLength: number,
  ttlMs?: number,
): string | null {
  return getStore().store(sessionId, context, fullContent, truncatedLength, ttlMs);
}

/**
 * Retrieve full content by reference ID. Returns null if not found,
 * expired, or the backend is unavailable.
 */
export function retrieveFullContent(
  sessionId: string,
  contentId: string,
): TruncatedContentEntry | null {
  return getStore().retrieve(sessionId, contentId);
}

/**
 * List all non-expired stored content IDs for a session (used by the
 * retrieveFullContent not-found fallback to steer the model back to
 * valid IDs).
 */
export function listStoredContent(sessionId: string): StoredContentSummary[] {
  return getStore().list(sessionId);
}

/**
 * Fast existence check used to gate dynamic injection of the
 * retrieveFullContent tool. Must stay cheap — a cold SQL hit on every
 * tool-list build is fine but we avoid anything heavier than a single
 * row lookup.
 */
export function sessionHasTruncatedContent(sessionId: string): boolean {
  return getStore().sessionHasContent(sessionId);
}

/**
 * Clear a specific session (test helper, manual flush).
 */
export function clearTruncatedContentSession(sessionId: string): void {
  getStore().clearSession(sessionId);
}

// ============================================================================
// Periodic cleanup
// ============================================================================
//
// Runs every 15 minutes on the active backend. For SQLite this is a single
// DELETE ... WHERE expires_at <= now, which is cheap against the indexed
// `expires_at` column.

let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

function startCleanupInterval(): void {
  if (cleanupIntervalId) return;
  if (typeof setInterval === "undefined") return;
  cleanupIntervalId = setInterval(() => {
    try {
      getStore().cleanupExpired();
    } catch (err) {
      // Never let cleanup errors crash the process.
      console.warn(
        `[TruncatedContentStore] Cleanup threw (continuing): ${String(err)}`,
      );
    }
  }, CLEANUP_INTERVAL_MS);

  // Node: prevent the interval from holding the event loop open during test
  // runs or short CLI processes.
  if (cleanupIntervalId && typeof cleanupIntervalId.unref === "function") {
    cleanupIntervalId.unref();
  }
}

// Opt-out via env for test contexts that want explicit control.
if (process.env.CONTENT_STORE_CLEANUP !== "disabled") {
  startCleanupInterval();
}

/**
 * Shared types for the TruncatedContentStore abstraction.
 */

// Default TTL: 7 days (long-running agents may need to retrieve old tool output)
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Cleanup interval: run every 15 minutes
export const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

export interface TruncatedContentEntry {
  /** Unique identifier for retrieving the content */
  id: string;
  /** Session this content belongs to */
  sessionId: string;
  /** Context where truncation occurred (e.g., "user message", "webSearch result") */
  context: string;
  /** The full untruncated content */
  fullContent: string;
  /** Length of the full content */
  fullLength: number;
  /** Length it was truncated to */
  truncatedLength: number;
  /** When the content was stored */
  storedAt: Date;
  /** When the content expires */
  expiresAt: Date;
}

export interface StoredContentSummary {
  id: string;
  context: string;
  fullLength: number;
  truncatedLength: number;
}

export interface ContentStore {
  /** Persist full content; returns the trunc_XXX id, or null if the backend is unavailable. */
  store(
    sessionId: string,
    context: string,
    fullContent: string,
    truncatedLength: number,
    ttlMs?: number,
  ): string | null;

  /** Retrieve a stored entry, or null if missing/expired/unavailable. */
  retrieve(sessionId: string, contentId: string): TruncatedContentEntry | null;

  /** List non-expired entries for a session (used by the not-found fallback). */
  list(sessionId: string): StoredContentSummary[];

  /** Fast existence check used to gate dynamic tool injection. */
  sessionHasContent(sessionId: string): boolean;

  /** Drop all entries for a session (test helper). */
  clearSession(sessionId: string): void;

  /** Delete expired rows across all sessions. Returns number removed. */
  cleanupExpired(): number;
}

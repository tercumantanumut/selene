/**
 * Client-side merge for incremental `/api/sessions/:id/messages?since=` polls.
 *
 * The server returns every message id in order plus full rows only for
 * messages changed since the cursor. These helpers rebuild the full list from
 * a cached copy, and reuse converted UI messages whose rows did not change so
 * React and assistant-ui can skip re-rendering them.
 */

interface MessageRowLike {
  id: string;
  role: string;
}

/**
 * Rebuild the ordered message list from cached rows and a delta response.
 * Returns null when the cache cannot fill a gap (an id that is neither cached
 * nor in the delta); the caller should then fall back to a full fetch.
 */
export function mergeIncrementalMessages<T extends MessageRowLike>(
  cachedById: ReadonlyMap<string, T>,
  ids: readonly string[],
  changed: readonly T[]
): T[] | null {
  const changedById = new Map(changed.map((row) => [row.id, row]));
  const merged: T[] = [];
  for (const id of ids) {
    const row = changedById.get(id) ?? cachedById.get(id);
    if (!row) return null;
    merged.push(row);
  }
  return merged;
}

/**
 * Swap freshly converted UI messages for the objects previously applied to the
 * UI when their source rows are the same objects as at that time (the merge
 * above keeps row identity for unchanged messages). The converter folds
 * role="tool" rows into assistant messages, so nothing is reused if any tool
 * row differs from what was applied.
 */
export function reuseUnchangedUIMessages<R extends MessageRowLike, U extends { id: string }>(
  next: readonly U[],
  rows: readonly R[],
  appliedRows: ReadonlyMap<string, R>,
  appliedUI: ReadonlyMap<string, U>
): U[] {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const toolRowsChanged =
    rows.some((row) => row.role === "tool" && appliedRows.get(row.id) !== row) ||
    [...appliedRows.values()].some((row) => row.role === "tool" && rowsById.get(row.id) !== row);
  if (toolRowsChanged) return [...next];

  return next.map((message) => {
    const previous = appliedUI.get(message.id);
    const row = rowsById.get(message.id);
    return previous && row && appliedRows.get(message.id) === row ? previous : message;
  });
}

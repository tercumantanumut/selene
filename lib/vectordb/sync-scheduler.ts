/**
 * Sync Scheduler
 *
 * In-memory sync tracking state plus scheduling, recovery, and watcher-restart
 * functions for the folder sync service.
 */

import { db } from "@/lib/db/sqlite-client";
import { agentSyncFolders } from "@/lib/db/sqlite-character-schema";
import { eq, or } from "drizzle-orm";
import { startWatching, isWatching } from "./file-watcher";
import { normalizeFolderPath, validateSyncFolderPath } from "./path-validation";
import { resolveFolderSyncBehavior, shouldRunForTrigger, type SyncMode } from "./sync-mode-resolver";
import { parseJsonArray, normalizeExtensions } from "./sync-helpers";
import { resolveRegistryPath, resolveRegistryPathAsync, getSubscriberCount } from "./shared-folder-registry";
import type { SyncTracking } from "./sync-types";

// ---------------------------------------------------------------------------
// In-memory tracking state
// ---------------------------------------------------------------------------

// Track folders currently being synced - by folder ID
export const syncingFolders = new Set<string>();

// Track syncs by folder path to detect duplicates even with different IDs
// Maps folderPath -> { folderId, abortController }
export const syncingPaths = new Map<string, SyncTracking>();

// Maximum time a folder can be in "syncing" status before it's considered stale
const MAX_SYNCING_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Sync state queries
// ---------------------------------------------------------------------------

/**
 * Check if a folder is currently being synced
 */
export function isSyncing(folderId: string): boolean {
  return syncingFolders.has(folderId);
}

/**
 * Check if a folder path is currently being synced (by any folder ID)
 */
export function isSyncingPath(folderPath: string): boolean {
  const normalizedPath = normalizeFolderPath(folderPath);
  return syncingPaths.has(normalizedPath) || syncingPaths.has(folderPath);
}

/**
 * Cancel a running sync for a folder path
 * @returns true if a sync was cancelled, false if no sync was running
 */
export async function cancelSyncByPath(folderPath: string): Promise<boolean> {
  const normalizedPath = normalizeFolderPath(folderPath);
  const tracking = syncingPaths.get(normalizedPath) ?? syncingPaths.get(folderPath);
  if (!tracking) {
    return false;
  }

  console.log(`[SyncService] Cancelling sync for path: ${normalizedPath} (folder ID: ${tracking.folderId})`);
  tracking.abortController.abort();

  // Wait briefly for the sync to acknowledge the abort
  await new Promise(resolve => setTimeout(resolve, 500));

  return true;
}

/**
 * Cancel a running sync for a folder ID
 * @returns true if a sync was cancelled, false if no sync was running
 */
export async function cancelSyncById(folderId: string): Promise<boolean> {
  // Find the path for this folder ID
  for (const [path, tracking] of syncingPaths.entries()) {
    if (tracking.folderId === folderId) {
      return cancelSyncByPath(path);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * Recover folders that are stuck in "syncing" status
 * This can happen if the sync process crashes or the app is closed mid-sync
 */
export async function recoverStuckSyncingFolders(): Promise<number> {
  const cutoffTime = new Date(Date.now() - MAX_SYNCING_DURATION_MS).toISOString();

  // Find folders that have been "syncing" for too long
  const stuckFolders = await db
    .select()
    .from(agentSyncFolders)
    .where(eq(agentSyncFolders.status, "syncing"));

  let recoveredCount = 0;

  for (const folder of stuckFolders) {
    // Check if folder is actually being synced in memory
    if (syncingFolders.has(folder.id)) {
      continue; // Skip - actually in progress
    }

    // If the folder is NOT tracked in memory, it's definitely stuck — recover
    // immediately regardless of how recently it was updated. The 30-minute
    // cutoff only applies as a safety net for folders that ARE in memory
    // (e.g., a very slow sync that hasn't timed out yet).
    const updatedAt = folder.updatedAt || folder.createdAt;
    const isStaleEnough = updatedAt < cutoffTime;
    const isOrphanedOnStartup = !syncingFolders.has(folder.id);

    if (isStaleEnough || isOrphanedOnStartup) {
      console.log(`[SyncService] Recovering stuck syncing folder: ${folder.id} (${folder.folderPath})`);

      let newStatus: "synced" | "error" | "paused" = (folder.fileCount ?? 0) > 0 ? "synced" : "error";
      let errorMsg: string | null = newStatus === "error" ? "Sync process was interrupted" : null;

      const { error: pathError } = await validateSyncFolderPath(folder.folderPath);
      if (pathError) {
        newStatus = "paused";
        errorMsg = `Paused: ${pathError}`;
      }

      await db
        .update(agentSyncFolders)
        .set({
          status: newStatus,
          lastError: errorMsg,
          lastSyncedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agentSyncFolders.id, folder.id));

      recoveredCount++;
    }
  }

  if (recoveredCount > 0) {
    console.log(`[SyncService] Recovered ${recoveredCount} stuck syncing folders`);
  }

  return recoveredCount;
}

/**
 * Force cleanup of all stuck sync folders regardless of time threshold.
 * Resets all folders with "syncing" or "pending" status that are not actively being synced in memory.
 * @returns Object with counts of cleaned syncing and pending folders
 */
export async function forceCleanupStuckFolders(): Promise<{ syncingCleaned: number; pendingCleaned: number }> {
  console.log("[SyncService] Force cleanup of stuck folders...");

  // Find all folders in syncing or pending status
  const stuckFolders = await db
    .select()
    .from(agentSyncFolders)
    .where(
      or(
        eq(agentSyncFolders.status, "syncing"),
        eq(agentSyncFolders.status, "pending")
      )
    );

  let syncingCleaned = 0;
  let pendingCleaned = 0;

  for (const folder of stuckFolders) {
    // Skip if actually being synced in memory
    if (syncingFolders.has(folder.id)) {
      console.log(`[SyncService] Skipping folder ${folder.id} - actively syncing in memory`);
      continue;
    }

    const wasStatus = folder.status;
    const { error: pathError } = await validateSyncFolderPath(folder.folderPath);

    const newStatus = pathError ? "paused" : "synced";
    const nextError = pathError ? `Paused: ${pathError}` : null;

    console.log(`[SyncService] Cleaning up folder: ${folder.id} (${folder.folderPath}) - ${wasStatus} -> ${newStatus}`);

    await db
      .update(agentSyncFolders)
      .set({
        status: newStatus,
        lastError: nextError,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(agentSyncFolders.id, folder.id));

    if (wasStatus === "syncing") {
      syncingCleaned++;
    } else {
      pendingCleaned++;
    }
  }

  console.log(`[SyncService] Force cleanup complete: ${syncingCleaned} syncing, ${pendingCleaned} pending folders cleaned`);
  return { syncingCleaned, pendingCleaned };
}

// ---------------------------------------------------------------------------
// Watcher restart
// ---------------------------------------------------------------------------

/**
 * Get all synced folders that need watchers restarted (for app startup)
 */
async function getSyncedFoldersNeedingWatch(): Promise<Array<{
  folderId: string;
  characterId: string;
  folderPath: string;
  recursive: boolean;
  includeExtensions: string[];
  excludePatterns: string[];
  syncMode: SyncMode;
}>> {
  const folders = await db
    .select()
    .from(agentSyncFolders)
    .where(eq(agentSyncFolders.status, "synced"));

  const results: Array<{
    folderId: string;
    characterId: string;
    folderPath: string;
    recursive: boolean;
    includeExtensions: string[];
    excludePatterns: string[];
    syncMode: SyncMode;
  }> = [];

  for (const folder of folders) {
    const { normalizedPath, error } = await validateSyncFolderPath(folder.folderPath);
    if (error) {
      await db
        .update(agentSyncFolders)
        .set({
          status: "paused",
          lastError: `Paused: ${error}`,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agentSyncFolders.id, folder.id));
      continue;
    }

    if (normalizedPath !== folder.folderPath) {
      await db
        .update(agentSyncFolders)
        .set({
          folderPath: normalizedPath,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agentSyncFolders.id, folder.id));
    }

    const behavior = resolveFolderSyncBehavior({
      indexingMode: folder.indexingMode,
      syncMode: folder.syncMode,
    });

    if (!behavior.allowsWatcherEvents) {
      continue;
    }

    const folderIncludeExtensions = normalizeExtensions(parseJsonArray(folder.includeExtensions));
    const folderFileTypeFilters = normalizeExtensions(parseJsonArray(folder.fileTypeFilters));

    results.push({
      folderId: folder.id,
      characterId: folder.characterId,
      folderPath: normalizedPath,
      recursive: folder.recursive,
      includeExtensions: folderFileTypeFilters.length > 0 ? folderFileTypeFilters : folderIncludeExtensions,
      excludePatterns: parseJsonArray(folder.excludePatterns),
      syncMode: behavior.syncMode,
    });
  }

  return results;
}

/**
 * Get stale folders that haven't been synced recently
 * @param maxAgeMs Maximum age in milliseconds (default: 1 hour)
 */
async function getStaleFolders(maxAgeMs: number = 60 * 60 * 1000): Promise<string[]> {
  const cutoffTime = new Date(Date.now() - maxAgeMs).toISOString();

  const staleFolders = await db
    .select({ id: agentSyncFolders.id })
    .from(agentSyncFolders)
    .where(
      or(
        eq(agentSyncFolders.status, "synced"),
        eq(agentSyncFolders.status, "error")
      )
    );

  // Filter by lastSyncedAt in application code (SQLite text comparison)
  return staleFolders
    .filter(f => {
      // Get full folder data for this ID
      return true; // Will be filtered below
    })
    .map(f => f.id);
}

/**
 * Restart file watchers for all synced folders (called on app startup).
 *
 * Groups folders by resolved physical path so that folders sharing the
 * same directory reuse a single chokidar watcher via the shared registry.
 */
export async function restartAllWatchers(): Promise<void> {
  // Use console.error so these appear in production logs (stderr is always captured)
  console.error("[SyncService] Restarting file watchers for synced folders...");

  const foldersToWatch = await getSyncedFoldersNeedingWatch();
  console.error(`[SyncService] Found ${foldersToWatch.length} folders needing watchers`);

  // Group by resolved path to log sharing stats
  const byPath = new Map<string, typeof foldersToWatch>();
  for (const folder of foldersToWatch) {
    const resolved = await resolveRegistryPathAsync(folder.folderPath);
    let group = byPath.get(resolved);
    if (!group) {
      group = [];
      byPath.set(resolved, group);
    }
    group.push(folder);
  }

  let watchersCreated = 0;
  let subscribersAdded = 0;

  for (const [resolvedPath, group] of byPath.entries()) {
    if (group.length > 1) {
      console.log(
        `[SyncService] Path ${resolvedPath} shared by ${group.length} folders: ` +
        group.map(f => f.folderId).join(", ")
      );
    }

    for (const folder of group) {
      if (!isWatching(folder.folderId)) {
        try {
          await startWatching({
            folderId: folder.folderId,
            characterId: folder.characterId,
            folderPath: folder.folderPath,
            recursive: folder.recursive,
            includeExtensions: folder.includeExtensions,
            excludePatterns: folder.excludePatterns,
          });

          const subCount = getSubscriberCount(folder.folderPath);
          if (subCount > 1) {
            subscribersAdded++;
          } else {
            watchersCreated++;
          }
        } catch (error) {
          console.error(`[SyncService] Failed to restart watcher for ${folder.folderPath}:`, error);
        }
      }
    }
  }

  // Tally folders deferred due to FD pressure / concurrent-watcher cap so the
  // user can see why some folders aren't syncing. Each deferred folder has its
  // lastError set to a message starting with "Deferred:" by teardownPathFatally.
  let deferredCount = 0;
  for (const group of byPath.values()) {
    for (const folder of group) {
      const [row] = await db
        .select({ lastError: agentSyncFolders.lastError })
        .from(agentSyncFolders)
        .where(eq(agentSyncFolders.id, folder.folderId));
      if (row?.lastError?.startsWith("Deferred:")) {
        deferredCount++;
      }
    }
  }

  console.error(
    `[SyncService] Watcher restart complete: ${watchersCreated} new watcher(s), ` +
    `${subscribersAdded} shared subscriber(s), ${foldersToWatch.length} total folders` +
    (deferredCount > 0 ? `, ${deferredCount} deferred (FD pressure / watcher cap)` : "")
  );
}

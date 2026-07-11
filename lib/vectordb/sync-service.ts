/**
 * Folder Sync Service
 *
 * Manages synchronization of local folders to the vector database.
 * Handles file discovery, indexing, and incremental updates.
 *
 * Supports parallel processing for faster indexing of large file sets.
 */

import { db } from "@/lib/db/sqlite-client";
import { agentSyncFolders, agentSyncFiles, characters, type AgentSyncFolder } from "@/lib/db/sqlite-character-schema";
import { eq, and, sql, or, isNotNull } from "drizzle-orm";
import { removeFileFromVectorDB, removeFolderFromVectorDB } from "./indexing";
import { DEFAULT_IGNORE_PATTERNS, createAggressiveIgnore } from "./ignore-patterns";
import { deleteAgentTable, listAgentTables } from "./collections";
import { startWatching, isWatching, stopWatching } from "./file-watcher";
import { getEmbeddingModelId } from "@/lib/ai/providers";

import { normalizeFolderPath, validateSyncFolderPath } from "./path-validation";
import {
  type ChunkPreset,
  type ReindexPolicy,
  type SyncExecutionTrigger,
  type SyncMode,
  normalizeChunkPreset,
  normalizeReindexPolicy,
  resolveChunkingOverrides,
  resolveFolderSyncBehavior,
  shouldRunForTrigger,
} from "./sync-mode-resolver";
import { onFolderChange, notifyFolderChange, type FolderChangeEvent } from "./folder-events";
import { resolveRegistryPath, getSubscriberCount } from "./shared-folder-registry";
import { getResourceErrorCode, isFileDescriptorLimitError } from "./resource-errors";

// Re-export types so existing imports from this path continue to work
export type { ParallelConfig, SyncFolderConfig, SyncFolderUpdateConfig, SyncResult } from "./sync-types";

import {
  type ParallelConfig,
  type SyncFolderConfig,
  type SyncFolderUpdateConfig,
  type SyncResult,
  type SyncTracking,
} from "./sync-types";

import {
  resolveParallelConfig,
  normalizeExtensions,
  warnIfLargeLocalEmbeddingSync,
  discoverFiles,
  parseJsonArray,
  parseJsonObject,
  shouldSmartReindex,
  decodeAgentTableName,
} from "./sync-helpers";

import { processFileInBatch, type FileProcessorContext } from "./sync-file-processor";

// Re-export CRUD functions so existing imports from this path continue to work
export {
  addSyncFolder,
  getAllSyncFolders,
  getSyncFolders,
  getPrimarySyncFolder,
  setPrimaryFolder,
} from "./sync-folder-crud";
import { getSyncFolders, setPrimaryFolder } from "./sync-folder-crud";

// Re-export scheduler functions so existing imports from this path continue to work
export {
  cancelSyncById,
  recoverStuckSyncingFolders,
  forceCleanupStuckFolders,
  restartAllWatchers,
} from "./sync-scheduler";
import {
  syncingFolders,
  syncingPaths,
  isSyncing,
  isSyncingPath,
  cancelSyncByPath,
  cancelSyncById,
} from "./sync-scheduler";

/**
 * Remove a sync folder and its indexed content.
 * Cancels any running sync first to prevent orphaned processes.
 */
export async function removeSyncFolder(folderId: string): Promise<void> {
  const [folder] = await db
    .select()
    .from(agentSyncFolders)
    .where(eq(agentSyncFolders.id, folderId));

  if (!folder) {
    console.warn(`[SyncService] Tried to remove missing sync folder: ${folderId}`);
    return;
  }

  const wasPrimary = folder.isPrimary;
  const characterId = folder.characterId;
  const isWorkspaceSource = folder.source === "workspace";

  if (isSyncing(folderId)) {
    console.log(`[SyncService] Cancelling running sync for folder: ${folderId}`);
    await cancelSyncById(folderId);
  }

  if (isWatching(folderId)) {
    await stopWatching(folderId);
  }

  // Delete child file rows first to prevent FK violations from concurrent syncs,
  // then delete the folder row so UI is unblocked even if vector cleanup fails.
  await db.delete(agentSyncFiles).where(eq(agentSyncFiles.folderId, folderId));
  await db.delete(agentSyncFolders).where(eq(agentSyncFolders.id, folderId));
  console.log(`[SyncService] Removed sync folder: ${folderId}`);

  // Check remaining folders AFTER deletion to decide cleanup strategy.
  const remainingFolders = await getSyncFolders(characterId);

  try {
    if (remainingFolders.length === 0) {
      // Last folder: drop table (if present).
      await deleteAgentTable(characterId);
    } else {
      // Multiple folders: delete vectors for this folder only.
      await removeFolderFromVectorDB({ characterId, folderId });
    }
  } catch (cleanupError) {
    // Non-fatal cleanup error: keep deletion successful to avoid HTTP 500 loops.
    console.error(`[SyncService] Non-fatal vector cleanup failure for folder ${folderId}:`, cleanupError);
  }

  if (wasPrimary && remainingFolders.length > 0) {
    await setPrimaryFolder(remainingFolders[0].id, characterId);
    console.log(`[SyncService] Promoted folder ${remainingFolders[0].id} to primary`);
  }

  // Workspace-sourced folders are internal path registrations for agent worktrees,
  // not user-configured vector-sync sources. Skip UI notifications and cross-agent
  // propagation — they'd spam the sync indicator and cascade to every sub-agent.
  if (!isWorkspaceSource) {
    notifyFolderChange(characterId, { type: "removed", folderId, wasPrimary, folderPath: folder.folderPath });

    // Propagate removal to workflow sub-agents so their inherited copies are cleaned up.
    // Dynamic import avoids circular dependency (workflow-folder-sharing → sync-service).
    try {
      const { propagateWorkflowFolderChange } = await import("@/lib/agents/workflow-folder-sharing");
      await propagateWorkflowFolderChange(characterId, { type: "removed", folderId, folderPath: folder.folderPath });
    } catch (err) {
      console.error(`[SyncService] Non-fatal: failed to propagate folder removal to workflow sub-agents:`, err);
    }
  }
}

async function maybeUpdateNormalizedFolderPath(
  folderId: string,
  normalizedPath: string,
  existingPath: string
): Promise<void> {
  if (normalizedPath !== existingPath) {
    await db
      .update(agentSyncFolders)
      .set({ folderPath: normalizedPath, updatedAt: new Date().toISOString() })
      .where(eq(agentSyncFolders.id, folderId));
  }
}

/**
 * Sync a folder — index new/changed files, remove deleted files.
 * Supports parallel processing for faster indexing of large file sets.
 */
export async function syncFolder(
  folderId: string,
  parallelConfig: Partial<ParallelConfig> = {},
  forceReindex: boolean = false,
  trigger: SyncExecutionTrigger = "manual"
): Promise<SyncResult> {
  const config = resolveParallelConfig(parallelConfig);

  const result: SyncResult = {
    folderId,
    filesProcessed: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesRemoved: 0,
    skippedReasons: {},
    errors: [],
  };

  const [folder] = await db
    .select()
    .from(agentSyncFolders)
    .where(eq(agentSyncFolders.id, folderId));

  if (!folder) {
    result.errors.push("Folder not found");
    return result;
  }

  // Don't run non-manual syncs on user-paused folders
  if (folder.status === "paused" && trigger !== "manual") {
    result.errors.push("Folder is paused");
    return result;
  }

  const { normalizedPath, error: pathError } = await validateSyncFolderPath(folder.folderPath);
  if (pathError) {
    await db
      .update(agentSyncFolders)
      .set({ status: "paused", lastError: `Paused: ${pathError}`, updatedAt: new Date().toISOString() })
      .where(eq(agentSyncFolders.id, folderId));
    result.errors.push(pathError);
    return result;
  }

  const folderPath = normalizedPath;
  await maybeUpdateNormalizedFolderPath(folderId, normalizedPath, folder.folderPath);

  const behavior = resolveFolderSyncBehavior({
    indexingMode: folder.indexingMode,
    syncMode: folder.syncMode,
    syncCadenceMinutes: folder.syncCadenceMinutes,
    maxFileSizeBytes: folder.maxFileSizeBytes,
    chunkPreset: folder.chunkPreset,
    chunkSizeOverride: folder.chunkSizeOverride,
    chunkOverlapOverride: folder.chunkOverlapOverride,
    reindexPolicy: folder.reindexPolicy,
  });

  if (!shouldRunForTrigger(behavior, trigger)) {
    result.errors.push(`Sync mode ${behavior.syncMode} blocks ${trigger} runs`);
    return result;
  }

  const shouldCreateEmbeddings = behavior.shouldCreateEmbeddings;
  const existingRunMetadata = parseJsonObject(folder.lastRunMetadata);
  const previousSmartReindexAt =
    typeof existingRunMetadata.smartReindexAt === "string"
      ? existingRunMetadata.smartReindexAt
      : undefined;
  const smartReindexDue =
    behavior.reindexPolicy === "smart" && trigger === "scheduled"
      ? shouldSmartReindex(folder.lastRunMetadata)
      : false;
  const shouldForceReindex = forceReindex || behavior.reindexPolicy === "always" || smartReindexDue;

  console.log(
    `[SyncService] Syncing folder ${folder.displayName || folderPath} with indexing=${folder.indexingMode}, sync=${behavior.syncMode}, trigger=${trigger} (embeddings: ${shouldCreateEmbeddings})`
  );

  if (syncingFolders.has(folderId)) {
    console.log(`[SyncService] Folder ${folderId} is already being synced, skipping`);
    result.errors.push("Folder is already being synced");
    return result;
  }

  // Note: we don't block cross-folder syncs for the same physical path.
  // Each folder writes to its own DB rows (agentSyncFiles keyed by folderId)
  // and may have different filter/indexing config, so both syncs are legitimate.

  const syncAbortController = new AbortController();
  syncingFolders.add(folderId);
  syncingPaths.set(folderPath, { folderId, abortController: syncAbortController });

  await db
    .update(agentSyncFolders)
    .set({ status: "syncing", lastError: null, fileCount: 0, chunkCount: 0, updatedAt: new Date().toISOString() })
    .where(eq(agentSyncFolders.id, folderId));

  try {
    const includeExtensions = normalizeExtensions(parseJsonArray(folder.includeExtensions));
    const fileTypeFilters = normalizeExtensions(parseJsonArray(folder.fileTypeFilters));
    const allowedExtensions = fileTypeFilters.length > 0 ? fileTypeFilters : includeExtensions;
    const excludePatterns = parseJsonArray(folder.excludePatterns);
    const mergedExcludePatterns = Array.from(new Set([...DEFAULT_IGNORE_PATTERNS, ...excludePatterns]));
    const shouldIgnore = createAggressiveIgnore(mergedExcludePatterns, folderPath, allowedExtensions);
    const chunkingOverrides = resolveChunkingOverrides(behavior);
    const skipReasons: Record<string, number> = {};

    console.log(`[SyncService] Discovering files in ${folderPath}`);
    console.log(`[SyncService] Include extensions: ${JSON.stringify(includeExtensions)}`);
    console.log(`[SyncService] Exclude patterns: ${JSON.stringify(mergedExcludePatterns)}`);
    console.log(`[SyncService] Parallel config: concurrency=${config.concurrency}, staggerDelayMs=${config.staggerDelayMs}`);
    if (shouldForceReindex) console.log(`[SyncService] Force reindex enabled for folder ${folderPath}`);

    const discoveredFiles = await discoverFiles(
      folderPath, folderPath, folder.recursive, allowedExtensions, shouldIgnore
    );
    warnIfLargeLocalEmbeddingSync(folderPath, discoveredFiles.length);
    console.log(`[SyncService] Discovered ${discoveredFiles.length} files to process`);

    const existingFiles = await db
      .select()
      .from(agentSyncFiles)
      .where(eq(agentSyncFiles.folderId, folderId));

    const existingFileMap = new Map(existingFiles.map(f => [f.filePath, f]));
    const discoveredPaths = new Set(discoveredFiles.map(f => f.filePath));

    for (const existing of existingFiles) {
      if (!discoveredPaths.has(existing.filePath)) {
        const pointIds = parseJsonArray(existing.vectorPointIds);
        if (pointIds.length > 0) {
          await removeFileFromVectorDB({ characterId: folder.characterId, pointIds });
        }
        await db.delete(agentSyncFiles).where(eq(agentSyncFiles.id, existing.id));
        result.filesRemoved++;
      }
    }

    // Mutable progress counters shared via context object
    const counters = { processedCount: 0, indexedCount: 0, totalChunksIndexed: 0 };
    const totalFiles = discoveredFiles.length;
    const startTime = Date.now();
    let lastProgressUpdate = Date.now();
    const PROGRESS_UPDATE_INTERVAL_MS = 500;

    const updateProgressInDb = async (force = false) => {
      const now = Date.now();
      if (force || now - lastProgressUpdate >= PROGRESS_UPDATE_INTERVAL_MS) {
        lastProgressUpdate = now;
        await db
          .update(agentSyncFolders)
          .set({
            fileCount: counters.indexedCount,
            chunkCount: counters.totalChunksIndexed,
            lastRunMetadata: {
              trigger,
              totalFiles,
              filesProcessed: counters.processedCount,
              filesIndexed: counters.indexedCount,
              inProgress: true,
            },
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agentSyncFolders.id, folderId));
      }
    };

    const processorCtx: FileProcessorContext = {
      folderId,
      characterId: folder.characterId,
      folderPath,
      syncAbortController,
      skipReasons,
      config,
      existingFileMap,
      behavior: { maxFileSizeBytes: behavior.maxFileSizeBytes, shouldCreateEmbeddings },
      shouldForceReindex,
      totalFiles,
      startTime,
      chunkingOverrides,
      counters,
      onProgress: updateProgressInDb,
    };

    console.log(`[SyncService] Starting parallel indexing with ${config.concurrency} concurrent workers...`);

    const { createConcurrencyLimiter } = await import("./sync-helpers");
    const limitConcurrency = createConcurrencyLimiter(config.concurrency);

    const fileResults = await Promise.all(
      discoveredFiles.map((file, index) =>
        limitConcurrency(() => processFileInBatch(file, index, processorCtx))
      )
    );

    for (const fileResult of fileResults) {
      result.filesProcessed++;
      if (fileResult.indexed) result.filesIndexed++;
      else if (fileResult.skipped) result.filesSkipped++;
      if (fileResult.error) result.errors.push(fileResult.error);
    }

    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SyncService] Parallel indexing complete in ${elapsedSeconds}s`);

    const allFolderFiles = await db
      .select()
      .from(agentSyncFiles)
      .where(eq(agentSyncFiles.folderId, folderId));

    const totalChunkCount = allFolderFiles.reduce((sum, file) => sum + (file.chunkCount || 0), 0);
    const hasIndexedFiles = allFolderFiles.length > 0 || result.filesIndexed > 0;
    const syncStatus = !hasIndexedFiles && result.errors.length > 0 ? "error" : "synced";
    const errorSummary =
      result.errors.length > 0
        ? `${result.errors.length} file(s) failed: ${result.errors.join("; ")}`
        : null;
    const embeddingModelId = shouldCreateEmbeddings ? getEmbeddingModelId() : null;

    result.skippedReasons = skipReasons;

    // Re-read folder status to check if user paused during sync
    const [currentFolder] = await db
      .select({ status: agentSyncFolders.status })
      .from(agentSyncFolders)
      .where(eq(agentSyncFolders.id, folderId));

    // If user paused while sync was running, preserve paused state
    const finalStatus = currentFolder?.status === "paused" ? "paused" : syncStatus;

    await db
      .update(agentSyncFolders)
      .set({
        status: finalStatus,
        lastSyncedAt: new Date().toISOString(),
        lastError: finalStatus === "paused" ? "Paused by user" : errorSummary,
        fileCount: allFolderFiles.length,
        chunkCount: totalChunkCount,
        skippedCount: result.filesSkipped,
        skipReasons,
        lastRunTrigger: trigger,
        lastRunMetadata: {
          trigger,
          syncMode: behavior.syncMode,
          reindexPolicy: behavior.reindexPolicy,
          forceReindex: shouldForceReindex,
          smartReindexAt: smartReindexDue ? new Date().toISOString() : previousSmartReindexAt,
          filesProcessed: result.filesProcessed,
          filesIndexed: result.filesIndexed,
          filesSkipped: result.filesSkipped,
          filesRemoved: result.filesRemoved,
          skippedReasons: skipReasons,
          completedAt: new Date().toISOString(),
        },
        embeddingModel: embeddingModelId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(agentSyncFolders.id, folderId));

    // Don't restart watcher if folder was paused during sync
    if (finalStatus === "paused") {
      console.log(`[SyncService] Folder ${folderId} was paused during sync, skipping watcher restart`);
    } else if (!behavior.allowsWatcherEvents && isWatching(folderId)) {
      await stopWatching(folderId);
    }

    if (finalStatus !== "paused" && syncStatus === "synced" && behavior.allowsWatcherEvents && !isWatching(folderId)) {
      const forcePolling =
        process.platform !== "win32" && discoveredFiles.length > 500;
      const watchConfig = {
        folderId,
        characterId: folder.characterId,
        folderPath,
        recursive: folder.recursive,
        includeExtensions: allowedExtensions,
        excludePatterns,
        forcePolling,
      };

      if (forcePolling) {
        console.log(
          `[SyncService] Large folder (${discoveredFiles.length} files), will start watcher in polling mode after brief delay`
        );
      }

      const watchDelay = forcePolling ? 5000 : 0;
      if (watchDelay > 0) {
        setTimeout(() => {
          startWatching(watchConfig).catch(err =>
            console.error(`[SyncService] Failed to start file watcher for ${folderPath}:`, err)
          );
        }, watchDelay);
      } else {
        startWatching(watchConfig).catch(err =>
          console.error(`[SyncService] Failed to start file watcher for ${folderPath}:`, err)
        );
      }
    }
  } catch (error) {
    const hitFileDescriptorLimit = isFileDescriptorLimitError(error);
    const resourceCode = getResourceErrorCode(error) ?? "file descriptor limit";
    const rawErrorMessage = error instanceof Error ? error.message : "Sync failed";
    const errorMsg = hitFileDescriptorLimit
      ? `Paused: ${resourceCode} while scanning ${folderPath}. ` +
        `Dependency, cache, virtualenv, build, and unrequested asset trees are excluded automatically; ` +
        `reduce the remaining sync scope before resuming if the limit persists.`
      : rawErrorMessage;
    result.errors.push(errorMsg);

    if (hitFileDescriptorLimit) {
      console.warn(`[SyncService] ${errorMsg}`);
      if (isWatching(folderId)) {
        try {
          await stopWatching(folderId);
        } catch (stopError) {
          console.warn(`[SyncService] Failed to stop watcher after ${resourceCode}:`, stopError);
        }
      }
    }

    // Re-read DB status: if user paused during sync, preserve paused state
    const [currentState] = await db
      .select({ status: agentSyncFolders.status })
      .from(agentSyncFolders)
      .where(eq(agentSyncFolders.id, folderId));

    if (currentState?.status === "paused") {
      console.log(`[SyncService] Folder ${folderId} was paused during sync error, preserving paused state`);
    } else {
      await db
        .update(agentSyncFolders)
        .set(hitFileDescriptorLimit
          ? {
              status: "paused",
              lastError: errorMsg,
              // Discovery aborted before reconciliation. Preserve the previous
              // counts so a resource error never looks like a successful empty scan.
              fileCount: folder.fileCount,
              chunkCount: folder.chunkCount,
              updatedAt: new Date().toISOString(),
            }
          : { status: "error", lastError: errorMsg, updatedAt: new Date().toISOString() })
        .where(eq(agentSyncFolders.id, folderId));
    }
  } finally {
    syncingFolders.delete(folderId);
    syncingPaths.delete(folderPath);
  }

  console.log(`[SyncService] Sync complete for folder ${folderId}:`, result);
  return result;
}

/**
 * Update settings for a sync folder
 */
export async function updateSyncFolderSettings(config: SyncFolderUpdateConfig): Promise<void> {
  const {
    folderId,
    displayName,
    recursive,
    includeExtensions,
    excludePatterns,
    indexingMode,
    syncMode,
    syncCadenceMinutes,
    fileTypeFilters,
    maxFileSizeBytes,
    chunkPreset,
    chunkSizeOverride,
    chunkOverlapOverride,
    reindexPolicy,
  } = config;

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };

  if (displayName !== undefined) updates.displayName = displayName;
  if (recursive !== undefined) updates.recursive = recursive;
  if (includeExtensions !== undefined) updates.includeExtensions = normalizeExtensions(includeExtensions);
  if (excludePatterns !== undefined) updates.excludePatterns = excludePatterns;
  if (indexingMode !== undefined) updates.indexingMode = indexingMode;
  if (syncMode !== undefined) updates.syncMode = syncMode;
  if (syncCadenceMinutes !== undefined) updates.syncCadenceMinutes = Math.max(5, Math.floor(syncCadenceMinutes));
  if (fileTypeFilters !== undefined) updates.fileTypeFilters = normalizeExtensions(fileTypeFilters);
  if (maxFileSizeBytes !== undefined) updates.maxFileSizeBytes = Math.max(1024, Math.floor(maxFileSizeBytes));
  if (chunkPreset !== undefined) updates.chunkPreset = normalizeChunkPreset(chunkPreset);
  if (chunkSizeOverride !== undefined) {
    updates.chunkSizeOverride =
      typeof chunkSizeOverride === "number" ? Math.max(100, Math.floor(chunkSizeOverride)) : null;
  }
  if (chunkOverlapOverride !== undefined) {
    updates.chunkOverlapOverride =
      typeof chunkOverlapOverride === "number" ? Math.max(0, Math.floor(chunkOverlapOverride)) : null;
  }
  if (reindexPolicy !== undefined) updates.reindexPolicy = normalizeReindexPolicy(reindexPolicy);

  await db
    .update(agentSyncFolders)
    .set(updates)
    .where(eq(agentSyncFolders.id, folderId));

  const [folder] = await db
    .select()
    .from(agentSyncFolders)
    .where(eq(agentSyncFolders.id, folderId));

  if (!folder) return;

  const behavior = resolveFolderSyncBehavior({
    indexingMode: folder.indexingMode,
    syncMode: folder.syncMode,
    syncCadenceMinutes: folder.syncCadenceMinutes,
    maxFileSizeBytes: folder.maxFileSizeBytes,
    chunkPreset: folder.chunkPreset,
    chunkSizeOverride: folder.chunkSizeOverride,
    chunkOverlapOverride: folder.chunkOverlapOverride,
    reindexPolicy: folder.reindexPolicy,
  });

  if (!behavior.allowsWatcherEvents && isWatching(folderId)) {
    await stopWatching(folderId);
  }

  if (behavior.allowsWatcherEvents && folder.status === "synced" && !isWatching(folderId)) {
    const { normalizedPath, error } = await validateSyncFolderPath(folder.folderPath);
    if (error) {
      await db
        .update(agentSyncFolders)
        .set({ status: "error", lastError: error, updatedAt: new Date().toISOString() })
        .where(eq(agentSyncFolders.id, folder.id));
    } else {
      if (normalizedPath !== folder.folderPath) {
        await db
          .update(agentSyncFolders)
          .set({ folderPath: normalizedPath, updatedAt: new Date().toISOString() })
          .where(eq(agentSyncFolders.id, folder.id));
      }

      const folderIncludeExtensions = normalizeExtensions(parseJsonArray(folder.includeExtensions));
      const folderFileTypeFilters = normalizeExtensions(parseJsonArray(folder.fileTypeFilters));

      try {
        await startWatching({
          folderId: folder.id,
          characterId: folder.characterId,
          folderPath: normalizedPath,
          recursive: folder.recursive,
          includeExtensions: folderFileTypeFilters.length > 0 ? folderFileTypeFilters : folderIncludeExtensions,
          excludePatterns: parseJsonArray(folder.excludePatterns),
        });
      } catch (watchError) {
        await db
          .update(agentSyncFolders)
          .set({
            status: "error",
            lastError: watchError instanceof Error ? watchError.message : "Failed to start file watcher",
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agentSyncFolders.id, folder.id));
      }
    }
  }

  notifyFolderChange(folder.characterId, { type: "updated", folderId });
}

/**
 * Pause a sync folder — stops its watcher, cancels any in-flight sync,
 * and persists `status: "paused"` so it survives restarts.
 */
export async function pauseSyncFolder(folderId: string): Promise<void> {
  const [folder] = await db
    .select()
    .from(agentSyncFolders)
    .where(eq(agentSyncFolders.id, folderId));

  if (!folder) throw new Error("Folder not found");
  if (folder.status === "paused") return; // Already paused, no-op

  // Cancel any running sync first
  if (isSyncing(folderId)) {
    await cancelSyncById(folderId);
  }

  // Stop watcher if active
  if (isWatching(folderId)) {
    await stopWatching(folderId);
  }

  await db
    .update(agentSyncFolders)
    .set({
      status: "paused",
      lastError: "Paused by user",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agentSyncFolders.id, folderId));

  notifyFolderChange(folder.characterId, { type: "updated", folderId });
}

/**
 * Resume a paused sync folder — restores `status: "synced"` and
 * restarts its watcher if the sync mode allows it.
 */
export async function resumeSyncFolder(folderId: string): Promise<void> {
  const [folder] = await db
    .select()
    .from(agentSyncFolders)
    .where(eq(agentSyncFolders.id, folderId));

  if (!folder) throw new Error("Folder not found");
  if (folder.status !== "paused") return; // Not paused, no-op

  const { normalizedPath, error: pathError } = await validateSyncFolderPath(folder.folderPath);
  if (pathError) {
    await db
      .update(agentSyncFolders)
      .set({ lastError: `Paused: ${pathError}`, updatedAt: new Date().toISOString() })
      .where(eq(agentSyncFolders.id, folderId));
    throw new Error(pathError);
  }

  const folderPath = normalizedPath;
  await maybeUpdateNormalizedFolderPath(folderId, normalizedPath, folder.folderPath);

  // Restore to synced (or pending if never synced)
  const newStatus = (folder.fileCount ?? 0) > 0 ? "synced" : "pending";

  await db
    .update(agentSyncFolders)
    .set({
      status: newStatus,
      lastError: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agentSyncFolders.id, folderId));

  // Restart watcher if sync mode allows it and folder is synced
  if (newStatus === "synced") {
    const behavior = resolveFolderSyncBehavior({
      indexingMode: folder.indexingMode,
      syncMode: folder.syncMode,
      syncCadenceMinutes: folder.syncCadenceMinutes,
      maxFileSizeBytes: folder.maxFileSizeBytes,
      chunkPreset: folder.chunkPreset,
      chunkSizeOverride: folder.chunkSizeOverride,
      chunkOverlapOverride: folder.chunkOverlapOverride,
      reindexPolicy: folder.reindexPolicy,
    });

    if (behavior.allowsWatcherEvents && !isWatching(folderId)) {
      const folderIncludeExtensions = normalizeExtensions(parseJsonArray(folder.includeExtensions));
      const folderFileTypeFilters = normalizeExtensions(parseJsonArray(folder.fileTypeFilters));

      try {
        await startWatching({
          folderId: folder.id,
          characterId: folder.characterId,
          folderPath,
          recursive: folder.recursive,
          includeExtensions: folderFileTypeFilters.length > 0 ? folderFileTypeFilters : folderIncludeExtensions,
          excludePatterns: parseJsonArray(folder.excludePatterns),
        });
      } catch (watchError) {
        await db
          .update(agentSyncFolders)
          .set({
            status: "error",
            lastError: watchError instanceof Error ? watchError.message : "Failed to start file watcher",
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agentSyncFolders.id, folderId));
      }
    }
  }

  notifyFolderChange(folder.characterId, { type: "updated", folderId });
}

export async function syncAllFolders(
  characterId: string,
  parallelConfig: Partial<ParallelConfig> = {},
  forceReindex: boolean = false,
  trigger: SyncExecutionTrigger = "manual"
): Promise<SyncResult[]> {
  const folders = await getSyncFolders(characterId);
  const results: SyncResult[] = [];
  for (const folder of folders) {
    if (folder.status === "paused") continue;
    results.push(await syncFolder(folder.id, parallelConfig, forceReindex, trigger));
  }
  return results;
}

/**
 * Reindex all folders for an agent.
 * Drops the existing table to rebuild schema, then forces a full reindex.
 */
export async function reindexAllFolders(
  characterId: string,
  parallelConfig: Partial<ParallelConfig> = {}
): Promise<SyncResult[]> {
  console.log(`[SyncService] Reindexing all folders for agent ${characterId}`);
  await deleteAgentTable(characterId);
  return syncAllFolders(characterId, parallelConfig, true, "manual");
}

/**
 * Reindex all folders for every character that has synced folders.
 */
async function reindexAllCharacters(
  parallelConfig: Partial<ParallelConfig> = {}
): Promise<Record<string, SyncResult[]>> {
  const rows = await db
    .select({ characterId: agentSyncFolders.characterId })
    .from(agentSyncFolders)
    .groupBy(agentSyncFolders.characterId);

  const results: Record<string, SyncResult[]> = {};
  for (const row of rows) {
    const characterId = row.characterId;
    if (!characterId) continue;
    results[characterId] = await reindexAllFolders(characterId, parallelConfig);
  }
  return results;
}

/**
 * Remove orphaned LanceDB tables that no longer have a matching character.
 */
export async function cleanupOrphanedVectorTables(): Promise<{ removed: string[]; kept: string[] }> {
  const tables = await listAgentTables();
  if (tables.length === 0) return { removed: [], kept: [] };

  const rows = await db.select({ id: characters.id }).from(characters);
  const validIds = new Set(rows.map(row => row.id));
  const removed: string[] = [];
  const kept: string[] = [];

  for (const table of tables) {
    const characterId = decodeAgentTableName(table);
    if (!characterId) { kept.push(table); continue; }
    if (!validIds.has(characterId)) {
      await deleteAgentTable(characterId);
      removed.push(table);
    } else {
      kept.push(table);
    }
  }

  if (removed.length > 0) {
    console.log(`[SyncService] Cleaned up ${removed.length} orphaned vector table(s): ${removed.join(", ")}`);
  }
  return { removed, kept };
}

/**
 * Remove orphaned agent_sync_folders DB rows — rows whose characterId no longer
 * maps to a live character.  This catches sub-agent folders that weren't cleaned
 * up when the owning character was deleted outside the normal DELETE endpoint
 * (e.g. direct SQL, workflow teardown, crash mid-delete).
 *
 * For each orphaned folder this function:
 *   1. Stops the file watcher (if running).
 *   2. Cancels any in-flight sync.
 *   3. Deletes the agentSyncFiles rows (FK cascade handles this, but we do it
 *      explicitly so the watcher/sync cancellation happens first).
 *   4. Deletes the agentSyncFolders row.
 *
 * Vector table cleanup for the same characterId is left to
 * cleanupOrphanedVectorTables(), which should be called in the same pass.
 */
export async function cleanupOrphanedSyncFolders(): Promise<{ removed: string[]; kept: number }> {
  const allFolders = await db.select().from(agentSyncFolders);
  if (allFolders.length === 0) return { removed: [], kept: 0 };

  const rows = await db.select({ id: characters.id }).from(characters);
  const validIds = new Set(rows.map(row => row.id));

  const orphaned = allFolders.filter(f => !validIds.has(f.characterId));
  const kept = allFolders.length - orphaned.length;
  const removed: string[] = [];

  for (const folder of orphaned) {
    try {
      if (isSyncing(folder.id)) {
        await cancelSyncById(folder.id);
      }
      if (isWatching(folder.id)) {
        await stopWatching(folder.id);
      }
      await db.delete(agentSyncFiles).where(eq(agentSyncFiles.folderId, folder.id));
      await db.delete(agentSyncFolders).where(eq(agentSyncFolders.id, folder.id));
      removed.push(folder.id);
    } catch (err) {
      console.error(`[SyncService] Failed to remove orphaned sync folder ${folder.id}:`, err);
    }
  }

  if (removed.length > 0) {
    console.log(`[SyncService] Cleaned up ${removed.length} orphaned sync folder(s) for deleted characters`);
  }
  return { removed, kept };
}

/**
 * Remove inherited sync folders whose source folder no longer exists.
 *
 * Inherited folders (created by workflow propagation) have an
 * `inheritedFromFolderId` pointing to the source folder on the initiator.
 * If that source folder was deleted (workspace cleanup, manual removal, etc.)
 * but the propagation failed to cascade, the inherited copy becomes orphaned.
 *
 * This function finds those orphans and removes them via removeSyncFolder()
 * so watchers, vector DB data, and DB rows are all cleaned up properly.
 */
export async function cleanupOrphanedInheritedFolders(): Promise<{ removed: string[]; kept: number }> {
  // Get all inherited folders (those with a non-null inheritedFromFolderId)
  const inheritedFolders = await db
    .select({
      id: agentSyncFolders.id,
      inheritedFromFolderId: agentSyncFolders.inheritedFromFolderId,
      folderPath: agentSyncFolders.folderPath,
      characterId: agentSyncFolders.characterId,
    })
    .from(agentSyncFolders)
    .where(isNotNull(agentSyncFolders.inheritedFromFolderId));

  if (inheritedFolders.length === 0) return { removed: [], kept: 0 };

  // Get the set of all existing folder IDs to check source existence
  const allFolderIds = new Set(
    (await db.select({ id: agentSyncFolders.id }).from(agentSyncFolders)).map(r => r.id)
  );

  const orphaned = inheritedFolders.filter(f => !allFolderIds.has(f.inheritedFromFolderId!));
  const kept = inheritedFolders.length - orphaned.length;
  const removed: string[] = [];

  for (const folder of orphaned) {
    try {
      await removeSyncFolder(folder.id);
      removed.push(folder.id);
    } catch (err) {
      console.error(`[SyncService] Failed to remove orphaned inherited folder ${folder.id} (${folder.folderPath}):`, err);
    }
  }

  if (removed.length > 0) {
    console.log(`[SyncService] Cleaned up ${removed.length} orphaned inherited folder(s) (source folder deleted)`);
  }
  return { removed, kept };
}

/**
 * Remove workspace-sourced sync folders whose on-disk worktree no longer exists.
 *
 * Workspace folders are created by the workspace tool to register an agent's
 * git worktree path for file-tool authorization (readFile/editFile/localGrep).
 * Agents often finish their sessions without calling `workspace({action: "delete"})`,
 * or external cleanup removes the worktree directory. Either way the sync folder
 * row lingers and counts against the per-character folder count.
 *
 * This function finds workspace-sourced folders where the folderPath does not
 * exist on disk and removes them via removeSyncFolder (which short-circuits the
 * UI notifications and workflow propagation for workspace source).
 */
export async function cleanupOrphanedWorkspaceFolders(): Promise<{ removed: string[]; kept: number }> {
  const { existsSync } = await import("node:fs");

  const { onlyWorkspaceSource } = await import("./source-predicates");
  const workspaceFolders = await db
    .select({
      id: agentSyncFolders.id,
      folderPath: agentSyncFolders.folderPath,
    })
    .from(agentSyncFolders)
    .where(onlyWorkspaceSource());

  if (workspaceFolders.length === 0) return { removed: [], kept: 0 };

  const orphaned = workspaceFolders.filter(f => !existsSync(f.folderPath));
  const kept = workspaceFolders.length - orphaned.length;
  const removed: string[] = [];

  // Lazy-load metrics to avoid circular imports.
  const { recordWorkspaceCleanup, recordWorkspaceCleanupError } = await import(
    "@/lib/workspace/metrics"
  );

  for (const folder of orphaned) {
    try {
      await removeSyncFolder(folder.id);
      removed.push(folder.id);
      recordWorkspaceCleanup("boot-sweep");
    } catch (err) {
      recordWorkspaceCleanupError();
      console.error(`[SyncService] Failed to remove orphaned workspace folder ${folder.id} (${folder.folderPath}):`, err);
    }
  }

  if (removed.length > 0) {
    console.log(`[SyncService] Cleaned up ${removed.length} orphaned workspace sync folder(s) (worktree path missing)`);
  }
  return { removed, kept };
}

// Global lock to prevent overlapping syncStaleFolders runs
let isSyncingStaleFolders = false;

/**
 * Sync pending folders (folders that were added but never synced).
 */
async function syncPendingFolders(): Promise<SyncResult[]> {
  console.log("[SyncService] Checking for pending folders to sync...");

  const pendingFolders = await db
    .select()
    .from(agentSyncFolders)
    .where(eq(agentSyncFolders.status, "pending"));

  console.log(`[SyncService] Found ${pendingFolders.length} pending folders to sync`);

  const results: SyncResult[] = [];
  for (const folder of pendingFolders) {
    if (!isSyncing(folder.id)) {
      results.push(await syncFolder(folder.id, {}, false, "auto"));
    }
  }
  return results;
}

/**
 * Sync stale folders (for app startup or periodic sync).
 * Includes pending folders that were never synced.
 */
export async function syncStaleFolders(maxAgeMs: number = 60 * 60 * 1000): Promise<SyncResult[]> {
  if (isSyncingStaleFolders) {
    console.log("[SyncService] syncStaleFolders already in progress, skipping");
    return [];
  }

  isSyncingStaleFolders = true;
  console.log("[SyncService] Checking for stale folders to sync...");

  try {
    const folders = await db
      .select()
      .from(agentSyncFolders)
      .where(
        or(
          eq(agentSyncFolders.status, "synced"),
          eq(agentSyncFolders.status, "error"),
          eq(agentSyncFolders.status, "pending")
        )
      );

    const staleFolders = folders.filter(f => {
      const behavior = resolveFolderSyncBehavior({
        indexingMode: f.indexingMode,
        syncMode: f.syncMode,
        syncCadenceMinutes: f.syncCadenceMinutes,
      });

      if (!shouldRunForTrigger(behavior, "scheduled")) return false;
      if (f.status === "pending") return true;
      if (!f.lastSyncedAt) return true;

      const cadenceMs = Math.max(behavior.syncCadenceMinutes * 60 * 1000, maxAgeMs);
      return f.lastSyncedAt < new Date(Date.now() - cadenceMs).toISOString();
    });

    console.log(`[SyncService] Found ${staleFolders.length} stale/pending folders to sync`);

    const results: SyncResult[] = [];
    for (const folder of staleFolders) {
      if (!isSyncing(folder.id)) {
        results.push(await syncFolder(folder.id, {}, false, "scheduled"));
      }
    }
    return results;
  } finally {
    isSyncingStaleFolders = false;
  }
}

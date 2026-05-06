/**
 * File Watcher Service
 *
 * Uses chokidar to watch folders for changes and trigger incremental sync.
 * Implements debouncing to avoid excessive re-indexing.
 *
 * Shared watcher architecture: a single chokidar instance per physical path,
 * with fan-out to all subscriber folders (agents) on file change events.
 * Managed via the shared-folder-registry.
 */

import chokidar, { FSWatcher } from "chokidar";
import { extname, relative, resolve } from "path";
import { db } from "@/lib/db/sqlite-client";
import { agentSyncFolders, agentSyncFiles } from "@/lib/db/sqlite-character-schema";
import { eq, and } from "drizzle-orm";
import { indexFileToVectorDB, removeFileFromVectorDB } from "./indexing";
import { DEFAULT_IGNORE_PATTERNS, createIgnoreMatcher, createAggressiveIgnore } from "./ignore-patterns";
import { taskRegistry } from "@/lib/background-tasks/registry";
import { resolveChunkingOverrides, resolveFolderSyncBehavior, shouldRunForTrigger } from "./sync-mode-resolver";
import type { TaskEvent } from "@/lib/background-tasks/types";
import { notifyFolderChange } from "./folder-events";
import {
  getMaxConcurrency,
  getOpenFileDescriptorCount,
  getWatcherFdBudget,
  getWatcherFdWarnThreshold,
  isProjectRootDirectory,
  processWithConcurrency,
} from "./file-watcher-utils";
import { parseJsonArray, normalizeExtensions } from "./sync-helpers";
import {
  registerFolder,
  unregisterFolder,
  setWatcherOwner,
  getWatcherOwner,
  getSubscribers,
  getPathForFolder,
  isRegistered,
  clearRegistry,
  getSubscriberCount,
  resolveRegistryPath,
  resolveRegistryPathAsync,
} from "./shared-folder-registry";

// ---------------------------------------------------------------------------
// Global state that persists across hot reloads (dev mode)
// ---------------------------------------------------------------------------

const globalForWatchers = globalThis as unknown as {
  // resolvedPath → chokidar instance (ONE watcher per physical path)
  pathWatchers?: Map<string, FSWatcher>;
  // folderId → set of pending file changes
  folderQueues?: Map<string, Set<string>>;
  // folderId → set of deferred file changes (deferred while chat is active)
  deferredQueues?: Map<string, Set<string>>;
  // folderId → batch processor info
  folderProcessors?: Map<string, {
    processBatch: () => Promise<void>;
    characterId: string;
    folderPath: string;
  }>;
  // folderId → subscriber filter/config for fan-out
  folderSubscribers?: Map<string, FolderSubscriber>;
};

if (!globalForWatchers.pathWatchers) {
  globalForWatchers.pathWatchers = new Map();
}
if (!globalForWatchers.folderQueues) {
  globalForWatchers.folderQueues = new Map();
}
if (!globalForWatchers.deferredQueues) {
  globalForWatchers.deferredQueues = new Map();
}
if (!globalForWatchers.folderProcessors) {
  globalForWatchers.folderProcessors = new Map();
}
if (!globalForWatchers.folderSubscribers) {
  globalForWatchers.folderSubscribers = new Map();
}

/**
 * Per-folder subscriber info used for fan-out filtering.
 * Each subscriber has its own extension filters and ignore patterns.
 */
interface FolderSubscriber {
  folderId: string;
  characterId: string;
  folderPath: string;
  resolvedPath: string;
  normalizedExts: string[];
  shouldIgnore: (filePath: string) => boolean;
}

// Alias for readability
const pathWatchers = globalForWatchers.pathWatchers;
const folderQueues = globalForWatchers.folderQueues;
const deferredQueues = globalForWatchers.deferredQueues;
const folderProcessors = globalForWatchers.folderProcessors;
const folderSubscribers = globalForWatchers.folderSubscribers;
// Track whether we've logged the first raw event per path (one-shot diagnostic)
const rawEventLogged = new Set<string>();

// Track which paths are using polling mode
const pollingModePaths = new Set<string>();

const activeBatchProcessing = new Set<string>();
const pendingBatchRun = new Map<string, boolean>();

// Track EACCES / EPERM errors per path. After the threshold the watcher is
// stopped and all subscriber folders are marked as errored.
const permissionErrorCounts = new Map<string, number>();
const PERMISSION_ERROR_THRESHOLD = 10;

const activeChatRunsByCharacter = new Map<string, number>();
let registryListenerInitialized = false;

// Debounce timers per folder
const folderTimers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 1000;

interface WatcherConfig {
  folderId: string;
  characterId: string;
  folderPath: string;
  recursive: boolean;
  includeExtensions: string[];
  excludePatterns: string[];
  forcePolling?: boolean;
}

// Track EMFILE retry attempts per path to prevent infinite restart loops
const emfileRetryCounts = new Map<string, number>();
const MAX_EMFILE_RETRIES = 3;
const EMFILE_BACKOFF_MS = [3000, 10000, 30000];

// Cap concurrent recursive watchers. macOS Electron utilityProcess hits FD
// pressure long before chokidar's per-subdirectory FDs from a 4th large tree
// would spill the budget; once exhausted, every spawn() in the host process
// fails with EBADF (MCP servers, node probes), not just the watcher.
const MAX_CONCURRENT_RECURSIVE_WATCHERS = process.platform === "darwin" ? 3 : 8;
const recursiveWatcherPaths = new Set<string>();
const READY_TIMEOUT_MS = 15000;
const pathReadyPromises = new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pauseFolderWithError(folderId: string, lastError: string): Promise<void> {
  await db
    .update(agentSyncFolders)
    .set({
      status: "paused",
      lastError,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agentSyncFolders.id, folderId));
}

/**
 * Safely close a path watcher, even when file descriptors are exhausted.
 */
async function safeClosePathWatcher(resolvedPath: string): Promise<void> {
  const watcher = pathWatchers.get(resolvedPath);
  if (!watcher) {
    // Still drop any tracking state in case the watcher was registered before
    // its readyPromise rejected.
    pathReadyPromises.delete(resolvedPath);
    recursiveWatcherPaths.delete(resolvedPath);
    return;
  }
  try {
    await watcher.close();
  } catch (err) {
    console.error(`[FileWatcher] Error closing watcher for ${resolvedPath}, force-removing:`, err);
  }
  pathWatchers.delete(resolvedPath);
  pathReadyPromises.delete(resolvedPath);
  recursiveWatcherPaths.delete(resolvedPath);
}

/**
 * Completely tear down a path's watcher and all subscriber state due to a fatal error.
 *
 * Closes the chokidar watcher, pauses all subscriber folders in DB, clears all
 * in-memory state, and removes all registry entries. Only call this for
 * unrecoverable errors (permission threshold, EMFILE exhaustion, FD budget exceeded).
 *
 * Returns the list of affected folder IDs (useful for retry logic).
 */
async function teardownPathFatally(resolvedPath: string, errorMsg: string): Promise<string[]> {
  // Snapshot subscriber IDs before mutation (getSubscribers returns a copy)
  const affectedFolderIds = getSubscribers(resolvedPath);

  // Close the chokidar watcher
  await safeClosePathWatcher(resolvedPath);

  // Pause each subscriber in DB and clean up all in-memory state
  for (const subId of affectedFolderIds) {
    await pauseFolderWithError(subId, errorMsg);
    await cleanupFolderSubscriber(subId);
    unregisterFolder(resolvedPath, subId);
  }

  // Clear path-level state
  pollingModePaths.delete(resolvedPath);
  permissionErrorCounts.delete(resolvedPath);
  emfileRetryCounts.delete(resolvedPath);

  return affectedFolderIds;
}

// ---------------------------------------------------------------------------
// Chat-run deferral — time-bounded periodic flush instead of blocking
//
// File changes during active chat are collected in deferred queues and
// flushed every DEFERRED_FLUSH_INTERVAL_MS, ensuring files get indexed
// within seconds even during continuous chat sessions.
// ---------------------------------------------------------------------------

const DEFERRED_FLUSH_INTERVAL_MS = 5000; // flush deferred files every 5 seconds
let deferredFlushTimer: ReturnType<typeof setInterval> | null = null;
let flushInProgress = false;
let flushStartedAt = 0;
const FLUSH_TIMEOUT_MS = 30000; // reset stuck flush after 30s

function seedActiveChatRuns(): void {
  activeChatRunsByCharacter.clear();
  const activeChatTasks = taskRegistry.list({ type: "chat" }).tasks;
  for (const task of activeChatTasks) {
    if (!task.characterId) continue;
    const current = activeChatRunsByCharacter.get(task.characterId) ?? 0;
    activeChatRunsByCharacter.set(task.characterId, current + 1);
  }
}

function startDeferredFlushTimer(): void {
  if (deferredFlushTimer) return;
  console.error(`[FileWatcher] Starting deferred flush timer (interval: ${DEFERRED_FLUSH_INTERVAL_MS}ms)`);
  deferredFlushTimer = setInterval(() => {
    // Count total deferred files across all queues
    let totalDeferred = 0;
    for (const deferred of deferredQueues.values()) {
      totalDeferred += deferred.size;
    }
    if (totalDeferred > 0) {
      console.error(`[FileWatcher] Flush timer tick: ${totalDeferred} deferred file(s) across ${deferredQueues.size} queues`);
    }
    void flushAllDeferredQueues();
  }, DEFERRED_FLUSH_INTERVAL_MS);
  // Don't prevent Node.js from exiting if stopAllWatchers isn't called
  if (deferredFlushTimer && typeof deferredFlushTimer === "object" && "unref" in deferredFlushTimer) {
    (deferredFlushTimer as NodeJS.Timeout).unref();
  }
}

function stopDeferredFlushTimer(): void {
  if (deferredFlushTimer) {
    clearInterval(deferredFlushTimer);
    deferredFlushTimer = null;
  }
}

function initializeRegistryListener(): void {
  if (registryListenerInitialized) return;
  seedActiveChatRuns();

  taskRegistry.on("task:started", (event: TaskEvent) => {
    if (event.eventType !== "task:started") return;
    if (event.task.type !== "chat" || !event.task.characterId) return;
    const current = activeChatRunsByCharacter.get(event.task.characterId) ?? 0;
    activeChatRunsByCharacter.set(event.task.characterId, current + 1);
  });

  taskRegistry.on("task:completed", (event: TaskEvent) => {
    if (event.eventType !== "task:completed") return;
    if (event.task.type !== "chat" || !event.task.characterId) return;
    const current = activeChatRunsByCharacter.get(event.task.characterId) ?? 0;
    const next = Math.max(0, current - 1);
    if (next === 0) {
      activeChatRunsByCharacter.delete(event.task.characterId);
      // Immediate flush when chat ends (no need to wait for timer)
      void flushAllDeferredQueues();
    } else {
      activeChatRunsByCharacter.set(event.task.characterId, next);
    }
  });

  // Start the periodic flush timer for time-bounded deferral
  startDeferredFlushTimer();

  registryListenerInitialized = true;
}

function isChatActive(characterId: string): boolean {
  return (activeChatRunsByCharacter.get(characterId) ?? 0) > 0;
}

/**
 * Flush ALL deferred queues regardless of chat state.
 * Called periodically (every 5s) and on chat completion.
 * Guarded against concurrent execution.
 */
async function flushAllDeferredQueues(): Promise<void> {
  if (flushInProgress) {
    // Safety: reset stuck flush after timeout
    if (flushStartedAt > 0 && Date.now() - flushStartedAt > FLUSH_TIMEOUT_MS) {
      console.error(`[FileWatcher] Flush stuck for ${Math.round((Date.now() - flushStartedAt) / 1000)}s, force-resetting`);
      flushInProgress = false;
    } else {
      console.error(`[FileWatcher] Flush already in progress (${Math.round((Date.now() - flushStartedAt) / 1000)}s), skipping`);
      return;
    }
  }
  flushInProgress = true;
  flushStartedAt = Date.now();
  let flushedCount = 0;
  try {
    for (const [folderId, processor] of folderProcessors.entries()) {
      try {
        const deferred = deferredQueues.get(folderId);
        const queue = folderQueues.get(folderId);
        if (!deferred || !queue || deferred.size === 0) continue;

        for (const filePath of deferred) {
          queue.add(filePath);
        }
        const count = deferred.size;
        deferred.clear();
        flushedCount += count;

        console.error(`[FileWatcher] Periodic flush: ${count} deferred file(s) for ${processor.folderPath}`);
        await processor.processBatch();
      } catch (err) {
        console.error(`[FileWatcher] Error flushing deferred queue for folder ${folderId}:`, err);
      }
    }
  } finally {
    flushInProgress = false;
    flushStartedAt = 0;
    if (flushedCount > 0) {
      console.error(`[FileWatcher] Flush complete (${flushedCount} files)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-folder batch scheduling (called during fan-out)
// ---------------------------------------------------------------------------

function scheduleBatchForFolder(folderId: string, filePath: string): void {
  const processor = folderProcessors.get(folderId);
  if (!processor) return;

  // Process immediately regardless of chat state.
  // Chat and file indexing are independent — no reason to defer.
  const queue = folderQueues.get(folderId);
  if (!queue) return;

  queue.add(filePath);

  // Reset debounce timer
  if (folderTimers.has(folderId)) {
    clearTimeout(folderTimers.get(folderId)!);
  }

  folderTimers.set(
    folderId,
    setTimeout(processor.processBatch, DEBOUNCE_MS)
  );
}

// ---------------------------------------------------------------------------
// startWatching
// ---------------------------------------------------------------------------

/**
 * Start watching a folder for changes.
 *
 * If the physical path is already being watched by another folder,
 * this folder is registered as an additional subscriber and receives
 * file change events via fan-out. No duplicate chokidar instance is created.
 */
export async function startWatching(config: WatcherConfig): Promise<void> {
  initializeRegistryListener();

  let { folderId, characterId, folderPath, recursive, includeExtensions, excludePatterns, forcePolling: configForcePolling } = config;
  const resolvedPath = await resolveRegistryPathAsync(folderPath);

  // --- 1. Clean up any previous state for this specific folderId ---
  // Unregister from old path first to prevent phantom registry entries
  const oldPath = getPathForFolder(folderId);
  await cleanupFolderSubscriber(folderId);
  if (oldPath && oldPath !== resolvedPath) {
    const noMoreSubs = unregisterFolder(oldPath, folderId);
    if (noMoreSubs) {
      await safeClosePathWatcher(oldPath);
      pollingModePaths.delete(oldPath);
      permissionErrorCounts.delete(oldPath);
    }
  } else if (oldPath) {
    unregisterFolder(oldPath, folderId);
  }

  // --- 2. Register in shared registry ---
  registerFolder(folderPath, folderId);

  // --- 3. Set up per-folder processor state ---
  folderQueues.set(folderId, new Set());
  deferredQueues.set(folderId, new Set());

  const mergedExcludePatterns = Array.from(
    new Set([...DEFAULT_IGNORE_PATTERNS, ...excludePatterns])
  );
  const shouldIgnore = createIgnoreMatcher(mergedExcludePatterns, folderPath);
  const normalizedExts = includeExtensions.map((e) =>
    e.startsWith(".") ? e.slice(1).toLowerCase() : e.toLowerCase()
  );

  // Store subscriber info for fan-out filtering
  folderSubscribers.set(folderId, {
    folderId,
    characterId,
    folderPath,
    resolvedPath,
    normalizedExts,
    shouldIgnore,
  });

  // Create the batch processor for this folder (reads its own DB config)
  const processBatch = createBatchProcessor(folderId, characterId, folderPath, includeExtensions);
  folderProcessors.set(folderId, { processBatch, characterId, folderPath });

  // --- 4. Check if a watcher already exists for this physical path ---
  const existingOwner = getWatcherOwner(folderPath);
  if (existingOwner && existingOwner !== folderId && pathWatchers.has(resolvedPath)) {
    const subscriberCount = getSubscriberCount(folderPath);
    console.error(
      `[FileWatcher] Path ${folderPath} already watched by ${existingOwner}, ` +
      `added ${folderId} as subscriber #${subscriberCount} (shared watcher)`
    );
    await db
      .update(agentSyncFolders)
      .set({ status: "synced" })
      .where(eq(agentSyncFolders.id, folderId));
    return;
  }

  // --- 5. This folder will own the watcher for this path ---
  setWatcherOwner(folderPath, folderId);

  // Use console.error for critical lifecycle messages so they appear in production
  // logs (stderr is always captured; stdout may be filtered by log level).
  console.error(`[FileWatcher] Starting watch for folder: ${folderPath} (owner: ${folderId})`);

  if (folderPath === process.cwd()) {
    console.warn(
      `[FileWatcher] WARNING: Watching entire project directory (${folderPath}). ` +
      `This may cause high file descriptor usage and performance issues. ` +
      `Consider syncing specific subdirectories instead.`
    );
  }

  // --- 6. FD budget check ---
  // Hard-fail at >= budget. At >= warn threshold, defer rather than fall back
  // to polling: chokidar's polling mode still allocates FDs (it stat-cycles
  // every watched file), so it doesn't actually relieve pressure.
  const fdBudget = getWatcherFdBudget();
  const fdWarnThreshold = getWatcherFdWarnThreshold(fdBudget);
  const openFdCount = await getOpenFileDescriptorCount();
  const fdMeasured = typeof openFdCount === "number";
  const underFdPressure = fdMeasured && openFdCount >= fdWarnThreshold;
  if (fdMeasured) {
    if (openFdCount >= fdBudget) {
      const lastError =
        `Paused: this sync would exceed the watcher file descriptor budget (${openFdCount}/${fdBudget} open). ` +
        `Exclude virtualenvs, caches, node_modules, and large asset folders, or sync a smaller subfolder.`;
      console.error(`[FileWatcher] ${lastError} Folder: ${folderPath}`);
      await teardownPathFatally(resolvedPath, lastError);
      return;
    }

    if (underFdPressure) {
      const lastError =
        `Deferred: high file descriptor pressure (${openFdCount}/${fdBudget} open). ` +
        `Reduce synced folders or exclude large trees, then re-enable this folder.`;
      console.error(`[FileWatcher] ${lastError} Folder: ${folderPath}`);
      await teardownPathFatally(resolvedPath, lastError);
      return;
    }
  }

  // --- 6b. Concurrent-recursive-watcher cap ---
  // Second-line guard that doesn't depend on /dev/fd accuracy. Recursive
  // watchers on large trees are what drive the FD count up in the first place.
  if (recursive && recursiveWatcherPaths.size >= MAX_CONCURRENT_RECURSIVE_WATCHERS) {
    const lastError =
      `Deferred: max concurrent recursive watchers reached (${MAX_CONCURRENT_RECURSIVE_WATCHERS}). ` +
      `Sync fewer large trees or sync a smaller subfolder.`;
    console.error(`[FileWatcher] ${lastError} Folder: ${folderPath}`);
    await teardownPathFatally(resolvedPath, lastError);
    return;
  }

  // --- 7. Create chokidar watcher ---
  const aggressiveIgnore = createAggressiveIgnore(mergedExcludePatterns, folderPath, includeExtensions);

  // On macOS, Node.js fs.watch() uses native FSEvents through libuv — no need
  // for polling even on large project roots.  Only force polling on Linux where
  // inotify has per-user watch limits that large codebases can exhaust.
  // Skip the project-root probe (up to 8 access() calls) when we're already
  // under FD pressure — it consumes the FDs we're trying to preserve.
  const isLinux = process.platform === "linux";
  const isProjectRoot = isLinux && !underFdPressure && await isProjectRootDirectory(folderPath);
  const forcedPolling = pollingModePaths.has(resolvedPath);
  const usePolling = isProjectRoot || forcedPolling || configForcePolling === true;

  if (usePolling) {
    console.error(
      `[FileWatcher] Using polling mode for large codebase: ${folderPath} ` +
      `(prevents file descriptor exhaustion)`
    );
  }

  console.error(
    `[FileWatcher] Creating chokidar watcher: polling=${usePolling}, recursive=${recursive}, ` +
    `path=${folderPath}`
  );

  const watcher = chokidar.watch(folderPath, {
    persistent: true,
    ignoreInitial: true,
    depth: recursive ? undefined : 0,
    ignored: aggressiveIgnore,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 100,
    },
    usePolling,
    interval: usePolling ? 2000 : undefined,
    binaryInterval: usePolling ? 5000 : undefined,
  });

  // --- 7a. Track readiness so callers can serialize watcher startup ---
  // chokidar.watch returns synchronously but its initial recursive scan (which
  // is what allocates FDs) runs async. Without awaiting "ready", a serialized
  // outer loop's FD-pressure check still races the previous watcher's scan.
  const readyPromise = new Promise<void>((resolveReady, rejectReady) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectReady(new Error(`Watcher ready timeout (${READY_TIMEOUT_MS}ms) for ${folderPath}`));
    }, READY_TIMEOUT_MS);
    if (typeof timeout === "object" && "unref" in timeout) {
      (timeout as NodeJS.Timeout).unref();
    }
    watcher.once("ready", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (recursive) {
        recursiveWatcherPaths.add(resolvedPath);
      }
      resolveReady();
    });
    watcher.once("error", (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectReady(err instanceof Error ? err : new Error(String(err)));
    });
  });
  pathReadyPromises.set(resolvedPath, readyPromise);
  // Prevent "unhandled rejection" warnings — the rejection is observed below
  // at the end of startWatching, but Node logs the warning before that await
  // runs if the error fires synchronously.
  readyPromise.catch(() => {});

  // --- 7b. Confirm watcher is operational ---
  watcher.on("ready", () => {
    console.error(
      `[FileWatcher] ✓ Watcher READY for ${folderPath} (owner: ${folderId}, ` +
      `polling: ${usePolling}, subscribers: ${getSubscribers(resolvedPath).length}, ` +
      `recursiveActive: ${recursiveWatcherPaths.size}/${MAX_CONCURRENT_RECURSIVE_WATCHERS})`
    );
  });

  // --- 7c. Raw event logging for diagnostics ---
  watcher.on("raw", (event: string, path: string) => {
    // Only log the first few raw events to confirm the watcher is live
    if (!rawEventLogged.has(resolvedPath)) {
      rawEventLogged.add(resolvedPath);
      console.error(`[FileWatcher] First raw event for ${folderPath}: ${event} ${path}`);
    }
  });

  // --- 8. Fan-out event handlers ---
  // These handlers broadcast to ALL subscriber folders for this path.

  const handleFileChange = (filePath: string) => {
    // Skip directory-level events (polling mode fires these but they have no extension)
    // Only process actual file paths
    const ext = extname(filePath).slice(1).toLowerCase();
    if (!ext) {
      console.error(`[FileWatcher] Skipping directory-level event: ${filePath}`);
      return;
    }

    const subscribers = getSubscribers(resolvedPath);
    console.error(`[FileWatcher] File change detected: ${filePath} (ext=${ext}, subscribers=${subscribers.length})`);
    for (const subFolderId of subscribers) {
      const sub = folderSubscribers.get(subFolderId);
      if (!sub) continue;

      // Apply per-subscriber filtering
      if (sub.shouldIgnore(filePath)) {
        console.error(`[FileWatcher] Ignored by pattern: ${filePath} (folder: ${subFolderId})`);
        continue;
      }
      if (sub.normalizedExts.length > 0 && !sub.normalizedExts.includes(ext)) {
        console.error(`[FileWatcher] Filtered by extension: ${filePath} ext=${ext} not in [${sub.normalizedExts.slice(0, 5).join(",")}...] (folder: ${subFolderId})`);
        continue;
      }

      console.error(`[FileWatcher] Scheduling batch for folder ${subFolderId}: ${filePath}`);
      scheduleBatchForFolder(subFolderId, filePath);
    }
  };

  const handleFileRemove = async (filePath: string) => {
    const subscribers = getSubscribers(resolvedPath);
    for (const subFolderId of subscribers) {
      const sub = folderSubscribers.get(subFolderId);
      if (!sub) continue;

      try {
        // Remove from pending queue
        const queue = folderQueues.get(subFolderId);
        if (queue && queue.has(filePath)) {
          queue.delete(filePath);
        }

        // Look up the file record for this specific folder
        const [fileRecord] = await db
          .select()
          .from(agentSyncFiles)
          .where(and(
            eq(agentSyncFiles.folderId, subFolderId),
            eq(agentSyncFiles.filePath, filePath)
          ));

        if (fileRecord) {
          let pointIds: string[] = [];
          if (Array.isArray(fileRecord.vectorPointIds)) {
            pointIds = fileRecord.vectorPointIds;
          } else if (typeof fileRecord.vectorPointIds === "string") {
            try {
              const parsed = JSON.parse(fileRecord.vectorPointIds);
              pointIds = Array.isArray(parsed) ? parsed : [];
            } catch {
              pointIds = [];
            }
          }

          if (pointIds.length > 0) {
            await removeFileFromVectorDB({
              characterId: sub.characterId,
              pointIds,
            });
          }

          await db.delete(agentSyncFiles).where(eq(agentSyncFiles.id, fileRecord.id));
          console.error(`[FileWatcher] Removed ${pointIds.length} vectors for deleted file: ${filePath} (folder: ${subFolderId})`);
        }
      } catch (error) {
        console.error(`[FileWatcher] Error removing file ${filePath} for folder ${subFolderId}:`, error);
      }
    }
  };

  watcher
    .on("add", handleFileChange)
    .on("change", handleFileChange)
    .on("unlink", handleFileRemove)
    .on("error", async (error: any) => {
      // --- Permission errors (EACCES / EPERM) ---
      if (error?.code === 'EACCES' || error?.code === 'EPERM') {
        const count = (permissionErrorCounts.get(resolvedPath) ?? 0) + 1;
        permissionErrorCounts.set(resolvedPath, count);

        if (count === 1) {
          console.warn(
            `[FileWatcher] Permission error watching ${folderPath}: ${error.path || error.message}. ` +
            `Will stop watcher if errors persist.`
          );
        }

        if (count >= PERMISSION_ERROR_THRESHOLD) {
          console.error(
            `[FileWatcher] ${PERMISSION_ERROR_THRESHOLD} permission errors for ${folderPath}. ` +
            `Stopping watcher and marking all subscriber folders as errored.`
          );
          const errorMsg =
            `Paused: repeated permission errors watching ${folderPath}. ` +
            `This directory likely contains paths the app cannot access. Pick a more specific folder.`;
          await teardownPathFatally(resolvedPath, errorMsg);
        }
        return;
      }

      console.error(`[FileWatcher] Error watching ${folderPath}:`, error);

      // --- File-descriptor exhaustion (EMFILE / EBADF) ---
      if (error?.code === 'EMFILE' || error?.code === 'EBADF') {
        const retryCount = (emfileRetryCounts.get(resolvedPath) ?? 0) + 1;
        emfileRetryCounts.set(resolvedPath, retryCount);

        pollingModePaths.add(resolvedPath);

        if (retryCount > MAX_EMFILE_RETRIES) {
          console.error(
            `[FileWatcher] EMFILE recovery exhausted (${MAX_EMFILE_RETRIES} retries) for ${folderPath}. ` +
            `Pausing all subscriber folders to prevent app hang.`
          );
          const errorMsg =
            `Paused: file descriptor limit reached after ${MAX_EMFILE_RETRIES} retries while watching ${folderPath}. ` +
            `Exclude virtualenvs, caches, and large asset folders, or sync a smaller subfolder.`;
          await teardownPathFatally(resolvedPath, errorMsg);
          return;
        }

        // Capture ALL affected subscriber IDs before cleanup so we can re-subscribe them all
        const affectedFolderIds = getSubscribers(resolvedPath);

        // Close watcher and clean all in-memory state (but don't pause in DB — we'll retry)
        await safeClosePathWatcher(resolvedPath);
        for (const subId of affectedFolderIds) {
          await cleanupFolderSubscriber(subId);
          unregisterFolder(resolvedPath, subId);
        }

        const backoffMs = EMFILE_BACKOFF_MS[retryCount - 1] ?? EMFILE_BACKOFF_MS[EMFILE_BACKOFF_MS.length - 1];
        console.warn(
          `[FileWatcher] Hit file descriptor limit for ${folderPath} (attempt ${retryCount}/${MAX_EMFILE_RETRIES}), ` +
          `will retry in polling mode after ${backoffMs / 1000}s...`
        );

        setTimeout(async () => {
          console.error(
            `[FileWatcher] Restarting watcher for ${folderPath} in polling mode ` +
            `(attempt ${retryCount}, ${affectedFolderIds.length} subscriber(s))...`
          );
          // Re-subscribe ALL affected folders, not just the original owner
          for (const subFolderId of affectedFolderIds) {
            try {
              const [folder] = await db
                .select()
                .from(agentSyncFolders)
                .where(eq(agentSyncFolders.id, subFolderId));
              if (!folder || folder.status === "paused") continue;

              const subIncludeExts = normalizeExtensions(parseJsonArray(folder.includeExtensions));
              const subFileTypeFilters = normalizeExtensions(parseJsonArray(folder.fileTypeFilters));

              await startWatching({
                folderId: folder.id,
                characterId: folder.characterId,
                folderPath: folder.folderPath,
                recursive: folder.recursive,
                includeExtensions: subFileTypeFilters.length > 0 ? subFileTypeFilters : subIncludeExts,
                excludePatterns: parseJsonArray(folder.excludePatterns),
                forcePolling: true,
              });
            } catch (err) {
              console.error(`[FileWatcher] Failed to restart watcher for subscriber ${subFolderId} in polling mode:`, err);
            }
          }
        }, backoffMs);
      }
    });

  pathWatchers.set(resolvedPath, watcher);
  console.error(
    `[FileWatcher] Watcher stored for ${folderPath}. ` +
    `Total active path watchers: ${pathWatchers.size}, subscribers: ${folderSubscribers.size}`
  );

  // --- 9. Wait for chokidar's initial scan to complete before returning ---
  // This is the load-bearing line for serialized startup: it ensures the next
  // caller's FD-pressure check sees this watcher's allocations.
  try {
    await readyPromise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[FileWatcher] Watcher failed to become ready for ${folderPath}: ${message}`);
    // The chokidar "error" handler below already runs teardownPathFatally for
    // EMFILE / permission errors. Only run it ourselves if the watcher is
    // still registered (e.g., on ready timeout, the error handler never fires).
    if (pathWatchers.has(resolvedPath)) {
      const lastError =
        `Deferred: watcher did not become ready (${message}). ` +
        `Reduce synced folders or sync a smaller subfolder.`;
      await teardownPathFatally(resolvedPath, lastError);
    }
    throw err;
  }

  // Watcher started successfully — reset EMFILE retry state
  emfileRetryCounts.delete(resolvedPath);

  // Update folder status
  await db
    .update(agentSyncFolders)
    .set({ status: "synced", lastError: null })
    .where(eq(agentSyncFolders.id, folderId));
}

// ---------------------------------------------------------------------------
// Batch processor factory (per-folder, reads own DB config)
// ---------------------------------------------------------------------------

function createBatchProcessor(
  folderId: string,
  characterId: string,
  folderPath: string,
  initialIncludeExtensions: string[],
): () => Promise<void> {
  let includeExtensions = initialIncludeExtensions;

  const processBatch = async () => {
    if (activeBatchProcessing.has(folderId)) {
      pendingBatchRun.set(folderId, true);
      return;
    }

    activeBatchProcessing.add(folderId);
    const queue = folderQueues.get(folderId);
    if (!queue || queue.size === 0) {
      activeBatchProcessing.delete(folderId);
      return;
    }

    const filesToProcess = Array.from(queue);
    queue.clear();
    folderTimers.delete(folderId);
    const batchStartTime = Date.now();

    console.error(`[FileWatcher] Processing batch of ${filesToProcess.length} files for ${folderPath} (folder: ${folderId})`);

    const [folder] = await db
      .select()
      .from(agentSyncFolders)
      .where(eq(agentSyncFolders.id, folderId));

    if (!folder) {
      console.error(`[FileWatcher] Folder ${folderId} not found, skipping batch`);
      activeBatchProcessing.delete(folderId);
      return;
    }

    const behavior = resolveFolderSyncBehavior({
      indexingMode: folder.indexingMode,
      syncMode: folder.syncMode,
      maxFileSizeBytes: folder.maxFileSizeBytes,
      chunkPreset: folder.chunkPreset,
      chunkSizeOverride: folder.chunkSizeOverride,
      chunkOverlapOverride: folder.chunkOverlapOverride,
      reindexPolicy: folder.reindexPolicy,
    });

    const fileTypeFilters = normalizeExtensions(parseJsonArray(folder.fileTypeFilters));
    const effectiveIncludeExtensions = fileTypeFilters.length > 0
      ? fileTypeFilters
      : normalizeExtensions(parseJsonArray(folder.includeExtensions));
    includeExtensions = effectiveIncludeExtensions;

    // Update subscriber filter with latest extensions from DB
    const sub = folderSubscribers.get(folderId);
    if (sub) {
      sub.normalizedExts = includeExtensions.map((e) =>
        e.startsWith(".") ? e.slice(1).toLowerCase() : e.toLowerCase()
      );
    }

    if (!shouldRunForTrigger(behavior, "triggered")) {
      console.error(`[FileWatcher] Folder ${folderId} ignores trigger runs in ${behavior.syncMode} mode`);
      activeBatchProcessing.delete(folderId);
      return;
    }

    const shouldCreateEmbeddings = behavior.shouldCreateEmbeddings;
    const chunkingOverrides = resolveChunkingOverrides(behavior);

    console.error(
      `[FileWatcher] Folder indexing mode: ${folder.indexingMode}, sync mode: ${behavior.syncMode} (embeddings: ${shouldCreateEmbeddings})`
    );

    let successCount = 0;

    try {
      await processWithConcurrency(filesToProcess, getMaxConcurrency(), async (filePath) => {
        try {
          const relativePath = relative(folderPath, filePath);

          const { stat } = await import("fs/promises");
          const fileStat = await stat(filePath);
          if (fileStat.size > behavior.maxFileSizeBytes) {
            console.error(`[FileWatcher] Skipping ${filePath}: exceeds max size ${behavior.maxFileSizeBytes}`);
            return;
          }

          if (shouldCreateEmbeddings) {
            console.error(`[FileWatcher] Indexing changed file with embeddings: ${filePath}`);
            await indexFileToVectorDB({
              characterId,
              filePath,
              folderId,
              relativePath,
              chunkingOverrides: chunkingOverrides.useOverrides
                ? {
                    maxCharacters: chunkingOverrides.chunkSize,
                    overlapCharacters: chunkingOverrides.chunkOverlap,
                  }
                : undefined,
            });
          } else {
            console.error(`[FileWatcher] Tracking changed file (files-only mode): ${filePath}`);

            const { stat } = await import("fs/promises");
            const { createHash } = await import("crypto");
            const { readFile: readFileContent } = await import("fs/promises");

            const fileStat = await stat(filePath);
            const content = await readFileContent(filePath);
            const fileHash = createHash("md5").update(content).digest("hex");

            const [existing] = await db
              .select()
              .from(agentSyncFiles)
              .where(and(
                eq(agentSyncFiles.folderId, folderId),
                eq(agentSyncFiles.filePath, filePath)
              ));

            if (existing) {
              await db
                .update(agentSyncFiles)
                .set({
                  contentHash: fileHash,
                  sizeBytes: fileStat.size,
                  modifiedAt: fileStat.mtime.toISOString(),
                  status: "indexed",
                  vectorPointIds: [],
                  chunkCount: 0,
                  lastIndexedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                })
                .where(eq(agentSyncFiles.id, existing.id));
            } else {
              await db.insert(agentSyncFiles).values({
                folderId,
                characterId,
                filePath,
                relativePath,
                contentHash: fileHash,
                sizeBytes: fileStat.size,
                modifiedAt: fileStat.mtime.toISOString(),
                status: "indexed",
                vectorPointIds: [],
                chunkCount: 0,
                lastIndexedAt: new Date().toISOString(),
              });
            }
          }
          successCount++;
        } catch (error) {
          console.error(`[FileWatcher] Error processing file ${filePath}:`, error);
        }
      });
    } finally {
      activeBatchProcessing.delete(folderId);
      const elapsedMs = Date.now() - batchStartTime;
      const failedCount = filesToProcess.length - successCount;
      console.error(
        `[FileWatcher] Batch processing complete for ${folderPath} (folder: ${folderId}, ` +
        `${successCount}/${filesToProcess.length} files, ${failedCount > 0 ? `${failedCount} failed, ` : ""}${elapsedMs}ms)`
      );

      // Only emit notification if at least one file was processed
      if (successCount > 0) {
        notifyFolderChange(characterId, {
          type: "file_watcher_sync",
          folderId,
          folderPath,
          filesIndexed: successCount,
          elapsedMs,
          syncReason: "file_watcher",
        });
      }

      if (pendingBatchRun.get(folderId)) {
        pendingBatchRun.delete(folderId);
        if (folderQueues.get(folderId)?.size) {
          await processBatch();
        }
      }
    }
  };

  return processBatch;
}

// ---------------------------------------------------------------------------
// stopWatching
// ---------------------------------------------------------------------------

/**
 * Clean up a folder's subscriber state without affecting the shared watcher.
 */
async function cleanupFolderSubscriber(folderId: string): Promise<void> {
  if (folderTimers.has(folderId)) {
    clearTimeout(folderTimers.get(folderId)!);
    folderTimers.delete(folderId);
  }
  folderQueues.delete(folderId);
  deferredQueues.delete(folderId);
  folderProcessors.delete(folderId);
  folderSubscribers.delete(folderId);
  pendingBatchRun.delete(folderId);
  activeBatchProcessing.delete(folderId);
}

/**
 * Stop watching a folder.
 *
 * Unregisters this folder from the shared registry. If other folders
 * still reference the same path, the chokidar watcher is kept alive.
 * Only destroys the watcher when the last subscriber is removed.
 */
export async function stopWatching(folderId: string): Promise<void> {
  const registeredPath = getPathForFolder(folderId);

  // Clean up per-folder state
  await cleanupFolderSubscriber(folderId);

  if (!registeredPath) {
    // Not registered — nothing else to do
    return;
  }

  // Unregister from the shared registry
  const noMoreSubscribers = unregisterFolder(registeredPath, folderId);

  if (noMoreSubscribers) {
    // Last subscriber — destroy the chokidar watcher
    await safeClosePathWatcher(registeredPath);
    pollingModePaths.delete(registeredPath);
    permissionErrorCounts.delete(registeredPath);
    console.error(`[FileWatcher] Stopped last watcher for path: ${registeredPath} (was folder: ${folderId})`);
  } else {
    // Other subscribers remain. The registry's unregisterFolder already
    // transferred ownership if this was the owner. Log the transfer.
    const newOwner = getWatcherOwner(registeredPath);
    const remainingCount = getSubscriberCount(registeredPath);
    console.error(
      `[FileWatcher] Removed subscriber ${folderId} from ${registeredPath}. ` +
      `${remainingCount} subscriber(s) remain, owner: ${newOwner}`
    );
  }
}

/**
 * Stop all watchers and clear all state.
 */
export async function stopAllWatchers(): Promise<void> {
  // Stop the periodic deferred flush timer and reset initialization flag
  stopDeferredFlushTimer();
  registryListenerInitialized = false;
  flushInProgress = false;
  activeChatRunsByCharacter.clear();

  // Clear any pending debounce timers
  for (const timer of folderTimers.values()) {
    clearTimeout(timer);
  }
  folderTimers.clear();

  // Close all chokidar instances
  for (const [resolvedPath, watcher] of pathWatchers.entries()) {
    try {
      await watcher.close();
    } catch (err) {
      console.error(`[FileWatcher] Error closing watcher for ${resolvedPath}:`, err);
    }
  }
  pathWatchers.clear();

  // Clear all per-folder state (snapshot keys to avoid mutation during iteration)
  for (const folderId of Array.from(folderSubscribers.keys())) {
    await cleanupFolderSubscriber(folderId);
  }

  // Clear the shared registry
  clearRegistry();

  // Clear path-level state
  pollingModePaths.clear();
  permissionErrorCounts.clear();
  emfileRetryCounts.clear();
  pathReadyPromises.clear();
  recursiveWatcherPaths.clear();
}

/**
 * Get list of currently watched folder IDs (all subscribers, not just owners).
 */
function getWatchedFolders(): string[] {
  return Array.from(folderSubscribers.keys());
}

/**
 * Check if a folder is being watched (either as owner or subscriber).
 */
export function isWatching(folderId: string): boolean {
  return folderSubscribers.has(folderId);
}

/**
 * Get the number of deferred (queued but not yet indexed) files for a folder.
 */
export function getDeferredCount(folderId: string): number {
  return deferredQueues.get(folderId)?.size ?? 0;
}

/**
 * Get a health snapshot of the watcher system for diagnostics.
 */
export function getWatcherHealth(): {
  activePathWatchers: number;
  folderSubscribers: number;
  totalDeferredFiles: number;
  watchedPaths: string[];
  subscriberFolderIds: string[];
} {
  let totalDeferred = 0;
  for (const q of deferredQueues.values()) {
    totalDeferred += q.size;
  }
  return {
    activePathWatchers: pathWatchers.size,
    folderSubscribers: folderSubscribers.size,
    totalDeferredFiles: totalDeferred,
    watchedPaths: Array.from(pathWatchers.keys()),
    subscriberFolderIds: Array.from(folderSubscribers.keys()),
  };
}

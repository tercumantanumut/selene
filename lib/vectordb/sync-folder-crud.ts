/**
 * Sync Folder CRUD
 *
 * Database create/read/update/delete operations for sync folder records.
 * These functions manage folder metadata in the SQLite database without
 * touching in-memory sync state or the vector database.
 */

import { db } from "@/lib/db/sqlite-client";
import { agentSyncFolders } from "@/lib/db/sqlite-character-schema";
import { eq, and, sql } from "drizzle-orm";
import { normalizeFolderPath, validateSyncFolderPath } from "./path-validation";
import {
  normalizeChunkPreset,
  normalizeReindexPolicy,
} from "./sync-mode-resolver";
import { notifyFolderChange } from "./folder-events";
// Lazy import to break the cycle:
// workflow-folder-sharing → sync-service → sync-folder-crud → workflow-folder-sharing
async function loadPropagateWorkflowFolderChange() {
  const { propagateWorkflowFolderChange } = await import("@/lib/agents/workflow-folder-sharing");
  return propagateWorkflowFolderChange;
}
import { normalizeExtensions } from "./sync-helpers";
import type { SyncFolderConfig } from "./sync-types";

/**
 * Add a folder to sync for an agent
 */
export async function addSyncFolder(config: SyncFolderConfig): Promise<string> {
  const {
    userId,
    characterId,
    folderPath,
    displayName,
    recursive = true,
    includeExtensions = [
      "md", "txt", "pdf", "html", "htm",
      "php", "css", "scss", "sass", "less",
      "js", "jsx", "ts", "tsx", "mjs", "cjs",
      "json", "xml", "yaml", "yml", "toml",
      "vue", "svelte", "astro",
      "twig", "liquid", "hbs", "ejs", "pug",
      "sql", "graphql", "gql",
      "env.example", "gitignore", "dockerignore",
      "sh", "bash", "zsh", "ps1",
      "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cpp", "h",
      "csv", "log", "ini", "cfg", "conf",
    ],
    excludePatterns = [
      "node_modules",
      ".*",
      ".git",
      ".venv",
      "venv",
      "env",
      "__pycache__",
      "site-packages",
      "*.pyc",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "*.lock",
      // Package manager vendor dirs for non-JS ecosystems
      "vendor",     // PHP Composer / Go
      ".bundle",    // Ruby Bundler
      "Pods",       // iOS CocoaPods
      ".dart_tool", // Dart/Flutter
    ],
    indexingMode = "auto",
    syncMode = "auto",
    syncCadenceMinutes = 60,
    fileTypeFilters = [],
    maxFileSizeBytes = 10 * 1024 * 1024,
    chunkPreset = "balanced",
    chunkSizeOverride,
    chunkOverlapOverride,
    reindexPolicy = "smart",
    source = "user",
  } = config;

  const { normalizedPath, error } = await validateSyncFolderPath(folderPath);
  if (error) {
    throw new Error(error);
  }

  const existingFolders = await getSyncFolders(characterId);
  const existingPaths = new Set(existingFolders.map((folder) => normalizeFolderPath(folder.folderPath)));
  if (existingPaths.has(normalizedPath)) {
    throw new Error("This folder is already synced.");
  }

  // Normalize extensions to ensure consistent format (without dots)
  const normalizedExtensions = normalizeExtensions(includeExtensions);
  const normalizedFileTypeFilters = normalizeExtensions(fileTypeFilters);

  // Workspace-tool records are ephemeral path-authorization rows; they are never
  // synced to the vector DB and must never be treated as the agent's primary
  // knowledge folder. Keep the primary slot reserved for user-configured folders.
  const isWorkspaceSource = source === "workspace";
  const userConfiguredFolderCount = existingFolders.filter((f) => f.source !== "workspace").length;
  const isPrimary = !isWorkspaceSource && userConfiguredFolderCount === 0;

  const [folder] = await db
    .insert(agentSyncFolders)
    .values({
      userId,
      characterId,
      folderPath: normalizedPath,
      displayName: displayName || normalizedPath.split(/[/\\]/).pop(),
      isPrimary,
      recursive,
      // Note: Drizzle handles JSON serialization automatically for mode: "json" columns
      // Do NOT use JSON.stringify here
      includeExtensions: normalizedExtensions,
      excludePatterns,
      indexingMode,
      syncMode,
      syncCadenceMinutes: Math.max(5, Math.floor(syncCadenceMinutes)),
      fileTypeFilters: normalizedFileTypeFilters,
      maxFileSizeBytes: Math.max(1024, Math.floor(maxFileSizeBytes)),
      chunkPreset: normalizeChunkPreset(chunkPreset),
      chunkSizeOverride: typeof chunkSizeOverride === "number" ? Math.max(100, Math.floor(chunkSizeOverride)) : null,
      chunkOverlapOverride: typeof chunkOverlapOverride === "number" ? Math.max(0, Math.floor(chunkOverlapOverride)) : null,
      reindexPolicy: normalizeReindexPolicy(reindexPolicy),
      skipReasons: {},
      lastRunMetadata: {},
      // Workspace folders skip the sync pipeline entirely; mark them "synced"
      // at insertion so they never surface as "pending" in the sync-status UI
      // and so pending-folder sweepers never try to index them.
      status: isWorkspaceSource ? "synced" : "pending",
      source,
    })
    .returning();

  console.log(
    `[SyncService] Added sync folder: ${folderPath} for agent ${characterId} (primary: ${isPrimary}, source: ${source})`
  );

  // Workspace folders are invisible to the Vector Search UI and to workflow
  // sub-agents by design. Suppress folder-change notifications and workflow
  // propagation so creating a workspace never triggers a "Vektör DB
  // Senkronizasyonu" toast or cascades rows into every workflow member.
  if (!isWorkspaceSource) {
    notifyFolderChange(characterId, {
      type: "added",
      folderId: folder.id,
    });
    const propagateWorkflowFolderChange = await loadPropagateWorkflowFolderChange();
    await propagateWorkflowFolderChange(characterId, {
      type: "added",
      folderId: folder.id,
    });
  }

  return folder.id;
}

/**
 * Get all sync folders for all agents
 */
export async function getAllSyncFolders() {
  return db
    .select()
    .from(agentSyncFolders)
    .orderBy(sql`is_primary DESC, created_at ASC`);
}

/**
 * Get all sync folders for an agent, primary first
 */
export async function getSyncFolders(characterId: string) {
  return db
    .select()
    .from(agentSyncFolders)
    .where(eq(agentSyncFolders.characterId, characterId))
    .orderBy(sql`is_primary DESC, created_at ASC`);
}

/**
 * Get primary synced folder for a character
 */
export async function getPrimarySyncFolder(characterId: string) {
  const [folder] = await db
    .select()
    .from(agentSyncFolders)
    .where(
      and(
        eq(agentSyncFolders.characterId, characterId),
        eq(agentSyncFolders.isPrimary, true)
      )
    )
    .limit(1);

  return folder || null;
}

/**
 * Set a folder as primary (unsets others for the same character)
 */
export async function setPrimaryFolder(folderId: string, characterId: string) {
  await db.transaction(async (tx) => {
    // Unset all primary flags for this character
    await tx
      .update(agentSyncFolders)
      .set({ isPrimary: false })
      .where(eq(agentSyncFolders.characterId, characterId));

    // Set the specified folder as primary
    await tx
      .update(agentSyncFolders)
      .set({ isPrimary: true })
      .where(eq(agentSyncFolders.id, folderId));
  });

  console.log(`[SyncService] Set folder ${folderId} as primary for character ${characterId}`);

  notifyFolderChange(characterId, {
    type: "primary_changed",
    folderId,
  });
  const propagateChange = await loadPropagateWorkflowFolderChange();
  await propagateChange(characterId, {
    type: "primary_changed",
    folderId,
  });
}

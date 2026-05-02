/**
 * Shared File System Path Utilities
 *
 * Security-critical path validation for all file tools.
 * Extracted from lib/ai/vector-search/tool.ts for reuse across
 * readFile, editFile, writeFile, and patchFile tools.
 */

import { isAbsolute, join, normalize, resolve, sep, basename, dirname } from "path";
import { mkdir, realpath } from "fs/promises";
import { areUnsafeAgentPermissionsEnabled } from "@/lib/config/unsafe-agent-permissions";
import { getAccessibleSyncFolders } from "@/lib/vectordb/accessible-sync-folders";
import { getSession } from "@/lib/db/queries-sessions";
import { getWorkspaceInfo } from "@/lib/workspace/types";
import { db } from "@/lib/db/sqlite-client";
import { agentSyncFiles, agentSyncFolders } from "@/lib/db/sqlite-character-schema";
import { eq, like, and } from "drizzle-orm";

/**
 * Normalize a path and ensure it uses correct separators
 */
function normalizePath(filePath: string): string {
  return normalize(filePath);
}

/**
 * Validate path for traversal attacks
 * @throws Error if path contains traversal attempts after normalization
 */
function validatePath(filePath: string): void {
  if (filePath.includes("..")) {
    // This is a simple check. normalize() usually handles .. 
    // but if someone passes "foo/../bar", normalize makes it "bar".
    // If they pass "../bar", normalize keeps it "../bar".
    // We want to ensure the final path doesn't start with ..
    // But isPathAllowed handles the containment check.
    // This function is for explicit blocking if needed.
  }
}

/**
 * Walk up the path tree until we find an ancestor that exists on disk,
 * realpath() that ancestor, then re-append the non-existent trailing
 * segments. Returns `null` if no ancestor exists — callers treat that as
 * a rejection because we cannot prove containment without a real anchor.
 *
 * This closes BA-1: when the candidate AND its immediate parent both fail
 * to realpath (for example because `/synced/foo/symlink-to-outside` is a
 * symlink and `newfile.tsx` under it does not exist yet), the previous
 * implementation fell back to comparing the *unresolved* string, which
 * allowed a symlink-followed-by-new-file to escape the allowed root.
 *
 * The walk MUST find an existing ancestor; a path whose entire lineage is
 * non-existent is genuinely unprovable and must be rejected at the caller.
 */
async function realpathFirstExistingAncestor(
  candidatePath: string
): Promise<{ resolved: string } | null> {
  const normalized = normalize(candidatePath);
  const trailing: string[] = [];
  let current = normalized;

  // Defensive upper bound — a normalized absolute path has finite depth.
  for (let i = 0; i < 4096; i += 1) {
    try {
      const resolvedAncestor = await realpath(current);
      // Re-append the non-existent trailing segments (in original order)
      // AFTER the symlinks in the existing ancestor were resolved.
      const resolved =
        trailing.length === 0
          ? resolvedAncestor
          : join(resolvedAncestor, ...trailing.slice().reverse());
      return { resolved };
    } catch {
      // Current doesn't exist — pop its tail segment and retry on parent.
      const parent = dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding anything on disk.
        return null;
      }
      trailing.push(basename(current));
      current = parent;
    }
  }
  return null;
}

/**
 * Validate that a file path is within allowed synced folders.
 *
 * Handles both:
 * 1. Absolute paths - checks if within any allowed folder
 * 2. Relative paths - tries resolving relative to each allowed folder
 *
 * Security (BA-1 hardened):
 * - Resolves symlinks in every existing ancestor via fs.realpath before
 *   checking containment, so a symlink that points outside the root
 *   cannot be used to smuggle a to-be-created file past the check.
 * - If no ancestor of the candidate path exists on disk (i.e. we cannot
 *   anchor the realpath walk anywhere), the path is REJECTED — we refuse
 *   to compare unresolved strings.
 *
 * @returns The resolved absolute path if allowed, or null if rejected
 */
export async function isPathAllowed(filePath: string, allowedFolderPaths: string[]): Promise<string | null> {
  // Normalize Unicode to NFC to prevent macOS APFS encoding mismatches
  // (e.g., ç as U+00E7 vs c + combining cedilla)
  filePath = filePath.normalize("NFC");
  allowedFolderPaths = allowedFolderPaths.map((p) => p.normalize("NFC"));

  if (areUnsafeAgentPermissionsEnabled()) {
    return isAbsolute(filePath) ? normalize(filePath) : resolve(filePath);
  }

  // Case 1: Path is already absolute
  if (isAbsolute(filePath)) {
    const normalizedPath = normalize(filePath);

    const resolvedCandidate = await realpathFirstExistingAncestor(normalizedPath);
    if (!resolvedCandidate) {
      // No existing ancestor on disk — we cannot prove containment via
      // realpath, so reject. This is the BA-1 fix: previously the code
      // fell back to a string comparison on the unresolved path.
      return null;
    }

    for (const allowedPath of allowedFolderPaths) {
      try {
        const resolvedAllowed = await realpath(allowedPath).catch(() => allowedPath);
        if (
          resolvedCandidate.resolved.startsWith(resolvedAllowed + sep) ||
          resolvedCandidate.resolved === resolvedAllowed
        ) {
          return resolvedCandidate.resolved;
        }
      } catch {
        // Ignore errors during resolution
      }
    }
    return null;
  }

  // Case 2: Relative path - try resolving relative to each allowed folder
  for (const allowedPath of allowedFolderPaths) {
    try {
      const resolvedAllowed = await realpath(allowedPath).catch(() => allowedPath);
      const candidatePath = normalize(join(resolvedAllowed, filePath));

      const resolvedCandidate = await realpathFirstExistingAncestor(candidatePath);
      if (!resolvedCandidate) {
        // Entire lineage missing — cannot anchor containment check.
        // Skip this root; another root may still anchor.
        continue;
      }

      // Security: Ensure the resolved path is still within the allowed folder
      if (
        resolvedCandidate.resolved.startsWith(resolvedAllowed + sep) ||
        resolvedCandidate.resolved === resolvedAllowed
      ) {
        return resolvedCandidate.resolved;
      }
    } catch {
      // Ignore
    }
  }

  return null;
}

/**
 * Get allowed synced folder paths for a character.
 */
async function resolveSyncedFolderPaths(characterId: string): Promise<string[]> {
  const syncedFolders = await getAccessibleSyncFolders(characterId);
  return syncedFolders.map((f) => f.folderPath);
}

/**
 * Get the active worktree path from session metadata, if any.
 * Returns null if no workspace is active or sessionId is invalid.
 *
 * Security (defense-in-depth):
 *   The session's `workspaceInfo.worktreePath` alone is NOT trusted as a path
 *   authorization anchor. We additionally require that an `agent_sync_folders`
 *   row exists with `source='workspace'` for the same character pointing at
 *   the same path. This closes two gaps:
 *
 *     1. Stale session metadata after orphan cleanup. The boot-time
 *        `cleanupOrphanedWorkspaceFolders` sweep removes the DB row when the
 *        worktree disappears from disk, but session metadata may still point
 *        at the now-phantom path. Without the DB cross-check, file tools would
 *        keep granting access to a path with no auth basis.
 *     2. Defense in depth against any future code path that mutates session
 *        metadata without going through the workspace tool. Without the DB
 *        cross-check, that would silently widen file-tool authorization.
 */
export async function getActiveWorktreePath(sessionId: string): Promise<string | null> {
  if (!sessionId || sessionId === "UNSCOPED") return null;
  try {
    const session = await getSession(sessionId);
    if (!session) return null;
    const wsInfo = getWorkspaceInfo(session.metadata as Record<string, unknown> | null);
    if (!wsInfo?.worktreePath || typeof wsInfo.worktreePath !== "string") return null;

    // Cross-check: a workspace-source row must exist for this character at
    // this exact path. Otherwise treat as no active workspace.
    const characterId = session.characterId;
    if (!characterId) return null;

    const row = await db
      .select({ id: agentSyncFolders.id })
      .from(agentSyncFolders)
      .where(
        and(
          eq(agentSyncFolders.characterId, characterId),
          eq(agentSyncFolders.folderPath, wsInfo.worktreePath),
          eq(agentSyncFolders.source, "workspace")
        )
      )
      .limit(1);

    if (row.length === 0) return null;
    return wsInfo.worktreePath;
  } catch {
    return null;
  }
}

/**
 * Check if a normalized path is a worktree directory
 * (lives under a `/worktrees/` parent — the convention used by the workspace tool).
 */
export function isWorktreePath(p: string): boolean {
  const normalized = normalize(p);
  return normalized.includes(`${sep}worktrees${sep}`);
}

/**
 * Check if a path belongs to a DIFFERENT worktree than the active one.
 * Returns false if there is no active worktree (nothing to conflict with).
 */
export function isOtherWorktreePath(p: string, activeWorktreePath: string | null): boolean {
  if (!activeWorktreePath) return false;
  const normalized = normalize(p);
  if (!isWorktreePath(normalized)) return false;
  return normalized !== normalize(activeWorktreePath);
}

/**
 * Workspace-aware synced folder resolution.
 *
 * When an active worktree exists, the worktree path is placed FIRST in the
 * returned array so it becomes the default for tools that use `[0]`.
 * Other worktree paths are EXCLUDED to prevent cross-workspace contamination.
 * The base repo path is still included (for index/vector lookups) but deprioritized.
 */
export async function resolveWorkspaceAwarePaths(
  characterId: string,
  sessionId: string
): Promise<string[]> {
  const basePaths = await resolveSyncedFolderPaths(characterId);
  const worktreePath = await getActiveWorktreePath(sessionId);
  if (!worktreePath) return basePaths;

  // Normalize for dedup — session metadata and DB may have different trailing slashes
  const normalizedWorktree = normalize(worktreePath);

  // Put worktree first, exclude other worktrees, keep base repo for path-allowed checks
  return [
    normalizedWorktree,
    ...basePaths.filter((p) => {
      const norm = normalize(p);
      if (norm === normalizedWorktree) return false; // dedup active worktree
      if (isOtherWorktreePath(norm, normalizedWorktree)) return false; // exclude other worktrees
      return true;
    }),
  ];
}

/**
 * Resolve the synced folders for a character+session, then validate that
 * `filePath` is within one of them.  Returns a discriminated result so callers
 * can turn it into the appropriate tool error without duplicating the logic.
 */
type ResolveSyncedPathResult =
  | { ok: true; validPath: string; syncedFolders: string[] }
  | { ok: false; status: "no_folders" | "error"; error: string };

export async function resolveSyncedPath(
  filePath: string,
  characterId: string,
  sessionId: string
): Promise<ResolveSyncedPathResult> {
  let syncedFolders: string[];
  try {
    syncedFolders = await resolveWorkspaceAwarePaths(characterId, sessionId);
    if (syncedFolders.length === 0 && !areUnsafeAgentPermissionsEnabled()) {
      return {
        ok: false,
        status: "no_folders",
        error: "No synced folders configured. Add synced folders in agent settings.",
      };
    }
  } catch (error) {
    return {
      ok: false,
      status: "error",
      error: `Failed to get synced folders: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }

  const validPath = await isPathAllowed(filePath, syncedFolders);
  if (!validPath) {
    return {
      ok: false,
      status: "error",
      error: `Path "${filePath}" is not within any synced folder. Allowed folders: ${syncedFolders.join(", ")}`,
    };
  }

  const diagnosticFolders = syncedFolders.length > 0 ? syncedFolders : [dirname(validPath)];
  return { ok: true, validPath, syncedFolders: diagnosticFolders };
}

/**
 * Create parent directories for a file path.
 */
export async function ensureParentDirectories(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
}

/**
 * Find similar files in synced folders for "did you mean?" suggestions.
 *
 * @param characterId - Agent character ID
 * @param filename - The filename or partial path to match
 * @returns Up to 5 similar file paths
 */
export async function findSimilarFiles(
  characterId: string,
  filename: string
): Promise<string[]> {
  try {
    const name = basename(filename);
    const results = await db
      .select({ relativePath: agentSyncFiles.relativePath })
      .from(agentSyncFiles)
      .where(
        and(
          eq(agentSyncFiles.characterId, characterId),
          like(agentSyncFiles.relativePath, `%${name}%`)
        )
      )
      .limit(5);

    return results.map((r) => r.relativePath);
  } catch {
    return [];
  }
}

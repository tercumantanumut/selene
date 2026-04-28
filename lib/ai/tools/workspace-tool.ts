/**
 * Workspace Tool
 *
 * Creates and manages git worktree workspaces for isolated code changes.
 * The agent calls this to create a workspace, check status, update metadata, or delete it.
 * Workspace info persists in sessions.metadata.workspaceInfo.
 *
 * On create: registers the worktree as a sync folder (files-only, no vectors)
 * so that file tools (readFile, editFile, writeFile, localGrep) can access it.
 * On delete: removes the sync folder and git worktree, clears metadata.
 */

import { tool, jsonSchema } from "ai";
import * as fs from "fs";
import * as path from "path";
import { getSession, updateSession } from "@/lib/db/queries";
import type { WorkspaceInfo } from "@/lib/workspace/types";
import { getWorkspaceInfo } from "@/lib/workspace/types";
import { addSyncFolder } from "@/lib/vectordb/sync-service";
import { runGitCommand } from "@/lib/workspace/git-runner";
import { cleanupWorkspace } from "@/lib/workspace/cleanup";
import { recordWorkspaceCreate } from "@/lib/workspace/metrics";
import {
  resolveWorkspaceInfoFromSession,
  updateWorkspaceLifecycleMetadata,
  writeWorkspaceInfo,
} from "@/lib/workspace/metadata";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkspaceInput {
  action: "create" | "status" | "update-metadata" | "delete";

  // For "create":
  branch?: string;
  baseBranch?: string;
  repoPath?: string;

  // For "update-metadata":
  prUrl?: string;
  prNumber?: number;
  prStatus?: "draft" | "open" | "merged" | "closed";
  status?: "active" | "changes-ready" | "pr-open" | "merged" | "cleanup-pending";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Broad set of extensions for code-centric workspace sync folders */
const WORKSPACE_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cpp", "h", "hpp",
  "json", "yaml", "yml", "toml",
  "md", "txt", "html", "css", "scss", "less",
  "sql", "graphql", "proto",
  "sh", "bash", "zsh",
  "env", "env.local", "env.example",
  "dockerfile", "dockerignore",
  "gitignore", "editorconfig",
];

// ---------------------------------------------------------------------------
// Safety helpers (reused from workspace route pattern)
// ---------------------------------------------------------------------------

function isWindowsAbsolutePath(p: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(p) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/.test(p) ||
    /^\\\\\?[\\/][a-zA-Z]:[\\/]/.test(p)
  );
}

function isValidPath(p: string): boolean {
  if (typeof p !== "string") {
    return false;
  }

  const candidate = p.trim();
  if (!candidate) {
    return false;
  }

  if (/[;&|`$(){}!#]/.test(candidate)) {
    return false;
  }

  return path.isAbsolute(candidate) || isWindowsAbsolutePath(candidate);
}

function isValidBranchName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length < 256 &&
    /^[a-zA-Z0-9._\-/]+$/.test(name)
  );
}

async function verifyGitRepository(repoPath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const insideWorkTree = (await runGitCommand(repoPath, ["rev-parse", "--is-inside-work-tree"]))
      .trim()
      .toLowerCase();
    if (insideWorkTree === "true") {
      return { ok: true };
    }
    return { ok: false, reason: `git rev-parse returned "${insideWorkTree || "(empty)"}"` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  }
}

/** Slugify a branch name for use as a directory name */
function branchSlug(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
}

// ---------------------------------------------------------------------------
// Tool Factory
// ---------------------------------------------------------------------------

export function createWorkspaceTool({
  sessionId,
  characterId,
  userId,
}: {
  sessionId: string;
  characterId: string;
  userId: string;
}) {
  return tool({
    description: `Create and manage git worktree workspaces for isolated code changes.

Use this when the user asks you to work on a feature, fix, or task in a separate branch.

**Actions:**
- "create": Create a new git worktree + branch for isolated work. Requires \`branch\` and \`repoPath\`. File tools (readFile, editFile, writeFile, localGrep) will automatically work in the worktree.
- "status": Check live git status of the current workspace (changed files, branch info).
- "update-metadata": Update workspace metadata (PR URL, status, etc.) after creating a PR or finishing work.
- "delete": Remove the workspace — deletes the git worktree and cleans up all associated resources.`,

    inputSchema: jsonSchema<WorkspaceInput>({
      type: "object",
      title: "WorkspaceInput",
      description: "Input for workspace management",
      properties: {
        action: {
          type: "string",
          enum: ["create", "status", "update-metadata", "delete"],
          description: 'The workspace action to perform.',
        },
        branch: {
          type: "string",
          description: 'Branch name for the new workspace (e.g., "feature/auth-refactor"). Required for "create".',
        },
        baseBranch: {
          type: "string",
          description: 'Base branch to create from (defaults to current branch or "main").',
        },
        repoPath: {
          type: "string",
          description: 'Absolute path to the git repository. Required for "create".',
        },
        prUrl: {
          type: "string",
          description: 'Pull request URL. For "update-metadata".',
        },
        prNumber: {
          type: "number",
          description: 'Pull request number. For "update-metadata".',
        },
        prStatus: {
          type: "string",
          enum: ["draft", "open", "merged", "closed"],
          description: 'Pull request status. For "update-metadata".',
        },
        status: {
          type: "string",
          enum: ["active", "changes-ready", "pr-open", "merged", "cleanup-pending"],
          description: 'Workspace lifecycle status. For "update-metadata".',
        },
      },
      required: ["action"],
      additionalProperties: false,
    }),

    execute: async (input: WorkspaceInput) => {
      try {
        if (sessionId === "UNSCOPED") {
          return { status: "error" as const, error: "workspace tool requires an active session." };
        }

        const { action } = input;

        switch (action) {
          case "create":
            return await handleCreate(sessionId, characterId, userId, input);
          case "status":
            return await handleStatus(sessionId);
          case "update-metadata":
            return await handleUpdateMetadata(sessionId, input);
          case "delete":
            return await handleDelete(sessionId);
          default:
            return { status: "error" as const, error: `Unknown action: ${action}` };
        }
      } catch (error) {
        console.error("[workspace] Unexpected error:", error);
        return {
          status: "error" as const,
          error: `Workspace operation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleCreate(
  sessionId: string,
  characterId: string,
  userId: string,
  input: WorkspaceInput,
) {
  const { branch, baseBranch, repoPath } = input;

  // Validate required fields
  if (!branch) {
    return { status: "error" as const, error: 'Missing required field "branch" for create action.' };
  }
  if (!repoPath) {
    return { status: "error" as const, error: 'Missing required field "repoPath" for create action.' };
  }
  if (characterId === "UNSCOPED" || userId === "UNSCOPED") {
    return { status: "error" as const, error: "Workspace creation requires an active agent context." };
  }

  // Path safety
  if (!isValidPath(repoPath)) {
    return { status: "error" as const, error: "Invalid repoPath. Must be an absolute path without shell metacharacters." };
  }

  const rawRepoPath = repoPath.trim();
  const useWindowsPath = isWindowsAbsolutePath(rawRepoPath);
  const pathApi = useWindowsPath ? path.win32 : path;
  const normalizedRepoPath = useWindowsPath
    ? path.win32.normalize(rawRepoPath)
    : path.resolve(rawRepoPath);
  const normalizedRepoPathForChecks = normalizedRepoPath.trim();
  if (!isValidPath(normalizedRepoPathForChecks)) {
    return { status: "error" as const, error: "Invalid repoPath after normalization." };
  }

  // Branch name safety
  if (!isValidBranchName(branch)) {
    return { status: "error" as const, error: "Invalid branch name. Use only alphanumeric, dot, dash, underscore, and slash characters." };
  }
  if (baseBranch && !isValidBranchName(baseBranch)) {
    return { status: "error" as const, error: "Invalid baseBranch name. Use only alphanumeric, dot, dash, underscore, and slash characters." };
  }

  // Verify it's a git repo via git itself (works for linked worktrees too).
  const repoVerification = await verifyGitRepository(normalizedRepoPathForChecks);
  if (!repoVerification.ok) {
    return {
      status: "error" as const,
      error: `"${normalizedRepoPath}" is not a valid git repository: ${repoVerification.reason}`,
    };
  }

  // Check if workspace already exists for this session
  const session = await getSession(sessionId);
  if (!session) {
    return { status: "error" as const, error: "Session not found." };
  }
  const metadata = (session.metadata || {}) as Record<string, unknown>;
  const existingWorkspace = getWorkspaceInfo(metadata);
  if (existingWorkspace && existingWorkspace.worktreePath && fs.existsSync(existingWorkspace.worktreePath)) {
    return {
      status: "error" as const,
      error: `This session already has an active workspace at "${existingWorkspace.worktreePath}" on branch "${existingWorkspace.branch}". Use "status" to check it or "update-metadata" to update it.`,
    };
  }

  // Stale metadata guard: if we get here with metadata pointing at a worktree
  // that no longer exists on disk, clear it BEFORE we do any side effects.
  // Without this, the call below creates the git worktree + sync-folder row,
  // and only then `writeWorkspaceInfo` detects the identity change and rejects
  // — leaking the new worktree and stranding the session on the stale identity.
  if (existingWorkspace) {
    console.warn("[workspace-tool:create] Clearing stale workspace metadata before re-create", {
      sessionId,
      stale: {
        type: existingWorkspace.type,
        branch: existingWorkspace.branch,
        worktreePath: existingWorkspace.worktreePath,
        syncFolderId: existingWorkspace.syncFolderId,
      },
    });
    try {
      // Best-effort cleanup of any orphaned sync-folder row pointing at the
      // missing worktree. Tool-created workspaces own this row; local Git Mode
      // doesn't, so skip cleanup for that case.
      if (existingWorkspace.type !== "local") {
        // Reuse the workspace-tool-delete trigger — semantically we ARE deleting
        // the stale workspace, just immediately followed by a fresh create.
        await cleanupWorkspace({
          syncFolderId: existingWorkspace.syncFolderId,
          worktreePath: existingWorkspace.worktreePath,
          trigger: "workspace-tool-delete",
        });
      }
    } catch (cleanupErr) {
      console.warn("[workspace-tool:create] Stale cleanup non-fatal:", cleanupErr);
    }
    const { workspaceInfo: _stale, ...restMetadata } = metadata;
    await updateSession(sessionId, { metadata: restMetadata });
  }

  // Determine base branch
  let resolvedBaseBranch = baseBranch;
  if (!resolvedBaseBranch) {
    try {
      resolvedBaseBranch = (await runGitCommand(normalizedRepoPath, ["branch", "--show-current"])).trim();
    } catch {
      resolvedBaseBranch = "main";
    }
  }

  // Compute worktree path: <repoPath>/../worktrees/<branch-slug>
  const worktreeParent = pathApi.join(normalizedRepoPath, "..", "worktrees");
  const worktreePath = pathApi.join(worktreeParent, branchSlug(branch));

  // Don't overwrite existing directory
  if (fs.existsSync(worktreePath)) {
    return {
      status: "error" as const,
      error: `Worktree directory already exists at "${worktreePath}". Choose a different branch name or clean up the existing worktree.`,
    };
  }

  // Ensure parent directory exists
  if (!fs.existsSync(worktreeParent)) {
    fs.mkdirSync(worktreeParent, { recursive: true });
  }

  // Validate resolvedBaseBranch (may be from git output) before shell interpolation
  if (!isValidBranchName(resolvedBaseBranch)) {
    return { status: "error" as const, error: "Resolved base branch name contains invalid characters." };
  }

  // Create the git worktree
  try {
    await runGitCommand(normalizedRepoPath, ["worktree", "add", "-b", branch, worktreePath, resolvedBaseBranch]);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // If branch already exists, try without -b
    if (errMsg.includes("already exists")) {
      try {
        await runGitCommand(normalizedRepoPath, ["worktree", "add", worktreePath, branch]);
      } catch (err2) {
        return {
          status: "error" as const,
          error: `Failed to create worktree: ${err2 instanceof Error ? err2.message : String(err2)}`,
        };
      }
    } else {
      return {
        status: "error" as const,
        error: `Failed to create worktree: ${errMsg}`,
      };
    }
  }

  // Register worktree as sync folder (files-only, no vectors, no watcher)
  // This enables file tools (readFile, editFile, writeFile, localGrep) to access the worktree
  let syncFolderId: string | undefined;
  try {
    syncFolderId = await addSyncFolder({
      userId,
      characterId,
      folderPath: worktreePath,
      displayName: `Workspace: ${branch}`,
      recursive: true,
      includeExtensions: WORKSPACE_EXTENSIONS,
      syncMode: "manual",
      indexingMode: "files-only",
      reindexPolicy: "never",
      // Mark as internal workspace path registration, not a user-configured
      // vector-sync source. addSyncFolder inserts with status="synced" directly,
      // skips UI notifications, and skips cross-agent propagation.
      source: "workspace",
    });
  } catch (syncErr) {
    console.error("[workspace] Failed to register sync folder (non-fatal):", syncErr);
    // Non-fatal: worktree exists, agent can still use executeCommand
    // File tools just won't have access
  }

  // Build workspace info
  const workspaceInfo: WorkspaceInfo = {
    type: "worktree",
    branch,
    baseBranch: resolvedBaseBranch,
    worktreePath,
    status: "active",
    changedFiles: 0,
    lastSyncedAt: new Date().toISOString(),
    syncFolderId,
  };

  // Persist to session metadata
  const persistedWorkspaceInfo = await writeWorkspaceInfo(
    sessionId,
    workspaceInfo,
    "workspace-tool:create"
  );

  recordWorkspaceCreate();

  return {
    status: "success" as const,
    message: `Workspace created successfully.`,
    workspace: {
      branch,
      baseBranch: resolvedBaseBranch,
      worktreePath: persistedWorkspaceInfo.worktreePath,
      status: persistedWorkspaceInfo.status,
      syncFolderId: persistedWorkspaceInfo.syncFolderId,
    },
    hint: `The worktree is at "${worktreePath}". File tools (readFile, editFile, writeFile, localGrep) can now access this path. Use executeCommand for git operations and builds. When done, use workspace tool with action "delete" to clean up.`,
  };
}

async function handleStatus(sessionId: string) {
  const session = await getSession(sessionId);
  if (!session) {
    return { status: "error" as const, error: "Session not found." };
  }

  // Verified resolver — stale metadata pointing at a removed sync folder
  // is treated the same as "no workspace configured" so we don't run git
  // commands against a directory the rest of the system has unbound.
  const workspaceInfo = await resolveWorkspaceInfoFromSession(session);

  if (!workspaceInfo) {
    return {
      status: "success" as const,
      message: "No workspace is configured for this session.",
      workspace: null,
    };
  }

  // If worktree path exists, get live git status
  let changedFiles = workspaceInfo.changedFiles ?? 0;
  let changedFileList: Array<{ path: string; status: string }> = [];
  let worktreeExists = false;

  if (workspaceInfo.worktreePath && isValidPath(workspaceInfo.worktreePath) && fs.existsSync(workspaceInfo.worktreePath)) {
    worktreeExists = true;
    try {
      // Check uncommitted changes first
      const porcelain = await runGitCommand(workspaceInfo.worktreePath, ["status", "--porcelain"]);
      if (porcelain.trim()) {
        changedFileList = porcelain.trim().split("\n").filter(Boolean).map((line) => {
          const statusCode = line.substring(0, 2).trim();
          const filePath = line.substring(3);
          let fileStatus = "modified";
          if (statusCode === "A" || statusCode === "??") fileStatus = "added";
          else if (statusCode === "D") fileStatus = "deleted";
          else if (statusCode.startsWith("R")) fileStatus = "renamed";
          return { path: filePath, status: fileStatus };
        });
        changedFiles = changedFileList.length;
      } else if (workspaceInfo.baseBranch && isValidBranchName(workspaceInfo.baseBranch)) {
        // No uncommitted changes — check committed changes ahead of baseBranch
        try {
          const branchDiff = (
            await runGitCommand(workspaceInfo.worktreePath, [
              "diff",
              "--name-status",
              `${workspaceInfo.baseBranch}...HEAD`,
            ])
          ).trim();
          if (branchDiff) {
            changedFileList = branchDiff.split("\n").filter(Boolean).map((line) => {
              const [sc, ...pp] = line.split("\t");
              const fp = pp.join("\t");
              let fs = "modified";
              if (sc === "A") fs = "added";
              else if (sc === "D") fs = "deleted";
              else if (sc?.startsWith("R")) fs = "renamed";
              return { path: fp, status: fs };
            });
            changedFiles = changedFileList.length;
          }
        } catch {
          // baseBranch might not exist locally
        }
      }
    } catch {
      // git status failed — directory might not be a valid repo anymore
    }

    // Update metadata with latest counts
    await updateWorkspaceLifecycleMetadata(
      sessionId,
      {
        changedFiles,
        lastSyncedAt: new Date().toISOString(),
      },
      "workspace-tool:status"
    );
  }

  return {
    status: "success" as const,
    workspace: {
      ...workspaceInfo,
      changedFiles,
      worktreeExists,
      changedFileList: changedFileList.length > 0 ? changedFileList : undefined,
    },
  };
}

async function handleUpdateMetadata(sessionId: string, input: WorkspaceInput) {
  const session = await getSession(sessionId);
  if (!session) {
    return { status: "error" as const, error: "Session not found." };
  }

  // Verified resolver — refuse PR/status patches against a stale workspace
  // whose sync folder is gone; otherwise we'd record metadata against an
  // identity the prompt-builder/localGrep already treat as invalid.
  const workspaceInfo = await resolveWorkspaceInfoFromSession(session);

  if (!workspaceInfo) {
    return { status: "error" as const, error: "No workspace exists for this session. Create one first." };
  }

  // Merge provided fields
  const updates: Partial<WorkspaceInfo> = {};
  if (input.prUrl !== undefined) updates.prUrl = input.prUrl;
  if (input.prNumber !== undefined) updates.prNumber = input.prNumber;
  if (input.prStatus !== undefined) updates.prStatus = input.prStatus;
  if (input.status !== undefined) updates.status = input.status;

  const updatedWorkspaceInfo = await updateWorkspaceLifecycleMetadata(
    sessionId,
    {
      ...updates,
      lastSyncedAt: new Date().toISOString(),
    },
    "workspace-tool:update-metadata"
  );

  return {
    status: "success" as const,
    message: "Workspace metadata updated.",
    workspace: updatedWorkspaceInfo,
  };
}

async function handleDelete(sessionId: string) {
  const session = await getSession(sessionId);
  if (!session) {
    return { status: "error" as const, error: "Session not found." };
  }

  const metadata = (session.metadata || {}) as Record<string, unknown>;
  const workspaceInfo = getWorkspaceInfo(metadata);

  if (!workspaceInfo) {
    return { status: "error" as const, error: "No workspace to delete." };
  }

  const isLocalWorkspace = workspaceInfo.type === "local";

  // Local Git Mode points at the user's real repo — only clear metadata.
  // Tool-created worktrees own both the sync folder row and the on-disk worktree.
  if (!isLocalWorkspace) {
    await cleanupWorkspace({
      syncFolderId: workspaceInfo.syncFolderId,
      worktreePath: workspaceInfo.worktreePath,
      trigger: "workspace-tool-delete",
    });
  }

  // 3. Clear workspace metadata from session
  const { workspaceInfo: _removed, ...restMetadata } = metadata;
  await updateSession(sessionId, { metadata: restMetadata });

  return {
    status: "success" as const,
    message: isLocalWorkspace ? "Git Mode disabled for this session." : "Workspace deleted and cleaned up.",
  };
}

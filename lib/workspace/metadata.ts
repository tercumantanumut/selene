import { getSession, updateSession } from "@/lib/db/queries";
import type { Session } from "@/lib/db/sqlite-schema";
import { getSyncFolders } from "@/lib/vectordb/sync-folder-crud";
import { normalizeFolderPath } from "@/lib/vectordb/path-validation";
import { getWorkspaceInfo } from "@/lib/workspace/types";
import type { WorkspaceInfo } from "@/lib/workspace/types";

type WorkspaceIdentityField = "type" | "branch" | "baseBranch" | "worktreePath" | "syncFolderId";
type WorkspaceLifecycleField = "repoUrl" | "prUrl" | "prNumber" | "prStatus" | "status" | "changedFiles" | "lastSyncedAt";

type WorkspaceLifecyclePatch = Partial<Pick<WorkspaceInfo, WorkspaceLifecycleField>>;

const WORKSPACE_IDENTITY_FIELDS: readonly WorkspaceIdentityField[] = [
  "type",
  "branch",
  "baseBranch",
  "worktreePath",
  "syncFolderId",
];

const WORKSPACE_LIFECYCLE_FIELDS: readonly WorkspaceLifecycleField[] = [
  "repoUrl",
  "prUrl",
  "prNumber",
  "prStatus",
  "status",
  "changedFiles",
  "lastSyncedAt",
];

function metadataFromSession(session: Session | null | undefined): Record<string, unknown> {
  return (session?.metadata as Record<string, unknown> | null) || {};
}

function workspaceIdentityChanged(current: WorkspaceInfo, next: WorkspaceInfo): boolean {
  return WORKSPACE_IDENTITY_FIELDS.some((field) => current[field] !== next[field]);
}

function pickWorkspaceIdentity(workspaceInfo: WorkspaceInfo | null | undefined) {
  if (!workspaceInfo) {
    return null;
  }

  return {
    type: workspaceInfo.type,
    branch: workspaceInfo.branch,
    baseBranch: workspaceInfo.baseBranch,
    worktreePath: workspaceInfo.worktreePath,
    syncFolderId: workspaceInfo.syncFolderId,
  };
}

function pickWorkspaceLifecyclePatch(patch: Partial<WorkspaceInfo>): WorkspaceLifecyclePatch {
  const lifecyclePatch: WorkspaceLifecyclePatch = {};

  for (const field of WORKSPACE_LIFECYCLE_FIELDS) {
    if (field in patch) {
      switch (field) {
        case "repoUrl":
          lifecyclePatch.repoUrl = patch.repoUrl;
          break;
        case "prUrl":
          lifecyclePatch.prUrl = patch.prUrl;
          break;
        case "prNumber":
          lifecyclePatch.prNumber = patch.prNumber;
          break;
        case "prStatus":
          lifecyclePatch.prStatus = patch.prStatus;
          break;
        case "status":
          lifecyclePatch.status = patch.status;
          break;
        case "changedFiles":
          lifecyclePatch.changedFiles = patch.changedFiles;
          break;
        case "lastSyncedAt":
          lifecyclePatch.lastSyncedAt = patch.lastSyncedAt;
          break;
      }
    }
  }

  return lifecyclePatch;
}

function hasIdentityFields(patch: Partial<WorkspaceInfo>): boolean {
  return WORKSPACE_IDENTITY_FIELDS.some((field) => field in patch);
}

function getWorkspaceIdentityFields(): readonly WorkspaceIdentityField[] {
  return WORKSPACE_IDENTITY_FIELDS;
}

export async function resolveSessionWorkspaceInfo(sessionId: string): Promise<WorkspaceInfo | null> {
  if (!sessionId || sessionId === "UNSCOPED") {
    return null;
  }

  const session = await getSession(sessionId);
  return resolveWorkspaceInfoFromSession(session);
}

export async function resolveWorkspaceInfoFromSession(
  session: Session | null | undefined,
): Promise<WorkspaceInfo | null> {
  if (!session?.characterId) {
    return null;
  }

  const workspaceInfo = getWorkspaceInfo(metadataFromSession(session));
  if (!workspaceInfo?.worktreePath) {
    return null;
  }

  const normalizedWorkspacePath = normalizeFolderPath(workspaceInfo.worktreePath);
  const syncFolders = await getSyncFolders(session.characterId);

  const matchingFolder = syncFolders.find((folder) => {
    const sameId = workspaceInfo.syncFolderId ? folder.id === workspaceInfo.syncFolderId : false;
    const samePath = normalizeFolderPath(folder.folderPath) === normalizedWorkspacePath;

    if (workspaceInfo.type === "local") {
      return sameId || samePath;
    }

    return folder.source === "workspace" && (sameId || samePath);
  });

  return matchingFolder ? workspaceInfo : null;
}

export async function writeWorkspaceInfo(
  sessionId: string,
  workspaceInfo: WorkspaceInfo,
  source: string,
): Promise<WorkspaceInfo> {
  const freshSession = await getSession(sessionId);
  const freshMetadata = metadataFromSession(freshSession);
  const currentWorkspace = getWorkspaceInfo(freshMetadata);

  if (currentWorkspace && workspaceIdentityChanged(currentWorkspace, workspaceInfo)) {
    console.warn("[workspace] Refusing implicit workspace identity change", {
      sessionId,
      source,
      current: pickWorkspaceIdentity(currentWorkspace),
      requested: pickWorkspaceIdentity(workspaceInfo),
    });
    throw new Error("Workspace identity changed during the operation; refusing to overwrite current workspace metadata.");
  }

  await updateSession(sessionId, {
    metadata: {
      ...freshMetadata,
      workspaceInfo,
    },
  });

  const persistedSession = await getSession(sessionId);
  const persistedWorkspace = getWorkspaceInfo(metadataFromSession(persistedSession));
  if (!persistedWorkspace) {
    throw new Error("Workspace metadata write did not persist.");
  }

  return persistedWorkspace;
}

export async function updateWorkspaceLifecycleMetadata(
  sessionId: string,
  patch: Partial<WorkspaceInfo>,
  source: string,
): Promise<WorkspaceInfo> {
  const freshSession = await getSession(sessionId);
  const freshMetadata = metadataFromSession(freshSession);
  const workspaceInfo = getWorkspaceInfo(freshMetadata);

  if (!workspaceInfo) {
    throw new Error("No workspace exists for this session.");
  }

  if (hasIdentityFields(patch)) {
    console.warn("[workspace] Ignoring attempted workspace identity mutation", {
      sessionId,
      source,
      attempted: pickWorkspaceIdentity(patch as WorkspaceInfo),
    });
  }

  const lifecyclePatch = pickWorkspaceLifecyclePatch(patch);
  const updatedWorkspaceInfo: WorkspaceInfo = {
    ...workspaceInfo,
    ...lifecyclePatch,
  };

  await updateSession(sessionId, {
    metadata: {
      ...freshMetadata,
      workspaceInfo: updatedWorkspaceInfo,
    },
  });

  const persistedSession = await getSession(sessionId);
  const persistedWorkspace = getWorkspaceInfo(metadataFromSession(persistedSession));
  if (!persistedWorkspace) {
    throw new Error("Workspace metadata write did not persist.");
  }

  if (workspaceIdentityChanged(workspaceInfo, persistedWorkspace)) {
    console.warn("[workspace] Workspace identity drift detected after lifecycle update", {
      sessionId,
      source,
      before: pickWorkspaceIdentity(workspaceInfo),
      persisted: pickWorkspaceIdentity(persistedWorkspace),
    });
    throw new Error("Workspace identity drift detected after metadata update.");
  }

  return persistedWorkspace;
}

import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import * as fs from "fs";
import { generateText } from "ai";
import { promisify } from "util";
import {
  getSession,
  updateSession,
} from "@/lib/db/queries";
import { resolveSessionAuth } from "@/lib/api/shared-handlers";
import {
  getSessionProviderTemperatureForSession,
  resolveSessionUtilityModelForSession,
} from "@/lib/ai/session-model-resolver";
import { getWorkspaceInfo } from "@/lib/workspace/types";
import { isEBADFError, spawnWithFileCapture } from "@/lib/spawn-utils";
import { GitService } from "@/lib/workspace/git-service";
import { getSyncFolders } from "@/lib/vectordb/sync-folder-crud";
import { runGitCommand } from "@/lib/workspace/git-runner";
import {
  resolveWorkspaceInfoFromSession,
  updateWorkspaceLifecycleMetadata,
  writeWorkspaceInfo,
} from "@/lib/workspace/metadata";
import type {
  WorkspaceInfo,
  WorkspaceStatus,
  WorkspaceAction,
} from "@/lib/workspace/types";

const execFileAsync = promisify(execFile);

interface WorkspaceActionBody {
  action: WorkspaceAction;
  filePath?: string;
  hunkPatch?: string;
  message?: string;
  folderPath?: string;
}

interface GitFolderDetection {
  id: string;
  path: string;
  branch: string;
  remoteUrl?: string;
  isPrimary: boolean;
}

interface ExistingPullRequest {
  number: number;
  url: string;
  isDraft?: boolean;
  state?: string;
}

// Validate that a path is safe for use in shell commands.
// Supports both Unix (/home/user/repo) and Windows (C:\Users\user\repo) absolute paths.
function isValidWorktreePath(pathStr: string): boolean {
  if (typeof pathStr !== "string" || pathStr.length === 0) return false;
  // Accept Unix absolute paths (/...) and Windows absolute paths (C:\... or C:/...)
  const isAbsolute = pathStr.startsWith("/") || /^[A-Za-z]:[/\\]/.test(pathStr);
  if (!isAbsolute) return false;
  // Reject shell metacharacters. Backslashes are allowed since they are
  // normal path separators on Windows and paths are passed to execFile (no shell).
  return !/[;&|`$(){}!#"'<>\n\r]/.test(pathStr);
}

// Validate that a branch name is safe for use in shell commands
function isValidBranchName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length < 256 &&
    /^[a-zA-Z0-9._\-/]+$/.test(name)
  );
}

const WORKSPACE_STATUSES = new Set<WorkspaceInfo["status"]>([
  "active",
  "changes-ready",
  "pr-open",
  "merged",
  "cleanup-pending",
]);
const WORKSPACE_PR_STATUSES = new Set<NonNullable<WorkspaceInfo["prStatus"]>>([
  "draft",
  "open",
  "merged",
  "closed",
]);

function sanitizeWorkspacePatch(payload: unknown): Partial<WorkspaceInfo> {
  if (!payload || typeof payload !== "object") return {};

  const body = payload as Record<string, unknown>;
  const safePayload: Partial<WorkspaceInfo> = {};

  if (typeof body.repoUrl === "string") {
    safePayload.repoUrl = body.repoUrl;
  }
  if (typeof body.prUrl === "string") {
    safePayload.prUrl = body.prUrl;
  }
  if (typeof body.prNumber === "number" && Number.isFinite(body.prNumber)) {
    safePayload.prNumber = body.prNumber;
  }
  if (
    typeof body.prStatus === "string" &&
    WORKSPACE_PR_STATUSES.has(body.prStatus as NonNullable<WorkspaceInfo["prStatus"]>)
  ) {
    safePayload.prStatus = body.prStatus as NonNullable<WorkspaceInfo["prStatus"]>;
  }
  if (
    typeof body.status === "string" &&
    WORKSPACE_STATUSES.has(body.status as WorkspaceInfo["status"])
  ) {
    safePayload.status = body.status as WorkspaceInfo["status"];
  }
  if (typeof body.changedFiles === "number" && Number.isFinite(body.changedFiles)) {
    safePayload.changedFiles = body.changedFiles;
  }
  if (typeof body.lastSyncedAt === "string") {
    safePayload.lastSyncedAt = body.lastSyncedAt;
  }

  return safePayload;
}

const GH_TIMEOUT_MS = 30_000;
const GH_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const GH_INSTALL_URL = "https://cli.github.com/";
const GH_AUTH_DOCS_URL = "https://cli.github.com/manual/gh_auth_login";
const PR_TEMPLATE_CANDIDATES = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
];

function ghExecOptions(cwd: string) {
  return {
    cwd,
    encoding: "utf-8" as const,
    timeout: GH_TIMEOUT_MS,
    maxBuffer: GH_MAX_OUTPUT_BYTES,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  };
}

async function runGhCommand(cwd: string, args: string[], input?: string): Promise<string> {
  const env = {
    ...process.env,
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  } as NodeJS.ProcessEnv;

  if (typeof input === "string") {
    const fb = await spawnWithFileCapture(
      "gh",
      args,
      cwd,
      env,
      GH_TIMEOUT_MS,
      GH_MAX_OUTPUT_BYTES,
      input,
    );
    const exitCode = fb.exitCode ?? 1;
    if (fb.timedOut) {
      throw new Error(`gh command timed out after ${GH_TIMEOUT_MS}ms`);
    }
    if (exitCode !== 0) {
      const detail = fb.stderr.trim() || fb.stdout.trim() || `exit code ${exitCode}`;
      throw new Error(`gh command failed: ${detail}`);
    }
    return fb.stdout;
  }

  try {
    const { stdout } = await execFileAsync("gh", args, ghExecOptions(cwd));
    return stdout;
  } catch (error) {
    if (isEBADFError(error) && process.platform === "darwin") {
      console.warn("[workspace route] gh execFile EBADF - retrying with file-capture fallback");
      const fb = await spawnWithFileCapture(
        "gh",
        args,
        cwd,
        env,
        GH_TIMEOUT_MS,
        GH_MAX_OUTPUT_BYTES,
      );
      const exitCode = fb.exitCode ?? 1;
      if (fb.timedOut) {
        throw new Error(`gh command timed out after ${GH_TIMEOUT_MS}ms`);
      }
      if (exitCode !== 0) {
        const detail = fb.stderr.trim() || fb.stdout.trim() || `exit code ${exitCode}`;
        throw new Error(`gh command failed: ${detail}`);
      }
      return fb.stdout;
    }
    throw error;
  }
}

function isCommandNotFoundError(error: unknown, command: string): boolean {
  if (!error) return false;
  const err = error as NodeJS.ErrnoException;
  if (err.code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`spawn ${command} ENOENT`) || message.includes(`${command}: command not found`);
}

function extractHttpUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/\S+/);
  return match?.[0]?.trim();
}

function mapPrStatus(pr: ExistingPullRequest): NonNullable<WorkspaceInfo["prStatus"]> {
  const state = (pr.state || "").toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  if (pr.isDraft) return "draft";
  return "open";
}

function buildFallbackPrTitle(commitLog: string, branch?: string): string {
  const firstSubject = commitLog
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^[a-f0-9]+\s+/, "")
    ?.trim();

  if (firstSubject) {
    return firstSubject.slice(0, 120);
  }

  if (branch) {
    return branch.replace(/[-_/]+/g, " ").trim().slice(0, 120) || "Create pull request";
  }

  return "Create pull request";
}

function buildFallbackPrBody(commitLog: string, diffStat?: string, template?: string): string {
  const commits = commitLog.trim()
    ? commitLog
        .trim()
        .split("\n")
        .map((line) => `- ${line.replace(/^[a-f0-9]+\s+/, "")}`)
        .join("\n")
    : "- No commit log available";

  const summaryBlock = [
    "## Summary",
    commits,
    "",
    "## Test Notes",
    "- Not run from the workspace UI.",
  ].join("\n");

  if (!template?.trim()) {
    return summaryBlock;
  }

  return [template.trim(), "", "<!-- Auto-filled context -->", summaryBlock].join("\n");
}

function readPullRequestTemplate(cwd: string): string | null {
  for (const relativePath of PR_TEMPLATE_CANDIDATES) {
    const fullPath = `${cwd}/${relativePath}`;
    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, "utf-8");
    }
  }

  const templateDirectory = `${cwd}/.github/PULL_REQUEST_TEMPLATE`;
  if (fs.existsSync(templateDirectory)) {
    try {
      const firstMarkdownTemplate = fs
        .readdirSync(templateDirectory)
        .find((entry) => entry.toLowerCase().endsWith(".md"));
      if (firstMarkdownTemplate) {
        return fs.readFileSync(`${templateDirectory}/${firstMarkdownTemplate}`, "utf-8");
      }
    } catch {
      // Ignore template directory read failures and fall back to generated content.
    }
  }

  return null;
}

async function generatePullRequestBody(
  sessionMetadata: Record<string, unknown> | null,
  input: {
    branch: string;
    baseBranch: string;
    commitLog: string;
    diffStat?: string;
    template?: string | null;
  }
): Promise<string> {
  const { branch, baseBranch, commitLog, diffStat, template } = input;

  try {
    const { text } = await generateText({
      model: await resolveSessionUtilityModelForSession(sessionMetadata),
      temperature: await getSessionProviderTemperatureForSession(sessionMetadata, 0.2),
      maxOutputTokens: 1200,
      prompt: [
        "Write a concise but detailed GitHub pull request description in markdown.",
        "Use factual language only. Do not invent tests or outcomes.",
        "If a pull request template is provided, preserve its headings and fill it naturally.",
        `Branch: ${branch}`,
        `Base branch: ${baseBranch}`,
        diffStat ? `Diff stat:\n${diffStat}` : "Diff stat: not available",
        `Commit log:\n${commitLog || "No commit log available"}`,
        template?.trim() ? `Pull request template:\n${template.trim()}` : "No pull request template was found.",
      ].join("\n\n"),
    });

    const normalized = text.trim();
    if (normalized) {
      return normalized;
    }
  } catch (error) {
    console.warn("[workspace route] Failed to generate PR body with AI, using fallback:", error);
  }

  return buildFallbackPrBody(commitLog, diffStat, template ?? undefined);
}

function parseGitPorcelain(
  output: string
): Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed" }> {
  if (!output.trim()) return [];

  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const statusCode = line.substring(0, 2).trim();
      const filePath = line.substring(3);
      let status: "added" | "modified" | "deleted" | "renamed" = "modified";
      if (statusCode === "A" || statusCode === "??") status = "added";
      else if (statusCode === "D") status = "deleted";
      else if (statusCode.startsWith("R")) status = "renamed";
      return { path: filePath, status };
    });
}

async function getLiveGitStatus(worktreePath: string, baseBranch?: string): Promise<{
  changedFileList: WorkspaceStatus["changedFileList"];
  changedFiles: number;
  diffStat: string | undefined;
  worktreeExists: boolean;
}> {
  if (!isValidWorktreePath(worktreePath) || !fs.existsSync(worktreePath)) {
    return {
      changedFileList: [],
      changedFiles: 0,
      diffStat: undefined,
      worktreeExists: false,
    };
  }

  try {
    const porcelain = await runGitCommand(worktreePath, ["status", "--porcelain"]);
    let changedFileList = parseGitPorcelain(porcelain);
    let diffStat: string | undefined;

    if (changedFileList.length > 0) {
      try {
        diffStat = (await runGitCommand(worktreePath, ["diff", "--stat"])).trim() || undefined;
      } catch {
        // diff --stat can fail if there are no commits yet
      }
    } else if (baseBranch && isValidBranchName(baseBranch)) {
      try {
        const branchDiff = (
          await runGitCommand(worktreePath, ["diff", "--name-status", `${baseBranch}...HEAD`])
        ).trim();

        if (branchDiff) {
          changedFileList = branchDiff.split("\n").filter(Boolean).map((line) => {
            const [statusCode, ...pathParts] = line.split("\t");
            const filePath = pathParts.join("\t");
            let status: "added" | "modified" | "deleted" | "renamed" = "modified";
            if (statusCode === "A") status = "added";
            else if (statusCode === "D") status = "deleted";
            else if (statusCode?.startsWith("R")) status = "renamed";
            return { path: filePath, status };
          });
        }

        diffStat = (
          await runGitCommand(worktreePath, ["diff", "--stat", `${baseBranch}...HEAD`])
        ).trim() || undefined;
      } catch {
        // baseBranch might not exist locally
      }
    }

    return {
      changedFileList,
      changedFiles: changedFileList.length,
      diffStat,
      worktreeExists: true,
    };
  } catch {
    return {
      changedFileList: [],
      changedFiles: 0,
      diffStat: undefined,
      worktreeExists: true,
    };
  }
}

async function buildWorkspaceStatus(workspaceInfo: WorkspaceInfo): Promise<WorkspaceStatus> {
  const workspaceStatus: WorkspaceStatus = { ...workspaceInfo, commitsAhead: 0 };

  if (!workspaceInfo.worktreePath) {
    return workspaceStatus;
  }

  const liveStatus = await getLiveGitStatus(workspaceInfo.worktreePath, workspaceInfo.baseBranch);
  workspaceStatus.changedFileList = liveStatus.changedFileList;
  workspaceStatus.changedFiles = liveStatus.changedFiles;
  workspaceStatus.diffStat = liveStatus.diffStat;
  workspaceStatus.worktreeExists = liveStatus.worktreeExists;

  if (liveStatus.worktreeExists) {
    try {
      const gitService = new GitService(workspaceInfo.worktreePath);
      const aheadBehind = await gitService.getAheadBehind(workspaceInfo.baseBranch);
      workspaceStatus.commitsAhead = aheadBehind.ahead;
    } catch {
      workspaceStatus.commitsAhead = 0;
    }
  }

  return workspaceStatus;
}

async function isGitRepo(folderPath: string): Promise<boolean> {
  if (!isValidWorktreePath(folderPath) || !fs.existsSync(folderPath)) {
    return false;
  }

  try {
    const result = (await runGitCommand(folderPath, ["rev-parse", "--is-inside-work-tree"])).trim();
    return result === "true";
  } catch {
    return false;
  }
}

async function getRemoteUrl(folderPath: string): Promise<string | undefined> {
  try {
    const remoteUrl = (await runGitCommand(folderPath, ["remote", "get-url", "origin"])).trim();
    return remoteUrl || undefined;
  } catch {
    return undefined;
  }
}

async function detectBaseBranch(folderPath: string, currentBranch: string): Promise<string> {
  for (const candidate of ["main", "master"]) {
    try {
      await runGitCommand(folderPath, ["rev-parse", "--verify", candidate]);
      return candidate;
    } catch {
      // Try the next base branch candidate.
    }
  }

  return currentBranch;
}

async function listSessionGitFolders(session: Awaited<ReturnType<typeof getSession>>): Promise<GitFolderDetection[]> {
  if (!session?.characterId) {
    return [];
  }

  const syncFolders = await getSyncFolders(session.characterId);
  const gitFolders = await Promise.all(
    syncFolders.map(async (folder) => {
      if (!(await isGitRepo(folder.folderPath))) {
        return null;
      }

      const branch = (await runGitCommand(folder.folderPath, ["branch", "--show-current"])).trim() || "HEAD";
      const gitFolder: GitFolderDetection = {
        id: folder.id,
        path: folder.folderPath,
        branch,
        isPrimary: Boolean(folder.isPrimary),
      };
      const remoteUrl = await getRemoteUrl(folder.folderPath);
      if (remoteUrl) {
        gitFolder.remoteUrl = remoteUrl;
      }
      return gitFolder;
    })
  );

  return gitFolders.filter((folder) => folder !== null);
}

async function findSessionSyncFolder(
  characterId: string | null,
  folderPath: string
) {
  if (!characterId) return null;
  const syncFolders = await getSyncFolders(characterId);
  return syncFolders.find((folder) => folder.folderPath === folderPath) ?? null;
}

async function getExistingPullRequest(
  cwd: string,
  branch: string,
  baseBranch: string
): Promise<ExistingPullRequest | null> {
  try {
    const output = await runGhCommand(cwd, [
      "pr",
      "list",
      "--head",
      branch,
      "--base",
      baseBranch,
      "--state",
      "all",
      "--json",
      "number,url,isDraft,state",
      "--limit",
      "1",
    ]);
    const pulls = JSON.parse(output) as ExistingPullRequest[];
    return pulls[0] ?? null;
  } catch (error) {
    console.warn("[workspace route] Failed to query existing PR:", error);
    return null;
  }
}

const WORKSPACE_DETECT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * GET /api/sessions/[id]/workspace
 *
 * Returns workspace info for a session, enriched with live git status.
 * If detect=true and the session has no workspace metadata yet, returns
 * git-capable synced folders for one-click Git Mode activation.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const authResult = await resolveSessionAuth(req, id);
    if ("errorResponse" in authResult) return authResult.errorResponse;

    const { session } = authResult;
    const metadata = session.metadata as Record<string, unknown> | null;
    // Use the verified resolver — `getWorkspaceInfo(metadata)` returns whatever
    // the session metadata claims, including stale identities whose sync folder
    // has since been removed. The prompt-builder and localGrep already reject
    // those, so this endpoint must do the same to avoid reporting workspaces
    // the rest of the system treats as invalid.
    const workspaceInfo = await resolveWorkspaceInfoFromSession(session);
    const url = new URL(req.url);
    const wantDetect = url.searchParams.get("detect") === "true";
    const wantDiff = url.searchParams.get("diff") === "true";

    if (!workspaceInfo && wantDetect) {
      // Return cached detection result if still fresh (unless ?refresh=true)
      const cachedFolders = metadata?.detectedGitFolders;
      const cachedAt = metadata?.detectedGitFoldersAt as string | undefined;

      if (
        cachedFolders &&
        cachedAt &&
        !url.searchParams.get("refresh") &&
        Date.now() - new Date(cachedAt).getTime() < WORKSPACE_DETECT_CACHE_TTL_MS
      ) {
        return NextResponse.json({ gitFolders: cachedFolders });
      }

      const gitFolders = await listSessionGitFolders(session);

      // Cache the detection result in session metadata
      try {
        await updateSession(id, {
          metadata: {
            ...(metadata || {}),
            detectedGitFolders: gitFolders,
            detectedGitFoldersAt: new Date().toISOString(),
          },
        });
      } catch (cacheErr) {
        console.warn("[workspace route] Failed to cache detection result:", cacheErr);
      }

      return NextResponse.json({ gitFolders });
    }

    if (!workspaceInfo) {
      return NextResponse.json(
        { error: "No workspace info for this session" },
        { status: 404 }
      );
    }

    const workspaceStatus = await buildWorkspaceStatus(workspaceInfo);

    if (wantDiff && workspaceInfo.worktreePath) {
      try {
        const gitService = new GitService(workspaceInfo.worktreePath);
        const diffFilter: {
          type?: string;
          filePath?: string;
          base?: string;
          head?: string;
        } = {};

        const diffType = url.searchParams.get("type");
        if (diffType) diffFilter.type = diffType;

        const diffFilePath = url.searchParams.get("filePath");
        if (diffFilePath) diffFilter.filePath = diffFilePath;

        const diffBase = url.searchParams.get("base");
        if (diffBase) diffFilter.base = diffBase;

        const diffHead = url.searchParams.get("head");
        if (diffHead) diffFilter.head = diffHead;

        const [diff, status] = await Promise.all([
          gitService.getDiff(diffFilter),
          gitService.getStatus(),
        ]);

        return NextResponse.json({
          workspace: workspaceStatus,
          diff,
          status,
        });
      } catch (error) {
        console.error("Failed to get structured diff:", error);
        return NextResponse.json(
          {
            error: "Failed to get structured diff",
            details: error instanceof Error ? error.message : String(error),
          },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ workspace: workspaceStatus });
  } catch (error) {
    console.error("Failed to get workspace info:", error);
    return NextResponse.json(
      { error: "Failed to get workspace info" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/sessions/[id]/workspace
 *
 * Updates workspace info in session metadata by merging the provided
 * partial WorkspaceInfo into the existing value.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const authResult = await resolveSessionAuth(req, id);
    if ("errorResponse" in authResult) return authResult.errorResponse;
    const { session } = authResult;

    const safePayload = sanitizeWorkspacePatch(await req.json());

    const existingMetadata = (session.metadata as Record<string, unknown>) || {};
    // Verified resolver — reject patches that target a sync-folder-less stale
    // workspace, mirroring what prompt-builder/localGrep already do.
    const existingWorkspaceInfo = await resolveWorkspaceInfoFromSession(session);
    if (!existingWorkspaceInfo) {
      return NextResponse.json(
        { error: "No workspace exists for this session." },
        { status: 404 }
      );
    }

    const mergedWorkspaceInfo = await updateWorkspaceLifecycleMetadata(
      id,
      safePayload,
      "workspace-route:patch"
    );
    const updated = await getSession(id);

    return NextResponse.json({
      workspace: mergedWorkspaceInfo,
      session: updated,
    });
  } catch (error) {
    console.error("Failed to update workspace info:", error);
    return NextResponse.json(
      { error: "Failed to update workspace info" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/sessions/[id]/workspace
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const authResult = await resolveSessionAuth(req, id);
    if ("errorResponse" in authResult) return authResult.errorResponse;

    const { session } = authResult;
    const metadata = (session.metadata as Record<string, unknown>) || {};
    const body = (await req.json()) as WorkspaceActionBody;
    const { action } = body;

    if (!action) {
      return NextResponse.json(
        { error: "Missing action field" },
        { status: 400 }
      );
    }

    if (action === "enable-git") {
      return await handleEnableGit(id, session, metadata, body.folderPath);
    }

    // Verified resolver — refuse to act on stale workspace metadata whose
    // sync folder has been removed. The prompt-builder and localGrep already
    // ignore those, so refresh/cleanup/push/sync routes must too instead of
    // silently operating on a workspace the rest of the system treats as
    // invalid.
    const workspaceInfo = await resolveWorkspaceInfoFromSession(session);
    if (!workspaceInfo) {
      return NextResponse.json(
        { error: "No workspace info for this session" },
        { status: 404 }
      );
    }

    switch (action) {
      case "refresh-status": {
        return await handleRefreshStatus(id, metadata, workspaceInfo);
      }
      case "cleanup": {
        return await handleCleanup(id, metadata, workspaceInfo);
      }
      case "sync-to-local": {
        return await handleSyncToLocal(id, metadata, workspaceInfo);
      }
      case "stage":
      case "unstage": {
        return await handleStageAction(action, workspaceInfo, body.filePath, body.hunkPatch);
      }
      case "stage-all":
      case "unstage-all": {
        return await handleStageAction(action, workspaceInfo);
      }
      case "revert": {
        return await handleRevert(workspaceInfo, body.filePath, body.hunkPatch);
      }
      case "commit": {
        return await handleCommit(workspaceInfo, body.message);
      }
      case "push": {
        return await handlePush(id, metadata, workspaceInfo);
      }
      case "push-and-create-pr": {
        return await handlePushAndCreatePR(id, session, metadata, workspaceInfo);
      }
      case "push-base-branch": {
        return await handlePushBaseBranch(workspaceInfo);
      }
      default: {
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
      }
    }
  } catch (error) {
    console.error("Failed to perform workspace action:", error);
    return NextResponse.json(
      { error: "Failed to perform workspace action" },
      { status: 500 }
    );
  }
}

async function handleEnableGit(
  sessionId: string,
  session: Awaited<ReturnType<typeof getSession>>,
  _metadata: Record<string, unknown>,
  folderPath?: string,
) {
  if (!folderPath || !isValidWorktreePath(folderPath)) {
    return NextResponse.json(
      { error: "A valid folderPath is required to enable Git Mode" },
      { status: 400 }
    );
  }

  const syncFolder = await findSessionSyncFolder(session?.characterId ?? null, folderPath);
  if (!syncFolder) {
    return NextResponse.json(
      { error: "Selected folder is not one of this agent's synced folders" },
      { status: 403 }
    );
  }

  if (!(await isGitRepo(folderPath))) {
    return NextResponse.json(
      { error: "Selected folder is not a git repository" },
      { status: 422 }
    );
  }

  const branch = (await runGitCommand(folderPath, ["branch", "--show-current"])).trim() || "HEAD";
  const baseBranch = await detectBaseBranch(folderPath, branch);
  const repoUrl = await getRemoteUrl(folderPath);

  const workspaceInfo: WorkspaceInfo = {
    type: "local",
    branch,
    baseBranch,
    worktreePath: folderPath,
    repoUrl,
    syncFolderId: syncFolder.id,
    status: "active",
    lastSyncedAt: new Date().toISOString(),
  };

  const persistedWorkspaceInfo = await writeWorkspaceInfo(
    sessionId,
    workspaceInfo,
    "workspace-route:enable-git"
  );
  const updatedSession = await getSession(sessionId);
  const workspaceStatus = await buildWorkspaceStatus(persistedWorkspaceInfo);

  return NextResponse.json({
    workspace: workspaceStatus,
    session: updatedSession,
  });
}

async function handleRefreshStatus(
  sessionId: string,
  _metadata: Record<string, unknown>,
  workspaceInfo: WorkspaceInfo
) {
  if (!workspaceInfo.worktreePath) {
    return NextResponse.json(
      { error: "No worktree path configured" },
      { status: 400 }
    );
  }

  const workspaceStatus = await buildWorkspaceStatus(workspaceInfo);
  const updatedWorkspaceInfo: WorkspaceInfo = {
    ...workspaceInfo,
    changedFiles: workspaceStatus.changedFiles,
    lastSyncedAt: new Date().toISOString(),
  };

  const persistedWorkspaceInfo = await updateWorkspaceLifecycleMetadata(
    sessionId,
    updatedWorkspaceInfo,
    "workspace-route:refresh-status"
  );

  return NextResponse.json({
    workspace: {
      ...workspaceStatus,
      ...persistedWorkspaceInfo,
    },
  });
}

async function handleCleanup(
  sessionId: string,
  metadata: Record<string, unknown>,
  workspaceInfo: WorkspaceInfo
) {
  const { worktreePath } = workspaceInfo;

  if (workspaceInfo.type !== "local" && worktreePath && isValidWorktreePath(worktreePath)) {
    if (fs.existsSync(worktreePath)) {
      try {
        const commonDir = (await runGitCommand(worktreePath, ["rev-parse", "--git-common-dir"])).trim();
        const mainRepoDir = fs.realpathSync(
          commonDir.endsWith("/.git") || commonDir.endsWith("\\.git")
            ? commonDir.replace(/[/\\]\.git$/, "")
            : `${commonDir}/..`
        );

        await runGitCommand(mainRepoDir, ["worktree", "remove", worktreePath, "--force"]);
      } catch (err) {
        console.error("Failed to remove git worktree:", err);
      }
    }
  }

  const { workspaceInfo: _removed, ...restMetadata } = metadata;
  await updateSession(sessionId, { metadata: restMetadata });

  return NextResponse.json({ success: true, message: "Workspace cleaned up" });
}

async function handleSyncToLocal(
  _sessionId: string,
  _metadata: Record<string, unknown>,
  workspaceInfo: WorkspaceInfo
) {
  if (workspaceInfo.type === "local") {
    return NextResponse.json(
      { error: "Git Mode sessions already operate in the local repository" },
      { status: 400 }
    );
  }

  const { worktreePath, baseBranch, branch } = workspaceInfo;

  if (!worktreePath || !isValidWorktreePath(worktreePath)) {
    return NextResponse.json(
      { error: "Invalid or missing worktree path" },
      { status: 400 }
    );
  }

  if (!fs.existsSync(worktreePath)) {
    return NextResponse.json(
      { error: "Worktree directory does not exist" },
      { status: 404 }
    );
  }

  if (!baseBranch || !branch) {
    return NextResponse.json(
      { error: "Both baseBranch and branch are required for sync-to-local" },
      { status: 400 }
    );
  }

  if (!isValidBranchName(baseBranch) || !isValidBranchName(branch)) {
    return NextResponse.json(
      { error: "Invalid branch name. Use only alphanumeric, dot, dash, underscore, and slash characters." },
      { status: 400 }
    );
  }

  try {
    const commonDir = (await runGitCommand(worktreePath, ["rev-parse", "--git-common-dir"])).trim();
    const mainRepoDir = fs.realpathSync(
      commonDir.endsWith("/.git") || commonDir.endsWith("\\.git")
        ? commonDir.replace(/[/\\]\.git$/, "")
        : `${commonDir}/..`
    );

    let patch: string;
    try {
      patch = await runGitCommand(worktreePath, ["diff", `${baseBranch}...${branch}`]);
    } catch (err) {
      return NextResponse.json(
        {
          error: "Failed to generate diff patch",
          details: err instanceof Error ? err.message : String(err),
        },
        { status: 500 }
      );
    }

    if (!patch.trim()) {
      return NextResponse.json({
        success: true,
        message: "No changes to sync",
        appliedFiles: 0,
      });
    }

    try {
      await runGitCommand(mainRepoDir, ["apply", "--check", "--3way", "-"], patch);
      await runGitCommand(mainRepoDir, ["apply", "--3way", "-"], patch);
    } catch (err) {
      return NextResponse.json(
        {
          error: "Failed to apply patch to main repository",
          details: err instanceof Error ? err.message : String(err),
        },
        { status: 500 }
      );
    }

    const appliedFiles = (patch.match(/^diff --git /gm) || []).length;

    return NextResponse.json({
      success: true,
      message: `Synced ${appliedFiles} file(s) to local repository`,
      appliedFiles,
    });
  } catch (error) {
    console.error("Failed to sync to local:", error);
    return NextResponse.json(
      {
        error: "Failed to sync changes to local repository",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

async function handleStageAction(
  action: "stage" | "unstage" | "stage-all" | "unstage-all",
  workspaceInfo: WorkspaceInfo,
  filePath?: string,
  hunkPatch?: string,
) {
  if (!workspaceInfo.worktreePath) {
    return NextResponse.json(
      { error: "No worktree path configured" },
      { status: 400 }
    );
  }

  if (!fs.existsSync(workspaceInfo.worktreePath)) {
    return NextResponse.json(
      { error: "Worktree directory does not exist" },
      { status: 404 }
    );
  }

  try {
    const gitService = new GitService(workspaceInfo.worktreePath);
    await gitService.stage(action, filePath, hunkPatch);
    const status = await gitService.getStatus();
    return NextResponse.json({ success: true, status });
  } catch (error) {
    console.error(`Failed to ${action}:`, error);
    return NextResponse.json(
      {
        error: `Failed to ${action}`,
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

async function handleRevert(
  workspaceInfo: WorkspaceInfo,
  filePath?: string,
  hunkPatch?: string,
) {
  if (!workspaceInfo.worktreePath) {
    return NextResponse.json(
      { error: "No worktree path configured" },
      { status: 400 }
    );
  }

  if (!fs.existsSync(workspaceInfo.worktreePath)) {
    return NextResponse.json(
      { error: "Worktree directory does not exist" },
      { status: 404 }
    );
  }

  if (!filePath) {
    return NextResponse.json(
      { error: "filePath is required for revert" },
      { status: 400 }
    );
  }

  try {
    const gitService = new GitService(workspaceInfo.worktreePath);
    await gitService.revert(filePath, hunkPatch);
    const status = await gitService.getStatus();
    return NextResponse.json({ success: true, status });
  } catch (error) {
    console.error("Failed to revert:", error);
    return NextResponse.json(
      {
        error: "Failed to revert changes",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

async function handleCommit(
  workspaceInfo: WorkspaceInfo,
  message?: string,
) {
  if (!workspaceInfo.worktreePath) {
    return NextResponse.json(
      { error: "No worktree path configured" },
      { status: 400 }
    );
  }

  if (!fs.existsSync(workspaceInfo.worktreePath)) {
    return NextResponse.json(
      { error: "Worktree directory does not exist" },
      { status: 404 }
    );
  }

  if (!message || !message.trim()) {
    return NextResponse.json(
      { error: "Commit message is required" },
      { status: 400 }
    );
  }

  try {
    const gitService = new GitService(workspaceInfo.worktreePath);
    const commitResult = await gitService.commit(message);
    const status = await gitService.getStatus();
    return NextResponse.json({ success: true, commit: commitResult, status });
  } catch (error) {
    console.error("Failed to commit:", error);
    return NextResponse.json(
      {
        error: "Failed to commit changes",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

async function handlePush(
  sessionId: string,
  _metadata: Record<string, unknown>,
  workspaceInfo: WorkspaceInfo,
) {
  if (!workspaceInfo.worktreePath) {
    return NextResponse.json(
      { error: "No worktree path configured" },
      { status: 400 }
    );
  }

  if (!workspaceInfo.branch) {
    return NextResponse.json(
      { error: "No branch configured for this workspace" },
      { status: 400 }
    );
  }

  if (!fs.existsSync(workspaceInfo.worktreePath)) {
    return NextResponse.json(
      { error: "Worktree directory does not exist" },
      { status: 404 }
    );
  }

  try {
    const gitService = new GitService(workspaceInfo.worktreePath);
    await gitService.push("origin", workspaceInfo.branch);

    const updatedWorkspaceInfo: WorkspaceInfo = {
      ...workspaceInfo,
      lastSyncedAt: new Date().toISOString(),
    };
    const persistedWorkspaceInfo = await updateWorkspaceLifecycleMetadata(
      sessionId,
      updatedWorkspaceInfo,
      "workspace-route:push"
    );

    return NextResponse.json({
      success: true,
      workspace: await buildWorkspaceStatus(persistedWorkspaceInfo),
    });
  } catch (error) {
    console.error("Failed to push:", error);
    return NextResponse.json(
      {
        error: "Failed to push branch",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

async function handlePushBaseBranch(workspaceInfo: WorkspaceInfo) {
  if (!workspaceInfo.worktreePath || !workspaceInfo.baseBranch) {
    return NextResponse.json(
      { error: "Worktree path and base branch are required" },
      { status: 400 }
    );
  }

  try {
    // Push the base branch from the main repo root (worktree shares the same git objects)
    await runGitCommand(workspaceInfo.worktreePath, [
      "push", "-u", "origin", workspaceInfo.baseBranch,
    ]);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to push base branch",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

async function handlePushAndCreatePR(
  sessionId: string,
  session: Awaited<ReturnType<typeof getSession>>,
  _metadata: Record<string, unknown>,
  workspaceInfo: WorkspaceInfo,
) {
  if (!workspaceInfo.worktreePath) {
    return NextResponse.json(
      { error: "No worktree path configured" },
      { status: 400 }
    );
  }

  if (!workspaceInfo.branch || !workspaceInfo.baseBranch) {
    return NextResponse.json(
      { error: "Both branch and baseBranch are required to create a pull request" },
      { status: 400 }
    );
  }

  if (!fs.existsSync(workspaceInfo.worktreePath)) {
    return NextResponse.json(
      { error: "Worktree directory does not exist" },
      { status: 404 }
    );
  }

  try {
    await runGhCommand(workspaceInfo.worktreePath, ["--version"]);
  } catch (error) {
    if (isCommandNotFoundError(error, "gh")) {
      return NextResponse.json(
        {
          error: "GitHub CLI is not installed. Install gh to create pull requests from the workspace UI.",
          errorCode: "GH_NOT_INSTALLED",
          installUrl: GH_INSTALL_URL,
          docsUrl: GH_INSTALL_URL,
        },
        { status: 422 }
      );
    }
    return NextResponse.json(
      {
        error: "Failed to verify GitHub CLI installation",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }

  try {
    await runGhCommand(workspaceInfo.worktreePath, ["auth", "status"]);
  } catch (error) {
    return NextResponse.json(
      {
        error: "GitHub CLI is not authenticated. Run `gh auth login` and try again.",
        details: error instanceof Error ? error.message : String(error),
        errorCode: "GH_AUTH_REQUIRED",
        authCommand: "gh auth login",
        authCheckCommand: "gh auth status",
        docsUrl: GH_AUTH_DOCS_URL,
      },
      { status: 401 }
    );
  }

  const gitService = new GitService(workspaceInfo.worktreePath);

  try {
    await gitService.push("origin", workspaceInfo.branch);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to push branch before creating pull request",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }

  // Check if the base branch exists on the remote before attempting PR creation
  try {
    const lsRemoteOutput = await runGitCommand(workspaceInfo.worktreePath, [
      "ls-remote", "--heads", "origin", workspaceInfo.baseBranch,
    ]);
    if (!lsRemoteOutput.trim()) {
      return NextResponse.json(
        {
          error: `Base branch '${workspaceInfo.baseBranch}' does not exist on the remote. Push it before creating a pull request.`,
          errorCode: "BASE_BRANCH_NOT_ON_REMOTE",
          baseBranch: workspaceInfo.baseBranch,
          partialSuccess: true,
          pushed: true,
          workspace: await buildWorkspaceStatus({
            ...workspaceInfo,
            lastSyncedAt: new Date().toISOString(),
          }),
        },
        { status: 422 }
      );
    }
  } catch {
    // If ls-remote fails (e.g. network), let the PR creation attempt proceed
    // and surface a more specific error from gh
  }

  let pullRequest = await getExistingPullRequest(
    workspaceInfo.worktreePath,
    workspaceInfo.branch,
    workspaceInfo.baseBranch,
  );

  if (!pullRequest) {
    const commitLog = (await gitService.getCommitLog(workspaceInfo.baseBranch, 20)).trim();
    if (!commitLog) {
      return NextResponse.json(
        {
          error: "No commits are available to open a pull request",
          errorCode: "NO_COMMITS_FOR_PR",
          partialSuccess: true,
          pushed: true,
          workspace: await buildWorkspaceStatus({
            ...workspaceInfo,
            lastSyncedAt: new Date().toISOString(),
          }),
        },
        { status: 400 }
      );
    }

    let diffStat: string | undefined;
    try {
      diffStat = (
        await runGitCommand(workspaceInfo.worktreePath, [
          "diff",
          "--stat",
          `${workspaceInfo.baseBranch}...HEAD`,
        ])
      ).trim() || undefined;
    } catch {
      diffStat = undefined;
    }

    const template = readPullRequestTemplate(workspaceInfo.worktreePath);
    const prTitle = buildFallbackPrTitle(commitLog, workspaceInfo.branch);
    const prBody = await generatePullRequestBody(session?.metadata as Record<string, unknown> | null, {
      branch: workspaceInfo.branch,
      baseBranch: workspaceInfo.baseBranch,
      commitLog,
      diffStat,
      template,
    });

    try {
      await runGhCommand(
        workspaceInfo.worktreePath,
        [
          "pr",
          "create",
          "--title",
          prTitle,
          "--body-file",
          "-",
          "--head",
          workspaceInfo.branch,
          "--base",
          workspaceInfo.baseBranch,
          "--draft",
        ],
        prBody,
      );
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      const requiresAuth = /gh auth login|not logged in|authentication|authenticate|scope|token/i.test(details);
      return NextResponse.json(
        {
          error: requiresAuth
            ? "GitHub CLI needs additional authentication before a pull request can be created."
            : "Failed to create pull request",
          details,
          errorCode: requiresAuth ? "GH_AUTH_REQUIRED" : "GH_PR_CREATE_FAILED",
          authCommand: requiresAuth ? "gh auth login" : undefined,
          authCheckCommand: requiresAuth ? "gh auth status" : undefined,
          docsUrl: requiresAuth ? GH_AUTH_DOCS_URL : undefined,
          partialSuccess: true,
          pushed: true,
          workspace: await buildWorkspaceStatus({
            ...workspaceInfo,
            lastSyncedAt: new Date().toISOString(),
          }),
        },
        { status: requiresAuth ? 401 : 500 }
      );
    }

    pullRequest = await getExistingPullRequest(
      workspaceInfo.worktreePath,
      workspaceInfo.branch,
      workspaceInfo.baseBranch,
    );
  }

  if (!pullRequest) {
    return NextResponse.json(
      { error: "Pull request was created but could not be resolved afterward" },
      { status: 500 }
    );
  }

  const updatedWorkspaceInfo: WorkspaceInfo = {
    ...workspaceInfo,
    prNumber: pullRequest.number,
    prUrl: pullRequest.url || extractHttpUrl(pullRequest.url || ""),
    prStatus: mapPrStatus(pullRequest),
    status: "pr-open",
    lastSyncedAt: new Date().toISOString(),
  };

  const persistedWorkspaceInfo = await updateWorkspaceLifecycleMetadata(
    sessionId,
    updatedWorkspaceInfo,
    "workspace-route:push-and-create-pr"
  );

  return NextResponse.json({
    success: true,
    created: pullRequest.state == null,
    workspace: await buildWorkspaceStatus(persistedWorkspaceInfo),
    prUrl: persistedWorkspaceInfo.prUrl,
    prNumber: persistedWorkspaceInfo.prNumber,
  });
}

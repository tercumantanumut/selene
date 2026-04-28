/**
 * Solo Story Mode — per-seat permission scope injection.
 *
 * Hooks the seat's snapshotted `permission_scope` into the chat request's tool
 * resolution pipeline at the single SPEC §7 injection site
 * (`app/api/chat/route.ts`, between `allowedPluginNames` build and
 * `buildToolsForRequest()`).
 *
 * Why a snapshot, not the live row:
 *   The captain may edit `lobby_seats.permission_scope` mid-execution. A
 *   running card's tool surface MUST NOT shift mid-flight. Per SPEC §3 #8 +
 *   #12, every soloStory `agent_runs` row carries `metadata.soloStory.permissionScope`
 *   captured at run start. Sprint 3's job is to read that snapshot — never the
 *   live `lobby_seats` row.
 *
 * Why role matters:
 *   Planner and synthesizer runs use an empty tool-list scope as a sentinel
 *   for "no tightening" (their character's enabled tools apply unmodified).
 *   Worker runs get the seat scope verbatim. We collapse both cases into one
 *   rule: an empty `allowedTools` array means "skip injection".
 *
 * V1 surface:
 *   - `enabledTools` (the agent's tool allowlist) is intersected with
 *     `scope.allowedTools` minus `scope.deniedTools`.
 *   - MCP tools (loaded later in tools-builder) are intersected by name with
 *     the same set.
 *   - `scopedPlugins` is left intact in V1: plugin hooks and MCP server
 *     connections still run; gating happens at the per-tool name layer
 *     (SPEC §7 step 3 is implicit in V1 — there is no per-plugin allowlist
 *     yet, so dropping plugins by name would mis-fire).
 */

import { and, desc, eq, like } from "drizzle-orm";
import type { Tool } from "ai";
import { db } from "@/lib/db/sqlite-client";
import { agentRuns } from "@/lib/db/sqlite-observability-schema";
import type {
  LobbyPermissionScopeV1,
  SoloStoryRunMetadata,
} from "@/lib/lobbies/types";

export type SoloStoryScopeContext = {
  scope: LobbyPermissionScopeV1;
  /** Echoed verbatim from the snapshot for downstream telemetry / auditing. */
  lobbyId: string;
  cardId?: string;
  seatId?: string;
  role: SoloStoryRunMetadata["soloStory"]["role"];
};

/**
 * Look up the soloStory snapshot attached to the most recent active soloStory
 * `agent_runs` row for `sessionId`. Returns `null` when no such row exists
 * (this is not a soloStory session).
 *
 * Unlike a tool-tightening helper, this returns the full context — including
 * the lobbyId / cardId / role — even when the snapshot's `allowedTools` is
 * empty. Empty-list snapshots ("no tightening" sentinels written by the
 * planner / synthesizer) still need their lobbyId tagged onto SSE events so
 * the lobby UI can route progress updates back to the right card.
 *
 * The query is intentionally narrow: only `running` rows whose pipeline name
 * begins with `solo_story.` are considered. This matches `insertSoloStoryRunInTx`
 * in `lib/lobbies/services.ts` and avoids accidental matches on unrelated
 * `agent_runs` rows that may have been authored by other features.
 *
 * Tool-tightening callers must additionally check
 * `shouldApplyScopeTightening(context.scope)` before filtering — empty scopes
 * are pass-throughs.
 */
export async function loadSoloStoryScopeForSession(input: {
  sessionId: string;
  userId: string;
}): Promise<SoloStoryScopeContext | null> {
  const { sessionId, userId } = input;

  const rows = await db
    .select({
      metadata: agentRuns.metadata,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.sessionId, sessionId),
        eq(agentRuns.userId, userId),
        eq(agentRuns.status, "running"),
        like(agentRuns.pipelineName, "solo_story.%"),
      ),
    )
    .orderBy(desc(agentRuns.startedAt))
    .limit(1)
    .all();

  const raw = rows[0]?.metadata as unknown;
  const snapshot = extractSoloStorySnapshot(raw);
  if (!snapshot) return null;

  return {
    scope: snapshot.permissionScope,
    lobbyId: snapshot.lobbyId,
    cardId: snapshot.cardId,
    seatId: snapshot.seatId,
    role: snapshot.role,
  };
}

/**
 * `true` when the seat's permission scope should narrow the request's tool
 * surface. Empty `allowedTools` is the planner / synthesizer sentinel and
 * means "leave the character's enabled tools untouched".
 */
export function shouldApplyScopeTightening(
  scope: LobbyPermissionScopeV1,
): boolean {
  return scope.allowedTools.length > 0;
}

function extractSoloStorySnapshot(
  raw: unknown,
): SoloStoryRunMetadata["soloStory"] | null {
  if (!raw || typeof raw !== "object") return null;
  const meta = raw as { soloStory?: unknown };
  if (!meta.soloStory || typeof meta.soloStory !== "object") return null;

  const ss = meta.soloStory as Record<string, unknown>;
  const scope = ss.permissionScope as Record<string, unknown> | undefined;
  if (
    !scope ||
    scope.version !== 1 ||
    scope.mode !== "tool_list" ||
    !Array.isArray(scope.allowedTools)
  ) {
    return null;
  }

  if (typeof ss.lobbyId !== "string" || ss.lobbyId.length === 0) return null;
  const role = ss.role;
  if (role !== "planner" && role !== "worker" && role !== "synthesizer") {
    return null;
  }

  const allowedTools = (scope.allowedTools as unknown[]).filter(
    (t): t is string => typeof t === "string",
  );
  const deniedTools = Array.isArray(scope.deniedTools)
    ? (scope.deniedTools as unknown[]).filter(
        (t): t is string => typeof t === "string",
      )
    : undefined;
  // Sprint 5.3: rehydrate `allowedFolderIds` from the snapshot. Without
  // this, the V1 → V1.1 upgrade path quietly loses the field on every run
  // even though the snapshot wrote it — the V1 tool gate ignores the
  // value but the field MUST round-trip through this reconstruction so
  // V1.1 (which will enforce folder scoping at the FS layer) can read it
  // off the snapshot just like every other scope dimension. The defensive
  // `Array.isArray + filter(string)` here is required because we're
  // reading from `agent_runs.metadata` (untyped JSON) rather than the
  // strict zod schema. The schema declares this as
  // `z.array(z.string()).optional()`, so when callers go through
  // `permissionScopeV1Schema` they get a well-typed value; this filter
  // exists for the JSON-roundtrip path. SPEC §3 #11 (`.strict()` on the
  // scope schema) only buys us "no extra keys" — it does not validate
  // the shape of present fields, so we belt-and-braces it here.
  const allowedFolderIds = Array.isArray(scope.allowedFolderIds)
    ? (scope.allowedFolderIds as unknown[]).filter(
        (t): t is string => typeof t === "string",
      )
    : undefined;

  return {
    lobbyId: ss.lobbyId,
    cardId: typeof ss.cardId === "string" ? ss.cardId : undefined,
    seatId: typeof ss.seatId === "string" ? ss.seatId : undefined,
    role,
    permissionScope: {
      version: 1,
      mode: "tool_list",
      allowedTools,
      deniedTools,
      allowedFolderIds,
    },
    permissionScopeSnapshotAt:
      typeof ss.permissionScopeSnapshotAt === "string"
        ? ss.permissionScopeSnapshotAt
        : new Date(0).toISOString(),
  };
}

/**
 * Apply the seat scope to an `enabledTools` list.
 *
 * Behavior:
 *   - When `toolNames` is undefined (no agent-level whitelist), the result is
 *     `scope.allowedTools` minus `scope.deniedTools`. This converts an
 *     unbounded "all character tools" into a bounded soloStory whitelist.
 *   - When `toolNames` is defined, the result is the intersection of
 *     `toolNames` with `scope.allowedTools`, minus `scope.deniedTools`.
 */
export function applyScopeToToolNames(
  toolNames: string[] | undefined,
  scope: LobbyPermissionScopeV1,
): string[] {
  const allowed = new Set(scope.allowedTools);
  const denied = new Set(scope.deniedTools ?? []);
  const base = toolNames ?? scope.allowedTools;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of base) {
    if (seen.has(name)) continue;
    if (!allowed.has(name)) continue;
    if (denied.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Intersect a map of MCP tools with the seat scope.
 *
 * SPEC §7 step 4: V1 simply denies any tool whose name is not in
 * `scope.allowedTools` (or is in `scope.deniedTools`). Returns the kept map
 * plus a list of denied names so the caller can emit a single audit log line
 * instead of one per dropped tool.
 */
export function applyScopeToMcpTools(
  tools: Record<string, Tool>,
  scope: LobbyPermissionScopeV1,
): { kept: Record<string, Tool>; denied: string[] } {
  const allowed = new Set(scope.allowedTools);
  const denied = new Set(scope.deniedTools ?? []);
  const kept: Record<string, Tool> = {};
  const dropped: string[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (!allowed.has(name) || denied.has(name)) {
      dropped.push(name);
      continue;
    }
    kept[name] = tool;
  }
  return { kept, denied: dropped };
}

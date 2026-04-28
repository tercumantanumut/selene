/**
 * Built-in (public) lobby starter templates.
 *
 * SPEC §2 V1 commits to shipping "3 starter templates: blank, 'research and
 * summarize', 'code task'". Public templates have `user_id = NULL` (SPEC §4)
 * and are seeded server-side, not via the API (the POST /api/lobby-templates
 * route forces visibility="private"; see app/api/lobby-templates/route.ts).
 *
 * This module is the seed mechanism. It runs at boot from
 * `lib/db/sqlite-migrations.ts:initializeTables()` AFTER the lobby tables
 * exist, and is idempotent — every starter template has a stable id so a
 * second invocation is a no-op `INSERT OR IGNORE`.
 *
 * Why stable ids instead of `crypto.randomUUID()`?
 *   - Idempotency: re-running boot should not double-insert.
 *   - Reference stability: a captain may have created lobbies that FK into
 *     a starter template (`lobbies.template_id`). Re-seeding with new ids
 *     would orphan those FKs (the FK is `ON DELETE SET NULL`, so they'd
 *     survive — but the historical link to the template would silently
 *     break).
 *   - Update path: when we tighten a starter prompt in V1.x, we can do an
 *     `INSERT OR REPLACE` (or surgical UPDATE) keyed off the stable id.
 *
 * Default seats deliberately set `agentId: undefined`. Public templates
 * cannot reference any specific captain's character library — the captain
 * picks the agent inside the lobby's roster phase. The route at
 * `app/api/lobbies/route.ts` materializes template seats with `agentId: null`
 * regardless, so this is enforced at two layers.
 *
 * Permission scopes here are sketches, not enforcement: V1's scope is
 * tool-list (SPEC §3 #11). The `allowedTools` array hints at what the seat
 * is *expected* to use; the actual filtering happens at run start
 * (`lib/lobbies/scope-injection.ts`). When the captain edits the seat, they
 * can broaden or tighten this.
 */

import type Database from "better-sqlite3";

import type {
  LobbyConfigV1,
  LobbyTemplateSeatV1,
} from "./types";

// ---------------------------------------------------------------------------
// Stable ids
// ---------------------------------------------------------------------------

/**
 * Prefixed with `builtin-` so they're visually distinct from the random
 * UUIDs used for user-created templates and so a future "list builtins"
 * filter can match by prefix without touching `visibility`.
 */
const BUILTIN_BLANK_ID = "builtin-lobby-template-blank";
const BUILTIN_RESEARCH_ID = "builtin-lobby-template-research-summarize";
const BUILTIN_CODE_ID = "builtin-lobby-template-code-task";

// ---------------------------------------------------------------------------
// Tool-list constants
// ---------------------------------------------------------------------------

/**
 * Match `lib/characters/templates/resolve-tools.ts:ALWAYS_ENABLED_TOOLS` —
 * every seat needs read/write/grep/bash to do anything useful. Hardcoded
 * (not imported) because that module is settings-aware and runs at user
 * signup; here we want a static seed that doesn't pull settings into the
 * SQLite boot path.
 */
const ALWAYS_ON_TOOLS = [
  "localGrep",
  "readFile",
  "editFile",
  "writeFile",
  "bash",
] as const;

const RESEARCH_TOOLS = [
  ...ALWAYS_ON_TOOLS,
  "webSearch",
  "chromiumWorkspace",
] as const;

const WRITER_TOOLS = [
  ...ALWAYS_ON_TOOLS,
  "webSearch", // for citation lookups + fact-checks
] as const;

const CODER_TOOLS = [
  ...ALWAYS_ON_TOOLS,
  "delegateToSubagent", // long tasks may want to fan out to subagents
] as const;

const REVIEWER_TOOLS = [
  ...ALWAYS_ON_TOOLS,
] as const;

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

type StarterTemplate = {
  id: string;
  name: string;
  description: string;
  defaultSeats: LobbyTemplateSeatV1[];
  planningPrompt: string;
  synthesisPrompt: string;
  config: Partial<LobbyConfigV1>;
};

/**
 * Blank — the "no scaffolding, just a goal" path. Zero default seats; the
 * captain builds the roster from scratch. The planning/synthesis prompts
 * are generic enough to work for any goal.
 *
 * This exists alongside the `null`/"No template" radio because:
 *   - "No template" creates a lobby with zero seats AND zero config (no
 *     planner/synthesizer prompt overrides).
 *   - "Blank" creates a lobby with zero seats but seeds `planningPrompt` /
 *     `synthesisPrompt` so the orchestrator has something to feed the
 *     planner subagent. A captain who doesn't want the prompts can still
 *     pick "No template".
 */
const BLANK_TEMPLATE: StarterTemplate = {
  id: BUILTIN_BLANK_ID,
  name: "Blank lobby",
  description:
    "Start from scratch. Bring your own seats; we'll wire up a generic planner and synthesizer.",
  defaultSeats: [],
  planningPrompt:
    "You are the planner for a Solo Story lobby. Read the captain's goal and produce a kanban of cards that, executed in order respecting their dependencies, will fully achieve that goal. Each card must have a clear title, a one-paragraph description, and 2-5 acceptance criteria. Group related work into cards that fit a single roster seat. Keep the DAG shallow — prefer a wider plan over a deep chain.",
  synthesisPrompt:
    "You are the synthesizer for a Solo Story lobby. Read every approved card's output and produce the captain's final artifact. Open with a one-paragraph summary of what was accomplished, followed by the artifact itself (deliverable, document, code summary, etc.). End with a short 'next steps' section if any acceptance criteria were partially met.",
  config: {
    version: 1,
  },
};

/**
 * Research and summarize — the canonical "go find out, write it up" lobby.
 *
 * Two seats:
 *   1. Researcher — uses webSearch + chromiumWorkspace + read/grep to
 *      collect primary sources.
 *   2. Writer — turns the researcher's notes into a coherent artifact.
 *
 * The split is intentional: keeping research and writing in separate seats
 * lets the captain approve the research card before any writing happens,
 * which is the only way to catch "the agent hallucinated a source" before
 * it gets baked into the final artifact.
 */
const RESEARCH_TEMPLATE: StarterTemplate = {
  id: BUILTIN_RESEARCH_ID,
  name: "Research and summarize",
  description:
    "Two seats: a researcher gathers sources, a writer turns them into a clean artifact. Best for briefs, market scans, literature reviews.",
  defaultSeats: [
    {
      role: "Researcher",
      required: true,
      position: 0,
      permissionScope: {
        version: 1,
        mode: "tool_list",
        allowedTools: [...RESEARCH_TOOLS],
      },
    },
    {
      role: "Writer",
      required: true,
      position: 1,
      permissionScope: {
        version: 1,
        mode: "tool_list",
        allowedTools: [...WRITER_TOOLS],
      },
    },
  ],
  planningPrompt:
    "You are the planner for a research-and-summarize lobby with a Researcher seat and a Writer seat. Produce a kanban that (1) has the Researcher gather, validate, and cite the primary sources for the captain's goal in 2-4 cards (assigned to the Researcher seat), and (2) has the Writer produce an outline, draft, and revision in 2-3 cards (assigned to the Writer seat) that depend on the Researcher's cards being approved. Keep acceptance criteria specific: 'cites at least 5 distinct primary sources', 'each claim links back to a source', 'final draft is under 1500 words unless the captain asked otherwise'.",
  synthesisPrompt:
    "You are the synthesizer for a research-and-summarize lobby. Read every approved card's output and produce the final brief. Structure: (1) one-paragraph executive summary, (2) the body (drawn from the Writer's cards), (3) a citations section listing every source the Researcher validated. Flag any acceptance criteria that were not fully met as open questions at the end.",
  config: {
    version: 1,
  },
};

/**
 * Code task — the "implement this thing" lobby.
 *
 * Two seats:
 *   1. Coder — read/write/grep/bash + subagent delegation for fan-out.
 *   2. Reviewer — read/grep only. The reviewer can't write code, which is
 *      the whole point: their job is to read the coder's output, run the
 *      tests it produced, and approve or reject. Tightening their scope
 *      protects the captain from a reviewer that "fixes" things instead
 *      of flagging them.
 *
 * The narrower reviewer scope is V1's poor-man's separation of duties.
 * V1.1+ folder-level scoping (SPEC §10) will make this stricter.
 */
const CODE_TEMPLATE: StarterTemplate = {
  id: BUILTIN_CODE_ID,
  name: "Code task",
  description:
    "Two seats: a coder implements, a reviewer reads and approves. Best for refactors, bug fixes, and bounded feature work.",
  defaultSeats: [
    {
      role: "Coder",
      required: true,
      position: 0,
      permissionScope: {
        version: 1,
        mode: "tool_list",
        allowedTools: [...CODER_TOOLS],
      },
    },
    {
      role: "Reviewer",
      required: true,
      position: 1,
      permissionScope: {
        version: 1,
        mode: "tool_list",
        allowedTools: [...REVIEWER_TOOLS],
        // The reviewer must not write code. Listing the write tools as
        // explicitly denied is belt-and-suspenders in V1 (the seat scope
        // already excludes them from `allowedTools`), but Sprint 11+ may
        // collapse `allowedTools` into a coarser preset, and a denylist
        // here keeps the no-writes invariant load-bearing.
        deniedTools: ["editFile", "writeFile", "bash"],
      },
    },
  ],
  planningPrompt:
    "You are the planner for a code-task lobby with a Coder seat and a Reviewer seat. Produce a kanban that (1) has the Coder investigate the codebase, design the change, implement it, and add tests in 3-5 cards, and (2) has the Reviewer read the diff, run the tests, and approve or flag issues in 1-2 cards (depending on the Coder cards). Acceptance criteria must be objectively checkable: 'tests pass', 'no new lint errors', 'public API surface unchanged unless the captain asked otherwise'. Mark the reviewer's final card as the gate before synthesis.",
  synthesisPrompt:
    "You are the synthesizer for a code-task lobby. Read every approved card's output and produce a one-page change report for the captain: (1) what was changed (a high-level summary, not a diff), (2) which files were touched, (3) the reviewer's verdict and any remaining concerns, (4) recommended follow-ups (tests, docs, deploy notes). Do not paste the full diff — the captain has it in the codebase.",
  config: {
    version: 1,
  },
};

const STARTER_TEMPLATES: StarterTemplate[] = [
  BLANK_TEMPLATE,
  RESEARCH_TEMPLATE,
  CODE_TEMPLATE,
];

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Idempotently insert the built-in starter templates as `visibility='public'`
 * rows with `user_id IS NULL`. Safe to call on every boot.
 *
 * Strategy: `INSERT OR IGNORE` on the stable id. Existing rows are NOT
 * updated — we don't want to clobber any divergence a deployment might have
 * intentionally made (or that a hand-edit introduced for debugging). When
 * we revise a starter prompt in a future sprint, that revision will land
 * via a dedicated migration that targets the row by id with an explicit
 * UPDATE.
 *
 * This intentionally uses raw SQL (not Drizzle) because it runs from
 * `initializeTables()` in `lib/db/sqlite-migrations.ts`, which bootstraps
 * before Drizzle's connection has been established for the runtime db
 * client. The `lobby_templates` schema is the only contract we need.
 */
export function seedLobbyStarterTemplatesWith(sqlite: Database.Database): void {
  // Guard: skip the entire seed if the table is missing. `initLobbiesTablesWith`
  // runs first, so this should never trigger — but a defensive check beats a
  // hard boot failure if the migration order ever drifts.
  const tableExists = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='lobby_templates'",
    )
    .get();
  if (!tableExists) {
    console.warn(
      "[SQLite Migration] lobby_templates table missing; skipping starter template seed.",
    );
    return;
  }

  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO lobby_templates (
      id,
      name,
      description,
      default_seats,
      planning_prompt,
      synthesis_prompt,
      user_id,
      visibility,
      config,
      created_at,
      updated_at
    ) VALUES (
      @id,
      @name,
      @description,
      @defaultSeats,
      @planningPrompt,
      @synthesisPrompt,
      NULL,
      'public',
      @config,
      datetime('now'),
      datetime('now')
    )
  `);

  let inserted = 0;
  try {
    const tx = sqlite.transaction((rows: StarterTemplate[]) => {
      for (const row of rows) {
        const result = insert.run({
          id: row.id,
          name: row.name,
          description: row.description,
          defaultSeats: JSON.stringify(row.defaultSeats),
          planningPrompt: row.planningPrompt,
          synthesisPrompt: row.synthesisPrompt,
          config: JSON.stringify(row.config),
        });
        // `INSERT OR IGNORE` reports `changes === 0` when the row already
        // existed — count only the actual inserts so the boot log is
        // honest about what happened.
        if (result.changes > 0) inserted += 1;
      }
    });
    tx(STARTER_TEMPLATES);
  } catch (error) {
    // Don't crash boot over seed failures — the rest of the system runs
    // fine without starter templates (the radiogroup falls back to its
    // empty-state copy). Log loudly so the operator notices.
    console.warn(
      "[SQLite Migration] Failed to seed lobby starter templates:",
      error,
    );
    return;
  }

  if (inserted > 0) {
    console.log(
      `[SQLite Migration] Seeded ${inserted} lobby starter template(s)`,
    );
  }
}

/**
 * Exported for tests + the admin "reset templates to defaults" path that may
 * appear in V1.1. Returns a defensive copy so callers can't mutate the
 * canonical list.
 */
export function getStarterTemplateDescriptors(): ReadonlyArray<StarterTemplate> {
  return STARTER_TEMPLATES;
}

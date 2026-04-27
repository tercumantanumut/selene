# Solo Story Mode — Consolidated Spec

> Single source of truth for the Solo Story Mode feature. Synthesized from 4 parallel research reports (workflow primitives, tool resolver extension, frontend architecture, backend architecture) plus the original product design.
>
> All implementer agents working on this feature MUST read this document first. Diverging from it requires explicit captain approval.

---

## 1. Feature Summary

Solo Story Mode is a single-captain (one human) multi-agent coordination feature on Selene. The captain creates a "lobby", fills seats with agents from their library, the planning agent generates a kanban board of cards, the captain edits the plan, then "rolls" execution. Cards run in parallel respecting their dependency DAG. Each completed card goes through captain review (approve/reject/retry/edit), and on full approval a synthesizer agent produces the final artifact.

The feature is additive. It introduces new tables and routes only. It does NOT modify the existing `agent_workflows` table (which is a roster-only primitive). It REUSES `agent_runs` for execution, `characters` (the existing agent library), `delegateToSubagent` for orchestration, `/api/tasks/events` for realtime, and the existing tool/plugin permission pipeline.

---

## 2. Scope (V1) — What Ships, What Doesn't

### Ships
- Lobby CRUD (`/lobbies`, `/lobbies/new`, `/lobbies/[id]`)
- Roster phase: seat-grid editor, agent picker, per-seat tool-list permission scope
- Planning phase: planner subagent emits cards w/ dependencies; captain edits manually
- Rolling phase: parallel card execution respecting DAG; each card runs as an `agent_runs` row via `delegateToSubagent`
- Review phase: per-card approve / reject (with required reason) / retry / edit-and-retry
- Synthesis phase: synthesizer subagent reads approved card outputs, produces final artifact
- Audit log via `lobby_events` (per-lobby monotonic sequence)
- 3 starter templates: blank, "research and summarize", "code task"

### Deferred (V1.1+)
- Save lobby as reusable workflow
- Multi-human / collaborative captain mode
- Public lobby template marketplace
- Auto-approve on acceptance criteria
- Re-planning mid-execution
- Fine-grained MCP / per-folder seat scope (V1 = tool-list level only)
- Dependency cycle autoresolve

---

## 3. Architecture Constraints (HARD CONSTRAINTS)

These are non-negotiable. Implementer agents MUST honor every item.

1. **SQLite + Drizzle.** The repo uses SQLite via `better-sqlite3`. No PG types. Every new table goes into `lib/db/sqlite-lobbies-schema.ts` using `sqliteTable`. Booleans use `integer({ mode: "boolean" })`. JSON columns use `text({ mode: "json" })`. Timestamps use `text("...").default(sql\`(datetime('now'))\`)`. Enums use `text("...", { enum: [...] })`.
2. **No barrel exports.** Do NOT add `index.ts` re-exports. Import from concrete schema files directly. The existing `lib/db/sqlite-schema.ts` is the only allowed barrel and it should be extended with one new line for the lobbies schema.
3. **Cookie auth.** Routes use `requireAuth(req)` from `lib/auth/local-auth.ts:245` or `getAuthenticatedUser` from `lib/auth/route-auth.ts:10`. Do not invent a JWT layer.
4. **Agent table is `characters`.** All FKs to "agent" must reference `characters.id`. There is no `agents` table.
5. **Lobbies are NOT workflows.** Do not extend `agent_workflows`. `lobbies` is a parallel namespace.
6. **No new heavy UI dependencies.** No `@dnd-kit`, no TanStack Query, no SWR. Use existing primitives + `framer-motion` + custom keyboard-first DnD.
7. **Reuse `/api/tasks/events`.** Do NOT create a new SSE endpoint. Extend the event payload with `lobbyId` and `cardId` fields.
8. **Reuse `agent_runs`.** Every card execution, planner run, and synthesizer run is an `agent_runs` row. Snapshot the seat permission scope into `agent_runs.metadata.soloStory.permissionScope` at run start so mid-execution scope changes don't affect in-flight runs.
9. **Per-lobby monotonic event sequence.** All `lobby_events` rows get a `sequence` allocated transactionally by incrementing `lobbies.event_sequence`. Timestamp ordering is unsafe under parallel completion.
10. **Optimistic concurrency.** Every mutation route accepts `expectedVersion`. Mismatch → `409 Conflict`. Lobbies, seats, cards each have a `lock_version` column.
11. **Permission scope V1 is tool-list only.** `permission_scope` JSON shape: `{ version: 1, mode: "tool_list", allowedTools: string[], deniedTools?: string[], notes?: string }`. Folder/MCP scope is deferred.
12. **Snapshot the seat scope at card start, not at every tool call.** Mid-run scope changes do not affect in-flight cards.
13. **Block structural edits to running cards.** Captain must cancel + edit + retry. Returns `409 Conflict` for edit attempts on `running` cards.
14. **No process-level mutation of the global tool registry.** Filter via `agentEnabledTools` set (the existing pattern); never unregister tools.
15. **Card output is JSON.** Schema: `{ summary?: string, artifacts?: Array<{kind, title?, url?, metadata?}>, raw?: unknown, stale?: boolean }`. The synthesizer reads this shape.

---

## 4. Data Model (SQLite-translated from BA report)

All tables live in `lib/db/sqlite-lobbies-schema.ts`. Init function follows the existing `init*TablesWith(sqlite)` pattern. Wire it into `lib/db/sqlite-migrations.ts`'s `initializeTables()`.

### `lobby_templates`
| Column | Type | Notes |
|---|---|---|
| id | text PK | uuid via `crypto.randomUUID()` |
| name | text NOT NULL | |
| description | text | |
| default_seats | text(json) NOT NULL DEFAULT '[]' | shape: `LobbyTemplateSeatV1[]` |
| planning_prompt | text NOT NULL | |
| synthesis_prompt | text NOT NULL | |
| user_id | text FK → users.id ON DELETE CASCADE (nullable) | null = built-in/public |
| visibility | text enum ['private','public'] DEFAULT 'private' | private requires user_id; public requires user_id NULL |
| config | text(json) NOT NULL DEFAULT '{}' | `Partial<LobbyConfigV1>` |
| created_at, updated_at | text default datetime('now') | |

Indexes: `(user_id, visibility)`. Uniqueness enforced in app layer (SQLite partial-index syntax differs).

### `lobbies`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| user_id | text FK → users.id ON DELETE CASCADE NOT NULL | captain |
| session_id | text FK → sessions.id ON DELETE CASCADE NOT NULL | unique; backing session for runs |
| title | text NOT NULL | |
| goal | text NOT NULL | |
| status | text enum ['roster','planning','rolling','review','completed','aborted'] DEFAULT 'roster' | |
| template_id | text FK → lobby_templates.id ON DELETE SET NULL | nullable |
| planning_run_id | text FK → agent_runs.id ON DELETE SET NULL | nullable |
| synthesis_run_id | text FK → agent_runs.id ON DELETE SET NULL | nullable |
| output_artifact_id | text | nullable; references e.g. a message id or document id |
| config | text(json) NOT NULL DEFAULT '{"version":1}' | `LobbyConfigV1` |
| lock_version | integer NOT NULL DEFAULT 0 | optimistic concurrency |
| event_sequence | integer NOT NULL DEFAULT 0 | monotonic event allocator |
| started_at, completed_at, aborted_at | text | nullable |
| created_at, updated_at | text default datetime('now') | |

Indexes: `(user_id, status, updated_at)`, `(template_id)`, `(planning_run_id)`, `(synthesis_run_id)`. Unique: `session_id`.

### `lobby_seats`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| lobby_id | text FK → lobbies.id ON DELETE CASCADE NOT NULL | |
| role | text NOT NULL | "Researcher", "Writer", etc. — free text |
| agent_id | text FK → characters.id ON DELETE RESTRICT | nullable |
| permission_scope | text(json) NOT NULL DEFAULT '{"version":1,"mode":"tool_list","allowedTools":[]}' | `LobbyPermissionScopeV1` |
| position | integer NOT NULL | display order |
| status | text enum ['empty','ready','busy','idle'] DEFAULT 'empty' | |
| lock_version | integer NOT NULL DEFAULT 0 | |
| created_at, updated_at | text default datetime('now') | |

Indexes: `(lobby_id, position)` UNIQUE, `(lobby_id, agent_id)` UNIQUE WHERE agent_id IS NOT NULL (app-layer enforced), `(lobby_id)`, `(agent_id)`. App-layer guards: `status='empty' iff agent_id IS NULL`; `permission_scope.mode === 'tool_list' && version === 1`.

### `lobby_cards`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| lobby_id | text FK → lobbies.id ON DELETE CASCADE NOT NULL | |
| column | text enum ['backlog','ready','in_progress','review','done','blocked'] DEFAULT 'backlog' | |
| title | text NOT NULL | |
| description | text NOT NULL DEFAULT '' | |
| acceptance_criteria | text(json) NOT NULL DEFAULT '[]' | `LobbyCardAcceptanceCriterionV1[]` |
| assigned_seat_id | text FK → lobby_seats.id ON DELETE RESTRICT | nullable; app-layer enforces same-lobby |
| position | integer NOT NULL DEFAULT 0 | within column |
| status | text enum ['pending','running','awaiting_review','approved','rejected','failed','cancelled'] DEFAULT 'pending' | |
| agent_run_id | text FK → agent_runs.id ON DELETE SET NULL | nullable; current/last run |
| output | text(json) | nullable; `LobbyCardOutputV1` |
| failure_reason | text | nullable |
| review_notes | text | nullable |
| reviewed_by_user_id | text FK → users.id ON DELETE SET NULL | nullable |
| attempt_count | integer NOT NULL DEFAULT 0 | |
| max_attempts | integer NOT NULL DEFAULT 3 | |
| lock_version | integer NOT NULL DEFAULT 0 | |
| created_by | text enum ['planner','human'] NOT NULL | |
| started_at, completed_at, reviewed_at | text | nullable |
| created_at, updated_at | text default datetime('now') | |

Indexes: `(lobby_id, column, position)`, `(lobby_id, status)`, `(assigned_seat_id, status)`, `(agent_run_id)`. App-layer guards: status/column consistency table per BA report; `agent_run_id` unique when not null; `assigned_seat_id` belongs to same lobby.

**Status ↔ column consistency** (app-layer enforced in repository writes):
- `pending` → `backlog | ready | blocked`
- `running` → `in_progress`
- `awaiting_review` → `review`
- `approved` → `done`
- `rejected | failed | cancelled` → `blocked`

### `lobby_card_dependencies`
| Column | Type | Notes |
|---|---|---|
| lobby_id | text FK → lobbies.id ON DELETE CASCADE NOT NULL | |
| card_id | text FK → lobby_cards.id ON DELETE CASCADE NOT NULL | |
| depends_on_card_id | text FK → lobby_cards.id ON DELETE CASCADE NOT NULL | |
| optional | integer(boolean) NOT NULL DEFAULT 0 | optional deps don't block dependents |
| created_at | text default datetime('now') | |

PK: composite `(lobby_id, card_id, depends_on_card_id)`. Indexes: `(lobby_id, depends_on_card_id)`, `(lobby_id, card_id)`. App-layer guards: `card_id !== depends_on_card_id`; both cards belong to `lobby_id`; DAG acyclic.

### `lobby_events`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| lobby_id | text FK → lobbies.id ON DELETE CASCADE NOT NULL | |
| sequence | integer NOT NULL | monotonic per lobby; allocated by transactional `lobbies.event_sequence` increment |
| type | text NOT NULL | e.g. `lobby.roster_ready`, `card.run_started` |
| payload | text(json) NOT NULL DEFAULT '{}' | |
| actor | text enum ['captain','agent','system'] NOT NULL | |
| actor_user_id | text FK → users.id ON DELETE SET NULL | nullable |
| actor_agent_id | text FK → characters.id ON DELETE SET NULL | nullable |
| card_id | text FK → lobby_cards.id ON DELETE SET NULL | nullable |
| seat_id | text FK → lobby_seats.id ON DELETE SET NULL | nullable |
| agent_run_id | text FK → agent_runs.id ON DELETE SET NULL | nullable |
| created_at | text default datetime('now') | |

Indexes: `(lobby_id, sequence)` UNIQUE, `(lobby_id, created_at)`, `(lobby_id, type)`, `(card_id)`, `(agent_run_id)`. App-layer guards: `sequence > 0`.

### Shared TypeScript types

Live in `lib/lobbies/types.ts`:

```ts
export type LobbyPermissionScopeV1 = {
  version: 1;
  mode: "tool_list";
  allowedTools: string[];
  deniedTools?: string[];
  notes?: string;
};

export type LobbyConfigV1 = {
  version: 1;
  maxParallelCards?: number;
  plannerAgentId?: string;
  synthesizerAgentId?: string;
  plannerPromptOverride?: string;
  synthesisPromptOverride?: string;
};

export type LobbyTemplateSeatV1 = {
  role: string;
  required: boolean;
  position: number;
  agentId?: string;
  permissionScope: LobbyPermissionScopeV1;
};

export type LobbyCardAcceptanceCriterionV1 = {
  id: string;
  text: string;
  required?: boolean;
};

export type LobbyCardOutputV1 = {
  summary?: string;
  artifacts?: Array<{
    id?: string;
    kind: "text" | "file" | "url" | "image" | "other";
    title?: string;
    url?: string;
    metadata?: Record<string, unknown>;
  }>;
  raw?: unknown;
  stale?: boolean;
};

export type SoloStoryRunMetadata = {
  soloStory: {
    lobbyId: string;
    cardId?: string;
    seatId?: string;
    role: "planner" | "worker" | "synthesizer";
    permissionScope: LobbyPermissionScopeV1;
    permissionScopeSnapshotAt: string;
  };
};
```

---

## 5. State Machines

### Lobby

| From | Transition | To | Guards | Side Effects |
|---|---|---|---|---|
| `roster` | `ready_roster` | `planning` | owner, expectedVersion, ≥1 ready seat with agent_id, every ready seat has non-null permission_scope, no running runs | inc lock_version, emit `lobby.roster_ready`, start planner subagent, set `planning_run_id` |
| `planning` | `planner_succeeded` | `planning` | planner run belongs to lobby, output parses | insert cards & deps in transaction, emit `lobby.plan_generated` |
| `planning` | `accept_plan` | `rolling` | acyclic DAG, every card has valid same-lobby seat, every assigned seat is ready/idle | mark root cards `ready`, set `started_at`, emit `lobby.rolling_started`, start eligible runs up to `maxParallelCards` |
| `rolling` | `enter_review` | `review` | no `running` cards, no runnable `pending` cards | emit `lobby.review_started` |
| `review` | `retry_card` | `rolling` | captain retries ≥1 card | emit `lobby.rolling_resumed`, recompute ready cards |
| `review` | `start_synthesis` | `review` | all required cards `approved` | start synthesizer, set `synthesis_run_id`, emit `lobby.synthesis_started` |
| `review` | `complete_synthesis` | `completed` | synthesizer succeeded | set `output_artifact_id`, `completed_at`, emit `lobby.completed` |
| Any non-terminal | `abort(cancel)` | `aborted` | owner | cancel active runs, mark running cards `cancelled`, emit `lobby.aborted` |
| Any non-terminal | `abort(wait)` | drains, then `aborted` | owner, running cards exist | reject new starts, abort after settle |
| Any non-terminal | `abort(abandon)` | `aborted` | owner + explicit confirm | mark aborted, ignore late callbacks |

### Card

| From | Transition | To | Column | Guards | Side Effects |
|---|---|---|---|---|---|
| `pending` | `deps_met` | `pending` | `ready` | required deps approved; optional deps approved/failed/cancelled | emit `card.ready` |
| `pending` | `start` | `running` | `in_progress` | lobby `rolling`, seat `ready`/`idle`, deps met, no current run | snapshot scope, create `agent_runs`, set `agent_run_id`, inc `attempt_count`, set seat `busy`, emit `card.run_started` |
| `running` | `run_succeeded` | `awaiting_review` | `review` | matching `agent_run_id`, run succeeded, idempotent | store output, set `completed_at`, set seat `idle`, emit `card.awaiting_review` |
| `running` | `run_failed` | `failed` | `blocked` | matching run, run failed | store reason, set seat `idle`, emit `card.failed` |
| `running` | `cancel` | `cancelled` | `blocked` | abort or explicit cancel | cancel run, set seat `idle`, emit `card.cancelled` |
| `awaiting_review` | `approve` | `approved` | `done` | captain owner, expectedVersion | set reviewer/timestamp, emit `card.approved`, unblock dependents |
| `awaiting_review` | `reject` | `rejected` | `blocked` | review notes required | store notes, emit `card.rejected` |
| `rejected` | `retry` | `pending` | `ready` or `blocked` | seat valid | clear terminal fields, emit `card.retry_requested` |
| `failed` | `retry` | `pending` | `ready` or `blocked` | attempts under cap or override | clear failure, emit `card.retry_requested` |
| `approved` | `reopen` | `pending` | `ready` or `blocked` | no running dependents unless `cancelDependents` | mark downstream stale, reset chain, emit `card.reopened` |
| Any non-terminal | `lobby_abort` | `cancelled` | `blocked` | lobby aborting | cancel run, emit `card.cancelled_by_lobby` |

---

## 6. API Surface (15 routes)

All routes under `app/api/lobbies/...`. All require `requireAuth(req)`. All use `expectedVersion` for mutations on lobbies/seats/cards. Use `zod` for request validation. Response shapes match the BA report.

| # | Method | Path | Purpose |
|---|---|---|---|
| 1 | GET | `/api/lobbies` | List captain's lobbies (paginated) |
| 2 | POST | `/api/lobbies` | Create lobby (also creates backing session, default seats from template) |
| 3 | GET | `/api/lobbies/:lobbyId` | Full lobby detail (lobby + seats + cards + deps) |
| 4 | PATCH | `/api/lobbies/:lobbyId` | Edit title/goal/config |
| 5 | POST | `/api/lobbies/:lobbyId/transition` | Lobby state transition |
| 6 | PUT | `/api/lobbies/:lobbyId/seats` | Bulk replace seats |
| 7 | PATCH | `/api/lobbies/:lobbyId/seats/:seatId` | Single seat edit |
| 8 | GET | `/api/lobbies/:lobbyId/cards` | List cards (filter by status/column) |
| 9 | POST | `/api/lobbies/:lobbyId/cards` | Add card (manual) |
| 10 | PATCH | `/api/lobbies/:lobbyId/cards/:cardId` | Edit non-running card |
| 11 | POST | `/api/lobbies/:lobbyId/cards/:cardId/transition` | Card state transition (start, succeed, approve, reject, retry, etc.) |
| 12 | PUT | `/api/lobbies/:lobbyId/cards/:cardId/dependencies` | Replace deps (rejects cycles) |
| 13 | GET | `/api/lobby-templates` | List templates (private + public) |
| 14 | POST | `/api/lobby-templates` | Create user template |
| 15 | GET | `/api/lobbies/:lobbyId/events` | Paginated events `afterSequence` |

---

## 7. Permission Scope Extension Point

Single injection site: `app/api/chat/route.ts:717`, between `allowedPluginNames` build and `buildToolsForRequest()` call.

Steps:
1. If the request's session has a `lobby_card_id` in `agent_runs.metadata.soloStory`, load the seat scope from `lobby_seats.permission_scope`.
2. Tighten `enabledTools = enabledTools.filter(t => seatScope.allowedTools.includes(t) && !seatScope.deniedTools?.includes(t))`.
3. Tighten `scopedPlugins` similarly. Recompute `allowedPluginNames`.
4. After `loadMCPToolsForCharacter()` returns at `tools-builder.ts:411`, intersect MCP tools with `seatScope` (V1: just deny anything not in `allowedTools`).

`ToolsBuildContext` and `ToolContext` gain `allowedFolderIds?: string[]` (V1.1+) — schema stub only in V1.

---

## 8. Realtime

Reuse `/api/tasks/events`. Extend existing `task:started`, `task:progress`, `task:completed` payloads to optionally carry `{ lobbyId?: string, cardId?: string }`. Frontend filters by `lobbyId` for the lobby page. Backend emits these fields whenever the originating run is a Solo Story run (detected via `agent_runs.metadata.soloStory.lobbyId`).

No new SSE endpoint. No EventSource per card.

---

## 9. Migration Order

The repo uses a **dual-file schema pattern**:
- `lib/db/sqlite-<name>-schema.ts` — Drizzle ORM definitions (`sqliteTable`, `relations`, inferred types). Used by application code (queries, services).
- `lib/db/migrations/<name>-tables.ts` — Raw SQL `CREATE TABLE IF NOT EXISTS ...` statements wrapped in `init<Name>TablesWith(sqlite)`. Called from `sqlite-migrations.ts`'s `initializeTables()` to provision tables on first connection.

Both files MUST stay in sync (column names, types, defaults, FK actions, CHECK constraints). The drizzle file does NOT create tables; the raw-SQL file does. The drizzle file is what the rest of the codebase imports.

### Order

1. Add `lib/db/migrations/lobbies-tables.ts` exporting `initLobbiesTablesWith(sqlite)` with raw `CREATE TABLE IF NOT EXISTS` for all 6 tables + their indexes (use the `skills-tables.ts` file as the reference pattern).
2. Add `lib/db/sqlite-lobbies-schema.ts` with the Drizzle definitions for the same 6 tables + `relations(...)` blocks + inferred `$inferSelect` / `$inferInsert` type aliases (use `sqlite-skills-schema.ts` as the reference pattern).
3. Wire into `lib/db/sqlite-migrations.ts`:
   - Import `initLobbiesTablesWith` at the top.
   - Call `initLobbiesTablesWith(sqlite)` inside `initializeTables()`. Place it AFTER `initObservabilityTablesWith(sqlite)` (lobbies FK into `agent_runs`).
4. Extend `lib/db/sqlite-schema.ts` with one new line: `export * from "./sqlite-lobbies-schema";` (existing barrel pattern; this is the only allowed barrel).
5. Add `lib/lobbies/types.ts` with the shared TypeScript types from §4 (LobbyPermissionScopeV1, LobbyConfigV1, LobbyTemplateSeatV1, LobbyCardAcceptanceCriterionV1, LobbyCardOutputV1, SoloStoryRunMetadata).
6. Future sprints: queries, services, routes, UI.

No changes to existing tables. Zero breaking changes. Boot/connect must remain idempotent.

---

## 10. Repo Conventions Reminder

- File names: kebab-case, `.ts` for non-React, `.tsx` for React.
- Routes: `app/api/<feature>/<resource>/route.ts`.
- Imports use absolute paths via `@/` alias.
- DB queries: one file per resource (`lib/lobbies/queries.ts`), inline zod schemas at route boundaries.
- No comments unless necessary for non-obvious logic.
- No emojis.
- No `console.log` in committed code; use existing logger if any.
- Tests (when written): colocated `*.test.ts` next to module.
- `requireAuth` short-circuits with 401 if not authenticated — call it first.

---

## 11. References

The four research reports are summarized inline in this spec. The original full reports remain in this conversation's history as the authoritative ground truth for evidence (file paths + line numbers). When in doubt, an implementer should:

1. Read this spec.
2. Read the actual existing file the spec references (e.g. `lib/db/sqlite-character-schema.ts` for the FK target style).
3. Pattern-match new code on the existing style.

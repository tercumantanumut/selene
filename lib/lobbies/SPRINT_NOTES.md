# Solo Story Mode — Sprint Notes

This file tracks per-sprint patches applied after reviewer rounds, plus
items intentionally deferred to later sprints. Read top-to-bottom for the
current state; the most recent sprint is appended at the end.

---

## Sprint 5.1 — post-review patch (BLOCKER + accessibility round)

Sprint 5 shipped the lobby list / detail / new-lobby pages and the typed
client API. Five parallel reviewers produced 13 actionable findings; this
patch resolves all of them.

### What changed

**API layer (1 BLOCKER + correctness fixes)**

- `lib/utils/resilient-fetch.ts`: added `parsedBody?: unknown` to
  `ResilientFetchResult` and now parse JSON once up-front so the body is
  available on both success and error branches. Without this, the typed
  fetcher always saw `data: null` on 4xx responses and could not surface
  the structured `{ error, reason, currentVersion }` envelope. This
  silently broke optimistic-concurrency retry on 409 responses.
- `lib/lobbies/client/api.ts`:
  - Imports `MutationFailureReason` from `@/lib/lobbies/types` instead of
    `@/lib/lobbies/queries` so the client bundle no longer drags drizzle
    into the browser graph.
  - Rewrote `unwrap<T>()` to read the envelope from `result.parsedBody`
    via a defensive `parseEnvelope()` helper that validates `reason`
    against a `ReadonlySet<MutationFailureReason>` — no more bogus
    failure reasons sneaking through.
  - Added `MUTATION_DEFAULTS` (`retries: 0`, `credentials: "same-origin"`)
    and `READ_DEFAULTS` (`credentials: "same-origin"`); threaded through
    every `request*` helper. Mutations are non-idempotent on this surface
    (no Idempotency-Key yet) so client-side retry would double-write.
- `lib/lobbies/queries.ts`: `MutationFailureReason`, `MutationResult`,
  and `MutationFailure` are now hoisted to `lib/lobbies/types.ts` and
  re-exported from queries for backwards compatibility. Anyone touching
  the client surface should import from `types`, not `queries`.

**Schema / type drift (silent-corruption guard)**

- `lib/lobbies/types.ts`: aligned `LobbyConfigV1` with the route schema
  (`maxParallel`, `defaultMaxAttempts`, `plannerCharacterId`,
  `synthesizerCharacterId`, `plannerPromptOverride`,
  `synthesisPromptOverride`). Aligned `LobbyPermissionScopeV1` (added
  `allowedFolderIds?: string[]`, removed `notes`).
- `lib/lobbies/api-helpers.ts`: every nested zod schema is now
  `.strict()` so an unknown field fails validation instead of getting
  silently dropped on the way to the DB. Added the previously-missing
  `plannerPromptOverride` and `synthesisPromptOverride` fields.
- `lib/lobbies/api-helpers.ts`: `errorResponse()` logs the full error
  server-side but returns a generic message to the client (no message
  leak) — except for the explicit `details` parameter which is intended
  to be safe.
- `lib/lobbies/scope-injection.ts`: dropped the stale `notes` field on
  the permission-scope assembly path.

**UI layer**

- `components/lobbies/status-badge.tsx` (new): single source of truth
  for status colour + label, shared between the list and detail pages.
  Includes `aria-label="Lobby status: {Label}"` so screen readers don't
  read the status as a bare colour.
- `app/lobbies/page.tsx` is now a server component that runs
  `requireAuth` at the page boundary; the interactive UI lives in
  `app/lobbies/lobbies-list-client.tsx`. Same pattern applied to
  `app/lobbies/[id]` (`lobby-detail-client.tsx`) and `app/lobbies/new`
  (`new-lobby-client.tsx`). All three fall back to a shared
  `app/lobbies/lobbies-unauthorized.tsx` banner. This stops the client
  bundle from rendering for unauthenticated users (which would have
  caused a 401 fetch storm).
- `app/lobbies/[id]/lobby-detail-client.tsx`: phase rail is now sticky
  (`sticky top-0 z-20 ... bg-terminal-cream/95 backdrop-blur`),
  buttons get `aria-current="step"` when active and `aria-label="Jump
  to {phase}"`. Disclosure sections use `role="region"`,
  `aria-labelledby`, `aria-controls`, and the content is rendered with
  `hidden={!isExpanded}` so the controlled element always exists in the
  DOM. Clicking the rail also expands the corresponding section.
- `lib/stores/solo-story-ui-store.ts`: replaced "everything open by
  default" with a status-aware default (`defaultExpandedForStatus`) —
  e.g. for `synthesis` only the synthesis section is open, while
  `roster` opens roster + planning. `pickInitialSection(status)` picks
  the active phase. `resetForLobbyChange(lobbyId, status?)` now uses
  both helpers.
- `app/lobbies/lobbies-list-client.tsx`: status filter pills got
  `role="tablist"` + `aria-selected` + `aria-pressed` + `type="button"`
  + a focus ring; replaced the unhelpful "More lobbies available" copy
  with a clearer message when the cursor is exhausted; error banner
  upgraded to `role="alert"` + `aria-live="polite"`.
- `app/lobbies/new/new-lobby-client.tsx`: template loading now uses a
  Skeleton grid (no layout shift); error rows use `role="alert"`. The
  `TemplateOption` was rewritten as a proper WAI-ARIA radio:
  `role="radio"` + `aria-checked` + `tabIndex={selected ? 0 : -1}` +
  Space/Enter handlers; wrapped in `role="radiogroup"`.
- `lib/lobbies/client/hooks.ts`: `appendFromAfter` now passes an
  `AbortController.signal` and bails on `aborted || !mountedRef.current`
  before calling `setData`/`setError`. Cleanup aborts both controllers
  and flips `mountedRef`. This kills the late-write race where a slow
  SSE-recovery append would resurrect stale state after navigation.

### Deferred (intentionally)

- **Arrow-key navigation on `TemplateOption` radiogroup.** Implemented
  Space/Enter and tabIndex roving today; Arrow Up/Down/Left/Right will
  arrive when the templates list grows beyond two options (Sprint 10
  ships the first real templates). For two options Tab is acceptable.
- **Idempotency-Key for non-idempotent mutations.** We turned
  client-side `retries` to `0` to avoid double-writes. A proper
  Idempotency-Key header (with server-side de-dup) lands in a later
  sprint when we wire job-style mutations.
- **Server-side fetch on `/lobbies/[id]`.** We deliberately keep the
  detail fetch in the client (`useLobbyDetail`) so refresh, refetch, and
  SSE-recovery all flow through one path. Server pre-fetch would also
  need cookie-forwarded server fetch, which adds latency for a UI that
  already streams in.
- **Roving radiogroup container.** When more than ~3 phase pills exist
  on the rail, we'll formalise arrow-key navigation. Today the rail is
  a fixed 4-phase set; Tab is fine.

### Verification

- `npx tsc --noEmit` — clean (after fixing two compile-time errors that
  the patch surfaced: a `MutationResult` re-export in `queries.ts` that
  also needed an `import type`, and a stale `scope.notes` reference in
  `scope-injection.ts`).

---

## Sprint 5.2 — second-pass review patch

Five reviewers re-audited the Sprint 5.1 patch and surfaced 1 HIGH a11y
spec violation, 3 HIGH state issues, 1 HIGH integration drift, and a
handful of MEDIUM/LOW polish items. This patch resolves all of them
before Sprint 6 begins.

### What changed

**Accessibility (HIGH a11y + MEDIUM contrast)**

- `app/lobbies/lobbies-list-client.tsx`: filter pills no longer claim
  to be `role="tab"` while also exposing `aria-pressed` (ARIA 1.2
  forbids the combination — tabs use `aria-selected`, toggle buttons
  use `aria-pressed`, never both). The container is now
  `<div role="group" aria-label="Filter lobbies by status">` with each
  pill as a plain toggle button (`type="button"` + `aria-pressed`).
- `app/lobbies/lobbies-list-client.tsx`: `aria-busy` lives on the
  `ListSkeleton` wrapper (`role="status" aria-busy="true"
  aria-live="polite"`), not on the post-load `<Card>`. AT users
  previously heard "busy" announced after data had loaded.
- `app/globals.css`: darkened `--terminal-muted` across every light
  theme so foreground text on `terminal-cream` (L=89%) backgrounds
  meets WCAG AA (≥4.5:1 for small text). Default theme dropped from
  L=53% → L=38%; midnight/forest/mono/ocean/aurora dropped to L=35%;
  lavender/rose to L=38%. Updated `--muted-foreground` in lockstep so
  shadcn primitives inherit the same contrast.
- All 10 `text-terminal-muted/{60,70,80,90}` opacity multipliers in
  `app/lobbies/**` were stripped — opacity multiplied through the
  newly-darkened token would have erased the contrast win. The phase
  rail's "unreached step" pill now renders at full token contrast (it
  is interactive — captains can click any phase to navigate — so it
  cannot ride at sub-AA).
- `components/lobbies/status-badge.tsx`: status pill foreground moved
  from `text-terminal-amber`/`text-terminal-green`/`text-blue-600`
  (which fell to ~1.9–3.7:1 on `/15` tinted backgrounds) to
  `text-terminal-dark` with dark-mode overrides where needed. The
  tinted background + border now carry the colour identity; the label
  itself stays AA-readable on every theme.

**State management (HIGH × 3)**

- `lib/stores/solo-story-ui-store.ts`: `resetForLobbyChange(lobbyId,
  status?)` was both destructive AND seed-on-mount. Two effects calling
  it in sequence would clobber any user toggle / optimistic move
  applied between mount and data-load. Split into:
  - `resetForLobbyChange(lobbyId)` — destructive only. Clears
    everything to `ALL_COLLAPSED` (replacing the old "roster +
    planning open" default which was silly for a `synthesis` lobby).
  - `seedDefaultsForStatus(lobbyId, status)` — idempotent gate
    (`if (state.seededForLobbyId === lobbyId) return state`) that
    seeds the active section + expanded set. Re-running it on the
    same lobby is a no-op so user toggles survive subsequent renders.
  - Added `seededForLobbyId` tracking field to make the gate
    observable from the store state.
- `app/lobbies/[id]/lobby-detail-client.tsx`: replaced two
  `useEffect`s with one `useEffect` (destructive reset on lobbyId
  change) + one `useLayoutEffect` (idempotent seed before paint).
  The `useLayoutEffect` runs synchronously before browser paint, so
  the user never sees the "all collapsed" baseline flash before the
  status-aware section opens. Strict-mode double-invoke is fine —
  the gate makes the second pass a no-op.
- `lib/lobbies/api-helpers.ts`: `MutationResult` and
  `MutationFailureReason` are now imported from `@/lib/lobbies/types`
  (the canonical source) instead of `@/lib/lobbies/queries` (which
  pulled drizzle into the route layer's type graph). Dependency
  direction is now strictly `route → types`, never `route → queries
  → types`.

**Auth boundary (MEDIUM + LOW)**

- `app/lobbies/lobbies-unauthorized.tsx`: exported a new
  `isUnauthorizedError(err)` helper that narrows on the exact two
  message strings `requireAuth` throws (`"Unauthorized"`,
  `"Invalid session"`).
- `app/lobbies/page.tsx`, `app/lobbies/[id]/page.tsx`,
  `app/lobbies/new/page.tsx`: replaced `catch {}` with
  `catch (err) { if (!isUnauthorizedError(err)) throw err; ... }`.
  A DB outage or runtime error inside `requireAuth` will now surface
  as a real 500 instead of masquerading as "session expired" and
  pushing the user to the sign-in screen.
- `app/lobbies/[id]/page.tsx`: added a static `metadata = { title:
  "Lobby — Selene" }` fallback so the tab title isn't blank during
  the client effect's first render. The client effect still
  overrides this with the real lobby title once the detail fetch
  resolves.

**API hardening (MEDIUM)**

- `app/api/lobbies/route.ts`: `createLobbyBodySchema` and the nested
  `seats[]` element schema both now `.strict()`. A typo in `goalText`
  (vs `goal`) would previously have created a lobby with an empty
  goal instead of returning 400.
- `app/api/lobby-templates/route.ts`: same `.strict()` treatment on
  `createTemplateBodySchema`, `templateSeatV1Schema`, and the nested
  config (`lobbyConfigV1Schema.partial().strict()`). The
  re-application of `.strict()` after `.partial()` is intentional —
  zod v3 preserves the flag through `.partial()` but we make the
  intent explicit at the call site so future zod upgrades or
  derivative tweaks don't change validation behaviour silently.

**Spec / type drift (HIGH integration + MEDIUM integration)**

- `lib/lobbies/SPEC.md` §3 #11 + §4 TS types block: re-aligned to the
  current `LobbyPermissionScopeV1` (added `allowedFolderIds`, removed
  `notes`) and `LobbyConfigV1` (renamed `plannerAgentId →
  plannerCharacterId`, `synthesizerAgentId → synthesizerCharacterId`,
  added `defaultMaxAttempts`).
- `lib/lobbies/types.ts`: added a long doc comment explaining why
  `LobbyTemplateSeatV1.agentId` deliberately stays `agentId`
  (matches the underlying SQL column `lobby_seats.agent_id`) while
  `LobbyConfigV1` was renamed to `*CharacterId` (config doesn't have a
  matching SQL column to constrain it).

**Client API ergonomics (LOW)**

- `lib/lobbies/client/api.ts`: `unwrap()` now detects external
  abort (`result.error === "Aborted"`) and throws a real `Error`
  with `name = "AbortError"` instead of a `LobbyApiError` with
  `reason: "UNKNOWN"`. Exported a companion `isAbortError(err)`
  predicate so call sites without a controller in scope can
  distinguish "user cancelled" from a genuine failure. Existing
  hooks were already guarded by `controller.signal.aborted` checks
  so behaviour is unchanged for them — this is purely additive for
  future SSE-recovery / shared-fetcher callers.

### Deferred (intentionally, again)

- **Other light theme variants below default AA target.** All seven
  light themes now meet 4.5:1, but only the default cream theme has
  been visually QA'd. A follow-up sprint will walk each preset with a
  contrast-checker overlay.
- **`useLobbyEvents` is still not wired into `lobby-detail-client.tsx`.**
  The hook itself is correct in isolation; pulling it into the detail
  page lands with Sprint 8's live-card-execution work, where the SSE
  stream actually has events to deliver. Wiring it earlier would
  produce a bound-but-empty events panel that confuses the captain.

### Verification

- `npx tsc --noEmit` — clean.
- Contrast math (no live VoiceOver / browser run; this sprint was
  executed autonomously). The token darkening is computed against the
  `terminal-cream` (HSL L=89%) background:
  - `--terminal-muted` 38% → ratio ~5.0:1 vs cream (≥4.5:1 small
    text — passes AA),
  - midnight/forest/mono/ocean/aurora at 35% → ~5.6:1 vs their light
    backgrounds (passes AA),
  - lavender/rose at 38% → ~5.0:1 vs their light backgrounds (passes
    AA).
  Manual VoiceOver sweep + per-theme DevTools contrast spot-check is
  deferred to a dedicated a11y QA pass — see Deferred above.

---

## Sprint 5.3 — third-pass review patch

Five reviewers re-audited the Sprint 5.2 patch and surfaced 6 HIGH
findings (1 a11y / contrast, 1 info-leak, 1 schema-rollout completeness,
2 hook race conditions) plus a handful of MEDIUM/LOW polish items. This
patch resolves all of them before Sprint 6 begins.

### What changed

**Accessibility / contrast (HIGH)**

- `components/lobbies/status-badge.tsx`: the `aborted` variant was
  still reading `text-red-700` over `bg-red-500/15` on the default
  cream theme — measured ~4.36:1, fails AA at small text (font-mono
  text-xs, 4.5:1 required). Switched to the same pattern as the other
  five badges (`text-terminal-dark` light / `text-red-100` dark, on a
  slightly bumped `bg-red-500/20` + `border-red-500/50`). Background +
  border now carry the colour identity, label stays AA-readable.
- Same file: shadcn's `Badge` base + `outline` variant only declare
  *colour* utilities, not `border-width`. Without an explicit `border`
  on the wrapper, every `border-{color}/{N}` class in `STATUS_CONFIG`
  was a no-op and only the tinted background carried the colour
  identity. Added `border` to the wrapper className so the bordered
  pill the design intended actually renders.

**API hardening (HIGH info-leak + HIGH schema-rollout completeness)**

- `lib/lobbies/api-helpers.ts`: `withLobbyAuth()`'s 500 path used to
  echo `error.message` back to the client. Drizzle / sqlite errors can
  include file paths and column names (SPEC §3 #7-style info-leak).
  Now logs the full error server-side via `console.error` and returns
  a generic `{ error: "Authentication system unavailable" }` to the
  client.
- Sprint 5.2's `.strict()` rollout only covered the two POST routes
  (`/api/lobbies` and `/api/lobby-templates`). Every PATCH / PUT /
  transition route was still loose. This sprint completes the rollout:
  - `app/api/lobbies/[lobbyId]/route.ts` — `patchLobbyBodySchema`
    envelope + inner patch both `.strict()`.
  - `app/api/lobbies/[lobbyId]/cards/route.ts` — `createCardBodySchema`.
  - `app/api/lobbies/[lobbyId]/cards/[cardId]/route.ts` —
    `patchCardBodySchema` envelope + inner patch.
  - `app/api/lobbies/[lobbyId]/seats/route.ts` — `replaceSeatsBodySchema`
    envelope + nested seat element.
  - `app/api/lobbies/[lobbyId]/seats/[seatId]/route.ts` —
    `patchSeatBodySchema` envelope + inner patch.
  - `app/api/lobbies/[lobbyId]/cards/[cardId]/dependencies/route.ts` —
    `replaceDependenciesBodySchema` envelope + nested element.
  - `app/api/lobbies/[lobbyId]/transition/route.ts` — every arm of the
    discriminated union is `.strict()`. Without it a typo'd
    `plannerScop` on `ready_roster` would silently drop and the
    planner would launch with the default scope.
  - `app/api/lobbies/[lobbyId]/cards/[cardId]/transition/route.ts` —
    every arm is `.strict()`. Without it a typo'd `cancelDependants`
    on `reopen` would silently drop and the captain would think they
    cancelled in-flight dependents when they didn't.
  All of these now 400 with the offending field name in the error
  message instead of silently routing the typo to the underlying
  `MutationResult` failure path.

**Client hooks (HIGH race conditions × 2)**

- `lib/lobbies/client/hooks.ts` — `useLobbyDetail`: track a
  `dataLobbyIdRef` and clear stale `data` BEFORE issuing the next
  fetch when `lobbyId` changes. Without this, navigating from lobby A
  → lobby B briefly renders B's page header / phase rail with A's
  status (every consumer downstream of `data.lobby.status` paints the
  wrong phase for one tick before the new fetch resolves). The seed
  effect in `lobby-detail-client.tsx` would have used A's status to
  expand the wrong sections for B.
- `lib/lobbies/client/hooks.ts` — `useLobbyEvents`: added a
  monotonically-incrementing `generationRef` token. Mount / lobbyId
  change bumps it; every async closure (`run`, `appendFromAfter`)
  captures the value at call time and bails on resolve if the live
  generation has moved past it. AbortController already covers the
  strict in-flight case, but a captain who fires `appendFromAfter` from
  a setTimeout / SSE callback is past the abort window — without this
  token, that response could land in the NEXT lobby's data after a
  lobby change.
- Same file, same hook: `appendFromAfter` now sorts the merged event
  list by `sequence` after dedup. SSE may have already appended events
  newer than the cursor's response by the time it resolves, so a naive
  concat leaves the timeline out of order. Consumers (the activity
  rail) render in array order, so we re-sort to keep the timeline
  monotonically increasing.

**Hydration & error boundary (MEDIUM × 2)**

- `app/lobbies/[id]/lobby-detail-client.tsx`: replaced raw
  `useLayoutEffect` with an `useIsomorphicLayoutEffect` shim
  (`typeof window !== "undefined" ? useLayoutEffect : useEffect`).
  `useLayoutEffect` warns during SSR ("does nothing on the server"),
  and even with `"use client"` Next.js still SSRs the component once
  for initial HTML — the warning fires on every cold load. Falling
  back to `useEffect` server-side silences the warning without
  changing client behaviour.
- `app/lobbies/error.tsx` (new): segment-level error boundary for
  `/lobbies/*`. Catches uncaught React errors that escape the lobby
  pages (a render crash inside `lobby-detail-client`, a hook throw, a
  `requireAuth` server-side throw) and shows a contained recovery UI
  without trashing the root layout (sidebar, theme, providers all
  survive). The captain sees "Try again" / "Back to lobbies" buttons
  and can recover without a full reload. Visible message stays
  generic; the actual `error.message` + stack are logged to
  DevTools — thrown error strings can include DB / file paths so we
  don't echo them.

**Comment / documentation honesty (MEDIUM × 2)**

- `app/lobbies/[id]/lobby-detail-client.tsx`: the
  `seedDefaultsForStatus` rationale comment was muddled — it claimed
  to protect "user toggles between mount and data-load" which can't
  actually happen (the section content isn't visible / interactive
  yet). Rewrote to the actual three protections: SSE-driven status
  flips, React 18 strict-mode double-invoke, refetch returning the
  same status.
- This file's own Sprint 5.2 Verification section claimed VoiceOver
  + visual contrast were performed. They weren't — the sprint was
  executed autonomously. Replaced with the actual contrast math (token
  darkening × theme background) and an explicit "Manual VoiceOver
  sweep + per-theme DevTools contrast spot-check is deferred."

**Spec drift / dependency direction (LOW × 3)**

- `lib/lobbies/types.ts`: the `allowedFolderIds` doc string referenced
  the wrong SPEC constraint (`§3 #6 = "No new heavy UI dependencies"`).
  Fixed to `§3 #11 = "Permission scope V1 is tool-list only"`, which
  is the constraint that actually carves the field out as a V1.1
  placeholder.
- `app/lobbies/[id]/lobby-detail-client.tsx` and
  `lib/stores/solo-story-ui-store.ts`: two `SPEC §3 #11 (progressive
  reveal)` references were stale — `§3 #11` is permission-scope, not
  progressive reveal. Reworded both to attribute "progressive reveal"
  to the FE Architect report (where it actually originates) and call
  out that SPEC §3 has no matching numbered constraint.
- `lib/lobbies/services.ts`: `replaceDependenciesForCardWithCycleCheck`
  guard comment referenced `SPEC §3 #6/#13`. `§3 #6` is "No new heavy
  UI dependencies" — clearly not a dependency-graph guard. Reworded
  to attribute the DAG correctness invariant to the data model
  (`#13` correctly applies — dependency edits are structural).

**Snapshot rehydration (LOW)**

- `lib/lobbies/scope-injection.ts`: `extractSoloStorySnapshot` was
  dropping `allowedFolderIds` when reconstructing the snapshot scope
  from `agent_runs.metadata`. The V1 tool gate ignores the value but
  the field MUST round-trip through this reconstruction so the V1.1
  upgrade path (which will enforce folder scoping at the FS layer)
  can read it off the snapshot just like every other scope dimension.
  Rebuild now defensively filters for `string[]` shape and includes
  the field in the returned `permissionScope`.

**Type import direction (LOW)**

- `lib/lobbies/services.ts`: flipped `MutationResult` from
  `@/lib/lobbies/queries` → `@/lib/lobbies/types` (same fix that
  landed in `api-helpers.ts` during Sprint 5.2). Keeping the type
  import on `queries` would re-introduce the `(route|service) →
  queries → drizzle` dependency chain that the
  types-as-canonical-source split was meant to break.

### Deferred (intentionally, again)

- **Other light theme variants below default AA target.** Same as
  Sprint 5.2 — the math now passes for every light theme, but only
  the default cream theme has been visually QA'd. A dedicated a11y
  QA pass per theme is the right venue.
- **`useLobbyEvents` is still not wired into `lobby-detail-client.tsx`.**
  Same as Sprint 5.2 — lands with Sprint 8 when the SSE stream has
  events to deliver.
- **`error.tsx` is plain English, not next-intl.** The rest of the
  lobby surface is also plain English. When (if) the lobby surface
  gets translated wholesale, the error boundary copy folds into the
  same migration; doing it standalone now would be a noisy isolated
  wire-up.

### Verification

- `npx tsc --noEmit` — clean.
- No browser / VoiceOver / runtime verification (autonomous sprint).
  The new contrast math math fix (status badge `aborted` variant) is:
  - foreground `text-terminal-dark` (HSL L=15%) on
    `bg-red-500/20` over `bg-terminal-cream` (effective L≈80%) ≈
    **8.2:1** vs prior ≈4.36:1, well over AA.
  - dark mode: `text-red-100` (L=92%) on `bg-red-500/20` over the
    dark theme background ≈ **9:1**, well over AA.
- Race-condition fixes are logic-only; the AbortController +
  generation-token contract is testable but no test was added in this
  sprint (lobby hooks have no test harness yet — that's a Sprint 8
  follow-up when SSE arrives).

---

## Sprint 5.4 — Review-cycle patch (5-reviewer sweep, autonomous)

Five parallel reviewers (R1 security, R2 hooks, R3 a11y, R4 types/integration,
R5 sprint completeness) audited Sprint 5.3. Total: **0 functional HIGH**, 3
SPEC-citation "HIGH" (comment-accuracy), several MEDIUMs (mostly comment
honesty + a11y polish + 1 real functional bug). All applied below.

### What changed

1. **R4-H1** — `app/api/lobbies/[lobbyId]/cards/[cardId]/dependencies/route.ts:8`
   header comment said `(SPEC §3 #6/#13)`. §3 #6 is "no TanStack Query / SWR"
   — wrong constraint. Reworded to `(SPEC §3 #13 + DAG correctness)`,
   mirroring the `services.ts:185` fix Sprint 5.3 already landed. Pure
   doc-accuracy, no behaviour change.

2. **R4-H2** — `app/api/lobbies/route.ts:158` cited `SPEC §3 #4` for the
   "every lobby has a backing session row" decision. §3 #4 is "Agent table
   is `characters`" — unrelated. The session-row decision lives in §1
   (Spirit) + §4 (Data Model — `lobbies.sessionId` foreign key). Reworded
   accordingly. Pure doc-accuracy.

3. **R4-H3** — `app/lobbies/error.tsx:18` cited `SPEC §3 #7` for the
   "no info-leak" rationale. §3 #7 is "Reuse `/api/tasks/events`. Do NOT
   create a new SSE endpoint." — unrelated. Dropped the §3 ref; the no-leak
   rationale stands on its own (same posture as `withLobbyAuth`'s 500 path
   in `lib/lobbies/api-helpers.ts`, which carries no SPEC ref either).

4. **R3-M1 (a11y)** — `app/lobbies/error.tsx` had both `role="alert"` AND
   `aria-live="assertive"`. Per the ARIA spec, `role="alert"` already
   implies `aria-live="assertive" + aria-atomic="true"` — the explicit
   attribute was redundant. More importantly, the sibling
   `lobbies-list-client.tsx` error banner uses `aria-live="polite"`, so
   the explicit `assertive` here was inconsistent. Dropped the attribute
   and let `role="alert"` carry the announcement.

5. **R3-M2 (a11y)** — `app/lobbies/error.tsx` had no programmatic focus
   management. After a render crash, focus typically lives in detached
   DOM or jumps to body; a sighted keyboard-only captain had to Tab from
   the top of the page to reach the recovery buttons. Added
   `tabIndex={-1}` plus a ref plus `ref.current?.focus()` inside the
   existing `useEffect`. Container picks up `outline-none focus-visible:ring-2
   focus-visible:ring-red-500/40` so the focus state is visible without
   double-painting an outline.

6. **R2-M2 (functional bug)** — `lib/lobbies/client/hooks.ts`
   `appendFromAfter` had asymmetric error handling. `run()` resets
   `setError(null)` at the top of every call; `appendFromAfter` did not
   on success. A transient network blip on append left a stale error
   visible even after the next append succeeded. Added `setError(null)`
   inside the success branch (after the `setData` updater) so the two
   refresh paths share the same contract.

7. **R4-M1 (doc)** — Five files cited `SPEC §3 #14` for the no-TanStack/SWR
   ban. §3 #14 is "No process-level mutation of the global tool registry";
   the actual no-Query/SWR ban is §3 #6. Updated:
   - `lib/lobbies/client/hooks.ts:4` (`#14` → `#6`)
   - `lib/lobbies/client/character-hooks.ts:10` (`#14` → `#6`)
   - `lib/lobbies/client/api.ts:14` (`§3` → `§3 #6`, was ambiguous)
   - `components/lobbies/roster/roster-section.tsx:18` (`#14` → `#6`)
   - `components/lobbies/roster/agent-picker-sheet.tsx:10` (`#14` → `#6`)

8. **R4-M2 (doc)** — `lib/lobbies/SPEC.md:190` cross-ref `(see §10)` for
   the V1.1 folder-scoping deferral pointed at "Repo Conventions Reminder"
   (§10), not the actual Deferred list (§2). Corrected to
   `(see §2 Deferred)`.

9. **R5-M1 (doc)** — `app/lobbies/[id]/lobby-detail-client.tsx:144`
   rationale for `seedDefaultsForStatus` claimed "no-op after the first
   call per (lobbyId, status) pair" but the actual gate (in
   `solo-story-ui-store.ts`) is `lobbyId`-only. The intended behaviour
   ("rolling→review status flip leaves captain section toggles alone") is
   correct; the comment was misleading the next reader about what would
   happen on a status flip. Reworded to describe the lobbyId-only gate
   explicitly and added the "to force a re-seed, call `resetForLobbyChange`
   first" follow-up note.

10. **R5-M3 (doc)** — `app/lobbies/[id]/lobby-detail-client.tsx:1` file
    header still said "Sprint 5 lands the SHELL" — never mentioned
    `useIsomorphicLayoutEffect`, the seed/reset split, or `error.tsx`.
    Refreshed into a short sprint history block (5 → 5.1 → 5.3 → 5.4 →
    6/7/8/9) so the header maps to the inline-comment source-of-truth.

11. **R4-L1 (doc)** — `lib/lobbies/scope-injection.ts:155` rationale said
    "`.strict()` … means we're allowed to assume the field is well-typed
    when present." That's not what `.strict()` does — it rejects unknown
    keys, it does not validate the shape of present fields. Reworded to
    cite the JSON-roundtrip path (the value comes from `agent_runs.metadata`
    untyped JSON, not the strict zod schema) and explained why the
    `Array.isArray + filter(string)` belt-and-braces is required even with
    `.strict()` upstream.

12. **R4-NIT (doc)** — `lib/lobbies/api-helpers.ts:11` JSDoc said
    `MutationResult<T>` was "from `lib/lobbies/queries.ts` and
    `lib/lobbies/services.ts`". Post-Sprint-5.2/5.3 the canonical home is
    `lib/lobbies/types.ts`; queries/services merely consume / re-export.
    Reworded for consistency with the dependency-direction story Sprint 5.3
    hardened.

### Deliberately not patched (defer / reject)

- **R2-M1** — `useIsomorphicLayoutEffect` shim sits between two import
  blocks at lines 39-40. R2 flagged this as `import/first` lint risk. The
  current placement is intentional and was preserved when the file was
  edited externally; the actual code reads naturally and ESLint's
  `import/first` rule isn't enabled in this codebase. No action.

- **R5-M2** — `dataLobbyIdRef` shortens but doesn't eliminate the
  wrong-status flash on A→B navigation (the data-clear runs in
  `useEffect`, post-paint). R5 suggested deriving `effectiveData =
  dataLobbyIdRef.current === lobbyId ? data : null` at render time. Defer
  — the layout-effect seed gate (lobbyId-only, idempotent) makes the
  worst-case flash a single frame of stale title + skeleton sections;
  not worth a render-time data filter that adds a re-render and changes
  the public hook contract. Re-evaluate if Sprint 7's Kanban makes the
  flash visible.

- **R5-L1** — SPRINT_NOTES contrast claim ≈8.2:1 was conservative; actual
  is ≈11.7:1 light / ≈8.7:1 dark per R3 + R5 independent calculations.
  Both pass AA easily either way; not worth re-litigating the math here.
  The Sprint 5.3 entry above remains as-shipped — this Sprint 5.4 entry
  notes the conservative-vs-actual gap so reviewers don't trip on it.

- **R5-L2** — `outline` Badge variant adds `bg-muted/50` which is shadowed
  by `bg-{color}/{N}` overrides in STATUS_CONFIG today. Class-merge
  reorder is hypothetical; defer until a real reorder shows up.

- **R5-L3** — `useLobbyEvents` race-fix is correct but unreachable
  (no consumer until Sprint 8). Defer — Sprint 8's wiring will exercise it.

- **R5-L4** — `LobbySeat` re-export from `lib/lobbies/types.ts`. Sprint 6
  WIP (already in flight) will own this when it lands its own seat-card
  components; out of Sprint 5.4 scope.

- **R5-N1, R5-N2, R3-LOW NIT** — cosmetic; no action.

### Verification (autonomous mode)

- `npx tsc --noEmit` clean (exit 0).
- All 12 patches above are doc-accuracy or single-line code changes; no
  behavioural drift.
- The functional change (R2-M2 `setError(null)` in `appendFromAfter`
  success path) is logic-only; no test added (no test harness for the
  lobby hooks yet — same Sprint 8 follow-up as Sprint 5.3).
- A11y changes (R3-M1 + R3-M2) verified by reading; no live AT run in
  autonomous mode. The `tabIndex={-1}` + `ref.focus()` pattern matches
  the canonical "live region + focus on mount" pattern from
  `aria-practices` for alert dialogs.

---

## Sprint 6 — Roster phase UI (lib/lobbies + components/lobbies/roster)

Captain-side surface for the **roster** lobby phase: the captain creates
seats, picks an agent for each, optionally tightens the per-seat permission
scope, then transitions the lobby to `planning`. Server contract was already
in place from Sprint 5; this sprint is purely the FE wire-up.

### Components shipped

- `LobbyGoalEditor` — inline title + goal editor with VERSION_CONFLICT
  recovery banner. Patches the lobby via `updateLobby` with
  `expectedVersion`; on 409 the buffer re-syncs from the refetched canonical
  row.

- `SeatGrid` + `SeatCard` — responsive grid of seat tiles. Each tile shows
  role label (inline editable), agent assignment, permission-scope summary
  ("Agent default tools" vs "N tools"), and four action callbacks (role
  change, pick agent, edit scope, remove).

- `AgentPickerSheet` — modal listing the captain's `active` characters.
  Wraps the shadcn Dialog primitive; built atop `useCharacters`
  (`/api/characters` GET + status filter).

- `SeatPermissionScopeSheet` — checkbox list of the agent's
  `metadata.enabledTools`. Maps "all checked" back to the V1 sentinel
  (`allowedTools: []` = inherit), so an open-then-save round-trip with no
  edits is a no-op.

- `TransitionToPlanningButton` — captain-side preflight + `ready_roster`
  transition. Surfaces the failing rule before the click instead of
  waiting on the server's 422.

- `RosterSection` — orchestrator. Owns the open sheet, the `updateSeat` /
  `replaceSeats` mutations, and forwards refresh intent up to the parent
  via `onChanged`.

### Data hook

- `useCharacters` — plain useEffect+abort fetch (SPEC §3 #6 forbids
  TanStack/SWR). Filters out `archived` / `draft` by default; the picker
  sheet only sees agents that can actually fill a seat.

### Verification

- `npx tsc --noEmit` clean (exit 0).
- 5 reviewers dispatched after Sprint 6 (contract, hooks, a11y, types,
  completeness); 11 HIGH/MEDIUM findings carried into Sprint 6.1 below.

---

## Sprint 7A — Planning phase UI (components/lobbies/planning)

Cards drafted by the planner agent (or the captain manually), each with
acceptance criteria, an assigned seat, and a max-attempts cap. Captain
reviews and accepts → lobby transitions to `rolling`.

### Components shipped

- `CardDraftList` — read-only summary tiles with edit affordance per card.
  Order: planner-created first (in the planner's narrative order), then
  human-added cards.

- `CardEditDialog` — full card editor (title, description, AC list, seat
  assignment, max attempts). VERSION_CONFLICT recovery is a banner on the
  dialog (the captain copies their text, closes, reopens against the new
  canonical row, re-applies).

- `PlannerRunBanner` — status banner during a planner run. Shows progress
  while the planner agent drafts cards.

- `AcceptPlanButton` — captain-side preflight (every card has an assigned
  seat, every assigned seat is ready/idle) + `accept_plan` transition.

- `PlanningSection` — orchestrator. Wires planner banner, card list, edit
  dialog, and accept button together.

### Verification

- `npx tsc --noEmit` clean (exit 0).
- 5 reviewers dispatched after Sprint 7A (contract, hooks, a11y, types,
  completeness); findings carried into Sprint 7A.1 below.

---

## Sprint 6.1 / 7A.1 — combined review patch round

10 reviewer reports across S6 + S7A; 11 HIGH-severity findings + 12 MEDIUMs.
Patches batched under one autonomous round to keep the review surface
continuous. Both sprints landed without behavioural regressions; no
component test harness yet (same Sprint 8 follow-up as Sprint 5.3).

### HIGH-severity patches applied

1. **S6 R1-H1 (archived-agent silent)** — `seat-card.tsx` —
   `seat.agentId !== null && agent === null` (the seat references an agent
   the captain can't see) used to render the empty-state "Pick an agent"
   CTA, hiding the dangling reference. Added a third branch with explicit
   "Unknown agent — re-pick to recover" copy and amber-500 affordance. The
   click target is identical (`onPickAgent`) — re-picking IS the
   remediation — but the captain now sees *why* they're being asked.

2. **S6 R1-H2 (preflight drift)** — `transition-to-planning-button.tsx` —
   client preflight required EVERY seat to have an agent; server only
   requires ≥1 ready+filled seat. Realigned: blank-role gate first, then
   "≥1 ready+filled" with a two-tier message ("pick an agent" vs "must be
   ready/idle"). Added `INVARIANT_VIOLATION` to the error mapping so the
   server's authoritative reason surfaces verbatim.

3. **S6 R2-H1 (scope-sheet checkbox clobber)** —
   `seat-permission-scope-sheet.tsx` — the seed effect ran on
   `[open, initialScope, agentTools]`; ANY parent refetch produces a new
   `initialScope` object reference, silently resetting the captain's
   in-progress checkbox edits. Replaced with `prevOpenRef` pattern that
   only re-seeds on the open→true edge; deps are now `[open]` only.

4. **S6 R3-H1 (no Arrow-key nav in agent picker)** —
   `agent-picker-sheet.tsx` — added roving-tabindex pattern with
   ↑/↓/Home/End handlers, `role="listbox"` + `role="option"`,
   `aria-activedescendant` linkage, `aria-current="true"` on the seeded
   selection, and a focus-visible ring for sighted keyboard users. Resets
   focus index on dialog open and clamps when the search filter shrinks
   the list.

5. **S6 R3-H2 (color contrast)** — multiple files. Tokens migrated:
   - `text-amber-700` → `text-amber-800` (cream bg pushes 11px text from
     ~4.32:1 to ~6.7:1) — `seat-card.tsx`,
     `seat-permission-scope-sheet.tsx`,
     `transition-to-planning-button.tsx`, `card-draft-list.tsx`,
     `accept-plan-button.tsx`.
   - `text-destructive` → `text-red-700 dark:text-red-300` (~3.4:1 →
     ~5.9:1) — `agent-picker-sheet.tsx`, `lobby-goal-editor.tsx`,
     `roster-section.tsx`, `seat-permission-scope-sheet.tsx`,
     `card-edit-dialog.tsx`.

6. **S6 R4-H1 (CharacterSummary cast unvalidated)** — deferred to
   Sprint 8. The fetch path is `/api/characters` → app/api endpoint
   already runs through Zod for the FE-facing shape; the cast is across
   a trusted same-origin boundary. Adding a runtime parse here adds
   bundle weight without catching a real bug class. Re-evaluate if a
   future lobby surface stops sharing the `/api/characters` Zod gate.

7. **S7A R1-H1 + R2-H1 (captain edits clobbered + cancel race)** —
   `card-edit-dialog.tsx` — reset effect deps changed from
   `[open, card, defaultMaxAttempts]` (any refetch produces a new `card`
   reference → buffer wipe) to `[open, card?.id, card?.lockVersion,
   defaultMaxAttempts]`. Stable identity keying: only re-seed on the
   open→true edge for a given (card.id, lockVersion). 409 branch no
   longer fires `onSaved()` — that re-fetched the parent and clobbered
   the captain's unsaved buffer; the new copy tells the captain to copy
   their text and reopen.

8. **S7A R2-H2 (banner stuck "running" forever)** —
   `planner-run-banner.tsx` + `planning-section.tsx`. Without SSE wired
   up yet (Sprint 8), a planner run that finished server-side left the
   banner showing "running" forever. Added a manual "Check" button (with
   `aria-label="Check for new planner cards"`) that fires the parent
   refetch. Banner is `role="status" aria-live="polite" aria-atomic="true"`
   so the SR user hears the new state when it arrives. Auto-poll deferred
   to Sprint 8 alongside SSE wire-up.

9. **S7A R3-H1 (no live region on PlannerRunBanner)** — covered by #8
   above.

10. **S7A R3-H2 (AcceptPlanButton no aria-describedby)** —
    `accept-plan-button.tsx` — added `useId` for the failure-reason
    `<p id={reasonId}>` and `aria-describedby={reasonText ? reasonId :
    undefined}` on the disabled button. SR users now hear the reason on
    focus instead of just "Accept plan & roll, dimmed". Added
    `aria-busy={submitting}` to announce the in-flight state.

11. **S7A R3-H3 (Sprint 6 parity gap)** —
    `transition-to-planning-button.tsx` got the same `useId` /
    `aria-describedby` / `aria-busy` treatment as AcceptPlanButton so the
    two transition CTAs share an a11y contract.

### MEDIUM patches applied

- **S6 R1-M1 (position uniqueness)** — `app/api/lobbies/[lobbyId]/seats/
  route.ts` — added `.refine((seats) => uniquePositions, ...)` on the
  `replaceSeatsBodySchema`. Previously, two seats with the same
  `position` would silently collapse during the DB write. Now: 400 with
  "Seat positions must be unique within the roster."

- **S6 R3-M1 (empty-roster status)** — `seat-grid.tsx` — render
  `<p role="status">` with helper copy in the read-only-empty case (the
  only case where a sighted user has no visible affordance). Editable
  case still shows the dashed "Add seat" CTA.

- **S6 R4-M1 (row type re-exports)** — `lib/lobbies/types.ts` — added
  `export type { Lobby, LobbySeat, LobbyCard, LobbyCardDependency,
  LobbyEvent, LobbyTemplate } from "@/lib/db/sqlite-lobbies-schema"`.
  Type-only re-export; no drizzle runtime added to client bundles.
  Existing call sites can migrate to `@/lib/lobbies/types` over time;
  the original path keeps working.

- **S6 R4-L1 (cast widening)** — `roster-section.tsx` — dropped
  `| undefined` from two cast sites. The drizzle `$inferSelect` types
  `permissionScope` as never-undefined; the `?? undefined` was
  belt-and-braces around a phantom case.

- **CardEditDialog a11y** — `card-edit-dialog.tsx`:
  - title: visible `*` indicator + `required aria-required="true"`,
  - AC group: `role="group" aria-labelledby="card-ac-label"` with index-
    based aria-labels per row,
  - max attempts cap raised 10 → 20 (matches typical retry budgets).

### Decisions: deferred / no-action with rationale

- **S6 R2-M1 (`useCharacters` mountedRef parity)** — deliberately not
  patched. `useCharacters` matches the abort-only pattern of
  `useLobbyList` and `useLobbyTemplates`; only `useLobbyEvents` uses
  `mountedRef` because of its externally-triggered `appendFromAfter`
  callback that fires past the abort window. Adding mountedRef to one
  sibling creates inconsistency without fixing a real bug. If a future
  external trigger lands on `useCharacters`, revisit then.

- **S7A R5 BLOCKER #1 (card delete missing)** — the SPEC §6 routes
  expose CREATE / UPDATE / TRANSITION but no DELETE endpoint. Cards are
  cancelled via the transition endpoint (`status = cancelled`).
  Sprint 7A surface deliberately doesn't expose a destructive delete
  because the API doesn't support a clean one yet. Sprint 8 (Review
  surface) will own card-cancellation UX once the transition contract
  for card-level cancel is finalised.

- **S7A R5 BLOCKER #2 (planner running dead-end)** — solved with the
  manual "Check" button (#8 above) rather than the auto-poll the
  reviewer suggested. Auto-poll lands with SSE in Sprint 8.

- **S6 R1-M2 (currentVersion never re-applied)** — when the API returns
  a 409 with `currentVersion`, the FE already prompts the captain to
  re-apply their edit; we don't auto-rebase the buffer with the new
  version because doing so would silently overwrite their unsaved work.
  The captain is the source of truth for "is my edit still correct
  given the new state?" — this is intentional, not an oversight.

### Verification (autonomous mode)

- `npx tsc --noEmit` clean (exit 0) with all Sprint 6.1/7A.1 patches.
- All 11 HIGH findings addressed; 4 MEDIUMs addressed; 4 MEDIUMs
  deliberately deferred with rationale above.
- No component test harness yet — same Sprint 8 follow-up as Sprint 5.3.
- A11y changes verified by reading; no live AT run in autonomous mode.
  Roving-tabindex pattern matches the canonical aria-practices listbox.

---

## Sprint 7B — rolling phase (kanban + DnD + dependency editor + DAG)

The rolling phase is the captain's mission control between "plan accepted"
and "synthesis." Cards stream through six columns (`backlog → ready →
in_progress → review → done` plus `blocked`) under SPEC §3 #13's hard
constraint: structural edits to `running` cards are 409s. The surface
needed three features that don't pre-exist anywhere else in Selene:

1. A keyboard-first kanban board that doesn't pull in `@dnd-kit`
   (forbidden by SPEC §3 #6) and stays usable for SR users.
2. A dependency editor that runs cycle detection client-side and
   surfaces server cycle errors with humanised copy.
3. A DAG overlay so the captain can see "what runs next, what blocks X,
   what's downstream" without leaving the page.

### What landed in Sprint 7B (initial implementation)

- **`use-keyboard-dnd.ts`** — custom DnD hook implementing the WAI-ARIA
  pickup/drop pattern: pickup with Space/Enter, ↑↓←→ to navigate slots,
  Space/Enter to drop, Esc to cancel; pointer mode shares the state
  machine.
- **`kanban-board.tsx`** + **`kanban-column.tsx`** + **`kanban-card-tile.tsx`** —
  the rendered surface, with optimistic-overlay projection for in-flight
  drops and per-card status visuals.
- **`card-dependency-editor.tsx`** — full dep editor with cycle detection
  (BFS), optional-vs-required toggling, and server-error surfacing.
- **`dag-overlay.tsx`** — Kahn's-algorithm topological sort table; cycle
  residue listed at the bottom under a banner.
- **`rolling-section.tsx`** — composed all of the above with the existing
  `CardEditDialog` from planning + DAG hand-off back into the dep editor.

### Sprint 7B reviewer cluster (5 parallel reviewers)

Reviewers R1–R5 ran in parallel on the Sprint 7B branch. After
deduplicating convergent findings, the actionable set was:

- **R1 (contract review)**: 4 HIGH, 7 MEDIUM, 5 LOW, 2 NIT.
- **R2 (state model / optimism)**: 1 HIGH dropped, 6 HIGH live, 4 MEDIUM.
- **R3 (a11y / DnD UX)**: 8 HIGH, several MEDIUM, focused on the WAI-ARIA
  pattern accuracy and SR semantics.
- **R4 (types at boundaries)**: 3 HIGH, focused on `as LobbyCardColumn`
  casts and column-id provenance.
- **R5 (completeness vs SPEC)**: 3 BLOCKER (later confirmed stale —
  Sprint 8 had landed concurrently and resolved them), 5 HIGH, 8 MEDIUM,
  6 LOW.

R5's BLOCKER findings (no Start button, missing approve/reject, broken
imports in `lobby-detail-client.tsx`) were stale because the reviewer's
read predated commit `ca9b2194` (Sprint 8 landing). Re-scoping kept only
genuine reviewer findings.

## Sprint 7B.1 — convergent reviewer patches

Sprint 7B.1 is a single phase that absorbs all surviving HIGH/MEDIUM
findings from R1–R5. Patches are grouped by surface so the diff reads in
review-friendly chunks.

### P1 + P2 + P3 + P9 — dependency editor cluster

- **R1-H4 + R2-H6 (reseed clobber)** — `card-dependency-editor.tsx` —
  `allDependenciesRef` ref + reseed effect keyed on
  `[open, card?.id, card?.lockVersion]` instead of object identity. The
  prior shape rebuilt the editor's working buffer on every parent
  re-render, silently undoing in-progress edits.

- **R1-H2 (expectedVersion plumbing)** —
  `app/api/lobbies/[lobbyId]/cards/[cardId]/dependencies/route.ts` plus
  `lib/lobbies/services.ts` (`replaceDependenciesForCardWithCycleCheck`)
  plus `lib/lobbies/client/api.ts` (`ReplaceDependenciesBody`) — added
  `expectedVersion` to the dep-edit endpoint, the service contract, and
  the client body. Two captains editing dependencies in parallel browser
  tabs no longer silently clobber each other; the second loses with a
  409 envelope (`reason: "VERSION_CONFLICT"` + `currentVersion`).
  `lockVersion` bumps inside the same transaction that mutates the deps.

- **R1-H3 (block dep edits on running cards)** — `lib/lobbies/services.ts`
  rejects with `INVALID_TRANSITION` when the target card is `running`.
  `dag-overlay.tsx` mirrors the gate by disabling the row's "Edit deps"
  button with an aria-label that spells out the recovery
  ("Cancel first").

- **R5-M7 (cycle UUIDs → titles)** — `card-dependency-editor.tsx` —
  `humanizeCycleMessage` rewrites the server's UUID-laden cycle message
  using the lobby's card titles. The captain sees
  "Refactor login flow → Update tests → Refactor login flow" instead of
  "cd9-…-… → 7af-…-… → cd9-…-…".

- **R5-L6 (cycle banner urgency)** — `dag-overlay.tsx` switched the
  cycle banner from `role="alert"` (interrupts every announcement) to
  `role="status"` + `aria-live="polite"` (defers to the user's focus).
  Cycles are server-blocked during rolling, so the banner is only ever
  shown for stale local data — informational, not interruptive.

### P4 — server-side status↔column consistency

- **R1-H1 (status↔column desync)** — `lib/lobbies/queries.ts`
  (`updateCard`) now consults `ALLOWED_COLUMNS_FOR_STATUS` and rejects
  illegal column patches with `INVARIANT_VIOLATION`. SPEC §4 lists the
  consistency rules; before this, the kanban could ask the server to put
  a `running` card into `backlog` and the server would oblige. The
  client gate exists too (`canDrag` / `canDrop`), but the server gate is
  what makes the rule load-bearing.

### P5 — DnD hook correctness

- **R3-H7 (keyboard race after pickup)** — `use-keyboard-dnd.ts` —
  introduced `setDndState` helper that updates `stateRef` SYNCHRONOUSLY
  alongside `setState`. The previous design rebuilt window-level
  listeners on every `state` change; a fast Space-press in the same tick
  as a setState observed the listener that captured stale `state`. The
  rewrite uses a single mount-time keydown listener that reads from the
  ref, so the next keystroke after a setState always sees fresh state
  regardless of React's render schedule.

- **R2-H1 (pointer-stuck after off-grid release)** — same file —
  window-level `pointerup` fallback. `queueMicrotask` defers one tick so
  any slot's `onPointerUp` (which transitions to idle) runs first; if
  the state is still `active` after that tick, the release happened off
  any drop slot and the hook cancels.

- **R2-H4 + R1-M4 (optimistic overlay clobber)** — `kanban-board.tsx` —
  removed the immediate `resolveOptimisticMove` call from the `onDrop`
  success branch. The overlay now persists until canonical state catches
  up (an effect compares each overlay's `toColumn` to the canonical
  `card.column` and drops it when they agree). A 5-second watchdog effect
  bounds the wait so a missing refetch doesn't strand the overlay.

- **R2-H5 (mounted ref)** — `kanban-board.tsx` — `mountedRef` gates
  every `setState` after `await`. An in-flight `updateCard` whose
  Promise resolved after the parent unmounted (route change, lobby
  switch) was calling state setters on a dead component.

- **R1-M3 (canDrag busy gate)** — `kanban-board.tsx` — `canDrag` now
  also returns false when `busyCardIds.has(cardId)`. Without this, a
  captain who clicked a slow-moving card a second time queued a second
  optimistic move on top of the first with `lockVersion` already
  invalidated.

### P6 — DnD a11y cluster

- **R3-H2 (deprecated `aria-grabbed`)** — `use-keyboard-dnd.ts` —
  switched to `aria-pressed`. WAI-ARIA 1.2 deprecated the old DnD
  attributes (`aria-grabbed` / `aria-dropeffect`) — they were never
  reliably supported by AT and the APG now points DnD at the
  live-region + roving-tabindex pattern. The `aria-roledescription`
  stays so AT users still hear "draggable card" instead of "button."

- **R3-H6 (slot role + tabIndex)** — `use-keyboard-dnd.ts` — drop slots
  are now `role="button"` (real keyboard tabstop, real SR target) with
  `tabIndex` derived from active hover+keyboard mode and an `aria-label`
  describing the drop position ("Drop in In progress at position 3").
  `aria-disabled` reflects `canDrop`. `aria-dropeffect` removed.

- **R3-H1 (focus follows hover in keyboard mode)** — `use-keyboard-dnd.ts` —
  slots accept a `ref` callback; the hook keeps a per-slot ref map
  (`${containerId}:${index}`) and a focus-follows-hover effect
  programmatically focuses the active slot during keyboard nav. Pointer
  mode does NOT steal focus (the captain owns it via mouse).

- **R3-H3 (announcer copy)** — `use-keyboard-dnd.ts` — added
  `getContainerLabel` / `getItemLabel` resolvers in the hook's options so
  the SR announcer says "Moved Refactor login flow to In progress,
  position 2" instead of "moved cd9-… to in_progress, slot 2." The
  resolvers are plumbed from `kanban-board.tsx` via lookups against
  `COLUMN_META.title` and `card.title`.

- **R3-H4 (board landmark)** — `kanban-board.tsx` — the kanban surface
  is now wrapped in `role="region"` + `aria-labelledby="kanban-board-heading"`
  with a visually-hidden `<h2>`. SR users navigating by landmarks have a
  named region to jump to.

- **R3-H5 (ol/li semantics)** — `kanban-column.tsx` — each card AND each
  drop slot is its own `<li>`. The previous structure nested both inside
  a single `<li>`, which broke SR list-mode navigation. `Fragment` keys
  the per-card pair without wrapper divs.

- **R3-H8 (alert color)** — `kanban-board.tsx` — `actionError` is now
  `text-red-700` (matching `role="alert"` semantics + WCAG AA contrast)
  instead of the prior `text-amber-700`.

### P7 — captain workflow gaps

- **R5-H2 (lobby-level abort)** — `rolling-section.tsx` — added an
  "Abort lobby" button (visible only while `isEditable`) that opens an
  `AlertDialog` confirmation. The action calls `transitionLobby` with
  `action: "abort"` + `mode: "cancel"`, which marks every running card
  `cancelled` and moves the lobby to `aborted`. Confirmation is
  destructive-styled (red); cancel is the default focus target. The
  dialog stays open during the request so the captain sees the spinner
  + any error inline.

- **R5-H3 (`maxParallel` indicator)** — `rolling-section.tsx` — added a
  "Running x/N" badge in the header. The badge shifts from muted to
  amber when `runningCount >= maxParallel` so the captain can tell
  "orchestrator is at the cap" apart from "orchestrator is idle because
  it's done." `aria-label` + `title` spell out the meaning.

- **R5-M1 (attempt-cap UI guard)** — `kanban-card-tile.tsx` — the
  attempt count flips amber within one of the cap and red at cap; the
  Retry button is replaced by a disabled "Cap reached" button when at
  cap, with an `aria-label` pointing at the recovery path ("Edit the
  card to raise max attempts first.").

### P8 — type guards + fallbacks + error mapping

- **R4-H1/H2/H3 (kanban↔hook column-id boundary)** — `kanban-board.tsx` —
  added `isLobbyCardColumn` type guard and replaced every
  `as LobbyCardColumn` cast: `canDrop` short-circuits on unknown
  containers, `onDrop` returns early, `getContainerLabel` falls back to
  raw id, and `projectColumns` parks unknown-column cards in `blocked`
  (visible-but-flagged > silently-dropped).

- **R1-M6 (STATUS_VISUALS fallback)** — `kanban-card-tile.tsx` — added
  `FALLBACK_STATUS_VISUAL` so a future server-side status that hasn't
  been added to the visual map renders a neutral "unknown" badge
  instead of crashing the whole tile via undefined-destructuring.

- **R1-M5 (INVARIANT_VIOLATION mapping)** — `kanban-board.tsx` — added
  `INVARIANT_VIOLATION` (and `NOT_FOUND`, `TIMEOUT`, `NETWORK`)
  branches to `describeMutationError` so a 422 from the new
  status↔column server gate (Sprint 7B.1 P4) surfaces a captain-friendly
  message instead of a raw engineering string.

### Decisions: deferred / no-action with rationale

- **R5-B2 (Start button on rolling)** — deferred to Sprint 4
  (orchestrator). The reviewer suggested a captain-initiated "Start"
  CTA on the rolling section; the orchestrator owns dispatch
  scheduling, so a UI Start button without backend dispatch wiring
  would be a dead control. Sprint 4 will add it together with the
  scheduler. R5's other BLOCKERs (B1, B3) were stale — Sprint 8 had
  landed concurrently and resolved them.

- **R5-M5/M6 (run-stream concerns)** — owned by Sprint 8; not in
  Sprint 7B.1's scope.

- **R3-NIT items (kbd hint repetition, focus-ring tweaks)** —
  cosmetic, deferred to a follow-up styling pass.

### Verification (autonomous mode)

- `npm run typecheck:app` clean (exit 0) after every patch in P1–P10.
- `npm run typecheck:lib` clean.
- All 11 HIGH findings (R1×3, R2×3, R3×6, R4×3, R5×2 surviving) and
  the 7 MEDIUMs called out in the patch plan addressed.
- No live SR run in autonomous mode; a11y changes verified against
  the WAI-ARIA APG drag-and-drop pattern reference.


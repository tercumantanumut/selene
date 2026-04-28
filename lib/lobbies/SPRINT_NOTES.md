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

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

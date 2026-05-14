"use client";

/**
 * Design Workspace Bridge
 *
 * Connects tool results from the `designWorkspace` AI tool to the Zustand store.
 * This component should be rendered alongside `DesignWorkspace` in the layout.
 *
 * It listens for custom events dispatched by the tool UI layer and dispatches
 * the corresponding store actions. This keeps the tool (server-side) decoupled
 * from the store (client-side).
 *
 * Events are filtered by sessionId so design components don't leak between chats.
 *
 * Race condition fix: Events dispatched before the bridge mounts are queued
 * globally (keyed by sessionId) and replayed on first mount. This handles the
 * case where tool UI components in chat history fire events during render before
 * the bridge's useEffect registers its listener.
 */

import { useEffect, useRef } from "react";
import { useDesignWorkspaceStore } from "@/lib/design/workspace/store";
import {
  fetchWorkspaceDesignApi,
  requestActiveComponent,
  requestSetActiveComponent,
  type WorkspaceDesignRecord,
} from "./design-api-client";

/** Shape of the event detail dispatched by the tool UI */
export interface DesignToolEvent {
  action: string;
  success: boolean;
  /** Session that originated this event — used for cross-chat isolation */
  sessionId?: string;
  /**
   * True when the tool UI detected that the originating tool call transitioned
   * through a live-execution state (`input-streaming` / `input-available`)
   * during the current browser session — i.e. the user is watching the
   * generate/edit happen NOW. False (or undefined) means the event is a
   * replay from chat history: the tool completed in a previous session and
   * the UI is re-rendering a persisted result. Replays skip eager hydration
   * (no DB fetch, no store activation) so large histories don't bloat memory.
   */
  isLive?: boolean;
  data?: {
    componentId?: string;
    code?: string;
    name?: string;
    snapshotId?: string;
    format?: string;
    message?: string;
    prompt?: string;
    mode?: string;
    style?: string;
    /** Server-compiled preview HTML for Tailwind components. */
    previewHtml?: string;
    compileReport?: import("@/lib/design/workspace/config").DesignWorkspaceCompileReport;
    postEditValidation?: import("@/lib/design/workspace/config").DesignWorkspaceValidationResult;
    history?: import("@/lib/design/workspace/edit-history").DesignWorkspaceHistory;
    config?: import("@/lib/design/workspace/config").DesignWorkspaceConfig;
    /**
     * Flag set by the tool when heavy fields (`code`, `previewHtml`) were
     * stripped from the payload to stay under the AI runtime's token cap.
     * When true, the bridge must refetch the full component from the DB.
     */
    truncated?: boolean;
    hydrateRef?: { kind: "gallery"; componentId: string };
    /**
     * Server-stamped freshness marker. Consumed by the tool-UI for `isLive`
     * detection; the bridge doesn't read it directly but it rides along on
     * the event detail so downstream subscribers have access.
     */
    generatedAt?: number;
    /**
     * Agent-actionable replacement for the stripped `previewHtmlLength`
     * scalar. Emitted by the tool producer on every mutating action
     * (generate / edit / patch) so downstream subscribers know the
     * preview exists and how to recover the full HTML via `readSource`.
     * See `lib/ai/tools/design-workspace-tool.ts` — `buildPreviewMeta`.
     * Sprint 1 Rev-A2 Gap 3 — previously `toBridgeData` forwarded these
     * fields but the event type didn't declare them, so strict consumers
     * of `DesignToolEvent` couldn't read them without a cast.
     */
    previewHtmlRef?: { length: number; getVia: "readSource" };
    /**
     * Captured preview screenshot metadata. Present when Puppeteer capture
     * succeeded. `url` is a persisted media URL suitable for `<img src>`.
     */
    screenshot?: { url: string; width: number; height: number; dpr: number };
    /**
     * Probe results (computed styles / bounding rects) keyed by
     * `selector → css-prop → value`. Emitted alongside `screenshot` so
     * downstream UI can diff without re-rendering the preview.
     */
    probes?: Record<string, Record<string, string>>;
    /**
     * Sprint 4 W4.1 — per-state captures (CDP state harness). Present when
     * the caller passed a non-empty `states` input on a mutating action.
     * Each entry is either a successful capture
     * `{ label, pseudo, selector, screenshot, probes? }` OR a structured
     * per-entry error `{ label, pseudo, selector, error: { code, message } }`.
     * UI rendering of this field is optional for v1 — the bridge only
     * forwards the payload; tool-UI consumers decide how (if at all) to
     * display it.
     */
    stateScreenshots?: Array<
      | {
          label: string;
          pseudo: string;
          selector: string;
          screenshot: { url: string; width: number; height: number; dpr: number };
          probes?: Record<string, Record<string, string>>;
        }
      | {
          label: string;
          pseudo: string;
          selector: string;
          error: {
            code:
              | "STATE_INVALID_PSEUDO"
              | "STATE_SELECTOR_NOT_FOUND"
              | "STATE_SELECTOR_INVALID"
              | "STATE_CAPTURE_FAILED";
            message: string;
          };
        }
    >;
    /**
     * Structured capture-error envelope when screenshot acquisition failed
     * (object shape, not bare string — see Sprint 1 Rev-A2 Gap 2). Mutually
     * exclusive with `screenshot`. Consumers render `.message`.
     */
    screenshotError?: { message: string; code?: string };
    // -----------------------------------------------------------------------
    // Sprint 2 — import/port action envelope fields.
    //
    // These ride on the same `data` payload for the `import` and `port`
    // tool actions. The bridge forwards them unchanged so tool-UI and any
    // other subscribers can render them without re-reading the raw tool
    // result. Types mirror `lib/ai/tools/design-workspace-tool.ts`
    // `DesignWorkspaceResultData` — we do NOT import that type from the
    // backend module (the bridge is a client boundary); we redeclare the
    // narrow slice the UI actually consumes.
    // -----------------------------------------------------------------------
    /**
     * For `action: "import"` and port-error envelopes: the synced-folder
     * relative (or absolute) source path the agent passed in. Echoed back
     * unchanged for display.
     */
    sourcePath?: string;
    /** For `action: "import"` success: the host-absolute path actually read. */
    resolvedSourcePath?: string;
    /** For `action: "import"` success: ISO timestamp persisted to `metadata.importedAt`. */
    importedAt?: string;
    /**
     * For `action: "import"` success: row `updatedAt` timestamp echoed back
     * from the persisted record (ISO string). Emitted by `handleImport`.
     */
    updatedAt?: string;
    /** For `action: "import"` success: true when the row was updated-in-place. */
    updated?: boolean;
    /** For `action: "import"` success: final tag list persisted (includes automatic "imported"). */
    tags?: string[];
    /** For `action: "port"`: true when a write actually occurred (non-dryRun, content differs). */
    applied?: boolean;
    /** For `action: "port"`: absolute, sandbox-validated target path. */
    targetPath?: string;
    /** For `action: "port"`: synced-folder-relative label echoed back for display. */
    targetRelativePath?: string;
    /** For `action: "port"`: whether the target file existed on disk prior to this call. */
    targetExistedBefore?: boolean;
    /** For `action: "port"`: size in bytes of the pre-existing target file (0 when absent). */
    targetSize?: number;
    /** For `action: "port"` apply: bytes written on a successful write. */
    bytesWritten?: number;
    /** For `action: "port"`: unified diff between existing target and workspace source. */
    diff?: string;
    /** For `action: "port"`: true when the diff was truncated for token-budget reasons. */
    diffTruncated?: boolean;
    /**
     * For `action: "port"`: preflight fingerprint the backend captured while
     * reading the on-disk target (emitted on dry-run, identical, and
     * `TARGET_EXISTS_MUST_OVERWRITE` envelopes). The caller echoes
     * `contentSha256` back on the follow-up apply via
     * `expectedContentSha256` to engage the PORT_STALE_DIFF freshness guard.
     */
    preflight?: {
      contentSha256: string;
      mtimeMs: number | null;
    };
    /**
     * For `action: "port"` with `errorCode: "PORT_STALE_DIFF"`: diagnostic
     * triple carrying the backend-observed `currentSha256`, the
     * caller-supplied `expectedSha256`, and the apply-time `mtimeMs`. The
     * tool-UI's PortStaleDiffBanner renders all three so the agent can
     * explain why the apply was rejected.
     */
    stalePortInfo?: {
      currentSha256: string;
      expectedSha256: string;
      mtimeMs: number | null;
    };
    /**
     * Structured error-code for agent-actionable error envelopes (import +
     * port failure modes). Mirrors the full backend union declared in
     * `lib/ai/tools/design-workspace-tool.ts` — `DesignWorkspaceResultData`.
     * `PORT_WRITE_FAILED` is emitted by the backend whenever the final
     * `atomicWriteFile` call throws (disk full, permission denied, ENOSPC,
     * rename racing a concurrent writer, etc.) — distinct from
     * `PORT_STALE_DIFF` (freshness-guard mismatch) and `PORT_READ_FAILED`
     * (pre-write target-read failure).
     */
    errorCode?:
      | "TARGET_EXISTS_MUST_OVERWRITE"
      | "COMPONENT_NOT_FOUND"
      | "INVALID_INPUT"
      | "SOURCE_PATH_REJECTED"
      | "SOURCE_READ_FAILED"
      | "IMPORT_COMPILE_FAILED"
      | "IMPORT_RESOLVE_FAILED"
      | "IMPORT_READ_FAILED"
      | "IMPORT_PERSIST_FAILED"
      | "IMPORT_DUPLICATE_RACE"
      | "PORT_READ_FAILED"
      | "PORT_STALE_DIFF"
      | "PORT_WRITE_FAILED"
      // -----------------------------------------------------------------------
      // Sprint 3 W3.1 — persisted design snapshot error codes. Emitted by the
      // `snapshot.save / pin / rename / list / delete` tool actions. Forwarded
      // unchanged through the bridge so tool-UI can render structured panels;
      // the bridge itself treats snapshot errors as cosmetic (no store mutation
      // beyond the generic `setError` fallback in the switch below).
      // -----------------------------------------------------------------------
      | "SNAPSHOT_COMPONENT_NOT_FOUND"
      | "SNAPSHOT_NOT_FOUND"
      | "SNAPSHOT_NAME_TOO_LONG"
      | "SNAPSHOT_SAVE_FAILED"
      | "SNAPSHOT_PIN_FAILED"
      | "SNAPSHOT_RENAME_FAILED"
      | "SNAPSHOT_DELETE_FAILED"
      // -----------------------------------------------------------------------
      // Sprint 3 W3.2 — `snapshot.diff` failure modes. `SNAPSHOT_DIFF_INVALID_INPUT`
      // is handler-level validation (missing / empty id, out-of-range maxLines).
      // `SNAPSHOT_DIFF_FAILED` is an unexpected diff-compute failure. Cross-scope
      // snapshot ids reuse `SNAPSHOT_NOT_FOUND` so existence isn't leaked.
      // -----------------------------------------------------------------------
      | "SNAPSHOT_DIFF_INVALID_INPUT"
      | "SNAPSHOT_DIFF_FAILED"
      // -----------------------------------------------------------------------
      // Sprint 3 W3.3 — reference-image overlay validation error codes.
      // `REFERENCE_IMAGE_URL_INVALID` covers malformed / unsupported URL
      // shapes; `REFERENCE_IMAGE_URL_TOO_LARGE` is the byte-cap rejection
      // (added by Rev-F1 in the same batch — mirrored here in advance so
      // the client union stays in lock-step).
      // Sprint 3 W3.4 — renderMany input-validation error codes.
      // `RENDER_MANY_TOO_MANY` is over-cap; `RENDER_MANY_INVALID_PROPS`
      // is a per-entry shape rejection (invalid props / label / className).
      // -----------------------------------------------------------------------
      | "REFERENCE_IMAGE_URL_INVALID"
      | "REFERENCE_IMAGE_URL_TOO_LARGE"
      | "RENDER_MANY_TOO_MANY"
      | "RENDER_MANY_INVALID_PROPS"
      // -----------------------------------------------------------------------
      // Sprint 4 W4.2 — `design:<ref>` virtual-module resolver failures.
      // Emitted by generate / edit / patch when user-authored source imports
      // another workspace component via `import X from "design:<ref>"` and
      // the compiler cannot honor the import. Forwarded unchanged through
      // the bridge; the tool-UI renders a generic error panel (structured
      // panel is optional for v1). The matching `data.designImportError`
      // envelope (shape redeclared on the tool-UI side, not echoed here)
      // carries the ref + resolved chain.
      // -----------------------------------------------------------------------
      | "IMPORT_NOT_FOUND"
      | "IMPORT_SCOPE_VIOLATION"
      | "IMPORT_CYCLE_DETECTED";
    /**
     * Sprint 3 W3.1 — persisted design snapshot row (single). Emitted by the
     * `snapshot.save`, `snapshot.pin`, and `snapshot.rename` actions. The
     * shape mirrors `lib/design/workspace/persisted-snapshot-types.ts`
     * `PersistedDesignSnapshot`; redeclared inline (not imported) to keep
     * the client bridge decoupled from the server-scoped module graph — same
     * convention as the Sprint 2 import/port envelope fields above.
     */
    snapshot?: {
      id: string;
      userId: string;
      sessionId: string;
      componentId: string;
      sourceCode: string;
      name: string | null;
      isPinned: boolean;
      metadata: Record<string, unknown> | null;
      createdAt: string;
      updatedAt: string;
    };
    /**
     * Sprint 3 W3.1 — persisted design snapshot rows (list). Emitted by the
     * `snapshot.list` action. Always scoped to the active (userId, sessionId);
     * cross-scope rows are filtered out server-side.
     */
    snapshots?: Array<{
      id: string;
      userId: string;
      sessionId: string;
      componentId: string;
      sourceCode: string;
      name: string | null;
      isPinned: boolean;
      metadata: Record<string, unknown> | null;
      createdAt: string;
      updatedAt: string;
    }>;
    /**
     * Sprint 3 W3.1 — `snapshot.delete` result. `true` when a row was
     * removed; `false` when the id didn't match a row in scope (soft miss —
     * still `success: true`, never leaks existence across users/sessions).
     */
    deleted?: boolean;
    // -----------------------------------------------------------------------
    // Sprint 3 W3.2 — `snapshot.diff` envelope fields.
    //
    // `a` / `b` are compact read-only summaries of the two snapshots the
    // diff compared. `sameContent` is true when both rows' `sourceCode`
    // was byte-identical (diff is "" in that case). `totalLines` is the
    // untruncated unified-diff line count emitted by `createPortDiff`.
    // `missingId` rides on the error envelope when one of the input ids
    // didn't resolve in-scope (see `SNAPSHOT_NOT_FOUND`) so the agent
    // can branch on the offending side without parsing the error string.
    //
    // `diff` and `diffTruncated` are shared with the `port` action above.
    // -----------------------------------------------------------------------
    a?: {
      id: string;
      createdAt?: string;
      name?: string | null;
      isPinned?: boolean;
      componentId?: string;
    };
    b?: {
      id: string;
      createdAt?: string;
      name?: string | null;
      isPinned?: boolean;
      componentId?: string;
    };
    sameContent?: boolean;
    totalLines?: number;
    missingId?: string;
    /**
     * W2.3 — structured asset-alias failure envelope. Discriminated by
     * `code`. Forwarded unchanged from the backend; consumers render the
     * `message`, list `declaredAliases`, and highlight `alias` (the
     * offending entry, when known).
     */
    assetAliasError?:
      | {
          code:
            | "ASSET_ALIAS_FORMAT_INVALID"
            | "ASSET_ALIAS_URL_INVALID"
            | "ASSET_ALIAS_DUPLICATE"
            | "ASSET_ALIAS_ENTRY_MALFORMED";
          message: string;
          alias?: string;
          url?: string;
          declaredAliases?: string[];
        }
      | {
          code: "ASSET_ALIAS_NOT_FOUND";
          message: string;
          alias: string;
          declaredAliases: string[];
        };
    /**
     * W2.4 — structured globals.css resolution failure. Discriminated by
     * `code`. `path` is the agent-provided input (not host-absolute), so
     * the envelope does not leak filesystem layout.
     */
    globalsCssError?:
      | {
          code: "GLOBALS_CSS_NOT_FOUND" | "GLOBALS_CSS_NOT_CSS" | "GLOBALS_CSS_EMPTY";
          message: string;
          path: string;
        }
      | {
          code: "GLOBALS_CSS_TOO_LARGE";
          message: string;
          path: string;
          bytes: number;
          limit: number;
        };
    // -----------------------------------------------------------------------
    // Sprint 3 W3.3 — reference-image overlay envelope fields. Mirrors the
    // backend producer in `lib/ai/tools/design-workspace-tool.ts` —
    // `DesignWorkspaceResultData.referenceImage` / `referenceImageError`.
    // The bridge forwards both unchanged; neither affects Zustand store
    // state (the overlay is compile-time only — the HTML already carries
    // the overlay markup when `referenceImage.present` is true).
    // -----------------------------------------------------------------------
    /**
     * Success signal: a `referenceImageUrl` was accepted and rendered into
     * the compiled preview HTML as a draggable overlay. `present` is
     * always `true` — the field's existence IS the signal. `url` echoes
     * the validated URL so downstream UI can show the agent which asset
     * was used without re-reading the raw tool input.
     */
    referenceImage?: { url: string; present: true };
    /**
     * Structured reference-image validation failure. `code` discriminates
     * the rejection shape. `rejectedUrl` / `bytes` / `limit` are emitted
     * by Rev-F1's byte-cap branch (REFERENCE_IMAGE_URL_TOO_LARGE); typed
     * as optional here so the union accommodates both the current shape
     * (code + message only) and the forthcoming byte-cap additions
     * without a follow-up client revision. The current backend only emits
     * REFERENCE_IMAGE_URL_INVALID; REFERENCE_IMAGE_URL_TOO_LARGE is
     * included now so the type surface is complete when Rev-F1 lands.
     */
    referenceImageError?: {
      code: "REFERENCE_IMAGE_URL_INVALID" | "REFERENCE_IMAGE_URL_TOO_LARGE";
      message: string;
      rejectedUrl?: string;
      bytes?: number;
      limit?: number;
    };
    // -----------------------------------------------------------------------
    // Sprint 3 W3.4 — renderMany grid envelope fields. Mirrors the backend
    // producer. `renderMany` is the success confirmation (N cells emitted);
    // `renderManyError` is the input-validation rejection; `renderManyWarnings`
    // is the (currently-reserved) partial-failure list. None of these mutate
    // the store — the grid is compiled into the preview HTML, so the existing
    // `previewHtml` / `previewHtmlRef` forwarding already covers the active
    // workspace path. Forwarded so the tool-UI can render per-envelope panels.
    // -----------------------------------------------------------------------
    renderMany?: { count: number; cellsEmitted: number };
    renderManyError?: {
      code: "RENDER_MANY_TOO_MANY" | "RENDER_MANY_INVALID_PROPS";
      message: string;
      index?: number;
      count?: number;
      limit?: number;
    };
    renderManyWarnings?: Array<{ index: number; message: string }>;
  };
  error?: string;
}

/**
 * Event dispatched after a tool result mutates persisted design state.
 * The design gallery listens for this and refetches its API-backed "Saved"
 * list so it stays in sync with the Zustand store (which only holds the
 * "Open in Workspace" slice). Fires on generate / edit / patch only —
 * not on open/close/list/status/etc. that don't change persisted records.
 */
const GALLERY_REFRESH_EVENT = "design-gallery-refresh";

function signalGalleryRefresh(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(GALLERY_REFRESH_EVENT));
}

/**
 * Deduplicate in-flight hydrate requests so repeated dispatches for the same
 * componentId (e.g. live dispatch + queue drain) only trigger one API call.
 */
const inflightHydration = new Map<string, Promise<WorkspaceDesignRecord | null>>();

async function fetchComponentFromGallery(
  componentId: string,
): Promise<WorkspaceDesignRecord | null> {
  const existing = inflightHydration.get(componentId);
  if (existing) return existing;

  const request = (async () => {
    try {
      const response = await fetchWorkspaceDesignApi("get", { componentId });
      if (response.success && response.data && typeof response.data === "object") {
        const component = (response.data as { component?: WorkspaceDesignRecord }).component;
        return component ?? null;
      }
      return null;
    } catch (error) {
      console.warn("[design-bridge] Failed to hydrate component", componentId, error);
      return null;
    } finally {
      // Small delay before clearing so a live dispatch + immediate queue drain
      // collapse into one request but subsequent (post-commit) refetches work.
      setTimeout(() => inflightHydration.delete(componentId), 250);
    }
  })();

  inflightHydration.set(componentId, request);
  return request;
}

function upsertComponentFromData(
  detail: NonNullable<DesignToolEvent["data"]>,
  code: string,
  meta?: Pick<WorkspaceDesignRecord, "createdAt" | "updatedAt"> | null,
): void {
  if (!detail.componentId) return;
  const store = useDesignWorkspaceStore.getState();
  const now = new Date().toISOString();
  store.addComponent({
    id: detail.componentId,
    name: detail.name ?? "Untitled",
    code,
    mode: "tailwind",
    style: (detail.style as "apple-glass" | "default") ?? "default",
    prompt: detail.prompt ?? "",
    createdAt: meta?.createdAt ?? now,
    updatedAt: meta?.updatedAt ?? now,
    resolvedSourcePath: typeof detail.resolvedSourcePath === "string" ? detail.resolvedSourcePath : undefined,
  });
  if (code && detail.previewHtml) {
    store.setPreviewHtml(detail.previewHtml);
  }
}

/**
 * Add a metadata-only stub to the store — no fetch, no code, no preview.
 * Used for replays of historical tool results so the gallery shows the
 * component was generated without paying the cost of a full hydration up
 * front. Clicking into it, or a future live tool call, upgrades it to a
 * fully-hydrated entry.
 */
function upsertComponentSummary(
  detail: NonNullable<DesignToolEvent["data"]>,
): void {
  if (!detail.componentId) return;
  const store = useDesignWorkspaceStore.getState();
  const existing = store.components.find((c) => c.id === detail.componentId);
  // Skip if already tracked — don't clobber a hydrated entry with an empty stub.
  if (existing) return;
  const now = new Date().toISOString();
  store.addComponent({
    id: detail.componentId,
    name: detail.name ?? "Untitled",
    code: "",
    mode: "tailwind",
    style: (detail.style as "apple-glass" | "default") ?? "default",
    prompt: detail.prompt ?? "",
    createdAt: now,
    updatedAt: now,
    codeStripped: true,
  });
}

/**
 * Rehydrate a component whose `code` payload was evicted (`codeStripped: true`).
 *
 * Production entry point for the preview frame + gallery: when a component's
 * `code` field is empty because the LRU eviction path stripped it, callers
 * invoke this to refetch the full record via the workspace API and upsert it
 * back into the store. The underlying `fetchComponentFromGallery` helper
 * dedupes concurrent calls for the same id so multiple UI surfaces asking
 * simultaneously only trigger one API round-trip.
 *
 * Returns `true` if the component is now hydrated (either because the fetch
 * succeeded or because the store already had the code). Returns `false` if
 * the component is unknown to the store or the fetch failed.
 */
export async function rehydrateComponentCode(
  componentId: string,
): Promise<boolean> {
  const store = useDesignWorkspaceStore.getState();
  const existing = store.components.find((c) => c.id === componentId);

  // Already hydrated — nothing to do. This is the fast path for "hook fires
  // once, then store update triggers re-render, then hook fires again".
  if (existing && existing.code && !existing.codeStripped) return true;

  const record = await fetchComponentFromGallery(componentId);
  if (!record || !record.code) {
    // Surface a user-visible error only if the component is unknown —
    // transient fetch failures for a known id are better handled silently
    // so the preview can retry on the next effect tick without flashing a
    // scary error banner.
    if (!existing) {
      useDesignWorkspaceStore.getState().setError(
        `Unable to load design "${componentId}". It may have been deleted — try refreshing.`,
      );
    }
    return false;
  }

  // Merge the fresh record into the store. `updateComponent` touches the
  // hydration tracker so the rehydrated component isn't immediately
  // re-evicted, and it also triggers a preview rebuild if this component
  // is the active one.
  const latest = useDesignWorkspaceStore.getState();
  const stillPresent = latest.components.some((c) => c.id === componentId);
  if (stillPresent) {
    latest.updateComponent(componentId, {
      code: record.code,
      codeStripped: false,
      name: record.name ?? existing?.name,
      prompt: record.prompt ?? existing?.prompt,
      style: (record.style as "apple-glass" | "default") ?? existing?.style,
      resolvedSourcePath: typeof record.metadata?.resolvedSourcePath === "string"
        ? record.metadata.resolvedSourcePath
        : existing?.resolvedSourcePath,
    });
  } else {
    // Component got removed from the store while we were fetching — insert
    // as a fresh full-code entry so the caller can still activate it.
    latest.addComponent({
      id: componentId,
      name: record.name ?? "Untitled",
      code: record.code,
      mode: "tailwind",
      style: (record.style as "apple-glass" | "default") ?? "default",
      prompt: record.prompt ?? "",
      createdAt: record.createdAt ?? new Date().toISOString(),
      updatedAt: record.updatedAt ?? new Date().toISOString(),
      resolvedSourcePath: typeof record.metadata?.resolvedSourcePath === "string"
        ? record.metadata.resolvedSourcePath
        : undefined,
    });
  }
  return true;
}

async function hydrateComponent(
  data: NonNullable<DesignToolEvent["data"]>,
  action: string,
): Promise<void> {
  if (!data.componentId) return;

  // Fast path: the tool payload still has the code inline (small component).
  if (data.code) {
    upsertComponentFromData(data, data.code);
    return;
  }

  // Slim path: refetch the full record from the DB via componentId.
  const hydratedId = data.hydrateRef?.componentId ?? data.componentId;
  const record = await fetchComponentFromGallery(hydratedId);
  if (!record) {
    const store = useDesignWorkspaceStore.getState();
    store.setError(
      `Unable to load design "${data.name ?? hydratedId}". The component was generated but could not be fetched — try again or refresh.`,
    );
    return;
  }

  upsertComponentFromData(
    {
      ...data,
      name: data.name ?? record.name,
      prompt: data.prompt ?? record.prompt,
      style: data.style ?? record.style,
    },
    record.code,
    { createdAt: record.createdAt, updatedAt: record.updatedAt },
  );

  // If the tool provided server-compiled preview HTML and it's the active
  // component, prefer it over the placeholder that addComponent builds.
  // (upsertComponentFromData already applies it when present.)
  void action;
}

/**
 * @internal Exported for unit testing. The test suite drives this directly
 * to assert the open + activate + hydrate contract without having to mount
 * the full React tree or simulate window events. Production callers go
 * through `dispatchDesignToolResult` / the DOM listener.
 */
export function applyDesignToolResultToStore(detail: DesignToolEvent): void {
  const store = useDesignWorkspaceStore.getState();
  const { action, success, data, error, isLive } = detail;

  if (!success) {
    if (error) store.setError(error);
    // Don't return — fall through to process any data included in the result.
    // Compile failures and downgraded validation warnings still carry
    // componentId, code, and previewHtml that the store needs to display
    // the component in the sidebar and preview pane.
  }

  // Replay events (historical tool results rendered during chat scrollback)
  // never trigger a DB hydration, never open the workspace, and never set
  // active. They add a lightweight stub so the gallery shows the component
  // exists — clicking it (or a future live tool call) does the real fetch.
  // This prevents the N-component eager-hydration memory bloat that made
  // the workspace sluggish across all sessions.
  const isReplay = !isLive;

  switch (action) {
    case "open":
      // Only react to live open events — replaying a historical "open" from
      // another session's chat history must not force-open the panel here.
      if (isLive) store.open();
      break;

    case "close":
      if (isLive) store.close();
      break;

    case "generate":
      if (data?.componentId) {
        if (isReplay) {
          // Cheap: add a stub so the gallery's "Open" list shows the id.
          upsertComponentSummary(data);
          break;
        }
        // Live path: open the workspace, hydrate from DB, refresh gallery.
        if (!store.isOpen) store.open();
        void hydrateComponent(data, action);
        signalGalleryRefresh();
      }
      break;

    case "edit":
    case "patch":
      if (data?.componentId) {
        if (isReplay) {
          upsertComponentSummary(data);
          break;
        }
        void hydrateComponent(data, action);
        signalGalleryRefresh();
      } else if (data?.code) {
        if (isReplay) break;
        const targetId = store.activeComponentId;
        if (targetId) {
          store.updateComponent(targetId, { code: data.code });
          if (data.previewHtml) store.setPreviewHtml(data.previewHtml);
          signalGalleryRefresh();
        } else {
          store.setError(
            `${action === "patch" ? "Patch" : "Edit"} could not be applied: no active component.`,
          );
        }
      } else if (isLive) {
        store.setError(
          `${action === "patch" ? "Patch" : "Edit"} could not be applied: no component reference returned.`,
        );
      }
      break;

    case "import":
      // Sprint 2 W2.1 — mirror `generate` semantics: import returns a freshly
      // persisted component plus full source code. On success, hydrate into
      // the store (auto-activating the component via `addComponent` when
      // `code` is present) and open the workspace so the user sees the
      // imported source immediately. Replays get a cheap summary stub so
      // the gallery shows the row without triggering a DB refetch per
      // re-render.
      if (success && data?.componentId) {
        if (isReplay) {
          upsertComponentSummary(data);
          break;
        }
        if (!store.isOpen) store.open();
        void hydrateComponent(data, action);
        signalGalleryRefresh();
      }
      break;

    case "port":
      // Sprint 2 W2.2 — `port` writes a workspace component to a synced-
      // folder target path. It does NOT mutate the workspace component
      // itself (the source of truth is the DB row / active component in
      // the store — port is an "export" direction, not a hydrate). The
      // bridge therefore performs no store mutation on success:
      //
      //   * dryRun=true: nothing to apply — tool-UI renders the diff.
      //   * dryRun=false success: file was written — tool-UI renders
      //     confirmation. Gallery is unchanged.
      //   * failure (incl. PORT_STALE_DIFF): tool-UI renders the
      //     structured error envelope and any stale-diff CTA.
      //
      // We do surface a user-facing error through the store when the
      // backend reports a failure without componentId context so the
      // workspace's error banner can pick it up — but we leave diff /
      // targetExistedBefore / errorCode inspection to the tool-UI
      // component, which already holds the raw result.
      if (!success && isLive && error && !store.error) {
        store.setError(error);
      }
      break;

    case "readSource":
    case "list":
    case "status":
    case "install":
      break;

    // -----------------------------------------------------------------------
    // Sprint 3 W3.1 — persisted design snapshot actions.
    //
    // These actions (save / pin / rename / list / delete) manage persisted
    // iteration memory — named / pinned source-code checkpoints stored in
    // the `design_snapshots` DB table. They are intentionally COSMETIC from
    // the Zustand store's perspective: the workspace's undo-history and the
    // transient in-memory `DesignSnapshot` on `store.activeComponent` remain
    // the source of truth for live editing. Persisted snapshots are their
    // own concept — surfaced through the tool-UI cards and future "saved
    // snapshots" drawer.
    //
    // On success the bridge does nothing (all state is rendered by the
    // tool-UI from the event `data` directly); on failure we forward
    // the backend error to the store banner so the user isn't left guessing.
    // -----------------------------------------------------------------------
    case "snapshot.save":
    case "snapshot.pin":
    case "snapshot.rename":
    case "snapshot.list":
    case "snapshot.delete":
    // -----------------------------------------------------------------------
    // Sprint 3 W3.2 — `snapshot.diff`. Session-local display only: the diff
    // lives in the envelope `data.diff` + `data.a` / `data.b` summary and is
    // rendered by the tool-UI panel. No Zustand mutation on success; on a
    // live failure we surface the error string through the store banner
    // (same contract as the other snapshot.* actions above).
    // -----------------------------------------------------------------------
    case "snapshot.diff":
      if (!success && isLive && error && !store.error) {
        store.setError(error);
      }
      break;

  }
}

/**
 * Outcome of the persisted-pointer rehydration GET, returned by
 * `applyRehydrationResultToStore` so tests can lock in the contract
 * without mounting React. Each variant maps 1:1 to the branch that fired.
 *
 *   - "skipped-live-selection": the user already made a live selection
 *     while the GET was in flight (H1 guard) — the historical pointer
 *     was discarded; the dedup anchor was updated to the live value.
 *   - "skipped-session-switched": the bridge swapped to a different
 *     session between GET issue and GET response.
 *   - "skipped-request-failed": the GET itself failed — nothing applied
 *     and the dedup anchor is left undefined so the subscription effect
 *     treats the first tick as informational.
 *   - "cleared-null": GET resolved to null and we explicitly cleared the
 *     active component (M1 fix — no stale content left).
 *   - "applied": GET resolved to a pointer that differs from the current
 *     active component and we applied it.
 *   - "no-op-same-pointer": GET resolved to the already-active pointer;
 *     no store mutation needed.
 *   - "no-op-already-null": GET resolved to null and the store was
 *     already in the no-selection state.
 */
export type RehydrationApplyOutcome =
  | "skipped-live-selection"
  | "skipped-session-switched"
  | "skipped-request-failed"
  | "cleared-null"
  | "applied"
  | "no-op-same-pointer"
  | "no-op-already-null";

/**
 * Apply the result of `requestActiveComponent` to the design workspace
 * store under the rules documented in `RehydrationApplyOutcome`.
 *
 * Exported so tests can verify H1 (live-selection guard) and M1 (null
 * clears stale content) without mounting the React bridge. Production
 * callers go through the `DesignWorkspaceBridge` effect, which owns
 * the refs + abort controller and forwards them here.
 *
 * `refs` are a `{ get, set }` pair (rather than React refs) so unit
 * tests can use plain objects. The bridge's `useEffect` adapts its
 * `MutableRefObject<T>` refs via `{ get: () => ref.current, set: (v) => { ref.current = v; } }`.
 */
export function applyRehydrationResultToStore(params: {
  result: {
    success: boolean;
    lastActiveComponentId?: string | null;
    error?: string;
  };
  capturedSessionId: string;
  liveSelectionMadeRef: { get: () => boolean };
  lastPersistedRef: {
    get: () => string | null | undefined;
    set: (value: string | null | undefined) => void;
  };
}): RehydrationApplyOutcome {
  const { result, capturedSessionId, liveSelectionMadeRef, lastPersistedRef } = params;

  // H1 guard: the user (or a live tool event) has already mutated
  // activeComponentId while this GET was in flight. The live selection
  // wins; the historical pointer we just read is stale. Seed the dedup
  // anchor to the live value so the pending POST in the subscription
  // effect proceeds.
  if (liveSelectionMadeRef.get()) {
    const liveState = useDesignWorkspaceStore.getState();
    if (liveState.sessionId === capturedSessionId) {
      lastPersistedRef.set(liveState.activeComponentId);
    }
    return "skipped-live-selection";
  }

  const persistedId = result.success
    ? result.lastActiveComponentId ?? null
    : undefined;
  if (persistedId !== undefined) {
    // Seed the dedup anchor so the first subscription tick (which always
    // fires with the current value) doesn't re-POST the value we just
    // read.
    lastPersistedRef.set(persistedId);
  }

  if (!result.success) return "skipped-request-failed";

  const state = useDesignWorkspaceStore.getState();
  // Don't clobber a newer session that fired while the GET was in flight
  // (e.g. user navigated to a different chat).
  if (state.sessionId !== capturedSessionId) return "skipped-session-switched";

  // M1 fix: when the GET resolves to null, explicitly clear the active
  // component. Previously we returned early, leaving whatever the store
  // was carrying (e.g. stale code from a cached session snapshot) —
  // the user saw the previously-loaded component's content instead of
  // the empty/picker state.
  if (persistedId === null || persistedId === undefined) {
    if (state.activeComponentId !== null) {
      state.setActiveComponent(null);
      return "cleared-null";
    }
    return "no-op-already-null";
  }

  if (state.activeComponentId === persistedId) return "no-op-same-pointer";
  state.setActiveComponent(persistedId);
  return "applied";
}

const EVENT_NAME = "design-workspace-tool-result";

/**
 * Global queue for events dispatched before any bridge mounts.
 * Keyed by sessionId so each session accumulates its own queue.
 *
 * Once a bridge mounts for a session, it drains only that session's events
 * and sets `bridgeReady` to true so subsequent events go directly through
 * the DOM listener.
 *
 * Events without a sessionId are keyed under "__nosession__".
 *
 * Capped at MAX_PENDING per session to prevent unbounded growth if the
 * bridge never mounts (e.g. workspace feature disabled, render error).
 */
const MAX_PENDING = 50;
let bridgeReady = false;
const pendingEvents = new Map<string, DesignToolEvent[]>();

const NO_SESSION_KEY = "__nosession__";

function getSessionKey(event: DesignToolEvent): string {
  return event.sessionId || NO_SESSION_KEY;
}

/**
 * Dispatch a design workspace tool result as a CustomEvent.
 * Call this from the tool UI component when a tool result arrives.
 *
 * If no bridge is mounted yet, the event is queued (by session) for replay on mount.
 * Events are ALWAYS queued (in addition to dispatching) because the bridge
 * may be in the brief gap between effect cleanup and re-setup during a
 * session switch — the DOM listener is detached but bridgeReady hasn't
 * been set to false yet. The bridge deduplicates on drain.
 */
export function dispatchDesignToolResult(detail: DesignToolEvent): void {
  // Queue by session so the correct bridge mount drains the right events
  const key = getSessionKey(detail);
  let queue = pendingEvents.get(key);
  if (!queue) {
    queue = [];
    pendingEvents.set(key, queue);
  }
  if (queue.length < MAX_PENDING) {
    queue.push(detail);
  }

  // Also dispatch live in case a listener is already attached
  if (bridgeReady) {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  }
}

interface DesignWorkspaceBridgeProps {
  /** Current chat session ID — only events matching this session are processed */
  sessionId?: string;
  /** Current agent/character ID — used by preview recompiles to resolve synced folders. */
  characterId?: string;
}

export function DesignWorkspaceBridge({ sessionId, characterId }: DesignWorkspaceBridgeProps) {
  // Start as null (not sessionId!) so the first mount ALWAYS triggers a session switch.
  // This prevents stale isOpen:true from leaking when the component remounts
  // (e.g., parent key change, route navigation) — the ref would otherwise
  // re-initialize to the current sessionId, making prev === current, skipping reset.
  const prevSessionIdRef = useRef<string | undefined | null>(null);

  // Sprint 4 W4.3 — persisted active-component pointer write-side.
  //
  // `lastPersistedRef` deduplicates POSTs so a rapid `activeComponentId`
  // toggle (e.g. user clicking through the gallery) only hits the server
  // once per settled value. The timer debounces: the pointer writes after
  // ~400ms of inactivity, matching the "user stopped navigating" window
  // without making the agent wait. The abort controller cancels any
  // in-flight POST on session change / unmount so we never persist a
  // pointer from an old session onto a new one.
  const lastPersistedRef = useRef<string | null | undefined>(undefined);
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeAbortRef = useRef<AbortController | null>(null);
  const rehydrationAbortRef = useRef<AbortController | null>(null);
  // Sprint 4 W4.3 — Rev-J2 / H1 fix: rehydration race guard.
  //
  // Flipped to `true` by the subscription effect the first time the user
  // (or a live tool event) mutates `activeComponentId` after a session
  // opens. The rehydration GET callback checks this ref and bails before
  // applying the persisted value — the live selection wins over the
  // historical pointer so an in-flight GET cannot clobber what the user
  // just did. Reset on every session switch so the next session starts
  // with a clean slate.
  const liveSelectionMadeRef = useRef<boolean>(false);

  // Single merged effect: switch session on change, drain queue, bind listener.
  // Merged to guarantee ordering — session switch MUST happen before queue drain.
  useEffect(() => {
    // Switch session when session changes (or on first mount)
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;

      // Cancel any pending write from the previous session. A session
      // switch invalidates both the debounce target and the in-flight
      // POST — otherwise we could persist session A's componentId onto
      // session B after the user switches.
      if (writeTimerRef.current !== null) {
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
      }
      writeAbortRef.current?.abort();
      writeAbortRef.current = null;
      rehydrationAbortRef.current?.abort();
      rehydrationAbortRef.current = null;
      // Reset the dedup anchor — the new session starts with an unknown
      // persisted value.
      lastPersistedRef.current = undefined;
      // Reset the live-selection guard — the new session starts with no
      // user interaction, so a fresh rehydration GET is allowed to apply.
      liveSelectionMadeRef.current = false;

      if (sessionId) {
        useDesignWorkspaceStore.getState().setActiveSession(sessionId, characterId);

        // Rehydrate the persisted "last active component" pointer. The
        // GET returns null for never-set and stale pointers alike (the
        // server transparently cleans up stale pointers), so we treat
        // both as "no selection to restore". A live componentId is
        // applied via `setActiveComponent`; if the component isn't yet
        // in the session's component list the store clears the active
        // id — a subsequent tool-event hydration then activates it.
        const rehydrationAbort = new AbortController();
        rehydrationAbortRef.current = rehydrationAbort;
        const capturedSessionId = sessionId;
        void (async () => {
          const result = await requestActiveComponent(
            capturedSessionId,
            rehydrationAbort.signal,
          );
          if (rehydrationAbort.signal.aborted) return;
          // Delegated to the exported helper so the H1 / M1 logic is
          // directly unit-testable without mounting the React effect.
          applyRehydrationResultToStore({
            result,
            capturedSessionId,
            liveSelectionMadeRef: {
              get: () => liveSelectionMadeRef.current,
            },
            lastPersistedRef: {
              get: () => lastPersistedRef.current,
              set: (value) => {
                lastPersistedRef.current = value;
              },
            },
          });
        })();
      } else {
        useDesignWorkspaceStore.getState().reset();
      }
    }

    function processEvent(detail: DesignToolEvent) {
      // Session isolation: if bridge has a session, require event to match.
      // Events without sessionId (legacy tool results) are dropped when the
      // bridge is session-aware — this prevents cross-session pollution from
      // old chat history re-renders.
      if (sessionId && detail.sessionId !== sessionId) {
        return;
      }

      applyDesignToolResultToStore(detail);
    }

    // Track which events have been processed to deduplicate queue drain vs live dispatch.
    // Uses a WeakSet on the event detail object reference — cheap and automatic GC.
    const processed = new WeakSet<DesignToolEvent>();

    function handleToolResult(e: Event) {
      const detail = (e as CustomEvent<DesignToolEvent>).detail;
      if (processed.has(detail)) return;
      processed.add(detail);
      processEvent(detail);
    }

    // Drain only this session's queued events
    bridgeReady = true;
    const queueKey = sessionId || NO_SESSION_KEY;
    const toDrain = pendingEvents.get(queueKey);
    if (toDrain) {
      pendingEvents.delete(queueKey);
      for (const queued of toDrain) {
        if (processed.has(queued)) continue;
        processed.add(queued);
        processEvent(queued);
      }
    }

    window.addEventListener(EVENT_NAME, handleToolResult);
    return () => {
      window.removeEventListener(EVENT_NAME, handleToolResult);
      // Set bridgeReady to false but DON'T drain — events accumulate until next mount
      bridgeReady = false;
    };
  }, [sessionId]); // re-bind when session changes

  // Sprint 4 W4.3 — persist `activeComponentId` changes to the session row.
  //
  // Subscribes to the store and POSTs whenever the settled value differs
  // from the last persisted value. Debounced by ~400ms so fast clicks
  // through a gallery produce one write per settled selection (not one
  // per intermediate hop). Aborts on session change / unmount so we never
  // persist a stale value.
  useEffect(() => {
    if (!sessionId) return;

    const unsubscribe = useDesignWorkspaceStore.subscribe((state) => {
      // Guard: only react when the subscription is still observing the
      // bridge's mounted session. `setActiveSession` swaps the store's
      // `sessionId`, and we must not persist cross-session mutations.
      if (state.sessionId !== sessionId) return;

      const nextId: string | null = state.activeComponentId;

      // First tick is informational — `lastPersistedRef` is seeded by the
      // rehydration GET (or left undefined when the GET failed). Treat
      // an undefined anchor as "no prior value to compare against" and
      // set it without writing — the server already holds this value
      // (or a failed GET means we can't infer what to compare to).
      if (lastPersistedRef.current === undefined) {
        lastPersistedRef.current = nextId;
        return;
      }

      if (lastPersistedRef.current === nextId) return;

      // Rev-J2 / H1 fix: the anchor diverges from the live value, i.e.
      // activeComponentId changed from something our rehydration logic
      // didn't do (rehydration seeds the anchor BEFORE calling
      // setActiveComponent, so its own write produces anchor === next).
      // Flip the guard so the in-flight rehydration GET's callback
      // knows the user has already acted and bails instead of clobbering.
      liveSelectionMadeRef.current = true;

      // Schedule a debounced write. A pending timer is replaced so only
      // the most recent settled value is written.
      if (writeTimerRef.current !== null) {
        clearTimeout(writeTimerRef.current);
      }
      const capturedSessionId = sessionId;
      writeTimerRef.current = setTimeout(() => {
        writeTimerRef.current = null;
        // Re-check the live store value inside the timer — the ID may
        // have changed again between schedule and fire, in which case
        // we prefer the freshest value.
        const liveState = useDesignWorkspaceStore.getState();
        if (liveState.sessionId !== capturedSessionId) return;
        const liveId: string | null = liveState.activeComponentId;
        if (liveId === lastPersistedRef.current) return;

        writeAbortRef.current?.abort();
        const abort = new AbortController();
        writeAbortRef.current = abort;
        void (async () => {
          const result = await requestSetActiveComponent(
            capturedSessionId,
            liveId,
            abort.signal,
          );
          if (abort.signal.aborted) return;
          if (result.success) {
            lastPersistedRef.current = liveId;
          } else {
            // Leave the anchor in place so we retry on the next change.
            // A scope-mismatch error means the id was rejected — the
            // server wouldn't accept this pointer, so a stable user
            // action (click another component) is the natural recovery.
            console.warn(
              "[design-bridge] Failed to persist active component:",
              result.error,
              result.reason,
            );
          }
        })();
      }, 400);
    });

    return () => {
      unsubscribe();
      if (writeTimerRef.current !== null) {
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
      }
      writeAbortRef.current?.abort();
      writeAbortRef.current = null;
    };
  }, [sessionId]);

  // This component renders nothing — it's a side-effect bridge
  return null;
}

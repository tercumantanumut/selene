/**
 * Design Workspace Tool
 *
 * Minimal iteration-first control surface for the design workspace.
 * The durable source of truth is persisted design source code plus preview,
 * not transient server cache state.
 */

import { tool, jsonSchema } from "ai";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import type { JSONValue } from "@ai-sdk/provider";
import { withToolLogging } from "@/lib/ai/tool-registry/logging";
import { loadSettings } from "@/lib/settings/settings-manager";
import { generateCard, editCard } from "../../design";
import type { AssetContext } from "../../design/types";
import {
  detectAvailableLibraries,
  getAvailableLibrariesPrompt,
  SANDBOX_DIR,
  type DesignLibrary,
} from "../../design/libraries";
import { getProjectRoot } from "../../utils/project-root";
import {
  buildDesignPreviewErrorHtml,
} from "../../design/workspace/preview";
import {
  buildTailwindPreviewWithMetadata,
  isDesignWorkspaceCompileError,
  isDesignWorkspaceGlobalsCssError,
  isDesignWorkspaceImportError,
  RENDER_MANY_MAX_CELLS,
  type DesignAssetAlias,
  type DesignImportErrorCode,
  type DesignWorkspaceGlobalsCssError,
  type DesignWorkspaceImportError,
  type RenderManyCell,
} from "../../design/workspace/compiler";
import {
  DEFAULT_DESIGN_WORKSPACE_CONFIG,
  getDesignWorkspaceConfigFromSettingsRecord,
  type DesignWorkspaceCompileReport,
  type DesignWorkspaceConfig,
  type DesignWorkspaceValidationResult,
} from "../../design/workspace/config";
import {
  finalizeDesignHistory,
  initDesignHistory,
  peekDesignHistory,
  recordDesignHistory,
  type DesignWorkspaceHistory,
} from "../../design/workspace/edit-history";
import { installSandboxPackages } from "../../design/workspace/dependencies";
import { runPostEditValidation } from "../../design/workspace/validation";
import { getFullPathFromMediaRef } from "../../storage/local-storage";
import {
  updateDesignComponent,
  upsertImportedDesignComponent,
} from "../../design/gallery/queries";
import {
  createSnapshot,
  deleteSnapshot,
  findSnapshotById,
  listSnapshots,
  pinSnapshot,
  renameSnapshot,
  SNAPSHOT_LIST_HARD_CAP,
  SNAPSHOT_NAME_MAX_LENGTH,
  SnapshotCreateError,
} from "../../design/gallery/snapshot-queries";
import type { PersistedDesignSnapshot } from "../../design/workspace/persisted-snapshot-types";
import type { DesignComponentMetadata } from "../../design/gallery/types";
import {
  findWorkspaceDesign,
  listWorkspaceDesigns,
  saveDesignComponentRecord,
  type DesignGalleryItem,
} from "../../design/gallery/service";
import fs from "fs/promises";
import path from "path";
import {
  buildInspectPromptText,
  type InspectMessageContext,
} from "../../design/workspace/inspect-context";
import {
  applyPatches as applyDesignPatches,
  findUnclosedJsxTag,
  type PatchOp,
} from "../../design/workspace/patch-logic";
import {
  captureScreenshot,
  type ScreenshotResult,
  type ScreenshotStateEntry,
  type ScreenshotStatePseudo,
  type ScreenshotStateRequest,
  type ScreenshotViewport,
} from "../../design/workspace/screenshot";
import type { DesignPreviewTheme } from "../../design/workspace/types";
import {
  findOwningSyncedFolder,
  loadTsconfigPaths,
  type TsconfigPathsConfig,
} from "../../design/workspace/tsconfig-paths";
// Round-2 (B1+M5): synced-folder containment for the `import` action.
// `buildContainmentConfig` is called from `handleImport` with the
// owning synced folder + sandbox node_modules + project root + any
// extra node paths; the resulting config is threaded through the
// compiler so onLoad rejects paths outside the allowlist.
import {
  buildContainmentConfig,
  type ContainmentConfig,
} from "../../design/workspace/containment";
// Direct source imports (no barrel) per W2.2 hard constraint.
import { resolveSyncedPath, resolveWorkspaceAwarePaths } from "../filesystem/path-utils";
import { atomicWriteFile } from "../filesystem/write-utils";
import {
  readSyncedFile,
  isReadSyncedFileError,
  type ReadSyncedFileErrorCode,
} from "../filesystem/read-utils";
import { createPortDiff } from "../../design/workspace/diff";
import { createHash } from "crypto";

interface DesignWorkspaceToolOptions {
  sessionId?: string;
  userId?: string;
  characterId?: string;
  /** Inspect context from the user's message, when available. */
  inspectContext?: InspectMessageContext | null;
  /**
   * Per-request fallback forwarded from the client's Zustand
   * `useDesignWorkspaceStore.previewTheme`. Applied whenever the LLM omits
   * `previewTheme` from the tool input — the tool is the only place with
   * access to BOTH the model's argument and the client's active UI theme,
   * so merging here closes the Sprint 1 reviewer gap where mutating tool
   * calls always captured dark screenshots regardless of the user's
   * currently-visible workspace theme.
   *
   * Never substitutes a hardcoded default — when both the LLM input and
   * this option are undefined, the screenshot service falls through to
   * `buildExportPreviewHtml` (see `captureScreenshot` in
   * `lib/design/workspace/screenshot.ts`), preserving the existing
   * theme-omitted behavior.
   */
  defaultPreviewTheme?: DesignPreviewTheme;
}

interface DesignWorkspaceInput {
  action:
    | "open"
    | "generate"
    | "edit"
    | "patch"
    | "readSource"
    | "list"
    | "status"
    | "close"
    | "install"
    | "port"
    | "import"
    // Sprint 3 W3.1 — persisted snapshot actions. These promote iteration
    // memory from the transient Zustand undo history (which stays untouched)
    // into durable `design_snapshots` rows. See
    // `lib/design/gallery/snapshot-queries.ts` for the query surface and
    // `lib/design/workspace/persisted-snapshot-types.ts` for the row shape.
    | "snapshot.save"
    | "snapshot.pin"
    | "snapshot.rename"
    | "snapshot.list"
    | "snapshot.delete"
    // Sprint 3 W3.2 — side-by-side diff of two persisted snapshots. Reads
    // two `design_snapshots` rows in the current (userId, sessionId) scope
    // and runs `createPortDiff` over their `source_code` to emit a unified
    // diff for side-by-side inspection. See `handleSnapshotDiff`.
    | "snapshot.diff";

  // ---------------------------------------------------------------------------
  // Sprint 3 W3.1 — snapshot action inputs.
  //
  // These are scoped to the `snapshot.*` action family and silently ignored
  // by the rest of the dispatch surface. Kept at the top of the input
  // shape so the grouping is legible in the JSON schema generated below.
  // ---------------------------------------------------------------------------

  /**
   * Identifier of an existing persisted snapshot row. Required for
   * `snapshot.pin`, `snapshot.rename`, and `snapshot.delete`.
   */
  snapshotId?: string;

  /**
   * TSX source to persist on a `snapshot.save`. When omitted the handler
   * fetches the current source from `design_components` via
   * `findWorkspaceDesign` — this makes "snapshot the current state of the
   * active component" a one-argument call.
   */
  sourceCode?: string;

  /**
   * Pin state for `snapshot.pin` (required) and optional initial pin flag
   * for `snapshot.save`.
   */
  isPinned?: boolean;

  /**
   * When true on `snapshot.list`, only pinned snapshots are returned.
   */
  isPinnedOnly?: boolean;

  /**
   * Optional cap on `snapshot.list` rows returned. Clamped to 100 at the
   * query level; over-cap requests surface `truncated: true` on the
   * envelope without throwing.
   */
  limit?: number;

  /**
   * Sprint 3 W3.2 — `snapshot.diff` input pair.
   *
   * Both `a` and `b` are persisted snapshot row ids (from the current
   * `design_snapshots` scope: same `userId`, same `sessionId`). Cross-user
   * and cross-session ids fail with `SNAPSHOT_NOT_FOUND` (no existence
   * leak) — mirrors the read-isolation contract the other snapshot
   * actions already enforce via `findSnapshotById`.
   */
  a?: string;
  b?: string;

  /**
   * Sprint 3 W3.2 — `snapshot.diff` truncation budget.
   *
   * Optional cap on the number of unified-diff lines returned. Defaults to
   * 1000. Requests above 5000 are rejected with
   * `SNAPSHOT_DIFF_INVALID_INPUT` at the handler boundary so the agent
   * gets a deterministic, cheap error envelope rather than paying the
   * compute for a huge diff that would also bust the tool's result-token
   * cap downstream.
   */
  maxLines?: number;

  /** npm package names to install. Required for "install" action. */
  packages?: string[];

  // ---------------------------------------------------------------------------
  // "import" action — Sprint 2 W2.1.
  // Read an existing TSX file from a character synced folder, validate via
  // the same compile pipeline `generate` uses, and persist as a
  // DesignComponentRow with `metadata.sourcePath` / `metadata.importedAt`.
  // Repeated imports of the same `(userId, sessionId, sourcePath)` triple
  // UPDATE the existing row in place rather than creating duplicates.
  // ---------------------------------------------------------------------------
  /**
   * Synced-folder-relative (or absolute) TSX file path for `action: "import"`.
   * Resolved via `resolveSyncedPath(characterId, sessionId, sourcePath)` so the
   * agent cannot read arbitrary files outside the character's synced folders.
   */
  sourcePath?: string;
  /**
   * Free-form tags to attach to the imported design row. Kept as a plain
   * `string[]` per the W2.1 anti-scope guidance — no atom/molecule schema.
   * When omitted (or missing the sentinel), `"imported"` is added
   * automatically so the workspace UI can filter for imports.
   */
  tags?: string[];

  // ---------------------------------------------------------------------------
  // "port" action — write a workspace component back to a synced-folder path.
  // ---------------------------------------------------------------------------
  /**
   * The workspace component to port. Required for "port".
   * NOTE: `componentId` is a dedicated field (NOT the existing
   * `activeComponentId`) because the W2.2 spec explicitly names it in the
   * action shape. We keep `activeComponentId` unchanged for backwards
   * compatibility with the other actions.
   */
  componentId?: string;
  /** Synced-folder-relative path the component should be written to. */
  targetPath?: string;
  /**
   * When true (or omitted), never writes — returns the computed unified diff
   * plus metadata so the user/agent can inspect before approving. Defaults
   * to `true` per the approval-gate requirement.
   */
  dryRun?: boolean;
  /**
   * When the target file exists AND differs, require explicit opt-in. If
   * `overwrite` is false/omitted and the target differs, the tool returns a
   * structured TARGET_EXISTS_MUST_OVERWRITE error envelope — it does not
   * throw. Irrelevant when the target doesn't exist.
   */
  overwrite?: boolean;

  /**
   * BA-warn-5 / Rev-C2 — port freshness guard.
   *
   * SHA-256 of the on-disk target captured during the preceding dry-run
   * (returned as `data.preflight.contentSha256`). On `dryRun:false` apply
   * calls this field is REQUIRED — right before `atomicWriteFile` the
   * tool re-reads the target, hashes it, and rejects with
   * `errorCode: "PORT_STALE_DIFF"` if the hash differs from the value
   * the caller supplied here.
   *
   * The only way to apply WITHOUT echoing this hash back is to pass
   * `allowStaleWrite: true` on the same call, which is an explicit,
   * auditable opt-out. See `allowStaleWrite` below.
   */
  expectedContentSha256?: string;

  /**
   * Rev-C2 — opt-out for the port freshness guard.
   *
   * When `dryRun:false` and the caller cannot (or chooses not to)
   * provide `expectedContentSha256`, they MUST set this flag to `true`.
   * Omitting both produces an `INVALID_INPUT` error at the handler-level
   * pre-filesystem validation step (the check runs at the top of
   * `handlePort` before any path resolution or filesystem read). This
   * converts the freshness guard from opt-in (the Rev-B default) to
   * opt-out so the caller has to deliberately acknowledge the race risk.
   *
   * Stateless by design: we do NOT look up whether a dry-run has
   * happened in this session; the contract is purely based on the
   * single call's inputs. A caller that wants the simple one-shot
   * write ("apply-fresh") passes `allowStaleWrite: true`; a caller
   * applying a previously-approved diff passes
   * `expectedContentSha256: <hash-from-dry-run>`.
   */
  allowStaleWrite?: boolean;

  prompt?: string;
  mode?: "tailwind";
  style?: "apple-glass" | "default";

  editPrompt?: string;
  activeComponentCode?: string;
  activeComponentId?: string;

  /** Short, descriptive name for the component (e.g. "Pricing Card", "Login Form"). */
  name?: string;
  code?: string;
  assets?: Array<{ url: string; description?: string }>;

  /**
   * Per-call `@asset/<alias>` resolution map (W2.3).
   *
   * When provided on `action: "generate" | "edit" | "patch"`, the compiler
   * rewrites every `@asset/<alias>` reference in the component TSX source to
   * the declared URL before bundling. This lets generated code write stable
   * references like `src="@asset/hero"` or `url("@asset/bg")` even though
   * the underlying media URL (`/api/media/...`) is opaque and request-scoped.
   *
   * NOT persisted on the component row — passed every turn by the LLM.
   *
   * Kept SEPARATE from the existing `assets` field above because that field
   * feeds the multimodal generation pipeline (`resolveAssets` → AssetContext
   * with base64 payloads) and has different semantics (description strings,
   * data-URI handling). The alias feature is a compile-time rewrite only.
   */
  assetAliases?: Array<{ url: string; alias: string }>;

  /** String to find in the active component code. For "patch" action. */
  oldString?: string;
  /** Replacement string. For "patch" action. */
  newString?: string;
  /** Replace all occurrences (default: false). For "patch" action. */
  replaceAll?: boolean;

  /**
   * Array of sequential patches for multi-location edits (e.g., wrapping).
   * Each patch is applied in order to the result of the previous one.
   * For "patch" action. Use instead of oldString/newString when the edit
   * requires changes at multiple locations in the source.
   */
  patches?: Array<{ oldString: string; newString: string; replaceAll?: boolean }>;

  /**
   * Optional viewport override for the post-action screenshot capture.
   * Executor defaults to { width: 1440, height: 900, deviceScaleFactor: 2 }.
   * Applies only to mutating actions (generate/edit/patch) when
   * returnScreenshot !== false.
   */
  viewport?: { width: number; height: number; deviceScaleFactor: number };

  /**
   * CSS selectors the screenshot service should probe on the rendered preview
   * to extract agent-actionable diagnostics (computed styles, bounding rects).
   * Hard size limits enforced at runtime: max 16 selectors, each <= 200 chars.
   */
  probeSelectors?: string[];

  /**
   * Sprint 4 W4.1 — CDP state harness. When provided, the screenshot service
   * captures ONE additional PNG per entry with the corresponding pseudo-class
   * force-applied to `selector` via Chrome DevTools Protocol
   * `Emulation.setEmulatedPseudoState`. Captures run on a fresh page per entry
   * so leaked pseudo state cannot bleed into the base screenshot or adjacent
   * state captures.
   *
   * Hard size limits enforced at runtime: max 8 entries, each selector <= 200
   * chars, `pseudo` must be one of `hover`, `focus-visible`, `active`,
   * `disabled`. Malformed entries (unsupported pseudo, missing selector) are
   * dropped at the tool boundary BEFORE the screenshot service is invoked.
   * Runtime failures (selector didn't resolve, CDP error) surface as
   * structured per-entry error envelopes inside `stateScreenshots[N].error`
   * without failing the base capture.
   */
  states?: Array<{
    selector: string;
    pseudo: "hover" | "focus-visible" | "active" | "disabled";
    label?: string;
  }>;

  /**
   * When false, the tool skips screenshot capture for this call (fast iteration
   * mode). The envelope still emits `previewHtmlRef` so the agent knows to
   * fetch full HTML via the `readSource` action if needed. Defaults to true.
   */
  returnScreenshot?: boolean;

  /**
   * Active preview theme to render under. When provided, forwarded to the
   * compiler so the post-action screenshot + probe computed-styles match the
   * theme the user currently sees in the workspace. Accepts the full
   * `DesignPreviewTheme` — `"system"` renders the inline media-query IIFE
   * from compiler.ts so Tailwind's class-based dark mode still toggles.
   *
   * Left optional so the tool caller (UI bridge) can forward the active
   * Zustand `previewTheme` without a schema churn — when omitted, the
   * compiler's own default applies (see
   * `buildTailwindPreviewWithMetadata`). The tool itself never substitutes
   * a hardcoded `"dark"` here; doing so would re-introduce the reviewer
   * blocker by making light/system previews capture a dark screenshot.
   */
  previewTheme?: DesignPreviewTheme;

  /**
   * Synced-folder-relative path to the real app's `globals.css`. When
   * provided on a mutating action ("generate" | "edit" | "patch" — plus
   * "import" if that action pipes through the compiler), the compiler
   * resolves the path via `resolveSyncedPath(…, characterId, sessionId)`,
   * reads the file, and injects the CSS as an inline
   * `<style data-source="globals">` block at the TOP of `<head>` — BEFORE
   * the preview theme vars / Tailwind utilities. This mirrors how a real
   * Next.js app layers `app/layout.tsx` + `globals.css`, so the generated
   * component renders against the real app's design tokens, theme
   * variables, and base styles.
   *
   * IMPORTANT: this is NOT a parallel tokens store. The tool never copies
   * or caches globals.css into the DB — it reads fresh from the synced
   * folder on every compile. The real app's globals.css IS the source of
   * truth.
   *
   * Resolution failures surface as structured envelopes on
   * `data.globalsCssError` with stable codes:
   *   `GLOBALS_CSS_NOT_FOUND` — path unresolvable or read failed.
   *   `GLOBALS_CSS_NOT_CSS`   — path is not a .css file.
   *   `GLOBALS_CSS_EMPTY`     — file is whitespace-only.
   *   `GLOBALS_CSS_TOO_LARGE` — file exceeds `GLOBALS_CSS_MAX_BYTES` (256KB).
   *
   * Requires `characterId` + `sessionId` on the tool options — when either
   * is missing the envelope surfaces `GLOBALS_CSS_NOT_FOUND` rather than
   * silently falling back to a token-less preview.
   *
   * Example: "sanity-seline/app/globals.css".
   */
  globalsCssPath?: string;

  /**
   * W3.3 — optional reference image URL to render as a fixed-position
   * overlay on top of the compiled preview, with a small control panel
   * (opacity slider, show/hide toggle, normal/difference blend-mode select)
   * driven by vanilla JS.
   *
   * Accepts `https?://...`, `/api/media/...`, or `data:image/...;base64,...`
   * (mirroring the W2.3 assetAliases URL policy plus inline data URIs, so
   * one-shot debug overlays don't require a media-store round trip).
   *
   * When provided on a mutating action (generate/edit/patch), the success
   * envelope carries `referenceImage: { url, present: true }` so the agent
   * knows the overlay was rendered. If the image fails to load in the
   * preview iframe, the overlay root stamps
   * `data-design-reference-error="true"` — probeable from the screenshot
   * service without touching the agent envelope.
   *
   * NOT persisted on the component row — this is a per-compile cosmetic
   * overlay, not a design-time asset.
   */
  referenceImageUrl?: string;

  /**
   * W3.4 — auto-grid rendering of arbitrary prop permutations.
   *
   * When supplied on a mutating action ("generate" | "edit" | "patch"),
   * REPLACES the default single-render `<Component />` with a CSS grid.
   * Each entry is rendered as one cell with `props` passed as the
   * component's full prop set, optionally chromed by `label` and
   * `className`. Each cell carries `data-design-cell-index="N"` so the
   * agent can target individual cells via probeSelectors (and the
   * screenshot service continues to capture the whole viewport — no
   * change to screenshot.ts required).
   *
   * Low-level primitive on purpose: the caller supplies the full array
   * of render specs. The tool does NOT auto-infer permutations from
   * prop types, and the `props` bag is treated as opaque JSON — passed
   * verbatim to the component at render time. See the compiler's
   * `encodeJsonForJsStringLiteral` for the serialization security
   * rationale (JSX-injection + `</script>`-escape defenses).
   *
   * Capped at `RENDER_MANY_MAX_CELLS` (24). Over-cap requests surface
   * `errorCode: "RENDER_MANY_TOO_MANY"`. Invalid entries (non-object
   * `props`, missing `props`) surface
   * `errorCode: "RENDER_MANY_INVALID_PROPS"` with the offending index.
   * Both paths fail BEFORE any compile work so the agent gets a
   * deterministic, cheap error envelope.
   */
  renderMany?: Array<{
    props: Record<string, unknown>;
    label?: string;
    className?: string;
  }>;
}

interface ListedDesignSummary {
  id: string;
  name: string;
  source: "session" | "saved";
  updatedAt?: string;
  isFavorite?: boolean;
}

interface DesignWorkspaceResultData {
  componentId?: string;
  code?: string;
  name?: string;
  message?: string;
  prompt?: string;
  mode?: string;
  style?: string;
  previewHtml?: string;
  availableLibraries?: string[];
  compileReport?: DesignWorkspaceCompileReport;
  postEditValidation?: DesignWorkspaceValidationResult;
  history?: DesignWorkspaceHistory;
  config?: DesignWorkspaceConfig;
  missingPackages?: string[];
  autoRecoveryAttempted?: boolean;
  autoRecoveryResult?: "success" | "failed" | "not-needed";
  agentErrorSummary?: string;
  components?: ListedDesignSummary[];
  status?: "available" | "missing" | "inline";
  storage?: {
    database: boolean;
    userScoped: boolean;
    sessionScoped: boolean;
  };
  recoveryHint?: string;
  updatedAt?: string;
  /**
   * Compact summary fields used when heavy payload fields (`code`, `previewHtml`)
   * are stripped to keep the tool result under the AI runtime's token cap.
   * The client bridge hydrates full data from the DB via `componentId`.
   */
  truncated?: boolean;
  codeLength?: number;
  codeLines?: number;
  /**
   * Agent-actionable replacement for the legacy stripped `previewHtmlLength`.
   * Always emitted on mutating actions (generate/edit/patch) regardless of
   * whether a screenshot was captured, so the agent knows the preview exists
   * and how to retrieve the full HTML when necessary.
   */
  previewHtmlRef?: { length: number; getVia: "readSource" };
  /** Post-action screenshot of the rendered preview (when captured). */
  screenshot?: ScreenshotResult["screenshot"];
  /** Probe results (computed styles / bounding rects) for requested selectors. */
  probes?: ScreenshotResult["probes"];
  /**
   * Sprint 4 W4.1 — per-state captures (present only when the caller passed
   * a non-empty `states` input). Each entry is either a successful capture
   * `{ label, pseudo, selector, screenshot, probes? }` or a structured
   * error `{ label, pseudo, selector, error: { code, message } }`.
   *
   * Mirrors `ScreenshotResult["stateScreenshots"]`. Emitted alongside the
   * base `screenshot` so the agent can reason about hover / focus-visible /
   * active / disabled visuals without re-rendering the preview.
   */
  stateScreenshots?: ScreenshotStateEntry[];
  /**
   * Populated when screenshot capture was requested but failed. Object
   * shape (`{ message, code? }`) instead of a bare string so future fields
   * (e.g. structured error codes, retry hints) can be added without
   * breaking consumers. The UI renders `.message` — never the object
   * itself — so nothing surfaces `[object Object]`.
   */
  screenshotError?: { message: string; code?: string };
  /** Hint for the client bridge on how to refetch the full component. */
  hydrateRef?: { kind: "gallery"; componentId: string };
  /**
   * W2.3 — structured alias failure surface. Populated when either the
   * tool-boundary alias validation rejected the input (bad alias format,
   * duplicate alias, bad URL protocol) OR the compiler found a
   * `@asset/<alias>` reference with no declaration in the per-call map.
   *
   * Shape is intentionally discriminated by `code` so the agent can branch
   * on a single field. `declaredAliases` is always included so the LLM can
   * self-correct by either declaring the missing alias or removing the
   * reference from the source.
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
   * W2.4 — structured globals.css resolution failure. Populated when a
   * caller-provided `globalsCssPath` could not be resolved, read, or
   * passed validation. Discriminated by `code` so the agent can branch on
   * a single field. The `path` echoed back is the agent-provided input,
   * not the host-absolute path — so the envelope does not leak host
   * filesystem layout.
   *
   * Never substitutes a fallback preview: surfacing a bad globals.css as
   * a compile-adjacent failure is always preferable to silently rendering
   * the component without the real app's tokens.
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
  /**
   * Sprint 4 W4.2 — structured failure envelope for the `design:<ref>`
   * virtual-module resolver. Populated when a user-authored component
   * imports another workspace component and the compiler cannot honor the
   * import for one of three reasons:
   *
   *   - `IMPORT_NOT_FOUND`: no row matches the ref in the current
   *     (userId, sessionId). Echoes the ref verbatim so the agent can
   *     re-issue the import with a known-good id/name.
   *   - `IMPORT_SCOPE_VIOLATION`: the loader explicitly identified a
   *     cross-scope hit. The default loader collapses scope-mismatches
   *     into `IMPORT_NOT_FOUND` (no existence leak); this branch exists
   *     for callers that know the target belongs to another scope and
   *     want to surface it as a distinct failure (e.g. tests, future
   *     admin-shared components).
   *   - `IMPORT_CYCLE_DETECTED`: A→B→A or deeper. `chain` is the ordered
   *     list of resolved ids, including the repeated head-of-cycle row,
   *     so the agent can point at exactly which component closed the
   *     loop.
   *
   * Echoed ONLY — never interpolated back into the component source. The
   * agent is expected to repair the import specifier in the calling
   * component's TSX and retry.
   */
  designImportError?: {
    code: DesignImportErrorCode;
    message: string;
    /**
     * The raw `design:<ref>` specifier the user authored — "attemptedRef"
     * in the Frontend-Developer review wording. Echoed verbatim so the
     * agent can diff against its last-known-good import.
     */
    ref: string;
    /**
     * Ordered list of resolved component ids from the compile root down
     * to the offending import. On IMPORT_CYCLE_DETECTED the last entry
     * is the repeated head-of-cycle id. Empty-ish on not-found/scope
     * failures that tripped before any successful resolution below the
     * root.
     */
    chain: string[];
    /**
     * Rev-J1 (Sprint 4 W4.2 revision) — resolved component id at the
     * failure boundary, when known. Populated on IMPORT_CYCLE_DETECTED
     * (always the head-of-cycle id). Undefined on IMPORT_NOT_FOUND (no
     * resolution) and IMPORT_SCOPE_VIOLATION (loader rejected before
     * the compiler saw a row). Exposed as its own field so the agent
     * does not have to re-derive it from `chain[chain.length - 1]` —
     * keeps the envelope self-describing per the "never strip without
     * an agent-actionable substitute" rule.
     */
    resolvedId?: string;
  };
  /**
   * Server-stamped freshness marker (ms since epoch). Set by `slimResult`
   * on mutating actions (generate/edit/patch) so the client tool-UI can
   * distinguish a just-produced result from a replay of persisted chat
   * history — critical for deciding whether to auto-open the workspace.
   */
  generatedAt?: number;

  /**
   * W3.3 — reflects whether a `referenceImageUrl` was rendered as a
   * preview overlay on this action. Emitted on generate/edit/patch
   * successes when the agent passed a reference image.
   *
   * The compiler injects the overlay markup unconditionally when a URL
   * is passed — actual image load-state diagnostics are best-effort and
   * live on the client-side `data-design-reference-error` /
   * `data-design-reference-loaded` attributes stamped by the preview JS.
   * We do NOT round-trip load state through this field; doing so would
   * require polling the iframe after compile, which adds latency for a
   * cosmetic signal.
   */
  referenceImage?: {
    url: string;
    present: true;
  };

  /**
   * W3.3 — structured validation failure when the caller-provided
   * `referenceImageUrl` didn't match the accepted URL shapes. Emitted
   * alongside `success: false` so the agent can fix the input without
   * parsing the freeform error string.
   *
   * Rev-F1 (Sprint 3 W3.3/W3.4 revision):
   *   - `REFERENCE_IMAGE_URL_INVALID` covers scheme / containment / MIME
   *     rejections (non-allowed URL shape, `<`/`>` containment, non-raster
   *     `data:image/*` MIME, `..` path traversal, etc.).
   *   - `REFERENCE_IMAGE_URL_TOO_LARGE` covers the 2 MB byte cap on
   *     `data:` URIs; `bytes` + `limit` are echoed so the agent can
   *     resize or switch to an `/api/media/...` reference without
   *     parsing the freeform message.
   *
   * Every rejection echoes the full offending URL via `rejectedUrl` so
   * the agent can diff against its last-known-good input. The
   * human-readable `error` string on the envelope truncates the URL to
   * 200 chars to avoid log bloat — the full URL only appears here.
   */
  referenceImageError?:
    | {
        code: "REFERENCE_IMAGE_URL_INVALID";
        message: string;
        rejectedUrl: string;
      }
    | {
        code: "REFERENCE_IMAGE_URL_TOO_LARGE";
        message: string;
        rejectedUrl: string;
        bytes: number;
        limit: number;
      };

  /**
   * W3.4 — confirmation that a renderMany grid was rendered on this
   * mutating action. `count` is the number of cells the caller requested,
   * `cellsEmitted` is the number that actually made it into the compiled
   * entry (normally equal; diverges only on the partial-failure branch
   * documented in `renderManyWarnings`). Emitted only on generate / edit
   * / patch successes — omitted entirely when `renderMany` was not used.
   */
  renderMany?: {
    count: number;
    cellsEmitted: number;
  };

  /**
   * W3.4 — structured per-cell warnings. Populated when one or more cells
   * failed during compile-time preparation but the overall compile still
   * succeeded (unlikely in v1 — the compiler never drops cells today —
   * but the shape is pre-wired so future partial-failure paths have a
   * stable envelope field to write to). Empty / absent on the clean
   * success path.
   */
  renderManyWarnings?: Array<{
    index: number;
    message: string;
  }>;

  /**
   * W3.4 — structured input-validation failure for the `renderMany`
   * primitive. Populated alongside `success: false` so the agent can
   * branch on `code` instead of parsing the freeform error string.
   *
   *   `RENDER_MANY_TOO_MANY`       — more than RENDER_MANY_MAX_CELLS entries.
   *   `RENDER_MANY_INVALID_PROPS`  — an entry's `props` is missing or not
   *                                  a plain JSON object.
   */
  renderManyError?: {
    code: "RENDER_MANY_TOO_MANY" | "RENDER_MANY_INVALID_PROPS";
    message: string;
    count?: number;
    limit?: number;
    index?: number;
  };

  // ---------------------------------------------------------------------------
  // "port" action result fields.
  // ---------------------------------------------------------------------------
  /**
   * True when the port action actually wrote the target file. False on
   * `dryRun: true`, on identical-content no-ops, and on overwrite refusals.
   */
  applied?: boolean;
  /** Absolute, sandbox-validated target path. */
  targetPath?: string;
  /** Resolved synced-folder-relative label echoed back for display. */
  targetRelativePath?: string;
  /** Whether the target file existed on disk prior to this action. */
  targetExistedBefore?: boolean;
  /** Size in bytes of the pre-existing target file, or 0 when absent. */
  targetSize?: number;
  /** Bytes written on a successful (non-dryRun) write. */
  bytesWritten?: number;
  /** Unified diff between the existing target and the workspace source. */
  diff?: string;
  /** True when the diff was truncated for token-budget reasons. */
  diffTruncated?: boolean;
  /**
   * BA-warn-5 — preflight fingerprint captured during a dry-run.
   *
   * Emitted on every `port` dry-run (even identical-content no-ops, so
   * the caller can round-trip the token reliably). The caller is
   * expected to echo `contentSha256` back on the follow-up
   * `dryRun:false` apply via `input.expectedContentSha256`; the tool
   * re-reads the target right before `atomicWriteFile` and rejects
   * with `errorCode: "PORT_STALE_DIFF"` if the hash changed since the
   * dry-run.
   *
   * `mtimeMs` is informational only (filesystem clock skew + NFS
   * caching make it unreliable as a primary freshness signal); the
   * hash is authoritative.
   */
  preflight?: {
    contentSha256: string;
    mtimeMs: number | null;
  };
  /**
   * Populated alongside `errorCode: "PORT_STALE_DIFF"` so the caller
   * knows the apply was rejected because the file changed on disk
   * between the dry-run and the apply. `expectedSha256` echoes the
   * `expectedContentSha256` the caller supplied so mismatches are easy
   * to diagnose without re-reading the dry-run envelope.
   */
  stalePortInfo?: {
    currentSha256: string;
    expectedSha256: string;
    mtimeMs: number | null;
  };
  /** Structured error-code for agent-actionable error envelopes. */
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
    // Sprint 3 W3.1 — snapshot action error codes. Every failure mode the
    // five `snapshot.*` actions can surface has a stable, agent-branchable
    // code here. The existing envelope rules apply: we never strip a field
    // without an actionable substitute, so every snapshot error carries at
    // minimum the input identifier the call targeted.
    | "SNAPSHOT_COMPONENT_NOT_FOUND"
    | "SNAPSHOT_NOT_FOUND"
    | "SNAPSHOT_NAME_TOO_LONG"
    | "SNAPSHOT_SAVE_FAILED"
    | "SNAPSHOT_PIN_FAILED"
    | "SNAPSHOT_RENAME_FAILED"
    | "SNAPSHOT_DELETE_FAILED"
    // Sprint 4 W4.2 — `design:<ref>` virtual-module resolver failure
    // modes. Emitted by generate / edit / patch when the user-authored
    // source imports another workspace component that cannot be resolved,
    // belongs to another scope, or participates in an import cycle. The
    // matching `data.designImportError` envelope carries the ref + chain.
    | "IMPORT_NOT_FOUND"
    | "IMPORT_SCOPE_VIOLATION"
    | "IMPORT_CYCLE_DETECTED"
    // Sprint 3 W3.2 — `snapshot.diff` failure modes.
    // `SNAPSHOT_DIFF_INVALID_INPUT` — handler-level validation (missing / empty
    //   id, non-positive maxLines, maxLines > 5000).
    // `SNAPSHOT_DIFF_FAILED` — `createPortDiff` threw unexpectedly.
    | "SNAPSHOT_DIFF_INVALID_INPUT"
    | "SNAPSHOT_DIFF_FAILED";

  // ---------------------------------------------------------------------------
  // Sprint 3 W3.1 — persisted snapshot envelope fields.
  //
  // Separate from the transient in-memory snapshot concept (see
  // `lib/design/workspace/types.ts`). `snapshot` / `snapshots` carry rows from
  // the `design_snapshots` table. `truncated` fires when the caller-supplied
  // `limit` was clamped to the DB cap OR when the returned rowcount equals the
  // cap. `deleted` is the soft-delete return for `snapshot.delete`.
  // ---------------------------------------------------------------------------
  snapshot?: PersistedDesignSnapshot;
  snapshots?: PersistedDesignSnapshot[];
  deleted?: boolean;
  snapshotId?: string;

  // ---------------------------------------------------------------------------
  // Sprint 3 W3.2 — `snapshot.diff` envelope fields.
  //
  // `a` / `b` are compact read-only summaries of the two rows the diff
  // compared — just enough for the tool-UI to title the panel ("Diff between
  // {a.name ?? a.id} and {b.name ?? b.id}") without the caller having to
  // re-fetch either row. The full `sourceCode` is intentionally NOT
  // included; the unified `diff` carries everything an agent / user needs.
  //
  // `sameContent` is true when both source strings were byte-identical; in
  // that case `diff` is the empty string and `totalLines` is 0. The field
  // keeps the branch cheap for the agent (no need to parse the diff text
  // to know the snapshots are identical).
  //
  // `diff` and `diffTruncated` piggy-back on the existing port-action
  // fields by design — the wire shape is the same (a unified-diff string
  // + a truncation flag) and both actions use `createPortDiff`.
  // `totalLines` is emitted unchanged from `createPortDiff`.
  // ---------------------------------------------------------------------------
  a?: {
    id: string;
    createdAt: string;
    name: string | null;
    isPinned: boolean;
    componentId: string;
  };
  b?: {
    id: string;
    createdAt: string;
    name: string | null;
    isPinned: boolean;
    componentId: string;
  };
  sameContent?: boolean;
  totalLines?: number;
  /** `snapshot.diff` — the input id that did not resolve in-scope. */
  missingId?: string;

  // ---------------------------------------------------------------------------
  // "import" action result fields (W2.1).
  // ---------------------------------------------------------------------------
  /** The synced-folder-relative or absolute source path that was imported. */
  sourcePath?: string;
  /** Absolute, sandbox-validated path that was actually read. */
  resolvedSourcePath?: string;
  /** ISO timestamp persisted to `metadata.importedAt`. */
  importedAt?: string;
  /** True when the import reused an existing row (update-in-place) instead of inserting. */
  updated?: boolean;
  /** Final tag list persisted to the row (includes the automatic "imported" tag). */
  tags?: string[];
}

interface DesignWorkspaceResult {
  success: boolean;
  action: string;
  data?: DesignWorkspaceResultData;
  error?: string;
}

interface CompiledPreviewSuccess {
  ok: true;
  previewHtml: string;
  compileReport: DesignWorkspaceCompileReport;
}

interface CompiledPreviewFailure {
  ok: false;
  previewHtml: string;
  compileReport: DesignWorkspaceCompileReport;
  error: string;
  /**
   * W2.4 — populated when the compile failure originated from the
   * caller-provided `globalsCssPath` (resolve / read / validate). The
   * handler lifts this onto `DesignWorkspaceResultData.globalsCssError`
   * so the agent sees a structured, code-branchable failure envelope
   * instead of just a free-form error string.
   */
  globalsCssError?: NonNullable<DesignWorkspaceResultData["globalsCssError"]>;
  /**
   * Sprint 4 W4.2 — populated when the compile failure originated from
   * the `design:<ref>` virtual-module resolver. Lifted verbatim onto
   * `DesignWorkspaceResultData.designImportError` by the tool handler.
   */
  designImportError?: NonNullable<DesignWorkspaceResultData["designImportError"]>;
}

interface ResolvedDesignSource {
  component: DesignGalleryItem | null;
  code: string | null;
  inline: boolean;
}

let librariesPromise: Promise<DesignLibrary[]> | null = null;

function getAvailableLibraries(): Promise<DesignLibrary[]> {
  if (!librariesPromise) {
    librariesPromise = detectAvailableLibraries().catch((err) => {
      librariesPromise = null;
      throw err;
    });
  }
  return librariesPromise;
}

function resetAvailableLibrariesCache(): void {
  librariesPromise = null;
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function parseDataUri(uri: string): { base64Data: string; mediaType: string } | null {
  const match = uri.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!match) return null;
  return { mediaType: match[1], base64Data: match[2] };
}

function filesystemPathToMediaUrl(filePath: string): string | null {
  const mediaMarker = /[/\\]media[/\\]/;
  const match = filePath.match(mediaMarker);
  if (!match || match.index === undefined) return null;
  const relativePart = filePath.slice(match.index + match[0].length).replace(/\\/g, "/");
  return relativePart ? `/api/media/${relativePart}` : null;
}

async function resolveAssets(
  inputAssets: Array<{ url: string; description?: string }>,
): Promise<AssetContext[]> {
  return Promise.all(
    inputAssets.map(async (asset, index) => {
      const ctx: AssetContext = {
        id: `asset-${index}`,
        url: asset.url,
        alt: asset.description,
        metadata: asset.description ? { description: asset.description } : undefined,
      };

      const parsed = parseDataUri(asset.url);
      if (parsed) {
        ctx.base64Data = parsed.base64Data;
        ctx.mediaType = parsed.mediaType;
        return ctx;
      }

      if (!asset.url.startsWith("/api/media/") && !asset.url.startsWith("http")) {
        const mediaUrl = filesystemPathToMediaUrl(asset.url);
        if (mediaUrl) {
          ctx.url = mediaUrl;
        }
      }

      const mediaRef = ctx.url.startsWith("/api/media/") ? ctx.url : asset.url;
      const fullPath = getFullPathFromMediaRef(mediaRef);
      if (fullPath) {
        const storageRoot = path.resolve(
          process.env.LOCAL_DATA_PATH
            ? path.resolve(process.env.LOCAL_DATA_PATH, "media")
            : path.resolve(process.cwd(), ".local-data", "media"),
        );
        const resolvedFull = path.resolve(fullPath);
        if (!resolvedFull.startsWith(storageRoot + path.sep) && resolvedFull !== storageRoot) {
          return ctx;
        }

        try {
          const buffer = await fs.readFile(fullPath);
          const ext = path.extname(fullPath).toLowerCase();
          const mediaType = IMAGE_MEDIA_TYPES[ext];
          if (mediaType) {
            ctx.base64Data = buffer.toString("base64");
            ctx.mediaType = mediaType;
          }
        } catch {
          // File not accessible — proceed without multimodal support.
        }
      }

      return ctx;
    }),
  );
}

function generateId(): string {
  return crypto.randomUUID();
}

function getSessionId(options: DesignWorkspaceToolOptions): string {
  return options.sessionId?.trim() || "UNSCOPED";
}

function getPersistedUserId(options: DesignWorkspaceToolOptions): string | undefined {
  const userId = options.userId?.trim();
  return userId && userId !== "UNSCOPED" ? userId : undefined;
}

function getWorkspaceConfig(): DesignWorkspaceConfig {
  try {
    const settings = loadSettings() as unknown as Record<string, unknown>;
    return getDesignWorkspaceConfigFromSettingsRecord(settings);
  } catch {
    return { ...DEFAULT_DESIGN_WORKSPACE_CONFIG };
  }
}

function createEmptyCompileReport(message: string): DesignWorkspaceCompileReport {
  return {
    warnings: [],
    errors: [
      {
        type: "unknown",
        message,
      },
    ],
    dependencyCheck: {
      manifestPackages: [],
      importedPackages: [],
      checkedPackages: [],
      missingManifestPackages: [],
      missingImportedPackages: [],
      missingPackages: [],
    },
    recovered: false,
    durationMs: 0,
  };
}

function ensureHistory(sessionId: string): void {
  initDesignHistory(sessionId);
}

function recordHistory(
  sessionId: string,
  action: DesignWorkspaceInput["action"],
  startedAt: number,
  success: boolean,
  options: {
    componentId?: string;
    validation?: DesignWorkspaceValidationResult;
    metadata?: Record<string, unknown>;
    error?: string;
  } = {},
): void {
  recordDesignHistory(sessionId, {
    action,
    componentId: options.componentId,
    durationMs: Date.now() - startedAt,
    success,
    validation: options.validation,
    metadata: options.metadata,
    error: options.error,
  });
}

// ---------------------------------------------------------------------------
// W2.3 — assetAliases validation (defense in depth over the JSON schema).
// ---------------------------------------------------------------------------

/** Allowed alias character class per the W2.3 spec. */
const ASSET_ALIAS_FORMAT = /^[a-zA-Z0-9_-]+$/;

/** Structured validation failure surfaced through the normal error envelope. */
export interface AssetAliasValidationError {
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

/**
 * Normalize + validate the raw `assetAliases` input from the tool schema.
 *
 * Returns either a validated list of `DesignAssetAlias` entries OR a single
 * structured error suitable for surfacing through the tool's error envelope.
 * Defense-in-depth over the JSON schema — the schema catches obvious shape
 * mismatches; this catches semantic failures (bad alias chars, bad URL
 * protocol, duplicate aliases).
 *
 * @internal Exported for unit tests.
 */
export function validateAssetAliases(
  raw: unknown,
):
  | { ok: true; aliases: DesignAssetAlias[] }
  | { ok: false; error: AssetAliasValidationError } {
  if (raw === undefined || raw === null) {
    return { ok: true, aliases: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: {
        code: "ASSET_ALIAS_ENTRY_MALFORMED",
        message: '"assetAliases" must be an array of { url, alias } objects.',
      },
    };
  }

  const seen = new Set<string>();
  const aliases: DesignAssetAlias[] = [];

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as unknown;
    if (!entry || typeof entry !== "object") {
      return {
        ok: false,
        error: {
          code: "ASSET_ALIAS_ENTRY_MALFORMED",
          message: `assetAliases[${i}] must be an object with "url" and "alias" string fields.`,
        },
      };
    }
    const alias = (entry as Record<string, unknown>).alias;
    const url = (entry as Record<string, unknown>).url;
    if (typeof alias !== "string" || alias.length === 0) {
      return {
        ok: false,
        error: {
          code: "ASSET_ALIAS_ENTRY_MALFORMED",
          message: `assetAliases[${i}].alias must be a non-empty string.`,
        },
      };
    }
    if (typeof url !== "string" || url.length === 0) {
      return {
        ok: false,
        error: {
          code: "ASSET_ALIAS_ENTRY_MALFORMED",
          message: `assetAliases[${i}].url must be a non-empty string.`,
          alias,
        },
      };
    }
    if (!ASSET_ALIAS_FORMAT.test(alias)) {
      return {
        ok: false,
        error: {
          code: "ASSET_ALIAS_FORMAT_INVALID",
          message: `assetAliases[${i}].alias "${alias}" must match /^[a-zA-Z0-9_-]+$/ (alphanumeric plus "-" and "_" only).`,
          alias,
        },
      };
    }
    const isHttp =
      url.startsWith("https://") ||
      url.startsWith("http://") ||
      url.startsWith("/api/media/");
    if (!isHttp) {
      return {
        ok: false,
        error: {
          code: "ASSET_ALIAS_URL_INVALID",
          message: `assetAliases[${i}].url must be an http(s):// URL or start with "/api/media/" (got "${url}").`,
          alias,
          url,
        },
      };
    }
    if (seen.has(alias)) {
      return {
        ok: false,
        error: {
          code: "ASSET_ALIAS_DUPLICATE",
          message: `assetAliases declares alias "${alias}" more than once. Each alias must be unique per call.`,
          alias,
          declaredAliases: Array.from(seen),
        },
      };
    }
    seen.add(alias);
    aliases.push({ alias, url });
  }

  return { ok: true, aliases };
}

/**
 * When the compile report's top error came from the pre-esbuild alias rewrite
 * step (AssetAliasNotFoundError), reshape it into a structured envelope so the
 * agent can react programmatically. Returns undefined for unrelated failures.
 *
 * @internal Exported for unit tests.
 */
export function extractAssetAliasNotFoundDetails(
  report: DesignWorkspaceCompileReport,
  declaredAliases: string[],
): { code: "ASSET_ALIAS_NOT_FOUND"; alias: string; declaredAliases: string[] } | undefined {
  const firstErr = report.errors?.[0];
  if (!firstErr) return undefined;
  const match = firstErr.message.match(/^@asset\/([a-zA-Z0-9_-]+) was referenced/);
  if (!match) return undefined;
  return {
    code: "ASSET_ALIAS_NOT_FOUND",
    alias: match[1],
    declaredAliases,
  };
}

// ---------------------------------------------------------------------------
// W3.4 — renderMany validation.
// ---------------------------------------------------------------------------

export type RenderManyValidationError =
  | {
      code: "RENDER_MANY_TOO_MANY";
      message: string;
      count: number;
      limit: number;
    }
  | {
      code: "RENDER_MANY_INVALID_PROPS";
      message: string;
      index: number;
    };

/**
 * Normalize + validate the raw `renderMany` input from the tool schema.
 *
 * Returns either a validated list of `RenderManyCell` entries OR a single
 * structured error suitable for surfacing through the tool's error envelope.
 * Defense-in-depth over the JSON schema — the schema catches obvious shape
 * mismatches; this catches semantic failures (over-cap, non-plain-object
 * `props` bags).
 *
 * @internal Exported for unit tests.
 */
export function validateRenderMany(
  raw: unknown,
):
  | { ok: true; cells: RenderManyCell[] }
  | { ok: false; error: RenderManyValidationError } {
  if (raw === undefined || raw === null) {
    return { ok: true, cells: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: {
        code: "RENDER_MANY_INVALID_PROPS",
        message: '"renderMany" must be an array of { props, label?, className? } objects.',
        index: -1,
      },
    };
  }
  if (raw.length > RENDER_MANY_MAX_CELLS) {
    return {
      ok: false,
      error: {
        code: "RENDER_MANY_TOO_MANY",
        message: `"renderMany" accepts at most ${RENDER_MANY_MAX_CELLS} entries; received ${raw.length}.`,
        count: raw.length,
        limit: RENDER_MANY_MAX_CELLS,
      },
    };
  }

  const cells: RenderManyCell[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as unknown;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        ok: false,
        error: {
          code: "RENDER_MANY_INVALID_PROPS",
          message: `renderMany[${i}] must be an object with a "props" field that is a plain JSON object.`,
          index: i,
        },
      };
    }
    const props = (entry as Record<string, unknown>).props;
    // `z.record(z.unknown())` equivalent: must be a plain object (not null,
    // not an array, not a primitive). Arrays are the sneaky failure mode
    // because `typeof [] === "object"`.
    if (
      props === undefined ||
      props === null ||
      typeof props !== "object" ||
      Array.isArray(props)
    ) {
      return {
        ok: false,
        error: {
          code: "RENDER_MANY_INVALID_PROPS",
          message: `renderMany[${i}].props must be a plain JSON object (got ${
            Array.isArray(props) ? "array" : typeof props
          }).`,
          index: i,
        },
      };
    }
    const label = (entry as Record<string, unknown>).label;
    const className = (entry as Record<string, unknown>).className;
    if (label !== undefined && typeof label !== "string") {
      return {
        ok: false,
        error: {
          code: "RENDER_MANY_INVALID_PROPS",
          message: `renderMany[${i}].label must be a string when provided.`,
          index: i,
        },
      };
    }
    if (className !== undefined && typeof className !== "string") {
      return {
        ok: false,
        error: {
          code: "RENDER_MANY_INVALID_PROPS",
          message: `renderMany[${i}].className must be a string when provided.`,
          index: i,
        },
      };
    }
    cells.push({
      props: props as Record<string, unknown>,
      ...(typeof label === "string" ? { label } : {}),
      ...(typeof className === "string" ? { className } : {}),
    });
  }

  return { ok: true, cells };
}

// ---------------------------------------------------------------------------
// W3.3 — referenceImageUrl validation.
// ---------------------------------------------------------------------------

/**
 * Maximum byte length accepted for `data:` URI references. Applied after the
 * MIME allowlist (Sprint 3 Rev-F1). 2 MB balances real-world inline PNGs
 * (screenshots, mocks) against the preview HTML bloat + parser memory cost
 * of sending arbitrarily large base64 blobs through the compiled document.
 * Everything past this limit should live in `/api/media/...` instead.
 */
export const REFERENCE_IMAGE_DATA_URI_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Raster-image MIME allowlist for `data:` URIs. Excludes SVG (which can
 * carry `<script>` / `onload=` payloads that the preview iframe would
 * execute inline) and every non-image `data:` form. Callers that need a
 * vector asset must serve it through `/api/media/...` where the sanitize
 * pipeline strips active content before the preview loads it.
 */
const REFERENCE_IMAGE_DATA_URI_ALLOWED_MIME_PREFIXES = [
  "data:image/png",
  "data:image/jpeg",
  "data:image/jpg",
  "data:image/gif",
  "data:image/webp",
] as const;

/** Truncate a URL for the human-readable `error` string; full URL is always
 *  available via `rejectedUrl` in the structured envelope. */
function truncateForErrorMessage(url: string, max = 200): string {
  if (url.length <= max) return url;
  return `${url.slice(0, max)}…`;
}

/**
 * Accept the same URL shapes the W2.3 asset-alias pipeline accepts, plus a
 * narrowed set of raster-only `data:image/*` URIs (so the agent can send a
 * one-shot inline preview without bouncing through the media store).
 *
 * Kept as a small standalone validator rather than `z.string().url()`
 * because the tool schema is already `jsonSchema<…>()` — not zod — and
 * because `z.string().url()` rejects `/api/media/...` relative paths that
 * the preview iframe can resolve against its own origin. Mirroring the
 * `validateAssetAliases` URL policy keeps the two inputs aligned and
 * surfaces a single, agent-actionable error shape.
 *
 * Sprint 3 Rev-F1 hardening:
 *   1. Reject any URL containing `<` or `>` — a legitimate URL URL-encodes
 *      those characters, so literal angle brackets are always an XSS probe
 *      (e.g. `…</script><script>alert(1)</script>`).
 *   2. Narrow the `data:image/...` gate to an explicit raster allowlist:
 *      PNG / JPEG / GIF / WEBP. Rejects `data:image/svg+xml` (active
 *      content) and every non-image `data:` form.
 *   3. Cap `data:` URIs at 2 MB. Oversized blobs surface
 *      `REFERENCE_IMAGE_URL_TOO_LARGE` with `bytes` + `limit` so the agent
 *      can resize or switch to `/api/media/...`.
 *   4. Reject `/api/media/...` URLs whose path contains `..` segments
 *      (path traversal) by normalizing via `new URL(…, "http://_")` — the
 *      dummy origin avoids the `URL()` throw on relative paths.
 *   5. Every rejection echoes `rejectedUrl` in the structured data so the
 *      agent can diff against its prior input without parsing the message.
 *
 * @internal Exported for unit tests.
 */
export function validateReferenceImageUrl(
  raw: unknown,
):
  | { ok: true; url?: string }
  | {
      ok: false;
      error:
        | {
            code: "REFERENCE_IMAGE_URL_INVALID";
            message: string;
            rejectedUrl: string;
          }
        | {
            code: "REFERENCE_IMAGE_URL_TOO_LARGE";
            message: string;
            rejectedUrl: string;
            bytes: number;
            limit: number;
          };
    } {
  if (raw === undefined || raw === null) {
    return { ok: true };
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    // We intentionally do NOT echo the raw input here when it is a
    // non-string (the envelope field is typed `rejectedUrl: string`); for
    // the empty-string case the echoed value is also the empty string so
    // the agent can still introspect the offending argument shape.
    const rejectedUrl = typeof raw === "string" ? raw : "";
    return {
      ok: false,
      error: {
        code: "REFERENCE_IMAGE_URL_INVALID",
        message: '"referenceImageUrl" must be a non-empty string.',
        rejectedUrl,
      },
    };
  }
  const url = raw.trim();

  // --- (1) Containment guard — strict XSS rejection. ---------------------
  // A legitimate URL URL-encodes `<` / `>` in every position (path, query,
  // fragment, and even data: payloads when authored by a spec-compliant
  // encoder). Literal angle brackets therefore always indicate either a
  // malformed URL or an injection probe; we reject BEFORE further parsing
  // so the offending string never reaches the preview HTML template.
  if (url.includes("<") || url.includes(">")) {
    return {
      ok: false,
      error: {
        code: "REFERENCE_IMAGE_URL_INVALID",
        message: `referenceImageUrl must not contain "<" or ">" characters (URL-encode them if legitimate). Got "${truncateForErrorMessage(url)}".`,
        rejectedUrl: url,
      },
    };
  }

  // --- (2) Scheme + MIME gate. ------------------------------------------
  const isHttps = url.startsWith("https://");
  const isHttp = url.startsWith("http://");
  const isApiMedia = url.startsWith("/api/media/");
  const isData = url.startsWith("data:");

  if (isData) {
    // Narrow data: URIs to the raster-image allowlist. Everything else —
    // including `data:image/svg+xml`, `data:text/html`, `data:application/*`
    // — is rejected. The prefix check is case-sensitive against the
    // canonical spelling; real-world base64 encoders emit lowercase MIME.
    const allowedMime = REFERENCE_IMAGE_DATA_URI_ALLOWED_MIME_PREFIXES.some(
      (prefix) => url.startsWith(prefix),
    );
    if (!allowedMime) {
      return {
        ok: false,
        error: {
          code: "REFERENCE_IMAGE_URL_INVALID",
          message: `referenceImageUrl data: URI must be one of image/png, image/jpeg, image/jpg, image/gif, image/webp (SVG + all non-image types rejected). Got "${truncateForErrorMessage(url)}".`,
          rejectedUrl: url,
        },
      };
    }

    // --- (3) Byte cap on data: URIs. -----------------------------------
    // Measure bytes using UTF-8 (Buffer.byteLength) to match what the
    // browser actually pushes through the network/parser, not JS code
    // units. Base64 payloads are ASCII so this is also the literal length
    // for the common case, but a base64-url or malformed payload with
    // multi-byte chars would otherwise under-count.
    const bytes = Buffer.byteLength(url, "utf8");
    if (bytes > REFERENCE_IMAGE_DATA_URI_MAX_BYTES) {
      return {
        ok: false,
        error: {
          code: "REFERENCE_IMAGE_URL_TOO_LARGE",
          message: `referenceImageUrl data: URI is ${bytes} bytes, exceeding the ${REFERENCE_IMAGE_DATA_URI_MAX_BYTES}-byte cap. Host the asset via /api/media/... instead.`,
          rejectedUrl: url,
          bytes,
          limit: REFERENCE_IMAGE_DATA_URI_MAX_BYTES,
        },
      };
    }

    return { ok: true, url };
  }

  if (!(isHttps || isHttp || isApiMedia)) {
    return {
      ok: false,
      error: {
        code: "REFERENCE_IMAGE_URL_INVALID",
        message: `referenceImageUrl must be an http(s):// URL, a /api/media/... path, or a data:image/{png,jpeg,jpg,gif,webp} URI (got "${truncateForErrorMessage(url)}").`,
        rejectedUrl: url,
      },
    };
  }

  // --- (4) Path traversal guard on /api/media/... -----------------------
  // A `..` segment in the path could escape the media root if the server
  // ever normalizes after trust boundary crossing. Reject at the tool
  // boundary (defense in depth) so a malicious suggestion never reaches
  // the preview iframe or the media resolver.
  //
  // Rev-G B1 — percent-encoded traversal hardening.
  // ---------------------------------------------
  // `new URL()` (and browsers / many upstream routers) silently normalize
  // `%2e%2e` → `..` → collapsed-path BEFORE our `pathname` inspector or
  // segment-split check can see it, which means attacker input like
  // `/api/media/%2e%2e/secret` used to sneak through both the
  // `url.includes("/..")` substring scan AND the parsed-segment check
  // (the backend review called this out as a block-severity finding).
  //
  // We defend on the RAW string by folding the exact encoding used for
  // the bypass (`%2e` / `%2E` → `.`) BEFORE any URL parsing, then re-run
  // the literal `..` scanner on the expanded copy. This catches
  // `%2e%2e`, `.%2e`, `%2e.`, and any mixed-case combination without
  // needing a full `decodeURIComponent` pass (which could over-decode
  // legitimate file names that happen to contain other percent codes).
  const rawHasEncodedTraversal = (raw: string): boolean => {
    // Fold three classes of encoding before segment detection:
    //   1. `%2e` / `%2E`   → `.`   (encoded dot)
    //   2. `%2f` / `%2F`   → `/`   (encoded forward-slash separator)
    //   3. `%5c` / `%5C`   → `/`   (encoded backslash — `new URL()` treats
    //                               backslash as a path separator on
    //                               `http(s):` URLs, so we must too)
    //   4. Literal `\`     → `/`   (same rationale as (3))
    // This is a targeted fold, NOT a full `decodeURIComponent`, which would
    // over-decode legitimate percent codes (e.g. spaces, unicode).
    const expanded = raw
      .replace(/%2[eE]/g, ".")
      .replace(/%2[fF]/g, "/")
      .replace(/%5[cC]/g, "/")
      .replace(/\\/g, "/");
    // Real `..` SEGMENTS only — bounded by `/`, query, fragment, or end
    // of string on both sides. This prevents false positives on legitimate
    // names like `/foo/.../bar` (3+ dots) or `/..foo.png` (no boundary).
    // Examples REJECTED: `/api/media/../secret`, `/api/media/foo/../bar`,
    // `/api/media/../../etc`, `/api/media/foo/..?x=1`, `/api/media/foo/..#a`,
    // `/api/media/..\secret`, `/api/media/%2f..%2fsecret`, `%5c..%5c`
    // Examples ALLOWED: `/api/media/foo/.../bar`, `/api/media/..foo.png`,
    // `/api/media/foo/..bar`, `/api/media/version1.0.0/x`
    if (/(^|\/)\.\.([\/?#]|$)/.test(expanded)) {
      return true;
    }
    return false;
  };

  if (isApiMedia) {
    if (rawHasEncodedTraversal(url)) {
      return {
        ok: false,
        error: {
          code: "REFERENCE_IMAGE_URL_INVALID",
          message: `referenceImageUrl must not contain ".." path segments (got "${truncateForErrorMessage(url)}").`,
          rejectedUrl: url,
        },
      };
    }
    try {
      const parsed = new URL(url, "http://_");
      const segments = parsed.pathname.split("/");
      if (segments.some((s) => s === "..")) {
        return {
          ok: false,
          error: {
            code: "REFERENCE_IMAGE_URL_INVALID",
            message: `referenceImageUrl must not contain ".." path segments (got "${truncateForErrorMessage(url)}").`,
            rejectedUrl: url,
          },
        };
      }
    } catch {
      // URL() should not throw with a dummy origin, but if it does we
      // treat the URL as malformed rather than silently accepting it.
      return {
        ok: false,
        error: {
          code: "REFERENCE_IMAGE_URL_INVALID",
          message: `referenceImageUrl could not be parsed as a URL (got "${truncateForErrorMessage(url)}").`,
          rejectedUrl: url,
        },
      };
    }
  }

  // For http(s) URLs we also guard against `..` in the path segment,
  // including the `%2e%2e` encoded variants described above. Browsers
  // normalize these before fetching, but an attacker-controlled upstream
  // might still use the raw path for logging / routing, and `new URL(…)`
  // silently collapses `..` segments before we can observe them — so we
  // inspect the RAW string (post-`%2e`→`.` fold) instead of the parsed
  // URL here. We still validate via `new URL()` afterwards to reject
  // wholly malformed inputs; a parse failure is also a rejection.
  if (isHttps || isHttp) {
    if (rawHasEncodedTraversal(url)) {
      return {
        ok: false,
        error: {
          code: "REFERENCE_IMAGE_URL_INVALID",
          message: `referenceImageUrl must not contain ".." path segments (got "${truncateForErrorMessage(url)}").`,
          rejectedUrl: url,
        },
      };
    }
    try {
      // Parse purely to ensure the URL is syntactically valid; the parsed
      // pathname is not inspected because `new URL()` normalizes `..` away.
      new URL(url);
    } catch {
      return {
        ok: false,
        error: {
          code: "REFERENCE_IMAGE_URL_INVALID",
          message: `referenceImageUrl is not a valid URL (got "${truncateForErrorMessage(url)}").`,
          rejectedUrl: url,
        },
      };
    }
  }

  return { ok: true, url };
}

async function compilePreviewForTool(
  code: string,
  componentName: string,
  source: string,
  options: {
    assetAliases?: DesignAssetAlias[];
    /** W2.4 — synced-folder-relative path to the real app's globals.css.
     *  Resolved by the compiler via `resolveSyncedPath`. */
    globalsCssPath?: string;
    /** W2.4 — character scope for globals.css resolution. */
    characterId?: string;
    /** W2.4 — session scope for globals.css resolution. */
    sessionId?: string;
    /**
     * Sprint 4 W4.2 — user scope for the `design:<ref>` resolver. When
     * set alongside `sessionId` the compiler enables the virtual-module
     * plugin that lets user-authored components import other workspace
     * components via `import X from "design:<id-or-name>"`. Callers that
     * don't thread this field will get "could not resolve" esbuild
     * errors for any `design:` specifier in the source — which is the
     * safe default (no plugin means no cross-scope lookup at all).
     */
    userId?: string;
    /**
     * Sprint 4 W4.2 — optional pre-seeded cycle-detection chain. Callers
     * that already know the top-level component's id pass it in so a
     * `design:<rootId>` self-import is diagnosed as IMPORT_CYCLE_DETECTED
     * rather than loading the component twice.
     */
    designImportChainSeed?: readonly string[];
    /** W3.3 — validated reference-image URL forwarded to the compiler so
     *  the overlay + control panel render inside the preview HTML. */
    referenceImageUrl?: string;
    /** W3.4 — validated renderMany cells forwarded to the compiler so the
     *  preview entry emits a CSS grid instead of a single-render
     *  `<Component />`. Validation (cap + plain-object `props`) happens at
     *  the tool boundary BEFORE this call. */
    renderMany?: readonly RenderManyCell[];
    /** Project-local TS path aliases loaded by the import action. */
    tsconfigPaths?: TsconfigPathsConfig;
    /**
     * Working directory esbuild uses to resolve unqualified imports emitted
     * by the imported source TSX. The `import` action passes
     * `dirname(resolvedSourcePath)` so relative imports like `./coach.css`
     * resolve against the source file's actual directory in the synced
     * folder, instead of falling back to `PROJECT_ROOT` (which produced
     * the misleading "install in selene-workspace/package.json" suggestion
     * for sibling files).
     *
     * Other actions (`generate` / `edit` / `patch`) leave this undefined —
     * their source has no on-disk home, so `PROJECT_ROOT` is correct.
     */
    componentResolveDir?: string;
    /**
     * Extra `node_modules` directories to add to esbuild's resolution
     * chain after the sandbox's own `node_modules`. The `import` action
     * passes the synced repo's `node_modules` so the preview piggy-backs
     * on whatever the user has already installed in their target codebase
     * — eliminating most install churn for production-grade Next.js apps
     * while preserving sandbox precedence on package collisions.
     */
    extraNodePaths?: readonly string[];
    /**
     * Round-2 (B1+M5): synced-folder containment config for the `import`
     * action. Built in `handleImport` from `[owningSyncedFolder,
     * SANDBOX_NODE_MODULES, PROJECT_ROOT, ...extraNodePaths]` and threaded
     * through the compiler so onLoad rejects any path outside the
     * allowlist. Other actions leave it undefined.
     */
    containment?: ContainmentConfig;
    /**
     * Sprint 1 theme-threading regression fix (Sprint 3 Rev-F1).
     *
     * Forward the effective `previewTheme` ("dark" | "light" | "system")
     * so the compiled preview HTML's `<html>` class + inline media-query
     * IIFE match the user's active workspace theme. Prior to this fix,
     * `compilePreviewForTool` silently dropped the theme on the floor
     * before calling `buildTailwindPreviewWithMetadata`, which caused the
     * compiler to fall back to its hardcoded "dark" default for every
     * generate / edit / patch preview — re-introducing the Sprint 1 Rev-A2
     * Gap 1 reviewer blocker for the preview HTML path (the screenshot
     * path was already fixed via `captureScreenshot({ theme })`).
     *
     * Left optional so non-mutating callers (e.g. the import handler) can
     * skip it; the compiler's own default applies when undefined.
     */
    previewTheme?: DesignPreviewTheme;
  } = {},
): Promise<CompiledPreviewSuccess | CompiledPreviewFailure> {
  try {
    const { html, report } = await buildTailwindPreviewWithMetadata(code, componentName, {
      autoInstallMissingDependencies: true,
      source,
      assetAliases: options.assetAliases,
      globalsCssPath: options.globalsCssPath,
      characterId: options.characterId,
      sessionId: options.sessionId,
      userId: options.userId,
      designImportChainSeed: options.designImportChainSeed,
      referenceImageUrl: options.referenceImageUrl,
      renderMany: options.renderMany,
      tsconfigPaths: options.tsconfigPaths,
      // Rev-J2 — `import` action threads these so esbuild resolves
      // relative imports (`./coach.css`, sibling components) against the
      // source file's directory in the synced folder, and falls back to
      // the synced repo's `node_modules` for bare imports the sandbox
      // doesn't already have. Other actions leave them undefined so the
      // historical PROJECT_ROOT + sandbox-only behavior is preserved.
      componentResolveDir: options.componentResolveDir,
      extraNodePaths: options.extraNodePaths,
      // Round-2 (B1+M5): synced-folder containment config — only set by
      // the `import` action. Compiler treats undefined as historical
      // no-containment mode, so generate/edit/patch are unaffected.
      containment: options.containment,
      // Sprint 3 Rev-F1: forward the effective theme so the preview HTML
      // matches the user's active workspace theme. Callers layer the
      // LLM's `input.previewTheme` over `options.defaultPreviewTheme` so
      // this value is already merged before reaching the compiler.
      previewTheme: options.previewTheme,
    });

    return {
      ok: true,
      previewHtml: html,
      compileReport: report,
    };
  } catch (error) {
    // W2.4 — globals.css resolution failure. Do NOT silently fall back
    // to a token-less preview. Surface the structured code so the agent
    // can correct the path (or drop the argument) without parsing
    // free-form error text.
    if (isDesignWorkspaceGlobalsCssError(error)) {
      const err = error as DesignWorkspaceGlobalsCssError;
      const globalsCssError =
        err.code === "GLOBALS_CSS_TOO_LARGE"
          ? ({
              code: err.code,
              message: err.message,
              path: err.path,
              bytes: err.bytes ?? 0,
              limit: err.limit ?? 0,
            } as const)
          : ({
              code: err.code,
              message: err.message,
              path: err.path,
            } as const);
      return {
        ok: false,
        previewHtml: buildDesignPreviewErrorHtml(err.message, {
          title: componentName,
          label: "Globals CSS Resolution Failed",
        }),
        compileReport: createEmptyCompileReport(err.message),
        error: err.message,
        globalsCssError,
      };
    }

    // Sprint 4 W4.2 — structured `design:<ref>` resolver failure. The
    // compiler propagates `DesignWorkspaceImportError` unchanged (it
    // never wraps into a DesignWorkspaceCompileError) so we get the
    // structured `code` / `ref` / `chain` directly here.
    if (isDesignWorkspaceImportError(error)) {
      const err = error as DesignWorkspaceImportError;
      const label =
        err.code === "IMPORT_CYCLE_DETECTED"
          ? "Design Import Cycle"
          : err.code === "IMPORT_SCOPE_VIOLATION"
            ? "Design Import Scope Violation"
            : "Design Import Not Found";
      return {
        ok: false,
        previewHtml: buildDesignPreviewErrorHtml(err.message, {
          title: componentName,
          label,
        }),
        compileReport: createEmptyCompileReport(err.message),
        error: err.message,
        designImportError: {
          code: err.code,
          message: err.message,
          ref: err.ref,
          chain: [...err.chain],
          // Rev-J1: lift resolvedId (cycle head) onto the envelope when
          // the compiler knew it. Omitted (not forced to null/empty) so
          // envelope consumers can branch on presence without tripping
          // on a placeholder.
          ...(err.resolvedId ? { resolvedId: err.resolvedId } : {}),
        },
      };
    }

    if (isDesignWorkspaceCompileError(error)) {
      return {
        ok: false,
        previewHtml: buildDesignPreviewErrorHtml(error.message, {
          title: componentName,
          label: "Compilation Failed",
        }),
        compileReport: error.report,
        error: error.message,
      };
    }

    const message = error instanceof Error ? error.message : "Compilation failed.";
    return {
      ok: false,
      previewHtml: buildDesignPreviewErrorHtml(message, {
        title: componentName,
        label: "Compilation Failed",
      }),
      compileReport: createEmptyCompileReport(message),
      error: message,
    };
  }
}

function buildValidationMessage(validation: DesignWorkspaceValidationResult | undefined): string | undefined {
  if (!validation) {
    return undefined;
  }

  if (validation.passed) {
    return `Post-edit checks passed (${validation.checks.length} checks).`;
  }

  const failedChecks = validation.checks.filter((check) => check.status === "fail").length;
  return `Post-edit checks found ${failedChecks} issue${failedChecks === 1 ? "" : "s"}.`;
}

function buildAgentErrorSummary(report: DesignWorkspaceCompileReport): string {
  const lines: string[] = [];

  if (report.errors.length > 0) {
    for (const err of report.errors.slice(0, 5)) {
      const loc = err.location ? ` (line ${err.location.line})` : "";
      const sug = err.suggestion ? ` → Fix: ${err.suggestion}` : "";
      lines.push(`[${err.type}]${loc} ${err.message}${sug}`);
    }
    if (report.errors.length > 5) {
      lines.push(`... and ${report.errors.length - 5} more errors`);
    }
  }

  const missing = report.dependencyCheck.missingPackages;
  if (missing.length > 0) {
    lines.push(`Missing packages: ${missing.join(", ")} — use action "install" to add them.`);
  }

  if (report.diagnostics?.length && lines.length === 0) {
    for (const diagnostic of report.diagnostics.slice(0, 3)) {
      const loc = diagnostic.location ? ` (line ${diagnostic.location.line})` : "";
      lines.push(`${diagnostic.text}${loc}`);
    }
    if (report.diagnostics.length > 3) {
      lines.push(`... and ${report.diagnostics.length - 3} more diagnostics`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "Compilation failed (no structured error details available).";
}

function buildCompileFailureResult(
  action: DesignWorkspaceInput["action"],
  baseData: DesignWorkspaceResultData,
  compileFailure: CompiledPreviewFailure,
  declaredAliases: string[] = [],
): DesignWorkspaceResult {
  // W2.3 — if the top-of-pipeline alias rewrite raised, surface a structured
  // envelope with the alias name + declared aliases so the agent can recover
  // without parsing free-form text.
  const aliasDetails = extractAssetAliasNotFoundDetails(
    compileFailure.compileReport,
    declaredAliases,
  );
  const assetAliasError = aliasDetails
    ? {
        ...aliasDetails,
        message: compileFailure.compileReport.errors[0]?.message ?? compileFailure.error,
      }
    : undefined;

  return {
    success: false,
    action,
    error: compileFailure.error,
    data: {
      ...baseData,
      previewHtml: compileFailure.previewHtml,
      compileReport: compileFailure.compileReport,
      missingPackages: compileFailure.compileReport.dependencyCheck.missingPackages,
      agentErrorSummary: buildAgentErrorSummary(compileFailure.compileReport),
      autoRecoveryAttempted: Boolean(compileFailure.compileReport.autoInstall?.attempted),
      autoRecoveryResult: compileFailure.compileReport.autoInstall
        ? compileFailure.compileReport.autoInstall.success
          ? "success"
          : "failed"
        : "not-needed",
      ...(assetAliasError ? { assetAliasError } : {}),
      // W2.4 — lift the structured globals.css failure onto the envelope so
      // the agent sees `data.globalsCssError.code` alongside the freeform
      // `error` string. Preserved verbatim from `CompiledPreviewFailure`.
      ...(compileFailure.globalsCssError
        ? { globalsCssError: compileFailure.globalsCssError }
        : {}),
      // Sprint 4 W4.2 — lift the structured `design:<ref>` resolver failure
      // onto the envelope alongside a matching top-level `errorCode` so the
      // agent can branch on a single string without parsing the freeform
      // `error` message. Done LAST so it overrides any generic errorCode
      // baseData might have carried from an earlier validation step.
      ...(compileFailure.designImportError
        ? {
            designImportError: compileFailure.designImportError,
            errorCode: compileFailure.designImportError.code,
          }
        : {}),
    },
  };
}

function buildMissingComponentError(componentId: string, action: "edit" | "patch" | "readSource" | "status"): string {
  return `Design "${componentId}" is not available for ${action}. Run action "list" to discover persisted designs for this session, or pass the latest source with "activeComponentCode".`;
}

/** Executor-side defaults for the screenshot service. Kept out of the Zod
 * schema so the tool description does not leak implementation details to the
 * model (per the W1.3 spec). */
const DEFAULT_SCREENSHOT_VIEWPORT: ScreenshotViewport = {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
};

const MAX_PROBE_SELECTORS = 16;
const MAX_PROBE_SELECTOR_CHARS = 200;

/** Defensive runtime normalization for agent-supplied probe selectors. */
function normalizeProbeSelectors(selectors: string[] | undefined): string[] | undefined {
  if (!selectors || !Array.isArray(selectors)) return undefined;
  const cleaned = selectors
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= MAX_PROBE_SELECTOR_CHARS)
    .slice(0, MAX_PROBE_SELECTORS);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Sprint 4 W4.1 — runtime cap for the CDP state harness. */
const MAX_STATE_ENTRIES = 8;
const SUPPORTED_STATE_PSEUDOS_AT_BOUNDARY: readonly ScreenshotStatePseudo[] = [
  "hover",
  "focus-visible",
  "active",
  "disabled",
];

/**
 * Defensive runtime normalization for agent-supplied state entries. Drops
 * malformed entries at the tool boundary so the screenshot service only
 * sees well-formed requests; runtime failures (selector-not-found,
 * CDP error) are still reported inline via `stateScreenshots[N].error`.
 */
export function normalizeStateRequests(
  raw: DesignWorkspaceInput["states"] | undefined,
): ScreenshotStateRequest[] | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;
  const cleaned: ScreenshotStateRequest[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const selector =
      typeof entry.selector === "string" ? entry.selector.trim() : "";
    const pseudo = entry.pseudo;
    if (!selector || selector.length > MAX_PROBE_SELECTOR_CHARS) continue;
    if (
      typeof pseudo !== "string" ||
      !(SUPPORTED_STATE_PSEUDOS_AT_BOUNDARY as readonly string[]).includes(
        pseudo,
      )
    ) {
      continue;
    }
    const label =
      typeof entry.label === "string" && entry.label.trim().length > 0
        ? entry.label.trim().slice(0, 120)
        : undefined;
    cleaned.push({
      selector,
      pseudo: pseudo as ScreenshotStatePseudo,
      ...(label ? { label } : {}),
    });
    if (cleaned.length >= MAX_STATE_ENTRIES) break;
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Defensive runtime normalization for the agent-supplied viewport. */
function normalizeViewport(
  viewport: { width?: unknown; height?: unknown; deviceScaleFactor?: unknown } | undefined,
): ScreenshotViewport {
  const safeNumber = (value: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  if (!viewport || typeof viewport !== "object") {
    return { ...DEFAULT_SCREENSHOT_VIEWPORT };
  }
  return {
    width: safeNumber(viewport.width, DEFAULT_SCREENSHOT_VIEWPORT.width, 200, 4096),
    height: safeNumber(viewport.height, DEFAULT_SCREENSHOT_VIEWPORT.height, 200, 4096),
    deviceScaleFactor: safeNumber(
      viewport.deviceScaleFactor,
      DEFAULT_SCREENSHOT_VIEWPORT.deviceScaleFactor,
      1,
      3,
    ),
  };
}

/** Resolve whether a given action should trigger screenshot capture. */
function actionProducesPreview(
  action: DesignWorkspaceInput["action"],
): action is "generate" | "edit" | "patch" | "import" {
  return (
    action === "generate" ||
    action === "edit" ||
    action === "patch" ||
    action === "import"
  );
}

interface ScreenshotCaptureOutcome {
  screenshot?: ScreenshotResult["screenshot"];
  probes?: ScreenshotResult["probes"];
  /**
   * Sprint 4 W4.1 — per-state captures. Present when the caller passed a
   * non-empty `states` input; each entry is either a successful capture or
   * a structured per-entry error (see `ScreenshotStateEntry`).
   */
  stateScreenshots?: ScreenshotStateEntry[];
  /** See `DesignWorkspaceResultData.screenshotError` — object shape for future extensibility. */
  screenshotError?: { message: string; code?: string };
}

/**
 * Thin wrapper around the screenshot service. Never throws — a screenshot
 * failure must NOT fail the whole tool call. Returns a neutral outcome when
 * capture is skipped (missing componentId, returnScreenshot === false) so the
 * caller can rely on a single code path.
 *
 * @internal Exported for the Sprint 1 Rev-A2 Gap 1 regression test. Do not
 * depend on this symbol outside of tests; the stable public surface is
 * `createDesignWorkspaceTool({ defaultPreviewTheme })`.
 */
export async function maybeCaptureScreenshot(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
  componentId: string | undefined,
): Promise<ScreenshotCaptureOutcome> {
  if (!componentId) return {};
  if (input.returnScreenshot === false) return {};

  const userId = getPersistedUserId(options);
  const sessionId = getSessionId(options);
  if (!userId) {
    // The screenshot service requires an authenticated user scope (per the
    // ScreenshotOptions contract). Skip quietly so unauthenticated flows still
    // work — the agent still receives previewHtmlRef in the envelope.
    return {};
  }

  const probeSelectors = normalizeProbeSelectors(input.probeSelectors);
  const states = normalizeStateRequests(input.states);
  const viewport = normalizeViewport(input.viewport);

  // Resolve the effective theme by layering two sources, preserving the
  // reviewer-mandated "never default to dark" invariant:
  //   1. The LLM's `input.previewTheme` (schema field) — most specific.
  //   2. The request-scoped `options.defaultPreviewTheme` forwarded by the
  //      route handler from the client's Zustand store (Sprint 1 Rev-A2
  //      Gap 1 fix).  This closes the reviewer blocker where mutating tool
  //      calls captured dark screenshots because no caller populated the
  //      schema field; the LLM omits it almost every turn.
  //
  // If BOTH are undefined, pass `undefined` so `captureScreenshot` falls
  // through to `buildExportPreviewHtml` (the compiler's own default path).
  // We still do NOT substitute a hardcoded "dark" here.
  const effectiveTheme = input.previewTheme ?? options.defaultPreviewTheme;
  // Sprint 3 Rev-F1 — forward the validated renderMany cells so the
  // compiled preview HTML emits the CSS grid + screenshot captures the
  // full scrollable document instead of clipping at viewport height.
  // Re-running `validateRenderMany` here is cheap (O(N) over ≤24 entries)
  // and keeps the screenshot path robust against callers that forget to
  // validate upstream. On the happy path the handlers have already
  // validated; on the failure path the handler short-circuited BEFORE
  // reaching this function, so falling back to `[]` is the only path
  // that can reach the `!ok` branch here.
  const renderManyValidation = validateRenderMany(input.renderMany);
  const renderManyCells = renderManyValidation.ok ? renderManyValidation.cells : [];
  try {
    const result = await captureScreenshot({
      componentId,
      sessionId,
      userId,
      viewport,
      probeSelectors,
      theme: effectiveTheme,
      renderMany: renderManyCells.length > 0 ? renderManyCells : undefined,
      states,
    });
    return {
      screenshot: result.screenshot,
      probes: result.probes,
      stateScreenshots: result.stateScreenshots,
    };
  } catch (error) {
    // Surface `error.cause` in addition to the top-level message so opaque
    // Puppeteer failures (e.g. `Waiting failed: 30000ms exceeded`) carry the
    // underlying reason — otherwise the agent sees just the timeout string
    // with no hint that the root cause was sanitizer stripping, missing
    // assets, or an eval error inside the preview bundle.
    const rawMessage = error instanceof Error ? error.message : "Screenshot capture failed.";
    const causeMessage =
      error instanceof Error && error.cause
        ? error.cause instanceof Error
          ? error.cause.message
          : String(error.cause)
        : undefined;
    const message = causeMessage ? `${rawMessage} (cause: ${causeMessage})` : rawMessage;
    console.warn(
      `[designWorkspace] Screenshot capture failed for component ${componentId}: ${message}`,
      error instanceof Error ? { stack: error.stack, cause: error.cause } : undefined,
    );
    return { screenshotError: { message } };
  }
}

/**
 * Build the agent-actionable preview metadata block that replaces the stripped
 * `previewHtmlLength` scalar. Emitted on every mutating action (generate /
 * edit / patch) regardless of whether the screenshot succeeded, so the agent
 * always knows how to recover the full HTML.
 */
function buildPreviewMeta(args: {
  componentId: string;
  generatedAt: number;
  previewHtmlLength: number;
  capture: ScreenshotCaptureOutcome;
}): Pick<
  DesignWorkspaceResultData,
  | "componentId"
  | "generatedAt"
  | "screenshot"
  | "probes"
  | "stateScreenshots"
  | "previewHtmlRef"
  | "screenshotError"
> {
  return {
    componentId: args.componentId,
    generatedAt: args.generatedAt,
    screenshot: args.capture.screenshot,
    probes: args.capture.probes,
    ...(args.capture.stateScreenshots && args.capture.stateScreenshots.length > 0
      ? { stateScreenshots: args.capture.stateScreenshots }
      : {}),
    previewHtmlRef: { length: args.previewHtmlLength, getVia: "readSource" },
    ...(args.capture.screenshotError ? { screenshotError: args.capture.screenshotError } : {}),
  };
}

async function resolveDesignSource(
  options: DesignWorkspaceToolOptions,
  input: Pick<DesignWorkspaceInput, "activeComponentCode" | "activeComponentId">,
): Promise<ResolvedDesignSource> {
  if (input.activeComponentCode?.trim()) {
    return {
      component: input.activeComponentId ? await findWorkspaceDesign({
        id: input.activeComponentId,
        userId: getPersistedUserId(options),
        sessionId: getSessionId(options),
      }) : null,
      code: input.activeComponentCode.trim(),
      inline: true,
    };
  }

  if (!input.activeComponentId) {
    return {
      component: null,
      code: null,
      inline: false,
    };
  }

  const component = await findWorkspaceDesign({
    id: input.activeComponentId,
    userId: getPersistedUserId(options),
    sessionId: getSessionId(options),
  });

  return {
    component,
    code: component?.code ?? null,
    inline: false,
  };
}

async function persistNewDesign(
  options: DesignWorkspaceToolOptions,
  input: {
    id: string;
    name: string;
    prompt: string;
    code: string;
    mode: string;
    style: string;
  },
): Promise<DesignGalleryItem> {
  const userId = getPersistedUserId(options);
  if (!userId) {
    throw new Error("Design workspace requires an authenticated user context to persist generated source.");
  }

  return saveDesignComponentRecord({
    id: input.id,
    userId,
    characterId: options.characterId,
    sessionId: getSessionId(options),
    name: input.name,
    prompt: input.prompt,
    code: input.code,
    mode: input.mode,
    style: input.style,
    framework: "react-tailwind",
    category: "workspace",
  });
}

async function persistExistingDesign(
  component: DesignGalleryItem,
  updates: {
    code: string;
    prompt?: string;
    name?: string;
    mode?: string;
    style?: string;
    sessionId?: string;
    characterId?: string;
  },
): Promise<DesignGalleryItem> {
  const updated = await updateDesignComponent(component.userId, component.id, {
    code: updates.code,
    prompt: updates.prompt,
    name: updates.name,
    mode: updates.mode,
    style: updates.style,
    sessionId: updates.sessionId,
    characterId: updates.characterId,
  });

  if (!updated) {
    throw new Error(`Failed to persist design "${component.id}".`);
  }

  return {
    ...updated,
    previewUrl: component.previewUrl,
  };
}

/**
 * Persist (or update-in-place) a design row produced by the "import" action.
 *
 * Centralizes two responsibilities the W2.1 spec requires but that live
 * nowhere else:
 *   1. Idempotency on `(userId, sessionId, sourcePath)` — a second import of
 *      the same file updates the existing row instead of creating a
 *      duplicate. See `findDesignComponentBySourcePath`.
 *   2. Metadata + tag stamping — `metadata.sourcePath`, `metadata.importedAt`,
 *      and the automatic `"imported"` tag.
 */
async function persistImportedDesign(
  options: DesignWorkspaceToolOptions,
  input: {
    name: string;
    code: string;
    sourcePath: string;
    importedAt: string;
    tags: string[];
  },
): Promise<{ component: DesignGalleryItem; updated: boolean }> {
  const userId = getPersistedUserId(options);
  if (!userId) {
    throw new Error(
      'Design workspace "import" requires an authenticated user context.',
    );
  }
  const sessionId = getSessionId(options);
  const effectiveSessionId = sessionId !== "UNSCOPED" ? sessionId : null;

  const importMetadata: DesignComponentMetadata & { sourcePath: string } = {
    sourcePath: input.sourcePath,
    importedAt: input.importedAt,
  };

  // BA-2: the find + insert/update sequence now runs inside a
  // `db.transaction()` inside `upsertImportedDesignComponent` with a
  // retry on UNIQUE constraint violation. The partial unique index on
  // (user_id, session_id, json_extract(metadata, '$.sourcePath')) makes
  // racing duplicates impossible at the DB level; the retry turns a
  // racing INSERT into an UPDATE so the caller sees a single
  // componentId regardless of which concurrent tool call won.
  const { row, updated } = await upsertImportedDesignComponent({
    userId,
    characterId: options.characterId ?? null,
    sessionId: effectiveSessionId,
    name: input.name,
    prompt: `Imported from ${input.sourcePath}`,
    code: input.code,
    mode: "tailwind",
    style: "default",
    framework: "react-tailwind",
    category: "workspace",
    tags: input.tags,
    metadata: importMetadata,
    newId: generateId(),
  });

  return {
    component: {
      ...row,
      previewUrl: row.previewPath
        ? `/api/media/${row.previewPath.replace(/^\/+/, "")}`
        : null,
    },
    updated,
  };
}

/**
 * Size cap for the tool-result payload reaching the AI runtime.
 *
 * The Anthropic / AI SDK runtime refuses tool results above a token cap
 * (~66KB observed in production) and spills them to disk — which means the
 * client bridge never receives the payload and the workspace stays empty.
 *
 * We slim the result to ensure the payload stays comfortably under this cap:
 *   - `code` is the source of truth in the DB; the bridge hydrates it via
 *     `/api/design/gallery` action "get" using `componentId`.
 *   - `previewHtml` is compiled server-side, but the client can always
 *     recompile via `/api/design/compile-preview` — so we only keep it when
 *     it's small enough to round-trip cheaply.
 *   - `compileReport` diagnostics are capped so error feedback still reaches
 *     the agent without blowing the budget.
 */
/** @internal Exported for unit testing only. */
export const SLIM_PREVIEW_HTML_THRESHOLD = 4_000; // ~4KB — keep only for trivial placeholders
/** @internal Exported for unit testing only. */
export const SLIM_CODE_THRESHOLD = 8_000; // ~8KB — below this we can inline code for readSource
/** @internal Exported for unit testing only. */
export const SLIM_RESULT_SAFETY_CAP = 40_000; // ~40KB — hard cap before we start stripping everything heavy

const MUTATING_ACTIONS: ReadonlySet<DesignWorkspaceInput["action"]> = new Set([
  "generate",
  "edit",
  "patch",
  "import",
]);

function estimatePayloadBytes(payload: unknown): number {
  try {
    return JSON.stringify(payload).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateCompileReport(
  report: DesignWorkspaceCompileReport | undefined,
): DesignWorkspaceCompileReport | undefined {
  if (!report) return report;
  const capped: DesignWorkspaceCompileReport = {
    ...report,
    errors: report.errors?.slice(0, 5),
    warnings: report.warnings?.slice(0, 5),
  };
  if (capped.diagnostics) {
    capped.diagnostics = capped.diagnostics
      .slice(0, 5)
      .map((d) => ({ ...d, text: typeof d.text === "string" ? d.text.slice(0, 2000) : d.text }));
  }
  return capped;
}

/** @internal Exported for unit testing only. */
export function slimResult(result: DesignWorkspaceResult): DesignWorkspaceResult {
  if (!result.data) {
    return result;
  }

  const action = result.action as DesignWorkspaceInput["action"];
  const {
    previewHtml,
    renderedHtml: _renderedHtml,
    code,
    compileReport,
    ...rest
  } = result.data as DesignWorkspaceResultData & { renderedHtml?: string };

  const slim: DesignWorkspaceResultData = { ...rest };
  let truncated = false;

  // --- Code handling -------------------------------------------------------
  // Mutating tool calls (generate/edit/patch) always drop full code from the
  // payload: the DB row is the source of truth, and the client bridge refetches
  // by componentId. This keeps the tool result compact regardless of how
  // long the generated component is.
  //
  // Non-mutating calls (readSource) keep the code inline up to a size cap
  // because the agent called them specifically to inspect the source.
  if (code !== undefined) {
    const isMutating = MUTATING_ACTIONS.has(action);
    const byteLen = code.length;
    const lineCount = code.split("\n").length;

    if (isMutating) {
      slim.codeLength = byteLen;
      slim.codeLines = lineCount;
      truncated = true;
    } else if (byteLen > SLIM_CODE_THRESHOLD) {
      // readSource on a huge file — still strip to avoid spill-to-disk.
      slim.codeLength = byteLen;
      slim.codeLines = lineCount;
      truncated = true;
    } else {
      slim.code = code;
    }
  }

  // --- Preview HTML --------------------------------------------------------
  // previewHtml is a fully-formed HTML document (often 20–80KB). The client
  // can always recompile via /api/design/compile-preview using the DB code,
  // so we only keep it inline when it's small (placeholder or tiny preview).
  //
  // When we strip it, we replace the legacy `previewHtmlLength` scalar with an
  // agent-actionable `previewHtmlRef` telling the agent how to retrieve the
  // full HTML (via the `readSource` action + client-side recompile). This
  // honors the "never strip a field without an actionable substitute" rule.
  if (previewHtml !== undefined) {
    if (previewHtml.length <= SLIM_PREVIEW_HTML_THRESHOLD) {
      slim.previewHtml = previewHtml;
    } else {
      slim.previewHtmlRef = { length: previewHtml.length, getVia: "readSource" };
      truncated = true;
    }
  }

  // --- Compile report ------------------------------------------------------
  // Truncate long diagnostic lists but preserve structure so the agent can
  // still read the first few actionable errors.
  const cappedReport = truncateCompileReport(compileReport);
  if (cappedReport) {
    slim.compileReport = cappedReport;
  }

  // --- Hydrate ref & truncated flag ---------------------------------------
  if (truncated && slim.componentId) {
    slim.hydrateRef = { kind: "gallery", componentId: slim.componentId };
    slim.truncated = true;
  }

  // --- Freshness stamp -----------------------------------------------------
  // Mutating actions stamp `generatedAt` so the client-side tool-UI can
  // distinguish a just-generated result from a replay of persisted chat
  // history. This is a belt-and-suspenders signal for `isLive` detection:
  // the assistant-ui streaming-state heuristic misses when the SDK delivers
  // `output-available` in a single render commit. A timestamp comparison at
  // the tool-UI never misses.
  if (MUTATING_ACTIONS.has(action)) {
    slim.generatedAt = Date.now();
  }

  // --- Final safety cap ---------------------------------------------------
  // If after all the above we're still too big (unlikely but possible with
  // huge agentErrorSummary / history blobs), drop compileReport.diagnostics
  // and long string fields.
  if (estimatePayloadBytes({ ...result, data: slim }) > SLIM_RESULT_SAFETY_CAP) {
    if (slim.compileReport?.diagnostics) {
      slim.compileReport = { ...slim.compileReport, diagnostics: undefined };
    }
    if (typeof slim.agentErrorSummary === "string" && slim.agentErrorSummary.length > 2000) {
      slim.agentErrorSummary = `${slim.agentErrorSummary.slice(0, 2000)}…`;
    }
    if (typeof slim.message === "string" && slim.message.length > 2000) {
      slim.message = `${slim.message.slice(0, 2000)}…`;
    }
    slim.truncated = true;
  }

  return { ...result, data: slim };
}

async function executeDesignWorkspace(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  let result: DesignWorkspaceResult;

  switch (input.action) {
    case "open":
      result = await handleOpen(options);
      break;
    case "install":
      result = await handleInstall(options, input);
      break;
    case "generate":
      result = await handleGenerate(options, input);
      break;
    case "edit":
      result = await handleEdit(options, input);
      break;
    case "patch":
      result = await handlePatch(options, input);
      break;
    case "readSource":
      result = await handleReadSource(options, input);
      break;
    case "list":
      result = await handleList(options);
      break;
    case "status":
      result = await handleStatus(options, input);
      break;
    case "close":
      result = handleClose(options);
      break;
    case "port":
      result = await handlePort(options, input);
      break;
    case "import":
      result = await handleImport(options, input);
      break;
    case "snapshot.save":
      result = await handleSnapshotSave(options, input);
      break;
    case "snapshot.pin":
      result = await handleSnapshotPin(options, input);
      break;
    case "snapshot.rename":
      result = await handleSnapshotRename(options, input);
      break;
    case "snapshot.list":
      result = await handleSnapshotList(options, input);
      break;
    case "snapshot.delete":
      result = await handleSnapshotDelete(options, input);
      break;
    case "snapshot.diff":
      result = await handleSnapshotDiff(options, input);
      break;
    default:
      result = { success: false, action: String(input.action), error: `Unknown action: ${input.action}` };
  }

  return slimResult(result);
}

export function createDesignWorkspaceTool(options: DesignWorkspaceToolOptions = {}) {
  // The AI SDK `tool()` factory types the `execute` and `toModelOutput`
  // callbacks with `input: unknown` (the schema's inferred type is not
  // propagated to these callback signatures). We accept `unknown` here and
  // cast to `DesignWorkspaceInput` inside the body — the `inputSchema`
  // jsonSchema<DesignWorkspaceInput>(...) guarantees the shape at runtime.
  const executeWithLogging = withToolLogging(
    "designWorkspace",
    options.sessionId,
    async (input: unknown) =>
      executeDesignWorkspace(options, input as DesignWorkspaceInput),
  );

  return tool({
    description: `Control the design workspace to generate, inspect, and iterate on UI components using code + preview.

**Actions:**
- "open": Open the design workspace panel.
- "install": Install npm packages for use in designs. Provide \`packages\` array (e.g. ["three", "@react-three/fiber"]).
- "generate": Generate a new UI component. Provide \`code\` (direct TSX) to render your own code, OR \`prompt\` for AI generation. Optional: \`mode\`, \`style\`, \`assets\`.
- "edit": Edit a persisted component. Provide \`activeComponentId\`. Provide \`activeComponentCode\` WITHOUT \`editPrompt\` to directly replace the code, OR provide \`editPrompt\` for AI-driven full-file rewriting.
- "patch": Surgically edit a persisted component using exact find-and-replace. Requires \`activeComponentId\`. Use \`oldString\` + \`newString\` for single-location edits, or \`patches\` array for multi-location edits (e.g., wrapping content in a new parent element requires inserting both an opening and closing tag). For wrapping operations, include the full block being wrapped in \`oldString\` and the wrapped version in \`newString\`, OR use \`patches\` to apply sequential insertions atomically.
- "readSource": Read back the source code of a persisted component. Pass \`activeComponentId\`.
- "list": List designs available to the current workspace session.
- "status": Inspect whether a design is persisted and available. Pass \`activeComponentId\`.
- "close": Close the design workspace panel.
- "port": Write a workspace component back to a synced-folder path. Requires \`componentId\` and \`targetPath\` (synced-folder-relative). Defaults to \`dryRun: true\` — set it to false to actually write. If the target file exists AND differs, you must also pass \`overwrite: true\`. Always returns a unified diff so the user can approve before you apply.
- "import": Import an existing TSX file from a synced folder into the workspace. Provide \`sourcePath\` (synced-folder-relative or absolute). The file is compiled via the same pipeline as "generate"; on compile failure no row is written and the error envelope carries the compile report. On success a DesignComponentRow is persisted with \`metadata.sourcePath\` + \`metadata.importedAt\`, and \`tags\` (plus an automatic \`"imported"\` tag). Repeated imports of the same file update the existing row in place rather than creating duplicates.
  Supported imports inside the imported file:
  - **Relative imports** ("./Foo", "../utils/bar") — resolved against the source file's actual directory inside the synced folder, so sibling components, hooks, and asset modules bundle transitively.
  - **TypeScript path aliases** ("@/lib/utils", "~/components/Button") — resolved via the synced folder's \`tsconfig.json\` (\`compilerOptions.paths\` + \`baseUrl\`). Aliased files are then bundled like any other source file.
  - **CSS imports** — only plain (\`./coach.css\`) and CSS Modules (\`./Foo.module.css\`) are bundled. Plain CSS is injected as a runtime <style> block at component mount; CSS Modules expose an identity Proxy (\`styles.button === "button"\`), which preserves class-name shape without scoping. \`@import\` and \`url(...)\` references inside imported CSS are recursively inlined (assets become \`data:\` URLs). **Preprocessed stylesheets (.scss / .sass / .less / .styl) are NOT supported** — pre-compile to plain CSS before importing, or render the component via \`action: "port"\` instead.
  - **Static asset imports** — \`.svg\`, \`.png\`, \`.jpg\`, \`.jpeg\`, \`.gif\`, \`.webp\`, \`.avif\`, \`.ico\` are inlined as \`data:\` URLs.
  - **Next.js framework primitives** — \`next/navigation\`, \`next/router\`, \`next/link\`, \`next/head\`, \`next/image\`, \`next/dynamic\`, \`next/script\`, \`next/font\`, \`next/font/*\` ship richer preview shims; everything else under \`next/...\` (incl. \`next/server\`, \`next/headers\`, \`next/cache\`, \`next/og\`) falls back to a generic noop Proxy that satisfies imports without crashing.
  - **Bare npm packages** — resolved against (1) the curated \`selene-workspace/node_modules\` first, (2) the synced repo's own \`node_modules\` next, (3) the host project's \`node_modules\` as a final fallback. Packages installed only in the synced repo (e.g. \`framer-motion\` in a customer app) are usable without re-installing.
  Imports that fail to resolve surface a structured \`compileReport\` with a 4-way classified suggestion (relative / alias / framework / npm), so the agent can fix the source rather than blindly install packages.
- "snapshot.save": Persist an iteration of a design component as a durable \`design_snapshots\` row (separate from the transient Zustand undo history). Provide \`componentId\`. Optional: \`sourceCode\` (defaults to the component's current source), \`name\` (<=200 chars), \`isPinned\` (defaults to false).
- "snapshot.pin": Pin / unpin a persisted snapshot. Provide \`snapshotId\` and \`isPinned\`. Returns the updated row.
- "snapshot.rename": Rename a persisted snapshot (or clear the name by passing \`name: null\`). Provide \`snapshotId\`. Max 200 chars on \`name\`.
- "snapshot.list": List persisted snapshots for the current (user, session), newest-first. Optional filters: \`isPinnedOnly\`, \`componentId\`, \`limit\` (capped at 100).
- "snapshot.delete": Delete a persisted snapshot. Provide \`snapshotId\`. Returns \`deleted: boolean\`.
- "snapshot.diff": Compute a unified diff between two persisted snapshots (both must belong to the current session). Provide \`a\` and \`b\` (snapshot ids). Optional: \`maxLines\` (default 1000, hard cap 5000). Returns \`diff\` (empty when identical), \`diffTruncated\`, \`sameContent\`, \`totalLines\`, plus compact \`a\`/\`b\` row summaries.`,
    inputSchema: jsonSchema<DesignWorkspaceInput>({
      type: "object",
      title: "DesignWorkspaceInput",
      description: "Input for design workspace operations",
      properties: {
        action: {
          type: "string",
          enum: [
            "open",
            "generate",
            "edit",
            "patch",
            "readSource",
            "list",
            "status",
            "close",
            "install",
            "port",
            "import",
            "snapshot.save",
            "snapshot.pin",
            "snapshot.rename",
            "snapshot.list",
            "snapshot.delete",
            "snapshot.diff",
          ],
          description: "The workspace action to perform.",
        },
        packages: {
          type: "array",
          items: { type: "string" },
          description: 'npm package names to install (e.g. ["three", "@react-three/fiber"]). Required for "install" action.',
        },
        prompt: {
          type: "string",
          description: 'Text description of the component to generate. Required for "generate" unless "code" is provided.',
        },
        name: {
          type: "string",
          description: 'Short, descriptive name for the component (e.g. "Pricing Card", "Login Form", "Hero Section"). Required for "generate". Used as the display name in the design workspace.',
        },
        code: {
          type: "string",
          description: 'Direct TSX/React component code. If provided for "generate", skips AI generation and renders this code directly. The code should be a complete React component with `export default`.',
        },
        mode: {
          type: "string",
          enum: ["tailwind"],
          description: 'Generation mode (always "tailwind"). Optional for "generate".',
        },
        style: {
          type: "string",
          enum: ["apple-glass", "default"],
          description: 'Visual style for generation or editing. Defaults to "default".',
        },
        assets: {
          type: "array",
          description: 'Image or asset URLs to use in the design (e.g. /api/media/... paths from user uploads). For "generate" and "edit".',
          items: {
            type: "object",
            properties: {
              url: { type: "string", description: "URL of the asset." },
              description: { type: "string", description: "Brief description of the asset content." },
            },
            required: ["url"],
            additionalProperties: false,
          },
        },
        assetAliases: {
          type: "array",
          description: 'Per-call alias map used by the compiler to rewrite `@asset/<alias>` references in the component source to the declared URL BEFORE bundling. Use this when you want generated code to use stable references like `src="@asset/hero"` or `url("@asset/bg")` while the actual media URL (usually /api/media/...) stays request-scoped. Aliases must match /^[a-zA-Z0-9_-]+$/ and be unique per call. URLs must start with http(s):// or /api/media/. Applies to "generate", "edit", and "patch".',
          items: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "Absolute http(s):// URL or a /api/media/... path. The compiler substitutes this for every `@asset/<alias>` reference in the source.",
              },
              alias: {
                type: "string",
                description: 'Short alias key (e.g. "hero", "bg-pattern"). Referenced in source as `@asset/<alias>`. Must match /^[a-zA-Z0-9_-]+$/.',
              },
            },
            required: ["url", "alias"],
            additionalProperties: false,
          },
        },
        editPrompt: {
          type: "string",
          description: 'Natural-language edit instruction for AI-driven editing. Required for "edit" unless providing "activeComponentCode" for direct replacement.',
        },
        activeComponentCode: {
          type: "string",
          description: 'Component code override. Optional for direct replacement or explicit source-driven edits.',
        },
        activeComponentId: {
          type: "string",
          description: 'ID of the persisted component to edit, patch, inspect, or read.',
        },
        oldString: {
          type: "string",
          description: 'The exact text to find in the component code. Required for "patch" action.',
        },
        newString: {
          type: "string",
          description: 'The replacement text. Required for "patch" action.',
        },
        replaceAll: {
          type: "boolean",
          description: 'If true, replace all occurrences of oldString. Default: false (replace first occurrence only). For "patch" action.',
        },
        patches: {
          type: "array",
          description: 'Array of sequential patches for multi-location edits. Each patch has oldString, newString, and optional replaceAll. Applied in order. Use instead of oldString/newString when wrapping content or making changes at multiple source locations. For "patch" action.',
          items: {
            type: "object",
            properties: {
              oldString: { type: "string", description: "The exact text to find." },
              newString: { type: "string", description: "The replacement text." },
              replaceAll: { type: "boolean", description: "Replace all occurrences. Default: false." },
            },
            required: ["oldString", "newString"],
            additionalProperties: false,
          },
        },
        componentId: {
          type: "string",
          description: 'ID of the workspace component to port. Required for "port" action.',
        },
        targetPath: {
          type: "string",
          description: 'Synced-folder-relative path to write the component source to. Required for "port" action.',
        },
        dryRun: {
          type: "boolean",
          description: 'For "port" action: when true (the default), returns the unified diff without writing. Must be explicitly set to false to actually write.',
        },
        overwrite: {
          type: "boolean",
          description: 'For "port" action: required to be true when the target file exists and differs from the component source. Default: false.',
        },
        expectedContentSha256: {
          type: "string",
          description: 'For "port" action with dryRun:false — SHA-256 of the on-disk target captured during the preceding dry-run (returned as `data.preflight.contentSha256`). REQUIRED on apply calls unless `allowStaleWrite: true` is passed. The tool re-reads the file right before writing and rejects with errorCode "PORT_STALE_DIFF" if the hash has changed since the dry-run.',
        },
        allowStaleWrite: {
          type: "boolean",
          description: 'For "port" action with dryRun:false — explicit opt-out for the freshness guard. When true, the tool does NOT require `expectedContentSha256` and writes without a compare-and-swap revalidation. Use only when the caller accepts the race risk (e.g. fresh-write into an empty path, or a scripted flow that takes responsibility for the ordering externally). Default: false.',
        },
        sourcePath: {
          type: "string",
          description: 'Synced-folder-relative (or absolute) TSX file path. Required for "import" action. Resolved through the character\'s synced folders — paths outside are rejected.',
        },
        tags: {
          type: "array",
          description: 'Tags to attach to the imported design row. "import" action automatically adds "imported" if not already present. Plain string array — no atom/molecule schema.',
          items: { type: "string" },
        },
        viewport: {
          type: "object",
          description: 'Optional viewport override for the post-action screenshot (applies to "generate", "edit", "patch").',
          properties: {
            width: { type: "number", description: "Viewport width in CSS pixels (200–4096)." },
            height: { type: "number", description: "Viewport height in CSS pixels (200–4096)." },
            deviceScaleFactor: { type: "number", description: "Device scale factor (1–3)." },
          },
          required: ["width", "height", "deviceScaleFactor"],
          additionalProperties: false,
        },
        probeSelectors: {
          type: "array",
          description: 'CSS selectors to probe on the rendered preview for computed styles / bounding rects. Max 16 selectors, each <= 200 chars. Applies to mutating actions.',
          items: { type: "string" },
          maxItems: 16,
        },
        states: {
          type: "array",
          description:
            'Sprint 4 W4.1 — CDP state harness. When provided on a mutating action ("generate" | "edit" | "patch"), the tool captures ONE additional PNG per entry with the corresponding pseudo-class force-applied to `selector` via Chrome DevTools Protocol `Emulation.setEmulatedPseudoState`. Each state capture runs on a fresh preview page so leaked pseudo state cannot bleed into the base screenshot. Per-entry failures (unresolvable selector, CDP error) surface as structured envelopes on `data.stateScreenshots[N].error` without failing the base capture. Max 8 entries per call.',
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              selector: {
                type: "string",
                description:
                  "CSS selector to apply the pseudo-class to. Must match exactly one element in the rendered preview. Selectors that don't resolve surface as STATE_SELECTOR_NOT_FOUND on the matching stateScreenshots entry.",
              },
              pseudo: {
                type: "string",
                enum: ["hover", "focus-visible", "active", "disabled"],
                description:
                  'Pseudo-class to force. `focus-visible` is recognized by CDP verbatim — pass the kebab-case form.',
              },
              label: {
                type: "string",
                description:
                  'Optional label for the returned capture. Defaults to `${pseudo}:${selector}` when omitted.',
              },
            },
            required: ["selector", "pseudo"],
            additionalProperties: false,
          },
        },
        returnScreenshot: {
          type: "boolean",
          description: 'When false, skip post-action screenshot capture (fast iteration). The envelope still includes previewHtmlRef so the agent can fetch the full HTML via "readSource". Default: true.',
        },
        previewTheme: {
          type: "string",
          enum: ["light", "dark", "system"],
          description: 'Active workspace preview theme to render the screenshot/probes under. Usually forwarded by the UI bridge from the Zustand store. When omitted, the compiler default applies.',
        },
        globalsCssPath: {
          type: "string",
          description:
            'Synced-folder-relative path to the real app\'s globals.css (e.g. "sanity-seline/app/globals.css"). When set on a mutating action ("generate" | "edit" | "patch"), the compiler reads the file via resolveSyncedPath and injects its contents as <style data-source="globals"> at the top of the preview <head> — BEFORE Tailwind utilities — so the rendered preview uses the real app\'s design tokens, theme variables, and base styles. Resolution failures surface on data.globalsCssError with codes GLOBALS_CSS_NOT_FOUND / GLOBALS_CSS_NOT_CSS / GLOBALS_CSS_EMPTY / GLOBALS_CSS_TOO_LARGE.',
        },
        referenceImageUrl: {
          type: "string",
          description:
            'Optional reference image rendered as a fixed-position overlay on top of the compiled preview, with a vanilla-JS control panel (opacity slider default 0.4, show/hide toggle, normal/difference blend-mode select) — useful for diffing the generated component against a Figma frame / screenshot. Accepts http(s):// URLs, /api/media/... paths, or data:image/...;base64,... URIs. Applies to "generate", "edit", and "patch". On success the envelope carries data.referenceImage = { url, present: true }; on image-load failure the overlay element stamps data-design-reference-error="true" (screenshot-probeable, not round-tripped through the envelope).',
        },
        renderMany: {
          type: "array",
          description:
            'Auto-grid rendering of prop permutations for "generate" | "edit" | "patch". When supplied (and non-empty), REPLACES the single `<Component />` render with a CSS grid — one cell per entry. Each cell carries `data-design-cell-index="N"` so probeSelectors can target individual cells (e.g. `[data-design-cell-index="2"]`). Low-level primitive: YOU supply the full array of render specs; the tool never auto-infers variants from prop types. Capped at 24 entries (RENDER_MANY_TOO_MANY on exceed). Each `props` must be a plain JSON object — arrays / primitives / nulls are rejected with RENDER_MANY_INVALID_PROPS. Prop values are escaped safely for embedding, so special characters (`"`, `<`, `>`, `\\n`, unicode) cannot escape the preview script context.',
          maxItems: 24,
          items: {
            type: "object",
            properties: {
              props: {
                type: "object",
                description:
                  "JSON-serializable prop bag passed as the component's full prop set for this cell. Treated as opaque — no schema-level validation of individual keys.",
                additionalProperties: true,
              },
              label: {
                type: "string",
                description: "Optional label rendered above the cell (monospace, reduced opacity).",
              },
              className: {
                type: "string",
                description: "Optional CSS class attached to the cell wrapper (useful for backgrounds, borders, etc).",
              },
            },
            required: ["props"],
            additionalProperties: false,
          },
        },
        // ---------------------------------------------------------------------
        // Sprint 3 W3.1 — snapshot action inputs.
        // ---------------------------------------------------------------------
        snapshotId: {
          type: "string",
          description:
            'ID of an existing persisted snapshot row. Required for "snapshot.pin", "snapshot.rename", and "snapshot.delete".',
        },
        sourceCode: {
          type: "string",
          description:
            'Optional TSX source to persist on "snapshot.save". When omitted, the handler reads the current source from the component row referenced by `componentId` (so snapshotting the current state of a component is a one-argument call).',
        },
        isPinned: {
          type: "boolean",
          description:
            'Pin state. Required for "snapshot.pin" (true = pin, false = unpin). Optional on "snapshot.save" (defaults to false) to create the snapshot already pinned.',
        },
        isPinnedOnly: {
          type: "boolean",
          description:
            'For "snapshot.list": when true, only pinned snapshots are returned.',
        },
        limit: {
          type: "number",
          description:
            'For "snapshot.list": optional cap on rows returned. Clamped to 100 (SNAPSHOT_LIST_HARD_CAP); over-cap requests surface `truncated: true` on the envelope without throwing.',
        },
        // ---------------------------------------------------------------------
        // Sprint 3 W3.2 — snapshot.diff inputs.
        // ---------------------------------------------------------------------
        a: {
          type: "string",
          description:
            'For "snapshot.diff": id of the first snapshot row (the "before" side of the diff). Must belong to the current (userId, sessionId); cross-scope ids fail with SNAPSHOT_NOT_FOUND.',
        },
        b: {
          type: "string",
          description:
            'For "snapshot.diff": id of the second snapshot row (the "after" side of the diff). Must belong to the current (userId, sessionId); cross-scope ids fail with SNAPSHOT_NOT_FOUND.',
        },
        maxLines: {
          type: "number",
          description:
            'For "snapshot.diff": optional cap on unified-diff lines returned. Default 1000, hard cap 5000 — over-cap requests surface SNAPSHOT_DIFF_INVALID_INPUT. Truncated output carries `diffTruncated: true` plus the full `totalLines` count.',
        },
      },
      required: ["action"],
      additionalProperties: false,
    }),
    execute: executeWithLogging,
    // Promote the captured screenshot into the model's visible content so the
    // agent can reason about the rendered output (not just the structured JSON
    // metadata). The JSON envelope is also forwarded as a text block so the
    // agent still sees componentId, previewHtmlRef, compileReport, etc.
    //
    // The AI SDK typings provide `input: unknown` / `output: unknown` here
    // regardless of the schema generic — we only read `output`, and the
    // helper narrows it internally via runtime checks.
    //
    // The runtime content-part shape `{type:"image", source:{type:"url", url}}`
    // is intentionally the media envelope our providers accept (asserted by
    // tests under "media envelope shape (Rev-A2)") and does not line up with
    // the AI SDK `ToolResultOutput` union, which only permits `image-url` /
    // `image-data` variants. We cast at the callback boundary to satisfy the
    // SDK's contract without altering the agent-observable envelope.
    toModelOutput: ({ output }: { toolCallId: string; input: unknown; output: unknown }) =>
      designWorkspaceToModelOutput(output) as unknown as ToolResultOutput,
  });
}

/**
 * Convert a DesignWorkspaceResult into AI SDK tool-output content parts.
 *
 * When a screenshot URL is present, emit a multi-part content block with the
 * JSON envelope as a text part AND the screenshot as a media-envelope image
 * part: `{type:"image", source:{type:"url", url}}`. This is the current
 * AI SDK media envelope shape — the older `{type:"image-url", url}` shape
 * is no longer accepted. See sprint plan Rev-A2.
 *
 * Exported so regression tests can assert on the serialized payload shape.
 */
export function designWorkspaceToModelOutput(output: unknown):
  | { type: "json"; value: JSONValue }
  | {
      type: "content";
      value: Array<
        | { type: "text"; text: string }
        | { type: "image"; source: { type: "url"; url: string } }
      >;
    } {
  const result = output as DesignWorkspaceResult;
  const screenshotUrl = result?.data?.screenshot?.url;
  if (!screenshotUrl) {
    return { type: "json", value: result as unknown as JSONValue };
  }
  return {
    type: "content",
    value: [
      { type: "text", text: JSON.stringify(result) },
      { type: "image", source: { type: "url", url: screenshotUrl } },
    ],
  };
}

async function handleOpen(options: DesignWorkspaceToolOptions): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  const libraries = await getAvailableLibraries();
  const available = libraries.filter((library) => library.available).map((library) => library.package);
  const config = getWorkspaceConfig();
  const history = peekDesignHistory(sessionId);

  recordHistory(sessionId, "open", startedAt, true, {
    metadata: {
      availableLibraries: available,
    },
  });

  return {
    success: true,
    action: "open",
    data: {
      message: "Design workspace opened.",
      availableLibraries: available.length > 0 ? available : undefined,
      config,
      history: history ?? undefined,
    },
  };
}

async function handleInstall(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  const packages = input.packages?.filter((pkg) => typeof pkg === "string" && pkg.trim());
  if (!packages || packages.length === 0) {
    const error = 'Provide a "packages" array with at least one npm package name.';
    recordHistory(sessionId, "install", startedAt, false, { error });
    return {
      success: false,
      action: "install",
      error,
    };
  }

  const installResult = await installSandboxPackages(packages);
  resetAvailableLibrariesCache();
  const libraries = await getAvailableLibraries();
  const available = libraries.filter((library) => library.available).map((library) => library.package);

  if (!installResult.success) {
    const error = installResult.error || "npm install failed.";
    recordHistory(sessionId, "install", startedAt, false, {
      error,
      metadata: { packages: installResult.packageNames },
    });
    return {
      success: false,
      action: "install",
      error,
      data: {
        availableLibraries: available.length > 0 ? available : undefined,
        missingPackages: installResult.packageNames,
        autoRecoveryAttempted: installResult.attempted,
        autoRecoveryResult: "failed",
      },
    };
  }

  recordHistory(sessionId, "install", startedAt, true, {
    metadata: { packages: installResult.packageNames },
  });

  return {
    success: true,
    action: "install",
    data: {
      message: `Successfully installed: ${installResult.packageNames.join(", ")}`,
      availableLibraries: available.length > 0 ? available : undefined,
      autoRecoveryAttempted: installResult.attempted,
      autoRecoveryResult: installResult.attempted ? "success" : "not-needed",
    },
  };
}

async function handleGenerate(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  const { prompt, mode = "tailwind", style = "default", assets: inputAssets } = input;
  if (!prompt?.trim() && !input.code?.trim()) {
    const error = 'Provide either "prompt" (for AI generation) or "code" (for direct rendering).';
    recordHistory(sessionId, "generate", startedAt, false, { error });
    return { success: false, action: "generate", error };
  }

  // W2.3 — validate assetAliases at the tool boundary before doing any work.
  const aliasValidation = validateAssetAliases(input.assetAliases);
  if (!aliasValidation.ok) {
    recordHistory(sessionId, "generate", startedAt, false, { error: aliasValidation.error.message });
    return {
      success: false,
      action: "generate",
      error: aliasValidation.error.message,
      data: { assetAliasError: aliasValidation.error },
    };
  }
  const assetAliases = aliasValidation.aliases;
  const declaredAliases = assetAliases.map((a) => a.alias);

  // W3.3 — validate referenceImageUrl at the tool boundary so a bad URL
  // short-circuits before we spin up the generation pipeline.
  const referenceImageValidation = validateReferenceImageUrl(input.referenceImageUrl);
  if (!referenceImageValidation.ok) {
    recordHistory(sessionId, "generate", startedAt, false, {
      error: referenceImageValidation.error.message,
    });
    return {
      success: false,
      action: "generate",
      error: referenceImageValidation.error.message,
      data: { referenceImageError: referenceImageValidation.error },
    };
  }
  const referenceImageUrl = referenceImageValidation.url;

  // W3.4 — validate renderMany at the tool boundary. Cap + per-cell shape
  // checks happen HERE so an over-cap / malformed-props request never
  // reaches the (expensive) generate pipeline, and the agent gets a
  // structured error envelope on the first round-trip.
  const renderManyValidation = validateRenderMany(input.renderMany);
  if (!renderManyValidation.ok) {
    recordHistory(sessionId, "generate", startedAt, false, {
      error: renderManyValidation.error.message,
    });
    return {
      success: false,
      action: "generate",
      error: renderManyValidation.error.message,
      data: { renderManyError: renderManyValidation.error },
    };
  }
  const renderManyCells = renderManyValidation.cells;

  const assets = inputAssets?.length ? await resolveAssets(inputAssets) : undefined;

  let finalCode = "";
  let generationError: string | undefined;

  if (input.code?.trim()) {
    finalCode = input.code.trim();
  } else {
    const libraries = await getAvailableLibraries();
    const availableLibrariesBlock = getAvailableLibrariesPrompt(libraries);

    for await (const event of generateCard({ prompt: prompt!, mode, style, assets, availableLibrariesBlock })) {
      if (event.type === "complete") {
        finalCode = event.content;
      }
      if (event.type === "error") {
        generationError = event.error.message;
      }
    }
  }

  if (generationError || !finalCode.trim()) {
    const error = generationError ?? "Generation produced empty output. Try a different prompt.";
    recordHistory(sessionId, "generate", startedAt, false, { error });
    return {
      success: false,
      action: "generate",
      error,
    };
  }

  const componentId = generateId();
  const name = input.name?.trim() || (input.code?.trim() ? "Direct Component" : "Generated Component");

  let persisted: DesignGalleryItem;
  try {
    persisted = await persistNewDesign(options, {
      id: componentId,
      name,
      prompt: prompt?.trim() || input.code?.trim() || "",
      code: finalCode,
      mode,
      style,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to persist generated design.";
    recordHistory(sessionId, "generate", startedAt, false, { error: message });
    return {
      success: false,
      action: "generate",
      error: message,
      data: {
        componentId,
        code: finalCode,
        name,
        mode,
        style,
      },
    };
  }

  const previewResult = await compilePreviewForTool(finalCode, persisted.name, "design-workspace-generate", {
    assetAliases,
    // W2.4 — forward the caller's `globalsCssPath` + scope so the compiler
    // can inject the real app's globals.css into the preview <head>. When
    // omitted, the compiler skips the resolution step entirely (no parallel
    // tokens store — the real app's globals.css IS the source of truth).
    globalsCssPath: input.globalsCssPath,
    characterId: options.characterId,
    sessionId,
    // Sprint 4 W4.2 — forward userId + the root component id so the
    // `design:<ref>` resolver is wired with proper scope enforcement AND
    // so a self-import (A importing `design:<A>`) is diagnosed as a
    // cycle immediately on first resolve.
    userId: getPersistedUserId(options),
    designImportChainSeed: [persisted.id],
    // W3.3 — forward the validated reference image URL so the compiler
    // injects the overlay + control-panel markup into the preview body.
    referenceImageUrl,
    // W3.4 — forward the validated renderMany cells. When non-empty the
    // compiler swaps the default `<Component />` entry for a CSS grid.
    renderMany: renderManyCells.length > 0 ? renderManyCells : undefined,
    // Sprint 3 Rev-F1 (Sprint 1 regression fix): forward the effective
    // previewTheme so the preview HTML matches the user's active
    // workspace theme. `input.previewTheme` (LLM) wins over
    // `options.defaultPreviewTheme` (client Zustand fallback); if both
    // are undefined the compiler's own default applies.
    previewTheme: input.previewTheme ?? options.defaultPreviewTheme,
  });
  const libraries = await getAvailableLibraries();
  const availableLibraries = libraries.filter((library) => library.available).map((library) => library.package);
  const baseData: DesignWorkspaceResultData = {
    componentId: persisted.id,
    code: finalCode,
    name: persisted.name,
    prompt: persisted.prompt,
    mode,
    style,
    availableLibraries: availableLibraries.length > 0 ? availableLibraries : undefined,
    updatedAt: persisted.updatedAt,
  };

  if (!previewResult.ok) {
    recordHistory(sessionId, "generate", startedAt, false, {
      componentId: persisted.id,
      error: previewResult.error,
      metadata: {
        missingPackages: previewResult.compileReport.dependencyCheck.missingPackages,
      },
    });
    return buildCompileFailureResult("generate", baseData, previewResult, declaredAliases);
  }

  recordHistory(sessionId, "generate", startedAt, true, {
    componentId: persisted.id,
    metadata: {
      recovered: previewResult.compileReport.recovered,
    },
  });

  const capture = await maybeCaptureScreenshot(options, input, persisted.id);
  const previewMeta = buildPreviewMeta({
    componentId: persisted.id,
    generatedAt: Date.now(),
    previewHtmlLength: previewResult.previewHtml.length,
    capture,
  });

  return {
    success: true,
    action: "generate",
    data: {
      ...baseData,
      ...previewMeta,
      message: `Design "${persisted.name}" generated and saved successfully.`,
      previewHtml: previewResult.previewHtml,
      compileReport: previewResult.compileReport,
      missingPackages: previewResult.compileReport.dependencyCheck.missingPackages,
      autoRecoveryAttempted: Boolean(previewResult.compileReport.autoInstall?.attempted),
      autoRecoveryResult: previewResult.compileReport.autoInstall
        ? previewResult.compileReport.autoInstall.success
          ? "success"
          : "failed"
        : "not-needed",
      // W3.3 — reflect the rendered overlay so the agent knows a
      // reference image was actually injected (cosmetic preview chrome;
      // see `referenceImage` docs on DesignWorkspaceResultData).
      ...(referenceImageUrl
        ? { referenceImage: { url: referenceImageUrl, present: true as const } }
        : {}),
      // W3.4 — confirm the renderMany grid count when active. `cellsEmitted`
      // is the count that actually reached the compiler — identical to
      // `count` on the clean success path.
      ...(renderManyCells.length > 0
        ? {
            renderMany: {
              count: renderManyCells.length,
              cellsEmitted: renderManyCells.length,
            },
          }
        : {}),
    },
  };
}

async function handleEdit(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  const {
    editPrompt,
    style = "default",
    activeComponentCode,
    activeComponentId,
    assets: inputAssets,
  } = input;

  if (!activeComponentId) {
    const error = 'Provide "activeComponentId" to edit a persisted design.';
    recordHistory(sessionId, "edit", startedAt, false, { error });
    return { success: false, action: "edit", error };
  }

  // W2.3 — validate assetAliases at the tool boundary before doing any work.
  const aliasValidation = validateAssetAliases(input.assetAliases);
  if (!aliasValidation.ok) {
    recordHistory(sessionId, "edit", startedAt, false, {
      componentId: activeComponentId,
      error: aliasValidation.error.message,
    });
    return {
      success: false,
      action: "edit",
      error: aliasValidation.error.message,
      data: { componentId: activeComponentId, assetAliasError: aliasValidation.error },
    };
  }
  const assetAliases = aliasValidation.aliases;
  const declaredAliases = assetAliases.map((a) => a.alias);

  // W3.3 — validate referenceImageUrl at the tool boundary.
  const referenceImageValidation = validateReferenceImageUrl(input.referenceImageUrl);
  if (!referenceImageValidation.ok) {
    recordHistory(sessionId, "edit", startedAt, false, {
      componentId: activeComponentId,
      error: referenceImageValidation.error.message,
    });
    return {
      success: false,
      action: "edit",
      error: referenceImageValidation.error.message,
      data: {
        componentId: activeComponentId,
        referenceImageError: referenceImageValidation.error,
      },
    };
  }
  const referenceImageUrl = referenceImageValidation.url;

  // W3.4 — validate renderMany at the tool boundary before touching the
  // edit pipeline. See handleGenerate for the rationale.
  const renderManyValidation = validateRenderMany(input.renderMany);
  if (!renderManyValidation.ok) {
    recordHistory(sessionId, "edit", startedAt, false, {
      componentId: activeComponentId,
      error: renderManyValidation.error.message,
    });
    return {
      success: false,
      action: "edit",
      error: renderManyValidation.error.message,
      data: {
        componentId: activeComponentId,
        renderManyError: renderManyValidation.error,
      },
    };
  }
  const renderManyCells = renderManyValidation.cells;

  const resolved = await resolveDesignSource(options, { activeComponentId, activeComponentCode });
  if (!resolved.code || !resolved.component) {
    const error = buildMissingComponentError(activeComponentId, "edit");
    recordHistory(sessionId, "edit", startedAt, false, { componentId: activeComponentId, error });
    return {
      success: false,
      action: "edit",
      error,
      data: {
        componentId: activeComponentId,
        status: "missing",
        recoveryHint: 'Run action "list" to inspect persisted designs, or pass explicit source with "activeComponentCode".',
      },
    };
  }

  if (!editPrompt?.trim() && !activeComponentCode?.trim()) {
    const error = 'Provide "editPrompt" for AI-driven editing, or provide "activeComponentCode" to directly replace the design source.';
    recordHistory(sessionId, "edit", startedAt, false, { componentId: activeComponentId, error });
    return { success: false, action: "edit", error };
  }

  let finalCode = activeComponentCode?.trim() || "";
  if (!finalCode) {
    const assets = inputAssets?.length ? await resolveAssets(inputAssets) : undefined;
    let editError: string | undefined;

    // Enrich edit prompt with inspect context when the user selected elements.
    // The AI model already sees [Inspect Focus] in the user message via content-extractor,
    // but we also inject it here so the edit pipeline sees element selectors directly.
    let enrichedEditPrompt = editPrompt!;
    if (options.inspectContext) {
      const inspectPromptText = buildInspectPromptText(options.inspectContext);
      if (inspectPromptText) {
        enrichedEditPrompt = `${inspectPromptText}\n\n${enrichedEditPrompt}`;
      }
    }

    for await (const event of editCard({ code: resolved.code, editPrompt: enrichedEditPrompt, style, assets })) {
      if (event.type === "complete") {
        finalCode = event.content;
      }
      if (event.type === "error") {
        editError = event.error.message;
      }
    }

    if (editError || !finalCode.trim()) {
      const error = editError ?? "Edit produced empty output. Try rephrasing the instruction.";
      recordHistory(sessionId, "edit", startedAt, false, {
        componentId: activeComponentId,
        error,
      });
      return {
        success: false,
        action: "edit",
        error,
      };
    }
  }

  let persisted: DesignGalleryItem;
  try {
    persisted = await persistExistingDesign(resolved.component, {
      code: finalCode.trim(),
      prompt: editPrompt?.trim() || resolved.component.prompt,
      style,
      sessionId,
      characterId: options.characterId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to persist edited design.";
    recordHistory(sessionId, "edit", startedAt, false, {
      componentId: activeComponentId,
      error: message,
    });
    return {
      success: false,
      action: "edit",
      error: message,
      data: {
        componentId: activeComponentId,
        code: finalCode.trim(),
      },
    };
  }

  const previewResult = await compilePreviewForTool(finalCode.trim(), persisted.name, "design-workspace-edit", {
    assetAliases,
    // W2.4 — see generate handler for rationale.
    globalsCssPath: input.globalsCssPath,
    characterId: options.characterId,
    sessionId,
    // Sprint 4 W4.2 — see generate handler for rationale.
    userId: getPersistedUserId(options),
    designImportChainSeed: [persisted.id],
    // W3.3 — forward the validated reference image URL.
    referenceImageUrl,
    // W3.4 — forward the validated renderMany cells (see generate handler).
    renderMany: renderManyCells.length > 0 ? renderManyCells : undefined,
    // Sprint 3 Rev-F1 (Sprint 1 regression fix): forward the effective
    // previewTheme (see generate handler for merge rationale).
    previewTheme: input.previewTheme ?? options.defaultPreviewTheme,
  });
  const config = getWorkspaceConfig();
  const validation = await runPostEditValidation(finalCode.trim(), config, { previewBuildPassed: previewResult.ok });
  const baseData: DesignWorkspaceResultData = {
    componentId: persisted.id,
    code: finalCode.trim(),
    name: persisted.name,
    prompt: persisted.prompt,
    style: persisted.style as "apple-glass" | "default",
    config,
    updatedAt: persisted.updatedAt,
  };

  if (!previewResult.ok) {
    recordHistory(sessionId, "edit", startedAt, false, {
      componentId: persisted.id,
      validation,
      error: previewResult.error,
      metadata: {
        missingPackages: previewResult.compileReport.dependencyCheck.missingPackages,
      },
    });
    return buildCompileFailureResult("edit", {
      ...baseData,
      postEditValidation: validation,
    }, previewResult, declaredAliases);
  }

  const validationMessage = buildValidationMessage(validation);
  recordHistory(sessionId, "edit", startedAt, true, {
    componentId: persisted.id,
    validation,
  });

  const capture = await maybeCaptureScreenshot(options, input, persisted.id);
  const previewMeta = buildPreviewMeta({
    componentId: persisted.id,
    generatedAt: Date.now(),
    previewHtmlLength: previewResult.previewHtml.length,
    capture,
  });

  return {
    success: true,
    action: "edit",
    data: {
      ...baseData,
      ...previewMeta,
      message: validationMessage || "Design edited successfully.",
      previewHtml: previewResult.previewHtml,
      compileReport: previewResult.compileReport,
      postEditValidation: validation,
      missingPackages: previewResult.compileReport.dependencyCheck.missingPackages,
      autoRecoveryAttempted: Boolean(previewResult.compileReport.autoInstall?.attempted),
      autoRecoveryResult: previewResult.compileReport.autoInstall
        ? previewResult.compileReport.autoInstall.success
          ? "success"
          : "failed"
        : "not-needed",
      // W3.3 — see generate handler.
      ...(referenceImageUrl
        ? { referenceImage: { url: referenceImageUrl, present: true as const } }
        : {}),
      // W3.4 — see generate handler.
      ...(renderManyCells.length > 0
        ? {
            renderMany: {
              count: renderManyCells.length,
              cellsEmitted: renderManyCells.length,
            },
          }
        : {}),
    },
  };
}

// BA-3: no barrel re-export. `findUnclosedJsxTag` is consumed only via
// its canonical source path (lib/design/workspace/patch-logic). The old
// `export { findUnclosedJsxTag } from "..."` line was a pass-through
// that hid the dependency edge; removed per Sprint 2 Rev-B hard
// constraint. If a future consumer needs the symbol, import it directly
// from `lib/design/workspace/patch-logic`.

async function handlePatch(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  const { oldString, newString, replaceAll: replaceAllOccurrences, activeComponentId, activeComponentCode, patches } = input;

  if (!activeComponentId) {
    const error = 'Provide "activeComponentId" to patch a persisted design.';
    recordHistory(sessionId, "patch", startedAt, false, { error });
    return { success: false, action: "patch", error };
  }

  // W2.3 — validate assetAliases at the tool boundary before doing any work.
  const aliasValidation = validateAssetAliases(input.assetAliases);
  if (!aliasValidation.ok) {
    recordHistory(sessionId, "patch", startedAt, false, {
      componentId: activeComponentId,
      error: aliasValidation.error.message,
    });
    return {
      success: false,
      action: "patch",
      error: aliasValidation.error.message,
      data: { componentId: activeComponentId, assetAliasError: aliasValidation.error },
    };
  }
  const assetAliases = aliasValidation.aliases;
  const declaredAliases = assetAliases.map((a) => a.alias);

  // W3.3 — validate referenceImageUrl at the tool boundary.
  const referenceImageValidation = validateReferenceImageUrl(input.referenceImageUrl);
  if (!referenceImageValidation.ok) {
    recordHistory(sessionId, "patch", startedAt, false, {
      componentId: activeComponentId,
      error: referenceImageValidation.error.message,
    });
    return {
      success: false,
      action: "patch",
      error: referenceImageValidation.error.message,
      data: {
        componentId: activeComponentId,
        referenceImageError: referenceImageValidation.error,
      },
    };
  }
  const referenceImageUrl = referenceImageValidation.url;

  // W3.4 — validate renderMany at the tool boundary. See handleGenerate.
  const renderManyValidation = validateRenderMany(input.renderMany);
  if (!renderManyValidation.ok) {
    recordHistory(sessionId, "patch", startedAt, false, {
      componentId: activeComponentId,
      error: renderManyValidation.error.message,
    });
    return {
      success: false,
      action: "patch",
      error: renderManyValidation.error.message,
      data: {
        componentId: activeComponentId,
        renderManyError: renderManyValidation.error,
      },
    };
  }
  const renderManyCells = renderManyValidation.cells;

  // Build the list of patch operations — either from `patches` array or single oldString/newString
  let patchOps: PatchOp[];

  if (patches && Array.isArray(patches) && patches.length > 0) {
    // Multi-patch mode
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i];
      if (!p.oldString && p.oldString !== "") {
        return { success: false, action: "patch", error: `patches[${i}]: "oldString" is required.` };
      }
      if (p.newString === undefined || p.newString === null) {
        return { success: false, action: "patch", error: `patches[${i}]: "newString" is required.` };
      }
      if (p.oldString === p.newString) {
        return { success: false, action: "patch", error: `patches[${i}]: "oldString" and "newString" are identical.` };
      }
    }
    patchOps = patches;
  } else {
    // Single-patch mode (backwards compatible)
    if (oldString === undefined || oldString === null) {
      return { success: false, action: "patch", error: '"oldString" is required for patch action (or provide "patches" array for multi-location edits).' };
    }
    if (newString === undefined || newString === null) {
      return { success: false, action: "patch", error: '"newString" is required for patch action.' };
    }
    if (oldString === newString) {
      return { success: false, action: "patch", error: '"oldString" and "newString" are identical — nothing to patch.' };
    }
    patchOps = [{ oldString, newString, replaceAll: replaceAllOccurrences }];
  }

  const resolved = await resolveDesignSource(options, { activeComponentId, activeComponentCode });
  if (!resolved.code || !resolved.component) {
    const error = buildMissingComponentError(activeComponentId, "patch");
    recordHistory(sessionId, "patch", startedAt, false, { componentId: activeComponentId, error });
    return {
      success: false,
      action: "patch",
      error,
      data: {
        componentId: activeComponentId,
        status: "missing",
        recoveryHint: 'Run action "readSource" before patching if you need the latest persisted source.',
      },
    };
  }

  // Apply patches using fuzzy match & patch algorithm
  const patchResult = applyDesignPatches(resolved.code, patchOps);

  if (!patchResult.success) {
    const errorParts = [patchResult.error || "Patch failed."];
    if (patchResult.hint) {
      errorParts.push(patchResult.hint);
    }
    recordHistory(sessionId, "patch", startedAt, false, {
      componentId: activeComponentId,
      error: errorParts[0],
    });
    return {
      success: false,
      action: "patch",
      error: errorParts.join("\n"),
    };
  }

  const patchedCode = patchResult.code;

  // JSX balance check — heuristic warning for potential wrapping mistakes.
  // Downgraded from a blocking error: the regex-based parser can false-positive
  // on complex nested JSX and conditional rendering patterns. The warning is
  // included in the result message so the AI can self-correct if needed.
  const unclosedTag = findUnclosedJsxTag(patchedCode);
  const jsxWarning = unclosedTag
    ? `Warning: <${unclosedTag}> may be unclosed (heuristic check — may be a false positive). For wrapping operations, include the full block being wrapped in "oldString" and the complete wrapped version in "newString". Verify the output visually.`
    : null;

  let persisted: DesignGalleryItem;
  try {
    persisted = await persistExistingDesign(resolved.component, {
      code: patchedCode,
      sessionId,
      characterId: options.characterId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to persist patched design.";
    recordHistory(sessionId, "patch", startedAt, false, {
      componentId: activeComponentId,
      error: message,
    });
    return {
      success: false,
      action: "patch",
      error: message,
      data: {
        componentId: activeComponentId,
        code: patchedCode,
      },
    };
  }

  const previewResult = await compilePreviewForTool(patchedCode, persisted.name, "design-workspace-patch", {
    assetAliases,
    // W2.4 — see generate handler for rationale.
    globalsCssPath: input.globalsCssPath,
    characterId: options.characterId,
    sessionId,
    // Sprint 4 W4.2 — see generate handler for rationale.
    userId: getPersistedUserId(options),
    designImportChainSeed: [persisted.id],
    // W3.3 — forward the validated reference image URL.
    referenceImageUrl,
    // W3.4 — forward the validated renderMany cells (see generate handler).
    renderMany: renderManyCells.length > 0 ? renderManyCells : undefined,
    // Sprint 3 Rev-F1 (Sprint 1 regression fix): forward the effective
    // previewTheme (see generate handler for merge rationale).
    previewTheme: input.previewTheme ?? options.defaultPreviewTheme,
  });
  const config = getWorkspaceConfig();
  const validation = await runPostEditValidation(patchedCode, config, { previewBuildPassed: previewResult.ok });
  const baseData: DesignWorkspaceResultData = {
    componentId: persisted.id,
    code: patchedCode,
    name: persisted.name,
    prompt: persisted.prompt,
    config,
    updatedAt: persisted.updatedAt,
  };

  if (!previewResult.ok) {
    recordHistory(sessionId, "patch", startedAt, false, {
      componentId: persisted.id,
      validation,
      error: previewResult.error,
      metadata: {
        missingPackages: previewResult.compileReport.dependencyCheck.missingPackages,
      },
    });
    return buildCompileFailureResult("patch", {
      ...baseData,
      postEditValidation: validation,
    }, previewResult, declaredAliases);
  }

  const linesChanged = countChangedLines(resolved.code, patchedCode);
  const validationMessage = buildValidationMessage(validation);
  const fuzzyNote = patchResult.fuzzyMatched?.length
    ? ` (fuzzy-matched ${patchResult.fuzzyMatched.length > 1 ? `patches ${patchResult.fuzzyMatched.join(", ")}` : `patch ${patchResult.fuzzyMatched[0]}`})`
    : "";
  recordHistory(sessionId, "patch", startedAt, true, {
    componentId: persisted.id,
    validation,
    metadata: {
      fuzzyMatched: patchResult.fuzzyMatched,
    },
  });

  const capture = await maybeCaptureScreenshot(options, input, persisted.id);
  const previewMeta = buildPreviewMeta({
    componentId: persisted.id,
    generatedAt: Date.now(),
    previewHtmlLength: previewResult.previewHtml.length,
    capture,
  });

  return {
    success: true,
    action: "patch",
    data: {
      ...baseData,
      ...previewMeta,
      message: [
        validationMessage || `Patch applied: ${patchResult.totalReplacements} replacement${patchResult.totalReplacements > 1 ? "s" : ""}${patchOps.length > 1 ? ` across ${patchOps.length} patches` : ""}${fuzzyNote}, ~${linesChanged} line${linesChanged !== 1 ? "s" : ""} changed.`,
        jsxWarning,
      ].filter(Boolean).join(" "),
      previewHtml: previewResult.previewHtml,
      compileReport: previewResult.compileReport,
      postEditValidation: validation,
      missingPackages: previewResult.compileReport.dependencyCheck.missingPackages,
      autoRecoveryAttempted: Boolean(previewResult.compileReport.autoInstall?.attempted),
      autoRecoveryResult: previewResult.compileReport.autoInstall
        ? previewResult.compileReport.autoInstall.success
          ? "success"
          : "failed"
        : "not-needed",
      // W3.3 — see generate handler.
      ...(referenceImageUrl
        ? { referenceImage: { url: referenceImageUrl, present: true as const } }
        : {}),
      // W3.4 — see generate handler.
      ...(renderManyCells.length > 0
        ? {
            renderMany: {
              count: renderManyCells.length,
              cellsEmitted: renderManyCells.length,
            },
          }
        : {}),
    },
  };
}

function countChangedLines(before: string, after: string): number {
  const a = before.split("\n");
  const b = after.split("\n");
  let changed = 0;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    if (a[i] !== b[i]) changed++;
  }
  return changed;
}

async function handleReadSource(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  const sessionId = getSessionId(options);
  const { activeComponentId, activeComponentCode } = input;

  if (activeComponentCode?.trim()) {
    return {
      success: true,
      action: "readSource",
      data: {
        componentId: activeComponentId,
        code: activeComponentCode.trim(),
        status: "inline",
        storage: {
          database: false,
          userScoped: Boolean(getPersistedUserId(options)),
          sessionScoped: sessionId !== "UNSCOPED",
        },
        message: "Inline design source retrieved.",
      },
    };
  }

  if (!activeComponentId) {
    return {
      success: false,
      action: "readSource",
      error: 'Provide "activeComponentId" to read back persisted design source.',
    };
  }

  const component = await findWorkspaceDesign({
    id: activeComponentId,
    userId: getPersistedUserId(options),
    sessionId,
  });

  if (!component) {
    return {
      success: false,
      action: "readSource",
      error: buildMissingComponentError(activeComponentId, "readSource"),
      data: {
        componentId: activeComponentId,
        status: "missing",
        recoveryHint: 'Run action "list" to inspect persisted designs for this session.',
      },
    };
  }

  return {
    success: true,
    action: "readSource",
    data: {
      componentId: component.id,
      code: component.code,
      name: component.name,
      status: "available",
      storage: {
        database: true,
        userScoped: Boolean(getPersistedUserId(options) || component.userId),
        sessionScoped: component.sessionId === sessionId,
      },
      updatedAt: component.updatedAt,
      message: `Design source retrieved (${component.code.length} chars, ~${Math.ceil(component.code.split("\n").length)} lines).`,
    },
  };
}

async function handleList(options: DesignWorkspaceToolOptions): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  try {
    const components = await listWorkspaceDesigns({
      userId: getPersistedUserId(options),
      sessionId,
      limit: 100,
    });

    recordHistory(sessionId, "list", startedAt, true, {
      metadata: { count: components.length },
    });

    return {
      success: true,
      action: "list",
      data: {
        components: components.map((component) => ({
          id: component.id,
          name: component.name,
          source: component.sessionId === sessionId ? "session" : "saved",
          updatedAt: component.updatedAt,
          isFavorite: component.isFavorite,
        })),
        message: components.length > 0
          ? `Found ${components.length} persisted design${components.length === 1 ? "" : "s"} for this workspace.`
          : "No persisted designs found for this workspace.",
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list persisted designs.";
    recordHistory(sessionId, "list", startedAt, false, { error: message });
    return {
      success: false,
      action: "list",
      error: message,
    };
  }
}

async function handleStatus(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  if (input.activeComponentCode?.trim()) {
    recordHistory(sessionId, "status", startedAt, true);
    return {
      success: true,
      action: "status",
      data: {
        componentId: input.activeComponentId,
        status: "inline",
        storage: {
          database: false,
          userScoped: Boolean(getPersistedUserId(options)),
          sessionScoped: sessionId !== "UNSCOPED",
        },
        message: "Inline design source provided; no persisted lookup was required.",
      },
    };
  }

  if (!input.activeComponentId) {
    const error = 'Provide "activeComponentId" to inspect design status.';
    recordHistory(sessionId, "status", startedAt, false, { error });
    return {
      success: false,
      action: "status",
      error,
    };
  }

  const component = await findWorkspaceDesign({
    id: input.activeComponentId,
    userId: getPersistedUserId(options),
    sessionId,
  });

  if (!component) {
    const error = buildMissingComponentError(input.activeComponentId, "status");
    recordHistory(sessionId, "status", startedAt, false, {
      componentId: input.activeComponentId,
      error,
    });
    return {
      success: false,
      action: "status",
      error,
      data: {
        componentId: input.activeComponentId,
        status: "missing",
        storage: {
          database: false,
          userScoped: Boolean(getPersistedUserId(options)),
          sessionScoped: sessionId !== "UNSCOPED",
        },
        recoveryHint: 'Run action "list" to inspect available persisted designs.',
      },
    };
  }

  recordHistory(sessionId, "status", startedAt, true, {
    componentId: component.id,
  });

  return {
    success: true,
    action: "status",
    data: {
      componentId: component.id,
      name: component.name,
      status: "available",
      storage: {
        database: true,
        userScoped: Boolean(getPersistedUserId(options) || component.userId),
        sessionScoped: component.sessionId === sessionId,
      },
      updatedAt: component.updatedAt,
      message: `Design "${component.name}" is persisted and ready for iteration.`,
    },
  };
}

function handleClose(options: DesignWorkspaceToolOptions): DesignWorkspaceResult {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  recordHistory(sessionId, "close", startedAt, true);
  const history = finalizeDesignHistory(sessionId);

  return {
    success: true,
    action: "close",
    data: {
      message: "Design workspace closed.",
      history: history ?? undefined,
    },
  };
}

/**
 * "port" action — write a workspace component back to a synced-folder path.
 *
 * BA-warn-5 / Sprint 2 Rev-C2 contract (port freshness guard — now a HARD
 * concurrency guarantee, not best-effort):
 *
 *   1. A `dryRun: true` call always returns `data.preflight = { contentSha256,
 *      mtimeMs }` for the target file's current on-disk content (or the empty
 *      string when the target does not yet exist).
 *   2. On `dryRun: false` apply calls, `expectedContentSha256` is REQUIRED
 *      UNLESS `allowStaleWrite: true` is explicitly set. If neither is
 *      provided the tool rejects with `INVALID_INPUT` at the handler-level
 *      pre-filesystem validation step — the check runs at the top of
 *      `handlePort`, BEFORE any path resolution or filesystem read, so the
 *      apply cannot silently race. (Note: this validation is NOT pushed
 *      into the tool's jsonSchema input schema because the AI-SDK
 *      `jsonSchema<T>()` helper does not expose a Zod-style `.refine()`
 *      for branch-conditional constraints; enforcing it in the handler
 *      gives us a clean, typed envelope and keeps the schema declarative.)
 *      Rationale: the Rev-B default made the guard opt-in, which means a
 *      caller who simply forgot the field would bypass it. Making the
 *      opt-out explicit (`allowStaleWrite: true`) is auditable and
 *      stateless — no session-history lookup required.
 *   3. When `expectedContentSha256` is supplied, `handlePort` performs a
 *      FINAL compare-and-swap-style revalidation immediately before
 *      `atomicWriteFile` (no awaits between the re-read and the write
 *      other than the unavoidable fs handles). A mismatch produces a
 *      `PORT_STALE_DIFF` envelope with `stalePortInfo` so the caller can
 *      re-run the dry-run and re-approve.
 *   4. RESIDUAL RISK (POSIX): even with the final re-read immediately
 *      before `atomicWriteFile`, there is a microsecond-level window
 *      between the re-read's returned content buffer and the eventual
 *      `rename()` inside `atomicWriteFile`. POSIX does not expose true
 *      compare-and-swap on regular files. This is a significant
 *      tightening, NOT a true CAS — see the comment beside the final
 *      revalidation block below.
 */
async function handlePort(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  const componentId = input.componentId?.trim();
  const targetPath = input.targetPath?.trim();
  const dryRun = input.dryRun ?? true;
  const overwrite = input.overwrite ?? false;
  const expectedContentSha256 = input.expectedContentSha256?.trim() || undefined;
  const allowStaleWrite = input.allowStaleWrite === true;

  if (!componentId) {
    const error = 'Provide "componentId" to port a workspace component.';
    recordHistory(sessionId, "port", startedAt, false, { error });
    return {
      success: false,
      action: "port",
      error,
      data: { errorCode: "INVALID_INPUT" },
    };
  }

  if (!targetPath) {
    const error = 'Provide "targetPath" (synced-folder-relative) to port a component.';
    recordHistory(sessionId, "port", startedAt, false, { componentId, error });
    return {
      success: false,
      action: "port",
      error,
      data: { componentId, errorCode: "INVALID_INPUT" },
    };
  }

  if (!options.characterId) {
    const error =
      'No agent context. The "port" action requires an agent with synced folders.';
    recordHistory(sessionId, "port", startedAt, false, { componentId, error });
    return {
      success: false,
      action: "port",
      error,
      data: { componentId, errorCode: "INVALID_INPUT" },
    };
  }

  // --- Rev-C2 handler-level pre-filesystem freshness-guard enforcement -----
  // Apply calls (`dryRun: false`) must carry EITHER:
  //   - `expectedContentSha256` (the preflight hash from a prior dry-run), OR
  //   - `allowStaleWrite: true` (explicit opt-out for the fresh-write case)
  //
  // This is a HANDLER-LEVEL check (not a jsonSchema refinement — the
  // AI-SDK `jsonSchema<T>()` helper has no Zod-style `.refine()` hook for
  // branch-conditional constraints). It runs at the TOP of `handlePort`,
  // BEFORE any path resolution or filesystem read, so the race window is
  // zero for this class of error: if the caller forgot the hash, they
  // can't even accidentally observe the on-disk content, let alone
  // overwrite it.
  //
  // This is the stateless approach — we don't inspect session history
  // for a prior dry-run, we just require the caller to commit to one of
  // the two branches on every apply call.
  if (!dryRun && !expectedContentSha256 && !allowStaleWrite) {
    const error =
      '"port" apply (dryRun:false) requires either `expectedContentSha256` ' +
      "(the preflight hash from a prior dry-run) or `allowStaleWrite: true` " +
      "(explicit opt-out). Run dryRun:true first, echo back " +
      "`data.preflight.contentSha256`, or pass `allowStaleWrite: true` if you " +
      "accept the race risk.";
    recordHistory(sessionId, "port", startedAt, false, {
      componentId,
      error,
      metadata: { errorCode: "INVALID_INPUT", dryRun: false },
    });
    return {
      success: false,
      action: "port",
      error,
      data: {
        componentId,
        targetRelativePath: targetPath,
        errorCode: "INVALID_INPUT",
        recoveryHint:
          "Re-run with action:\"port\", dryRun:true to get `data.preflight.contentSha256`, " +
          "then resend this call with `expectedContentSha256` set to that hash. " +
          "Or pass `allowStaleWrite:true` to write without a freshness check.",
      },
    };
  }

  const resolved = await resolveSyncedPath(targetPath, options.characterId, sessionId);
  if (!resolved.ok) {
    recordHistory(sessionId, "port", startedAt, false, {
      componentId,
      error: resolved.error,
    });
    return {
      success: false,
      action: "port",
      error: resolved.error,
      data: { componentId, targetRelativePath: targetPath, errorCode: "INVALID_INPUT" },
    };
  }
  const { validPath } = resolved;

  const component = await findWorkspaceDesign({
    id: componentId,
    userId: getPersistedUserId(options),
    sessionId,
  });
  if (!component) {
    const error = buildMissingComponentError(componentId, "status");
    recordHistory(sessionId, "port", startedAt, false, { componentId, error });
    return {
      success: false,
      action: "port",
      error,
      data: {
        componentId,
        targetPath: validPath,
        targetRelativePath: targetPath,
        errorCode: "COMPONENT_NOT_FOUND",
        status: "missing",
        recoveryHint: 'Run action "list" to inspect persisted designs.',
      },
    };
  }

  const sourceCode = component.code ?? "";

  // Read the target via the synced-folder helper (BA-4). `validPath` has
  // already passed containment via `resolveSyncedPath` above, so
  // `readSyncedFile` re-runs the same check and only fails for FILE_NOT_FOUND
  // / READ_FAILED / FILE_TOO_LARGE paths. We treat FILE_NOT_FOUND as a
  // not-yet-existing target (creation mode) and re-throw everything else.
  let targetExistedBefore = false;
  let targetContent = "";
  let targetSize = 0;
  let targetMtimeMs: number | null = null;
  try {
    const readResult = await readSyncedFile({
      characterId: options.characterId,
      sessionId,
      sourcePath: targetPath,
    });
    targetContent = readResult.content;
    targetExistedBefore = true;
    targetSize = readResult.bytes;
    // `readSyncedFile` captures `mtimeMs` from the same pre-read `stat()`
    // that gates the size check — no second fs round-trip here.
    targetMtimeMs = readResult.mtimeMs;
  } catch (error: unknown) {
    if (isReadSyncedFileError(error)) {
      const code: ReadSyncedFileErrorCode = error.code;
      if (code !== "FILE_NOT_FOUND") {
        recordHistory(sessionId, "port", startedAt, false, {
          componentId,
          error: error.message,
        });
        return {
          success: false,
          action: "port",
          error: `Failed to read target "${targetPath}": ${error.message}`,
          data: {
            componentId,
            targetPath: validPath,
            targetRelativePath: targetPath,
            errorCode: "PORT_READ_FAILED",
          },
        };
      }
      // FILE_NOT_FOUND — creation mode; leave the defaults.
    } else {
      const message = error instanceof Error ? error.message : "Failed to read target file.";
      recordHistory(sessionId, "port", startedAt, false, {
        componentId,
        error: message,
      });
      return {
        success: false,
        action: "port",
        error: `Failed to read target "${targetPath}": ${message}`,
        data: {
          componentId,
          targetPath: validPath,
          targetRelativePath: targetPath,
          errorCode: "PORT_READ_FAILED",
        },
      };
    }
  }

  const preflightContentSha256 = createHash("sha256").update(targetContent).digest("hex");

  const diffResult = createPortDiff(targetPath, targetContent, sourceCode);
  const contentMatches = diffResult.identical;

  if (dryRun) {
    recordHistory(sessionId, "port", startedAt, true, {
      componentId,
      metadata: {
        dryRun: true,
        targetExistedBefore,
        targetSize,
        identical: contentMatches,
      },
    });
    const writtenBytes = Buffer.byteLength(sourceCode, "utf-8");
    const dryRunMessage = contentMatches
      ? `Target "${targetPath}" already matches component source — no changes.`
      : targetExistedBefore
        ? `[Dry Run] Would overwrite "${targetPath}" (${targetSize} -> ${writtenBytes} bytes). Pass dryRun:false AND overwrite:true to apply.`
        : `[Dry Run] Would create "${targetPath}" (${writtenBytes} bytes). Pass dryRun:false to apply.`;
    return {
      success: true,
      action: "port",
      data: {
        componentId,
        applied: false,
        targetPath: validPath,
        targetRelativePath: targetPath,
        targetExistedBefore,
        targetSize,
        diff: diffResult.diff,
        diffTruncated: diffResult.truncated,
        preflight: {
          contentSha256: preflightContentSha256,
          mtimeMs: targetMtimeMs,
        },
        message: dryRunMessage,
      },
    };
  }

  if (contentMatches) {
    recordHistory(sessionId, "port", startedAt, true, {
      componentId,
      metadata: { dryRun: false, identical: true },
    });
    return {
      success: true,
      action: "port",
      data: {
        componentId,
        applied: false,
        targetPath: validPath,
        targetRelativePath: targetPath,
        targetExistedBefore,
        targetSize,
        bytesWritten: 0,
        diff: "",
        preflight: {
          contentSha256: preflightContentSha256,
          mtimeMs: targetMtimeMs,
        },
        message: `No changes — target "${targetPath}" already matches component source.`,
      },
    };
  }

  if (targetExistedBefore && !overwrite) {
    const error = `Target "${targetPath}" exists and differs. Pass overwrite:true to replace it.`;
    recordHistory(sessionId, "port", startedAt, false, {
      componentId,
      error,
      metadata: { errorCode: "TARGET_EXISTS_MUST_OVERWRITE" },
    });
    return {
      success: false,
      action: "port",
      error,
      data: {
        componentId,
        applied: false,
        targetPath: validPath,
        targetRelativePath: targetPath,
        targetExistedBefore,
        targetSize,
        diff: diffResult.diff,
        diffTruncated: diffResult.truncated,
        preflight: {
          contentSha256: preflightContentSha256,
          mtimeMs: targetMtimeMs,
        },
        errorCode: "TARGET_EXISTS_MUST_OVERWRITE",
      },
    };
  }

  // --- BA-warn-5 / Rev-C2 port freshness guard (FINAL CAS revalidation) ---
  // This is the LAST async step before `atomicWriteFile` is invoked below.
  // Ordering contract (do NOT insert awaits between this block's re-read
  // and the atomicWriteFile call):
  //
  //   resolve path → initial read (for diff) → diff compute →
  //   ==> FINAL re-read + sha compare (this block) <==
  //   → atomicWriteFile (next statement)
  //
  // When the caller echoed back the dry-run's `preflight.contentSha256` via
  // `expectedContentSha256`, we re-read the target RIGHT NOW and compare
  // the fresh hash. A mismatch means another writer (editor, another AI
  // turn, a git checkout, etc.) raced between the dry-run and this apply;
  // we reject with PORT_STALE_DIFF so the caller can re-run the dry-run
  // and re-approve the now-different diff.
  //
  // RESIDUAL RISK — this is NOT a true compare-and-swap. POSIX does not
  // expose CAS on regular files; between the `readFile` completing here
  // and the `rename()` inside `atomicWriteFile` there is still a
  // microsecond-level window where another writer could mutate the
  // target. We cannot close that window without either (a) holding an
  // exclusive advisory lock via `flock`/`fcntl` (which `atomicWriteFile`
  // would also need to honor, plus it's not portable to Windows) or
  // (b) re-reading inside the rename syscall itself (impossible via the
  // Node fs API). For the design-workspace port use case — a human-in-
  // the-loop approval flow where concurrent writers are rare and the
  // consequences of a missed race are "user's edits get overwritten and
  // are still recoverable via git / the undo history" — this
  // tightening is sufficient. Callers that need stricter semantics must
  // pipe writes through their own lockfile.
  if (expectedContentSha256) {
    let freshContent = "";
    let freshMtimeMs: number | null = null;
    try {
      const fresh = await readSyncedFile({
        characterId: options.characterId,
        sessionId,
        sourcePath: targetPath,
      });
      freshContent = fresh.content;
      // `readSyncedFile` returns `mtimeMs` from the SAME pre-read `stat()`
      // that gates its size check. Pulling it off the result instead of
      // issuing a separate `fs.stat(fresh.resolvedPath)` is CRITICAL for
      // the CAS ordering contract below: any await between the content
      // hash comparison and `atomicWriteFile` reopens the TOCTOU window
      // the hash was meant to close.
      freshMtimeMs = fresh.mtimeMs;
    } catch (error: unknown) {
      if (isReadSyncedFileError(error) && error.code === "FILE_NOT_FOUND") {
        // File vanished between dry-run and apply — that's a staleness
        // signal too (empty-string hash doesn't equal the dry-run hash
        // unless the dry-run already saw a missing file).
        freshContent = "";
      } else {
        const message = error instanceof Error ? error.message : "Failed to re-read target file.";
        recordHistory(sessionId, "port", startedAt, false, {
          componentId,
          error: message,
          metadata: { errorCode: "PORT_READ_FAILED" },
        });
        return {
          success: false,
          action: "port",
          error: `Failed to re-read target "${targetPath}" for freshness check: ${message}`,
          data: {
            componentId,
            applied: false,
            targetPath: validPath,
            targetRelativePath: targetPath,
            targetExistedBefore,
            targetSize,
            diff: diffResult.diff,
            diffTruncated: diffResult.truncated,
            errorCode: "PORT_READ_FAILED",
          },
        };
      }
    }
    const freshContentSha256 = createHash("sha256").update(freshContent).digest("hex");
    if (freshContentSha256 !== expectedContentSha256) {
      const error = `Target "${targetPath}" changed on disk between dry-run and apply. Re-run the dry-run to see the new diff.`;
      recordHistory(sessionId, "port", startedAt, false, {
        componentId,
        error,
        metadata: { errorCode: "PORT_STALE_DIFF" },
      });
      return {
        success: false,
        action: "port",
        error,
        data: {
          componentId,
          applied: false,
          targetPath: validPath,
          targetRelativePath: targetPath,
          targetExistedBefore,
          targetSize,
          diff: diffResult.diff,
          diffTruncated: diffResult.truncated,
          errorCode: "PORT_STALE_DIFF",
          stalePortInfo: {
            currentSha256: freshContentSha256,
            expectedSha256: expectedContentSha256,
            mtimeMs: freshMtimeMs,
          },
        },
      };
    }
  }

  try {
    await atomicWriteFile(validPath, sourceCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to write target file.";
    recordHistory(sessionId, "port", startedAt, false, {
      componentId,
      error: message,
      metadata: { errorCode: "PORT_WRITE_FAILED" },
    });
    return {
      success: false,
      action: "port",
      error: `Failed to write "${targetPath}": ${message}`,
      data: {
        componentId,
        applied: false,
        targetPath: validPath,
        targetRelativePath: targetPath,
        targetExistedBefore,
        targetSize,
        diff: diffResult.diff,
        diffTruncated: diffResult.truncated,
        errorCode: "PORT_WRITE_FAILED",
      },
    };
  }

  const bytesWritten = Buffer.byteLength(sourceCode, "utf-8");
  recordHistory(sessionId, "port", startedAt, true, {
    componentId,
    metadata: { dryRun: false, targetExistedBefore, bytesWritten },
  });

  return {
    success: true,
    action: "port",
    data: {
      componentId,
      applied: true,
      targetPath: validPath,
      targetRelativePath: targetPath,
      targetExistedBefore,
      targetSize,
      bytesWritten,
      diff: diffResult.diff,
      diffTruncated: diffResult.truncated,
      message: targetExistedBefore
        ? `Overwrote "${targetPath}" (${bytesWritten} bytes).`
        : `Wrote "${targetPath}" (${bytesWritten} bytes).`,
    },
  };
}

// ---------------------------------------------------------------------------
// Sprint 2 W2.1 — "import" action.
// ---------------------------------------------------------------------------

/**
 * Hard upper-bound on the imported TSX file size (1 MiB). The compile pipeline
 * already caps JSX depth / diagnostic volume internally, but we refuse to even
 * read files above this cap so a pathological input can't exhaust the tool
 * budget before the compiler rejects it.
 */
const IMPORT_MAX_FILE_BYTES = 1024 * 1024;

/**
 * Derive a human-readable component name from a synced-folder-relative path.
 * Strips the `.tsx` / `.ts` extension and leaves the basename otherwise
 * untouched (no camelCase / title-case rewriting — the user's filename
 * convention is the ground truth for display).
 */
function deriveImportedComponentName(sourcePath: string): string {
  const base = path.basename(sourcePath);
  return base.replace(/\.(tsx|ts|jsx|js)$/i, "") || base;
}

/**
 * Normalize the caller-supplied tag list and guarantee the automatic
 * `"imported"` sentinel is present. Returns a de-duplicated, trimmed list.
 * Non-string entries are dropped defensively — the input schema says
 * `string[]`, but the runtime sees `unknown` from the AI SDK jsonSchema.
 */
function normalizeImportTags(raw: string[] | undefined): string[] {
  const source = Array.isArray(raw) ? raw : [];
  const cleaned = source
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const unique = Array.from(new Set(cleaned));
  if (!unique.includes("imported")) {
    unique.push("imported");
  }
  return unique;
}

async function handleImport(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  // --- 1. Validate required input. -----------------------------------------
  const sourcePath = input.sourcePath?.trim();
  if (!sourcePath) {
    const error = 'Provide "sourcePath" (synced-folder-relative TSX file path).';
    recordHistory(sessionId, "import", startedAt, false, { error });
    return {
      success: false,
      action: "import",
      error,
      data: { errorCode: "INVALID_INPUT" },
    };
  }

  const characterId = options.characterId;
  if (!characterId) {
    const error = 'Design workspace "import" requires a character-scoped session.';
    recordHistory(sessionId, "import", startedAt, false, { error });
    return {
      success: false,
      action: "import",
      error,
      data: { errorCode: "SOURCE_PATH_REJECTED", sourcePath },
    };
  }

  // --- 2. Resolve + read the source via the synced-folder helper (BA-4). ---
  // `readSyncedFile()` bundles the `resolveSyncedPath()` containment check
  // with the on-disk read, and returns structured errors keyed by a stable
  // `code` (PATH_NOT_ALLOWED, FILE_NOT_FOUND, FILE_TOO_LARGE, READ_FAILED).
  // We map those codes into the import-specific errorCodes
  // (IMPORT_RESOLVE_FAILED / IMPORT_READ_FAILED) so the agent can branch.
  let code: string;
  let resolvedSourcePath: string;
  let sourceBytes: number;
  let syncedFolders: string[] = [];
  try {
    syncedFolders = await resolveWorkspaceAwarePaths(characterId, sessionId);
    const readResult = await readSyncedFile({
      characterId,
      sessionId,
      sourcePath,
    });
    code = readResult.content;
    resolvedSourcePath = readResult.resolvedPath;
    sourceBytes = readResult.bytes;
  } catch (error: unknown) {
    if (isReadSyncedFileError(error)) {
      const isPathErr = error.code === "PATH_NOT_ALLOWED";
      const errorCode = isPathErr
        ? "IMPORT_RESOLVE_FAILED"
        : "IMPORT_READ_FAILED";
      recordHistory(sessionId, "import", startedAt, false, {
        error: error.message,
        metadata: {
          sourcePath,
          resolvedSourcePath: error.resolvedPath,
          readErrorCode: error.code,
          bytes: error.bytes,
        },
      });
      return {
        success: false,
        action: "import",
        error: error.message,
        data: {
          // Legacy SOURCE_PATH_REJECTED / SOURCE_READ_FAILED shadowed by the
          // more specific import-scoped codes below, per BA-2. Emit the
          // legacy code as a second field so existing consumers still read
          // a meaningful value — `errorCode` carries the new canonical code.
          errorCode,
          sourcePath,
          ...(error.resolvedPath ? { resolvedSourcePath: error.resolvedPath } : {}),
        },
      };
    }
    const message = error instanceof Error ? error.message : "Failed to read source file.";
    recordHistory(sessionId, "import", startedAt, false, {
      error: message,
      metadata: { sourcePath },
    });
    return {
      success: false,
      action: "import",
      error: message,
      data: {
        errorCode: "IMPORT_READ_FAILED",
        sourcePath,
      },
    };
  }

  if (sourceBytes > IMPORT_MAX_FILE_BYTES) {
    // The 1 MiB import cap is tighter than the 5 MiB readSyncedFile cap,
    // so we still have to enforce it explicitly — the helper's FILE_TOO_LARGE
    // only fires above 5 MiB.
    const error = `Source file "${sourcePath}" exceeds the import size cap (${sourceBytes} > ${IMPORT_MAX_FILE_BYTES} bytes).`;
    recordHistory(sessionId, "import", startedAt, false, {
      error,
      metadata: { sourcePath, size: sourceBytes, limit: IMPORT_MAX_FILE_BYTES },
    });
    return {
      success: false,
      action: "import",
      error,
      data: {
        errorCode: "IMPORT_READ_FAILED",
        sourcePath,
        resolvedSourcePath,
      },
    };
  }

  if (!code.trim()) {
    const error = `Source file "${sourcePath}" is empty.`;
    recordHistory(sessionId, "import", startedAt, false, {
      error,
      metadata: { sourcePath, resolvedSourcePath },
    });
    return {
      success: false,
      action: "import",
      error,
      data: {
        errorCode: "IMPORT_READ_FAILED",
        sourcePath,
        resolvedSourcePath,
      },
    };
  }

  const owningSyncedFolder = findOwningSyncedFolder(resolvedSourcePath, syncedFolders);
  const tsconfigPaths = owningSyncedFolder
    ? loadTsconfigPaths(owningSyncedFolder)
    : null;

  // --- 4. Compile through the same pipeline `generate` uses. ---------------
  const componentName = deriveImportedComponentName(sourcePath);
  // Rev-J3 — `import` is the only action that pulls a real source file from
  // the synced repo, so it's the only action that needs the esbuild bundler
  // to resolve relative imports (`./coach.css`, sibling components) against
  // the source file's own directory and to fall back to the synced repo's
  // `node_modules` for bare imports the sandbox doesn't already curate.
  // `componentResolveDir` is the absolute parent directory of the resolved
  // source file; `extraNodePaths` is appended after the sandbox node_modules
  // so the curated sandbox version always wins on collision.
  const componentResolveDir = path.dirname(resolvedSourcePath);
  const extraNodePaths = owningSyncedFolder
    ? [path.resolve(owningSyncedFolder, "node_modules")]
    : undefined;
  // Round-2 (B1+M5): build the containment allowlist from the roots
  // esbuild is allowed to read at onLoad time:
  //   - The owning synced folder (covers source + its node_modules).
  //     Required — without it relative imports + tsconfig-paths cannot
  //     resolve to anything inside the synced repo.
  //   - The curated sandbox dir (covers SANDBOX_NODE_MODULES too) so the
  //     sandbox-first plugin's resolutions land in an allowed root.
  //   - The host project's `node_modules` so the React/JSX-runtime
  //     aliases configured at the build level (`react`, `react-dom`,
  //     `react/jsx-runtime`, `react/jsx-dev-runtime`) can still load.
  //
  // The synced repo's `node_modules` is implicitly covered because it
  // lives inside `owningSyncedFolder`; we still pass `extraNodePaths` to
  // keep the allowlist explicit if a future caller separates them.
  const containment = buildContainmentConfig([
    owningSyncedFolder ?? undefined,
    SANDBOX_DIR,
    path.resolve(getProjectRoot(), "node_modules"),
    ...(extraNodePaths ?? []),
  ]);
  const previewResult = await compilePreviewForTool(
    code,
    componentName,
    "design-workspace-import",
    {
      globalsCssPath: input.globalsCssPath,
      characterId,
      sessionId,
      tsconfigPaths: tsconfigPaths ?? undefined,
      componentResolveDir,
      extraNodePaths,
      containment,
    },
  );

  if (!previewResult.ok) {
    // Compile failed — do NOT persist. Surface the structured compile report
    // + agent-actionable summary so the caller can correct the source file.
    recordHistory(sessionId, "import", startedAt, false, {
      error: previewResult.error,
      metadata: {
        sourcePath,
        resolvedSourcePath,
        missingPackages: previewResult.compileReport.dependencyCheck.missingPackages,
      },
    });
    return {
      success: false,
      action: "import",
      error: previewResult.error,
      data: {
        // Rev-J1: when the underlying compile failure is actually a
        // structured `design:<ref>` resolver error (IMPORT_NOT_FOUND /
        // IMPORT_SCOPE_VIOLATION / IMPORT_CYCLE_DETECTED), surface that
        // stronger code instead of the coarse IMPORT_COMPILE_FAILED so
        // the agent can branch on a single `errorCode` string without
        // digging into the freeform message. The matching
        // `designImportError` envelope ships the full structured
        // detail so nothing is stripped.
        errorCode: previewResult.designImportError?.code ?? "IMPORT_COMPILE_FAILED",
        sourcePath,
        resolvedSourcePath,
        name: componentName,
        previewHtml: previewResult.previewHtml,
        compileReport: previewResult.compileReport,
        missingPackages: previewResult.compileReport.dependencyCheck.missingPackages,
        agentErrorSummary: buildAgentErrorSummary(previewResult.compileReport),
        autoRecoveryAttempted: Boolean(
          previewResult.compileReport.autoInstall?.attempted,
        ),
        autoRecoveryResult: previewResult.compileReport.autoInstall
          ? previewResult.compileReport.autoInstall.success
            ? "success"
            : "failed"
          : "not-needed",
        ...(previewResult.globalsCssError
          ? { globalsCssError: previewResult.globalsCssError }
          : {}),
        ...(previewResult.designImportError
          ? { designImportError: previewResult.designImportError }
          : {}),
      },
    };
  }

  // --- 5. Persist (update-in-place or insert) via the W2.1 helper. ---------
  const importedAt = new Date().toISOString();
  const tags = normalizeImportTags(input.tags);

  let persisted: DesignGalleryItem;
  let wasUpdated: boolean;
  try {
    const result = await persistImportedDesign(options, {
      name: componentName,
      code,
      sourcePath,
      importedAt,
      tags,
    });
    persisted = result.component;
    wasUpdated = result.updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to persist imported design.";
    // BA-2: differentiate a duplicate-race (another concurrent import
    // inserted the (userId, sessionId, sourcePath) row between our
    // find + insert) from a generic persistence failure. The transactional
    // upsert in `persistImportedDesign` retries the lookup on UNIQUE
    // constraint, so reaching this branch with a UNIQUE error indicates
    // the retry itself failed — surface it as IMPORT_DUPLICATE_RACE so
    // the agent can inspect the existing row via `list`.
    const maybeSqliteErr = error as { code?: string } | null;
    const errorCode =
      maybeSqliteErr?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      maybeSqliteErr?.code === "SQLITE_CONSTRAINT"
        ? "IMPORT_DUPLICATE_RACE"
        : "IMPORT_PERSIST_FAILED";
    recordHistory(sessionId, "import", startedAt, false, {
      error: message,
      metadata: { sourcePath, resolvedSourcePath, errorCode },
    });
    return {
      success: false,
      action: "import",
      error: message,
      data: {
        errorCode,
        sourcePath,
        resolvedSourcePath,
        name: componentName,
        code,
      },
    };
  }

  // --- 6. Post-compile screenshot + envelope assembly. ---------------------
  const capture = await maybeCaptureScreenshot(options, input, persisted.id);
  const previewMeta = buildPreviewMeta({
    componentId: persisted.id,
    generatedAt: Date.now(),
    previewHtmlLength: previewResult.previewHtml.length,
    capture,
  });

  recordHistory(sessionId, "import", startedAt, true, {
    componentId: persisted.id,
    metadata: {
      sourcePath,
      resolvedSourcePath,
      updated: wasUpdated,
    },
  });

  return {
    success: true,
    action: "import",
    data: {
      componentId: persisted.id,
      code,
      name: persisted.name,
      prompt: persisted.prompt,
      mode: "tailwind",
      style: "default",
      updatedAt: persisted.updatedAt,
      sourcePath,
      resolvedSourcePath,
      importedAt,
      updated: wasUpdated,
      tags,
      ...previewMeta,
      previewHtml: previewResult.previewHtml,
      compileReport: previewResult.compileReport,
      missingPackages: previewResult.compileReport.dependencyCheck.missingPackages,
      autoRecoveryAttempted: Boolean(previewResult.compileReport.autoInstall?.attempted),
      autoRecoveryResult: previewResult.compileReport.autoInstall
        ? previewResult.compileReport.autoInstall.success
          ? "success"
          : "failed"
        : "not-needed",
      message: wasUpdated
        ? `Design "${persisted.name}" re-imported from "${sourcePath}" (existing row updated).`
        : `Design "${persisted.name}" imported from "${sourcePath}" and saved successfully.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Sprint 3 W3.1 — persisted snapshot handlers.
//
// All five handlers require BOTH an authenticated `userId` and a concrete
// `sessionId` (not "UNSCOPED"). Cross-user / cross-session reads never leak
// existence — the query module returns `null` rather than raising. Handlers
// translate that `null` into `SNAPSHOT_NOT_FOUND` so callers can branch on a
// single code without inspecting scope tuples.
//
// The existing transient in-memory DesignSnapshot (lib/design/workspace/
// types.ts + store.ts:428-485) is completely unaffected by these actions —
// this is a SEPARATE persisted concept.
// ---------------------------------------------------------------------------

/**
 * Validate that the handler has both a concrete `userId` and a concrete
 * `sessionId`. Returns the resolved pair or an `INVALID_INPUT` envelope.
 * Keeps the guard in one place so every snapshot handler surfaces the same
 * shape when the AI runtime strips the character / session context.
 */
function resolveSnapshotScope(
  options: DesignWorkspaceToolOptions,
): { ok: true; userId: string; sessionId: string } | { ok: false; error: string } {
  const userId = getPersistedUserId(options);
  const sessionId = getSessionId(options);
  if (!userId) {
    return {
      ok: false,
      error:
        'Snapshot actions require an authenticated user context. Reconnect or sign in.',
    };
  }
  if (!sessionId || sessionId === "UNSCOPED") {
    return {
      ok: false,
      error:
        'Snapshot actions require a concrete session context. Open the workspace from an active chat session.',
    };
  }
  return { ok: true, userId, sessionId };
}

async function handleSnapshotSave(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  const scope = resolveSnapshotScope(options);
  if (!scope.ok) {
    recordHistory(sessionId, "snapshot.save", startedAt, false, { error: scope.error });
    return {
      success: false,
      action: "snapshot.save",
      error: scope.error,
      data: { errorCode: "INVALID_INPUT" },
    };
  }

  const componentId = input.componentId?.trim();
  if (!componentId) {
    const error = 'Provide "componentId" to save a snapshot for.';
    recordHistory(sessionId, "snapshot.save", startedAt, false, { error });
    return {
      success: false,
      action: "snapshot.save",
      error,
      data: { errorCode: "INVALID_INPUT" },
    };
  }

  const providedName = input.name;
  if (typeof providedName === "string" && providedName.length > SNAPSHOT_NAME_MAX_LENGTH) {
    const error = `Snapshot name exceeds ${SNAPSHOT_NAME_MAX_LENGTH} characters (got ${providedName.length}).`;
    recordHistory(sessionId, "snapshot.save", startedAt, false, {
      componentId,
      error,
    });
    return {
      success: false,
      action: "snapshot.save",
      error,
      data: { errorCode: "SNAPSHOT_NAME_TOO_LONG", componentId },
    };
  }

  // Rev-G B2 — always verify the referenced componentId belongs to the
  // current `(userId, sessionId)` scope, regardless of whether the caller
  // supplied an explicit `sourceCode`. The previous version short-circuited
  // past this check when `sourceCode` was provided, which would have let a
  // malicious or buggy caller attach ANY existing `design_components.id`
  // to the new snapshot row — creating cross-session/user FK coupling and
  // making `ON DELETE CASCADE` depend on a foreign component (the backend
  // review called this out as a scope-leak warn).
  //
  // We do the scope lookup unconditionally and use its `code` as the
  // source-of-truth only when the caller did NOT supply an explicit
  // `sourceCode` (so the explicit-buffer use case still wins).
  const component = await findWorkspaceDesign({
    id: componentId,
    userId: scope.userId,
    sessionId: scope.sessionId,
  });
  if (!component) {
    const error = `Design component "${componentId}" was not found for this workspace session.`;
    recordHistory(sessionId, "snapshot.save", startedAt, false, {
      componentId,
      error,
    });
    return {
      success: false,
      action: "snapshot.save",
      error,
      data: { errorCode: "SNAPSHOT_COMPONENT_NOT_FOUND", componentId },
    };
  }

  // Resolve the source code: caller-supplied wins; otherwise read the
  // current component source from the gallery. This keeps "snapshot the
  // current state" a one-argument call but still allows capturing a
  // specific in-progress edit buffer the agent hasn't yet persisted to
  // the component row.
  let sourceCode = input.sourceCode;
  if (typeof sourceCode !== "string" || sourceCode.length === 0) {
    sourceCode = component.code ?? "";
  }

  const snapshotName =
    typeof providedName === "string"
      ? providedName
      : providedName === null
        ? null
        : null;

  let persisted: PersistedDesignSnapshot;
  try {
    persisted = await createSnapshot({
      id: generateId(),
      userId: scope.userId,
      sessionId: scope.sessionId,
      componentId,
      sourceCode,
      name: snapshotName,
      isPinned: input.isPinned === true,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to persist snapshot.";
    recordHistory(sessionId, "snapshot.save", startedAt, false, {
      componentId,
      error: message,
      metadata: {
        errorCode:
          error instanceof SnapshotCreateError ? error.code : "SNAPSHOT_SAVE_FAILED",
      },
    });
    return {
      success: false,
      action: "snapshot.save",
      error: message,
      data: {
        errorCode: "SNAPSHOT_SAVE_FAILED",
        componentId,
      },
    };
  }

  recordHistory(sessionId, "snapshot.save", startedAt, true, {
    componentId,
    metadata: { snapshotId: persisted.id, isPinned: persisted.isPinned },
  });

  return {
    success: true,
    action: "snapshot.save",
    data: {
      snapshot: persisted,
      snapshotId: persisted.id,
      componentId,
      message: persisted.name
        ? `Saved snapshot "${persisted.name}" (id: ${persisted.id}).`
        : `Saved snapshot ${persisted.id}.`,
    },
  };
}

async function handleSnapshotPin(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  const scope = resolveSnapshotScope(options);
  if (!scope.ok) {
    recordHistory(sessionId, "snapshot.pin", startedAt, false, { error: scope.error });
    return {
      success: false,
      action: "snapshot.pin",
      error: scope.error,
      data: { errorCode: "INVALID_INPUT" },
    };
  }

  const snapshotId = input.snapshotId?.trim();
  if (!snapshotId) {
    const error = 'Provide "snapshotId" to pin / unpin a snapshot.';
    recordHistory(sessionId, "snapshot.pin", startedAt, false, { error });
    return {
      success: false,
      action: "snapshot.pin",
      error,
      data: { errorCode: "INVALID_INPUT" },
    };
  }
  if (typeof input.isPinned !== "boolean") {
    const error = 'Provide "isPinned" (boolean) to pin / unpin a snapshot.';
    recordHistory(sessionId, "snapshot.pin", startedAt, false, { error });
    return {
      success: false,
      action: "snapshot.pin",
      error,
      data: { errorCode: "INVALID_INPUT", snapshotId },
    };
  }

  let updated: PersistedDesignSnapshot | null;
  try {
    updated = await pinSnapshot(snapshotId, scope.userId, scope.sessionId, input.isPinned);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update snapshot pin state.";
    recordHistory(sessionId, "snapshot.pin", startedAt, false, {
      error: message,
      metadata: { snapshotId },
    });
    return {
      success: false,
      action: "snapshot.pin",
      error: message,
      data: { errorCode: "SNAPSHOT_PIN_FAILED", snapshotId },
    };
  }
  if (!updated) {
    const error = `Snapshot "${snapshotId}" was not found for this session.`;
    recordHistory(sessionId, "snapshot.pin", startedAt, false, {
      error,
      metadata: { snapshotId },
    });
    return {
      success: false,
      action: "snapshot.pin",
      error,
      data: { errorCode: "SNAPSHOT_NOT_FOUND", snapshotId },
    };
  }

  recordHistory(sessionId, "snapshot.pin", startedAt, true, {
    metadata: { snapshotId, isPinned: updated.isPinned },
  });

  return {
    success: true,
    action: "snapshot.pin",
    data: {
      snapshot: updated,
      snapshotId: updated.id,
      componentId: updated.componentId,
      message: updated.isPinned
        ? `Pinned snapshot ${updated.id}.`
        : `Unpinned snapshot ${updated.id}.`,
    },
  };
}

async function handleSnapshotRename(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  const scope = resolveSnapshotScope(options);
  if (!scope.ok) {
    recordHistory(sessionId, "snapshot.rename", startedAt, false, { error: scope.error });
    return {
      success: false,
      action: "snapshot.rename",
      error: scope.error,
      data: { errorCode: "INVALID_INPUT" },
    };
  }

  const snapshotId = input.snapshotId?.trim();
  if (!snapshotId) {
    const error = 'Provide "snapshotId" to rename a snapshot.';
    recordHistory(sessionId, "snapshot.rename", startedAt, false, { error });
    return {
      success: false,
      action: "snapshot.rename",
      error,
      data: { errorCode: "INVALID_INPUT" },
    };
  }

  // Explicit null means "clear the name". Undefined means "caller forgot to
  // supply one" — reject with INVALID_INPUT so the agent cannot silently
  // no-op a rename.
  if (input.name === undefined) {
    const error = 'Provide "name" (string or null) to rename a snapshot.';
    recordHistory(sessionId, "snapshot.rename", startedAt, false, {
      error,
      metadata: { snapshotId },
    });
    return {
      success: false,
      action: "snapshot.rename",
      error,
      data: { errorCode: "INVALID_INPUT", snapshotId },
    };
  }
  const newName = input.name;
  if (typeof newName === "string" && newName.length > SNAPSHOT_NAME_MAX_LENGTH) {
    const error = `Snapshot name exceeds ${SNAPSHOT_NAME_MAX_LENGTH} characters (got ${newName.length}).`;
    recordHistory(sessionId, "snapshot.rename", startedAt, false, {
      error,
      metadata: { snapshotId },
    });
    return {
      success: false,
      action: "snapshot.rename",
      error,
      data: { errorCode: "SNAPSHOT_NAME_TOO_LONG", snapshotId },
    };
  }

  let updated: PersistedDesignSnapshot | null;
  try {
    updated = await renameSnapshot(
      snapshotId,
      scope.userId,
      scope.sessionId,
      typeof newName === "string" ? newName : null,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to rename snapshot.";
    recordHistory(sessionId, "snapshot.rename", startedAt, false, {
      error: message,
      metadata: { snapshotId },
    });
    return {
      success: false,
      action: "snapshot.rename",
      error: message,
      data: { errorCode: "SNAPSHOT_RENAME_FAILED", snapshotId },
    };
  }
  if (!updated) {
    const error = `Snapshot "${snapshotId}" was not found for this session.`;
    recordHistory(sessionId, "snapshot.rename", startedAt, false, {
      error,
      metadata: { snapshotId },
    });
    return {
      success: false,
      action: "snapshot.rename",
      error,
      data: { errorCode: "SNAPSHOT_NOT_FOUND", snapshotId },
    };
  }

  recordHistory(sessionId, "snapshot.rename", startedAt, true, {
    metadata: { snapshotId, name: updated.name },
  });

  return {
    success: true,
    action: "snapshot.rename",
    data: {
      snapshot: updated,
      snapshotId: updated.id,
      componentId: updated.componentId,
      message: updated.name
        ? `Renamed snapshot ${updated.id} to "${updated.name}".`
        : `Cleared name on snapshot ${updated.id}.`,
    },
  };
}

async function handleSnapshotList(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  const scope = resolveSnapshotScope(options);
  if (!scope.ok) {
    recordHistory(sessionId, "snapshot.list", startedAt, false, { error: scope.error });
    return {
      success: false,
      action: "snapshot.list",
      error: scope.error,
      data: { errorCode: "INVALID_INPUT" },
    };
  }

  const requestedLimit =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.floor(input.limit)
      : undefined;
  const clampedLimit =
    requestedLimit !== undefined
      ? Math.max(1, Math.min(requestedLimit, SNAPSHOT_LIST_HARD_CAP))
      : SNAPSHOT_LIST_HARD_CAP;

  let rows: PersistedDesignSnapshot[];
  try {
    rows = await listSnapshots({
      userId: scope.userId,
      sessionId: scope.sessionId,
      isPinnedOnly: input.isPinnedOnly === true,
      componentId: input.componentId,
      limit: clampedLimit,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list snapshots.";
    recordHistory(sessionId, "snapshot.list", startedAt, false, {
      error: message,
    });
    return {
      success: false,
      action: "snapshot.list",
      error: message,
      data: { errorCode: "INVALID_INPUT" },
    };
  }

  // `truncated` fires when EITHER the caller asked for more than the hard
  // cap, OR the rowcount equals the cap (which means there could be more
  // rows the query did not return). In either case the agent should know
  // the listing was not exhaustive.
  const truncated =
    (requestedLimit !== undefined && requestedLimit > SNAPSHOT_LIST_HARD_CAP) ||
    rows.length === SNAPSHOT_LIST_HARD_CAP;

  recordHistory(sessionId, "snapshot.list", startedAt, true, {
    metadata: { count: rows.length, truncated },
  });

  return {
    success: true,
    action: "snapshot.list",
    data: {
      snapshots: rows,
      truncated,
      message:
        rows.length === 0
          ? "No persisted snapshots for this session."
          : `Found ${rows.length} persisted snapshot${rows.length === 1 ? "" : "s"}.`,
    },
  };
}

async function handleSnapshotDelete(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  const scope = resolveSnapshotScope(options);
  if (!scope.ok) {
    recordHistory(sessionId, "snapshot.delete", startedAt, false, { error: scope.error });
    return {
      success: false,
      action: "snapshot.delete",
      error: scope.error,
      data: { errorCode: "INVALID_INPUT" },
    };
  }

  const snapshotId = input.snapshotId?.trim();
  if (!snapshotId) {
    const error = 'Provide "snapshotId" to delete a snapshot.';
    recordHistory(sessionId, "snapshot.delete", startedAt, false, { error });
    return {
      success: false,
      action: "snapshot.delete",
      error,
      data: { errorCode: "INVALID_INPUT" },
    };
  }

  // The spec describes delete as a "soft return" — both hits and misses are
  // success: true with a `deleted` boolean so the agent can branch without
  // treating miss as an error. The `SNAPSHOT_DELETE_FAILED` code is reserved
  // for genuine DB failures (thrown errors). We still record the existence
  // check via `findSnapshotById` so the history log distinguishes a real
  // delete from a no-op, which matters for audit / undo downstream.
  const existed = await findSnapshotById(snapshotId, scope.userId, scope.sessionId);

  let deleted: boolean;
  try {
    deleted = await deleteSnapshot(snapshotId, scope.userId, scope.sessionId);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to delete snapshot.";
    recordHistory(sessionId, "snapshot.delete", startedAt, false, {
      error: message,
      metadata: { snapshotId },
    });
    return {
      success: false,
      action: "snapshot.delete",
      error: message,
      data: { errorCode: "SNAPSHOT_DELETE_FAILED", snapshotId },
    };
  }

  recordHistory(sessionId, "snapshot.delete", startedAt, true, {
    metadata: { snapshotId, deleted, existedBefore: existed !== null },
  });

  return {
    success: true,
    action: "snapshot.delete",
    data: {
      deleted,
      snapshotId,
      message: deleted
        ? `Deleted snapshot ${snapshotId}.`
        : `Snapshot ${snapshotId} did not exist in this session (no-op).`,
    },
  };
}

// ---------------------------------------------------------------------------
// Sprint 3 W3.2 — snapshot.diff handler.
//
// Computes a unified diff between two persisted snapshots scoped to the
// current (userId, sessionId). Reuses the Sprint 2 `createPortDiff` util so
// there's only one diff dependency (`diff` from npm) in the module graph —
// per the W3.2 hard constraints.
//
// Cross-user / cross-session isolation is handled entirely by
// `findSnapshotById`'s scoped query — a row owned by another user or
// another session returns `null`, and the handler translates that to
// `SNAPSHOT_NOT_FOUND` carrying the offending id. We never emit a distinct
// "forbidden" code; the existence of the row (or lack thereof) never leaks
// through the envelope.
// ---------------------------------------------------------------------------

/** Default unified-diff line cap for snapshot.diff (spec: 1000). */
const SNAPSHOT_DIFF_DEFAULT_MAX_LINES = 1000;
/** Hard upper cap the handler will accept for `maxLines` (spec: 5000). */
const SNAPSHOT_DIFF_HARD_MAX_LINES = 5000;

/**
 * Shorten a UUID-like id for display in diff labels. Kept in one place so
 * the test can lock the "short id" fallback contract.
 */
function shortSnapshotLabel(row: PersistedDesignSnapshot): string {
  return row.name ?? row.id.slice(0, 8);
}

/**
 * Project a full `PersistedDesignSnapshot` row down to the compact summary
 * shape the `snapshot.diff` envelope emits (`a` / `b`). Intentionally
 * omits `sourceCode` and `metadata` — the diff itself carries the
 * content, and callers that want the full rows can round-trip through
 * `snapshot.list` or the query layer.
 */
function summarizeSnapshotForDiff(
  row: PersistedDesignSnapshot,
): NonNullable<DesignWorkspaceResultData["a"]> {
  return {
    id: row.id,
    createdAt: row.createdAt,
    name: row.name,
    isPinned: row.isPinned,
    componentId: row.componentId,
  };
}

async function handleSnapshotDiff(
  options: DesignWorkspaceToolOptions,
  input: DesignWorkspaceInput,
): Promise<DesignWorkspaceResult> {
  const startedAt = Date.now();
  const sessionId = getSessionId(options);
  ensureHistory(sessionId);

  const scope = resolveSnapshotScope(options);
  if (!scope.ok) {
    recordHistory(sessionId, "snapshot.diff", startedAt, false, {
      error: scope.error,
    });
    return {
      success: false,
      action: "snapshot.diff",
      error: scope.error,
      data: { errorCode: "SNAPSHOT_DIFF_INVALID_INPUT" },
    };
  }

  // Handler-level validation. We do this BEFORE any DB read so the agent
  // gets a deterministic, cheap error envelope and we never leak row
  // existence when the caller's input was malformed.
  const aId = typeof input.a === "string" ? input.a.trim() : "";
  const bId = typeof input.b === "string" ? input.b.trim() : "";
  if (aId.length === 0 || bId.length === 0) {
    const error = 'Provide non-empty "a" and "b" snapshot ids to diff.';
    recordHistory(sessionId, "snapshot.diff", startedAt, false, { error });
    return {
      success: false,
      action: "snapshot.diff",
      error,
      data: { errorCode: "SNAPSHOT_DIFF_INVALID_INPUT" },
    };
  }

  let maxLines = SNAPSHOT_DIFF_DEFAULT_MAX_LINES;
  if (input.maxLines !== undefined) {
    if (
      typeof input.maxLines !== "number" ||
      !Number.isFinite(input.maxLines) ||
      !Number.isInteger(input.maxLines) ||
      input.maxLines <= 0 ||
      input.maxLines > SNAPSHOT_DIFF_HARD_MAX_LINES
    ) {
      const error = `"maxLines" must be a positive integer <= ${SNAPSHOT_DIFF_HARD_MAX_LINES}.`;
      recordHistory(sessionId, "snapshot.diff", startedAt, false, { error });
      return {
        success: false,
        action: "snapshot.diff",
        error,
        data: { errorCode: "SNAPSHOT_DIFF_INVALID_INPUT" },
      };
    }
    maxLines = input.maxLines;
  }

  // Scoped reads. Cross-user / cross-session ids return null from
  // `findSnapshotById` — we surface that as SNAPSHOT_NOT_FOUND with the
  // offending `missingId` so the agent can branch on a single field without
  // inspecting the scope tuple. The `a`-first ordering means an agent that
  // passes two bad ids only sees the first one, which is the same
  // ergonomic contract the rest of the tool uses for paired-input errors.
  const aRow = await findSnapshotById(aId, scope.userId, scope.sessionId);
  if (!aRow) {
    const error = `Snapshot "${aId}" was not found for this session.`;
    recordHistory(sessionId, "snapshot.diff", startedAt, false, {
      error,
      metadata: { missingId: aId },
    });
    return {
      success: false,
      action: "snapshot.diff",
      error,
      data: { errorCode: "SNAPSHOT_NOT_FOUND", missingId: aId },
    };
  }
  const bRow = await findSnapshotById(bId, scope.userId, scope.sessionId);
  if (!bRow) {
    const error = `Snapshot "${bId}" was not found for this session.`;
    recordHistory(sessionId, "snapshot.diff", startedAt, false, {
      error,
      metadata: { missingId: bId },
    });
    return {
      success: false,
      action: "snapshot.diff",
      error,
      data: { errorCode: "SNAPSHOT_NOT_FOUND", missingId: bId },
    };
  }

  // Build a composite "target path" for the diff header. `createPortDiff`
  // uses the same label for both sides of the unified-diff `---` / `+++`
  // lines, so we fold both snapshot labels into one string so the header
  // is informative regardless. The caller-visible truth lives in the
  // structured `a` / `b` summary fields on the envelope below.
  const aLabel = shortSnapshotLabel(aRow);
  const bLabel = shortSnapshotLabel(bRow);
  const diffPathLabel = `snapshot:${aLabel}->${bLabel}`;

  let diffResult: ReturnType<typeof createPortDiff>;
  try {
    diffResult = createPortDiff(diffPathLabel, aRow.sourceCode, bRow.sourceCode, {
      maxLines,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to compute snapshot diff.";
    recordHistory(sessionId, "snapshot.diff", startedAt, false, {
      error: message,
      metadata: { a: aId, b: bId },
    });
    return {
      success: false,
      action: "snapshot.diff",
      error: message,
      data: {
        errorCode: "SNAPSHOT_DIFF_FAILED",
        a: summarizeSnapshotForDiff(aRow),
        b: summarizeSnapshotForDiff(bRow),
      },
    };
  }

  const sameContent = diffResult.identical;
  const diff = sameContent ? "" : diffResult.diff;

  recordHistory(sessionId, "snapshot.diff", startedAt, true, {
    metadata: {
      a: aRow.id,
      b: bRow.id,
      sameContent,
      diffTruncated: diffResult.truncated,
      totalLines: diffResult.totalLines,
    },
  });

  return {
    success: true,
    action: "snapshot.diff",
    data: {
      a: summarizeSnapshotForDiff(aRow),
      b: summarizeSnapshotForDiff(bRow),
      diff,
      diffTruncated: diffResult.truncated,
      sameContent,
      totalLines: diffResult.totalLines,
      message: sameContent
        ? `Snapshots ${aLabel} and ${bLabel} are identical.`
        : diffResult.truncated
          ? `Diff between ${aLabel} and ${bLabel} (truncated — ${diffResult.totalLines} total lines).`
          : `Diff between ${aLabel} and ${bLabel} (${diffResult.totalLines} lines).`,
    },
  };
}

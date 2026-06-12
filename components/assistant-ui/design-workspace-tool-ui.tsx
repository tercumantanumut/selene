"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import type { FC } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  FileDiff,
  FilePlus,
  FileUp,
  Grid2x2,
  Image as ImageIcon,
  List,
  PanelRightClose,
  PanelRightOpen,
  PenSquare,
  Pin,
  PinOff,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Tag,
  Trash2,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { dispatchDesignToolResult } from "@/components/design/design-workspace-bridge";
import { useChatSessionId } from "@/components/chat-provider";
import { parseNestedJsonString } from "@/lib/utils/parse-nested-json";
import type { DesignWorkspaceCompileReport } from "@/lib/design/workspace/config";
import type { DesignWorkspaceConfig } from "@/lib/design/workspace/config";
import type { DesignWorkspaceValidationResult } from "@/lib/design/workspace/config";
import type { DesignWorkspaceHistory } from "@/lib/design/workspace/edit-history";

type ValidationCheck = {
  name: string;
  status: "pass" | "fail" | "skip";
  message?: string;
};

interface HistoryActionSummary {
  seq?: number;
  action?: string;
  success?: boolean;
  durationMs?: number;
  error?: string;
}

interface HistorySummary extends Omit<DesignWorkspaceHistory, "actions"> {
  actions?: HistoryActionSummary[];
}

interface CompileReportSummary extends Omit<DesignWorkspaceCompileReport, "errors" | "dependencyCheck"> {
  errors?: Array<{ message?: string; suggestion?: string }>;
  dependencyCheck?: { missingPackages?: string[] };
}

interface ConfigSummary extends Partial<DesignWorkspaceConfig> {}

interface ValidationSummary extends Omit<DesignWorkspaceValidationResult, "checks"> {
  checks?: ValidationCheck[];
}

interface DesignWorkspaceResultData {
  componentId?: string;
  code?: string;
  name?: string;
  snapshotId?: string;
  format?: string;
  message?: string;
  prompt?: string;
  mode?: string;
  style?: string;
  previewHtml?: string;
  missingPackages?: string[];
  autoRecoveryAttempted?: boolean;
  autoRecoveryResult?: "success" | "failed" | "not-needed";
  compileReport?: CompileReportSummary;
  postEditValidation?: ValidationSummary;
  history?: HistorySummary;
  config?: ConfigSummary;
  /**
   * Set by the tool when heavy fields (code/previewHtml) were stripped to
   * keep the tool result under the AI runtime's token cap. The bridge uses
   * `hydrateRef.componentId` to refetch the full record from the DB.
   */
  truncated?: boolean;
  codeLength?: number;
  codeLines?: number;
  /**
   * Agent-actionable replacement for the removed `previewHtmlLength` scalar.
   * Carries the original previewHtml length plus a machine-readable hint
   * (`getVia: "readSource"`) telling the agent how to fetch the full HTML.
   * Emitted by `buildPreviewMeta` on every mutating action (generate / edit /
   * patch). See `lib/ai/tools/design-workspace-tool.ts` for the producer.
   */
  previewHtmlRef?: { length: number; getVia: "readSource" };
  /**
   * Captured preview screenshot metadata. Present when screenshot capture
   * succeeded for the associated component. The `url` is a data: or asset
   * URL suitable for <img src>. Produced by `maybeCaptureScreenshot`.
   */
  screenshot?: { url: string; width: number; height: number; dpr: number };
  /**
   * Probed inline style snapshots keyed by selector → CSS prop → value.
   * Emitted alongside `screenshot` so downstream UI can diff / display
   * computed styles without re-rendering the preview.
   */
  probes?: Record<string, Record<string, string>>;
  /**
   * Sprint 4 W4.1 — per-state captures emitted when the caller passed a
   * non-empty `states` input. Each entry is either a successful capture
   * `{ label, pseudo, selector, screenshot, probes? }` OR a structured
   * per-entry error `{ label, pseudo, selector, error: { code, message } }`.
   * Mirrors the backend `ScreenshotStateEntry` union; redeclared here
   * because the tool-UI is a client boundary.
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
   * Structured capture-error envelope when screenshot acquisition failed.
   * Mutually exclusive with `screenshot` — if this is set, `screenshot`
   * will be absent (and vice versa). Consumers MUST render
   * `screenshotError.message` (not the object) to avoid `[object Object]`.
   * The object shape matches the producer in
   * `lib/ai/tools/design-workspace-tool.ts` (Sprint 1 Rev-A2 Gap 2) and is
   * future-extensible via the optional `code` field.
   */
  screenshotError?: { message: string; code?: string };
  hydrateRef?: { kind: "gallery"; componentId: string };
  /**
   * Server-stamped timestamp (ms since epoch) set by `slimResult` on
   * mutating actions (generate/edit/patch). Used as a freshness fallback
   * for `isLive` detection when the tool-UI mounts directly at
   * `output-available` and the streaming-state transition heuristic misses.
   */
  generatedAt?: number;
  /** Project metadata fields (detect/browse/cast/open) */
  framework?: Record<string, unknown>;
  projectStructure?: Record<string, unknown>;
  castFile?: string;
  castMode?: "page" | "component" | "route";
  rendererInfo?: Record<string, unknown>;
  metadata?: Record<string, unknown>;

  // ---------------------------------------------------------------------------
  // Sprint 2 — import/port action result fields.
  // Mirrored from `lib/ai/tools/design-workspace-tool.ts`
  // `DesignWorkspaceResultData`; redeclared here because the tool-UI is a
  // client component and the backend module is server-scoped.
  // ---------------------------------------------------------------------------
  /** For `action: "import"` and port-error envelopes: the agent-provided source path. */
  sourcePath?: string;
  /** For `action: "import"`: host-absolute path actually read (diagnostics only). */
  resolvedSourcePath?: string;
  /** For `action: "import"`: ISO timestamp persisted to `metadata.importedAt`. */
  importedAt?: string;
  /**
   * For `action: "import"`: row `updatedAt` timestamp echoed back from the
   * persisted record (ISO string). Forwarded through the bridge so consumers
   * can display freshness without re-reading the raw tool result.
   */
  updatedAt?: string;
  /** For `action: "import"`: true when an existing row was updated-in-place. */
  updated?: boolean;
  /** For `action: "import"`: final tag list persisted (includes automatic "imported"). */
  tags?: string[];
  /** For `action: "port"`: true when a write actually occurred. */
  applied?: boolean;
  /** For `action: "port"`: absolute target path. */
  targetPath?: string;
  /** For `action: "port"`: synced-folder-relative label echoed back for display. */
  targetRelativePath?: string;
  /** For `action: "port"`: whether the target file existed before this call. */
  targetExistedBefore?: boolean;
  /** For `action: "port"`: size in bytes of the pre-existing target file. */
  targetSize?: number;
  /** For `action: "port"` apply: bytes written on a successful write. */
  bytesWritten?: number;
  /** For `action: "port"`: unified diff between existing target and workspace source. */
  diff?: string;
  /** For `action: "port"`: true when the diff was truncated for token-budget reasons. */
  diffTruncated?: boolean;
  /**
   * For `action: "port"`: preflight fingerprint of the on-disk target file
   * captured during a dry-run (or at the moment a `TARGET_EXISTS_MUST_OVERWRITE`
   * envelope was produced). The caller echoes `contentSha256` back via
   * `expectedContentSha256` on the follow-up apply so the backend can
   * detect mid-flight edits and reject with `PORT_STALE_DIFF`.
   */
  preflight?: {
    contentSha256: string;
    mtimeMs: number | null;
  };
  /**
   * For `action: "port"` with `errorCode: "PORT_STALE_DIFF"`: diagnostic
   * triple documenting why the apply was rejected. `currentSha256` is the
   * hash the backend read at apply-time; `expectedSha256` echoes the
   * caller-supplied dry-run hash so mismatches are legible without
   * cross-referencing the earlier envelope.
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
    // Sprint 3 W3.1 — persisted design snapshot error codes.
    | "SNAPSHOT_COMPONENT_NOT_FOUND"
    | "SNAPSHOT_NOT_FOUND"
    | "SNAPSHOT_NAME_TOO_LONG"
    | "SNAPSHOT_SAVE_FAILED"
    | "SNAPSHOT_PIN_FAILED"
    | "SNAPSHOT_RENAME_FAILED"
    | "SNAPSHOT_DELETE_FAILED"
    // Sprint 3 W3.2 — snapshot.diff validation / compute failures. Mirror of
    // the bridge's `DesignToolEvent.data.errorCode` additions.
    | "SNAPSHOT_DIFF_INVALID_INPUT"
    | "SNAPSHOT_DIFF_FAILED"
    // Sprint 3 W3.3 — reference-image overlay validation codes. Mirror of
    // the bridge's `DesignToolEvent.data.errorCode` union addition.
    // REFERENCE_IMAGE_URL_TOO_LARGE is Rev-F1's forthcoming byte-cap code;
    // included here so the client tool-UI stays in lock-step.
    | "REFERENCE_IMAGE_URL_INVALID"
    | "REFERENCE_IMAGE_URL_TOO_LARGE"
    // Sprint 3 W3.4 — renderMany input-validation codes.
    | "RENDER_MANY_TOO_MANY"
    | "RENDER_MANY_INVALID_PROPS"
    // Sprint 4 W4.2 — `design:<ref>` virtual-module resolver failures.
    // Mirror of the bridge's `DesignToolEvent.data.errorCode` union
    // addition. v1 does NOT render a dedicated panel for these codes —
    // the generic error envelope is sufficient because the agent uses
    // `errorCode` + `data.designImportError.{ref,chain}` to self-correct.
    | "IMPORT_NOT_FOUND"
    | "IMPORT_SCOPE_VIOLATION"
    | "IMPORT_CYCLE_DETECTED";
  // ---------------------------------------------------------------------------
  // Sprint 3 W3.1 — persisted design snapshot envelope fields.
  //
  // These ride on the tool result for the `snapshot.*` action family. The
  // shape mirrors `lib/design/workspace/persisted-snapshot-types.ts`
  // `PersistedDesignSnapshot`; redeclared here because the tool-UI is a
  // client component while the backend module is server-scoped — same
  // decoupling strategy used for the Sprint 2 import/port fields above.
  // ---------------------------------------------------------------------------
  /** Single persisted snapshot row — `snapshot.save / pin / rename`. */
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
  /** Persisted snapshot rows — `snapshot.list`. Newest-first. */
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
  /** `snapshot.delete` result: true when a row was removed, false on soft miss. */
  deleted?: boolean;
  // ---------------------------------------------------------------------------
  // Sprint 3 W3.2 — snapshot.diff envelope fields (mirror of the backend
  // shape; redeclared here because the tool-UI is a client component and we
  // don't import the backend type).
  //
  // `a` / `b` are compact row summaries (no sourceCode). `sameContent` is
  // true when the two rows' `sourceCode` was byte-identical. `totalLines`
  // is the unified-diff line count (pre-truncation). `missingId` rides
  // alongside `errorCode: "SNAPSHOT_NOT_FOUND"` so the tool-UI can echo
  // the offending side without parsing the error string.
  // ---------------------------------------------------------------------------
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
   * W2.3 — structured asset-alias failure envelope. Discriminated by `code`.
   * Consumers render `.message` and `.declaredAliases`, highlighting
   * `.alias` (the offending entry) when present.
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
   * `code`. `path` is the agent-provided input.
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
  // ---------------------------------------------------------------------------
  // Sprint 3 W3.3 — reference-image overlay envelope fields (mirror of the
  // bridge's `DesignToolEvent.data` additions). Redeclared here because the
  // tool-UI is a client component and we don't import the backend type.
  // ---------------------------------------------------------------------------
  /**
   * Present on generate / edit / patch successes when the agent passed a
   * valid `referenceImageUrl`. The field's EXISTENCE is the signal; `url`
   * echoes the validated URL for display.
   */
  referenceImage?: { url: string; present: true };
  /**
   * Structured reference-image validation failure. `rejectedUrl` / `bytes`
   * / `limit` are emitted by Rev-F1's forthcoming byte-cap rejection
   * (REFERENCE_IMAGE_URL_TOO_LARGE); optional now so consumers don't need
   * a follow-up type bump.
   */
  referenceImageError?: {
    code: "REFERENCE_IMAGE_URL_INVALID" | "REFERENCE_IMAGE_URL_TOO_LARGE";
    message: string;
    rejectedUrl?: string;
    bytes?: number;
    limit?: number;
  };
  // ---------------------------------------------------------------------------
  // Sprint 3 W3.4 — renderMany grid envelope fields (mirror of backend shape).
  // ---------------------------------------------------------------------------
  /** Success confirmation: N cells rendered into the compiled preview HTML. */
  renderMany?: { count: number; cellsEmitted: number };
  /** Structured input-validation failure for the renderMany primitive. */
  renderManyError?: {
    code: "RENDER_MANY_TOO_MANY" | "RENDER_MANY_INVALID_PROPS";
    message: string;
    index?: number;
    count?: number;
    limit?: number;
  };
  /** Per-cell warnings on partial-success compiles (reserved; empty in v1). */
  renderManyWarnings?: Array<{ index: number; message: string }>;
}

interface DesignWorkspaceResult {
  success?: boolean;
  action?: string;
  data?: DesignWorkspaceResultData;
  error?: string;
  status?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  output?: unknown;
  result?: unknown;
}

type ToolCallContentPartComponent = FC<{
  toolName: string;
  toolCallId?: string;
  argsText?: string;
  args?: {
    action?: string;
    prompt?: string;
    mode?: string;
    style?: string;
    editPrompt?: string;
    label?: string;
    snapshotId?: string;
    format?: string;
  };
  result?: DesignWorkspaceResult | Record<string, unknown>;
  output?: DesignWorkspaceResult | Record<string, unknown> | string;
  state?: "input-streaming" | "input-available" | "output-available" | "output-error" | "output-denied";
  errorText?: string;
}>;

function getActionIcon(action?: string) {
  switch (action) {
    case "generate":
      return Sparkles;
    case "edit":
    case "patch":
      return PenSquare;
    case "list":
      return List;
    case "status":
    case "readSource":
      return Search;
    case "open":
      return PanelRightOpen;
    case "close":
      return PanelRightClose;
    case "import":
      return Upload;
    case "port":
      return FileUp;
    // Sprint 3 W3.1 — persisted snapshot actions.
    case "snapshot.save":
      return Save;
    case "snapshot.pin":
      return Pin;
    case "snapshot.rename":
      return Tag;
    case "snapshot.list":
      return List;
    case "snapshot.delete":
      return Trash2;
    case "snapshot.diff":
      return FileDiff;
    default:
      return Sparkles;
  }
}

function getActionLabel(action?: string): string {
  switch (action) {
    case "generate":
      return "Generate design";
    case "edit":
      return "Edit design";
    case "patch":
      return "Patch design";
    case "readSource":
      return "Read source";
    case "list":
      return "List designs";
    case "status":
      return "Inspect design";
    case "open":
      return "Open design workspace";
    case "close":
      return "Close design workspace";
    case "import":
      return "Import design source";
    case "port":
      return "Port design to file";
    // Sprint 3 W3.1 — persisted snapshot actions.
    case "snapshot.save":
      return "Save design snapshot";
    case "snapshot.pin":
      return "Pin / unpin snapshot";
    case "snapshot.rename":
      return "Rename snapshot";
    case "snapshot.list":
      return "List snapshots";
    case "snapshot.delete":
      return "Delete snapshot";
    case "snapshot.diff":
      return "Diff snapshots";
    default:
      return action || "Design workspace";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractContentText(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts = content
    .filter((item): item is { type?: string; text?: string } => isRecord(item))
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text!.trim())
    .filter(Boolean);

  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join("\n");
}

function normalizeDesignWorkspaceResult(
  raw: unknown,
  depth: number = 0,
  visited: WeakSet<object> = new WeakSet<object>(),
): DesignWorkspaceResult | undefined {
  if (depth > 6 || raw == null) {
    return undefined;
  }

  if (typeof raw === "string") {
    const parsed = parseNestedJsonString(raw);
    if (parsed !== undefined && parsed !== raw) {
      return normalizeDesignWorkspaceResult(parsed, depth + 1, visited);
    }
    return {
      success: true,
      status: "success",
      data: { message: raw },
      content: raw,
    };
  }

  if (Array.isArray(raw)) {
    const contentText = extractContentText(raw);
    if (!contentText) {
      return undefined;
    }
    return normalizeDesignWorkspaceResult({ content: raw, status: "success", data: { message: contentText } }, depth + 1, visited);
  }

  if (!isRecord(raw)) {
    return undefined;
  }

  if (visited.has(raw)) {
    return undefined;
  }
  visited.add(raw);

  const direct = raw as DesignWorkspaceResult;

  if (isRecord(direct.result)) {
    const nested = normalizeDesignWorkspaceResult(direct.result, depth + 1, visited);
    if (nested) return nested;
  }
  if (isRecord(direct.output)) {
    const nested = normalizeDesignWorkspaceResult(direct.output, depth + 1, visited);
    if (nested) return nested;
  }

  const contentText = extractContentText(direct.content);
  if (contentText) {
    const parsed = parseNestedJsonString(contentText);
    if (parsed !== undefined && parsed !== contentText) {
      const nested = normalizeDesignWorkspaceResult(parsed, depth + 1, visited);
      if (nested) return nested;
    }

    if (!direct.action && !direct.data && !direct.error && direct.success === undefined) {
      return {
        success: direct.status !== "error",
        status: typeof direct.status === "string" ? direct.status : "success",
        data: { message: contentText },
        content: direct.content,
      };
    }
  }

  if (typeof direct.action === "string" || direct.success !== undefined || isRecord(direct.data) || typeof direct.error === "string") {
    const status = typeof direct.status === "string"
      ? direct.status
      : direct.success === false || typeof direct.error === "string"
        ? "error"
        : "success";

    return {
      ...direct,
      status,
      success: typeof direct.success === "boolean" ? direct.success : status !== "error",
    };
  }

  return undefined;
}

function isDesignWorkspaceResultData(value: unknown): value is DesignWorkspaceResultData {
  return isRecord(value);
}

/**
 * @internal Exported for unit testing. Production callers render it through
 * `DesignWorkspaceToolUI`; the bridge test suite drives it directly so it
 * can assert field-level forwarding without mounting the chat-provider
 * runtime (same pattern as `PortStaleDiffBanner`).
 */
export function toBridgeData(data: DesignWorkspaceResultData | undefined) {
  if (!data) {
    return undefined;
  }

  return {
    componentId: data.componentId,
    code: data.code,
    name: data.name,
    snapshotId: data.snapshotId,
    format: data.format,
    message: data.message,
    prompt: data.prompt,
    mode: data.mode,
    style: data.style,
    previewHtml: data.previewHtml,
    compileReport: data.compileReport as DesignWorkspaceCompileReport | undefined,
    postEditValidation: data.postEditValidation as DesignWorkspaceValidationResult | undefined,
    history: data.history as DesignWorkspaceHistory | undefined,
    config: data.config as DesignWorkspaceConfig | undefined,
    // Hydration hints — the bridge uses these to refetch full component data
    // from the DB when the tool stripped `code`/`previewHtml` to stay under
    // the token cap.
    truncated: data.truncated,
    hydrateRef: data.hydrateRef,
    // Preview envelope fields introduced in Sprint 1 (Rev-A2). The producer
    // always emits `previewHtmlRef` on mutating actions; `screenshot` +
    // `probes` are present on success, `screenshotError` on capture failure.
    // Forwarded through the bridge state shape so downstream UI consumers
    // (gallery preview, compile diagnostics panel, etc.) can observe them
    // without re-reading the raw tool result.
    previewHtmlRef: data.previewHtmlRef,
    screenshot: data.screenshot,
    probes: data.probes,
    // Sprint 4 W4.1 — per-state captures. Forwarded unchanged so the bridge
    // event detail carries the full union (successful captures + per-entry
    // errors); UI rendering is optional for v1.
    stateScreenshots: data.stateScreenshots,
    screenshotError: data.screenshotError,
    // Freshness marker — forwarded so the bridge's event detail carries it
    // for any downstream subscribers; the tool-UI uses it directly for
    // isLive detection when the streaming-state heuristic misses.
    generatedAt: data.generatedAt,
    // Project metadata fields — pass through so the bridge can update the store
    framework: data.framework,
    projectStructure: data.projectStructure,
    castFile: data.castFile,
    castMode: data.castMode,
    rendererInfo: data.rendererInfo,
    metadata: data.metadata,
    // Sprint 2 — import/port envelope fields. Every field is explicitly
    // typed via DesignWorkspaceResultData (above) and the bridge's
    // DesignToolEvent shape (mirrors these types). No `any` / `unknown`.
    sourcePath: data.sourcePath,
    resolvedSourcePath: data.resolvedSourcePath,
    importedAt: data.importedAt,
    // `updatedAt` is emitted by the import-response builder in
    // `lib/ai/tools/design-workspace-tool.ts` (see `handleImport`) —
    // forwarded unchanged so downstream UI can show persisted-row
    // freshness without re-reading the raw result.
    updatedAt: data.updatedAt,
    updated: data.updated,
    tags: data.tags,
    applied: data.applied,
    targetPath: data.targetPath,
    targetRelativePath: data.targetRelativePath,
    targetExistedBefore: data.targetExistedBefore,
    targetSize: data.targetSize,
    bytesWritten: data.bytesWritten,
    diff: data.diff,
    diffTruncated: data.diffTruncated,
    // `preflight` rides on every port response (dry-run, identical, and
    // TARGET_EXISTS_MUST_OVERWRITE envelopes) per the backend producer in
    // `handlePort`. It's the authoritative freshness triple the caller
    // echoes back via `expectedContentSha256` to engage the PORT_STALE_DIFF
    // guard.
    preflight: data.preflight,
    // `stalePortInfo` is emitted alongside `errorCode: "PORT_STALE_DIFF"`.
    // PortStaleDiffBanner consumes both hashes + `mtimeMs` to render a
    // human-readable diagnostic so the agent knows the apply was rejected
    // because the file changed between dry-run and apply.
    stalePortInfo: data.stalePortInfo,
    errorCode: data.errorCode,
    assetAliasError: data.assetAliasError,
    globalsCssError: data.globalsCssError,
    // Sprint 3 W3.1 — persisted design snapshot envelope fields. Forwarded
    // unchanged so the bridge event carries them for any subscriber; the
    // tool-UI consumes them directly via the `data` slot on this component.
    snapshot: data.snapshot,
    snapshots: data.snapshots,
    deleted: data.deleted,
    // Sprint 3 W3.2 — snapshot.diff envelope fields. Session-local display
    // only; no store mutation. `diff` / `diffTruncated` are already forwarded
    // above alongside the port-action fields (shared wire shape).
    a: data.a,
    b: data.b,
    sameContent: data.sameContent,
    totalLines: data.totalLines,
    missingId: data.missingId,
    // Sprint 3 W3.3 — reference-image overlay envelope fields. Forwarded
    // unchanged so downstream subscribers (chat-history preview, tool-UI)
    // observe the same success/error shape the backend emitted. The bridge
    // itself performs no store mutation for these — the overlay is baked
    // into the compiled preview HTML at generate/edit/patch time.
    referenceImage: data.referenceImage,
    referenceImageError: data.referenceImageError,
    // Sprint 3 W3.4 — renderMany grid envelope fields. Forwarded unchanged.
    // Like referenceImage, these are confirmation signals only — the grid
    // lives inside `previewHtml` / is rehydrated via `previewHtmlRef`.
    renderMany: data.renderMany,
    renderManyError: data.renderManyError,
    renderManyWarnings: data.renderManyWarnings,
  };
}

function getMissingPackages(data: DesignWorkspaceResultData | undefined): string[] | undefined {
  const missingPackages = data?.missingPackages ?? data?.compileReport?.dependencyCheck?.missingPackages;
  return Array.isArray(missingPackages) && missingPackages.length > 0 ? missingPackages : undefined;
}

function shouldShowSource(action: string | undefined, code: string | undefined): boolean {
  if (!code) {
    return false;
  }

  return action === "generate" || action === "edit" || action === "patch";
}

// ---------------------------------------------------------------------------
// Sprint 2 W2.1 / W2.2 — render subcomponents for the new import + port
// action branches. Kept in this file (no new folder, no barrel) per the
// hard constraints; `PortDryRunDiff` is factored out because it owns its own
// scrollable layout + truncation handling.
// ---------------------------------------------------------------------------

interface PortDryRunDiffProps {
  diff: string;
  diffTruncated: boolean;
  targetExistedBefore: boolean;
  targetRelativePath: string | undefined;
  targetPath: string | undefined;
}

function PortDryRunDiff({
  diff,
  diffTruncated,
  targetExistedBefore,
  targetRelativePath,
  targetPath,
}: PortDryRunDiffProps) {
  const displayPath = targetRelativePath ?? targetPath ?? "(unknown target)";
  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center gap-2 rounded bg-terminal-dark/5 px-2 py-1.5 text-xs text-terminal-dark">
        {targetExistedBefore ? (
          <>
            <FileDiff className="h-3.5 w-3.5 text-amber-600" />
            <span className="font-medium">Updating existing file</span>
          </>
        ) : (
          <>
            <FilePlus className="h-3.5 w-3.5 text-terminal-green" />
            <span className="font-medium">Creating new file</span>
          </>
        )}
        <span className="ml-1 truncate text-terminal-muted">{displayPath}</span>
      </div>
      {diff ? (
        <pre className="max-h-96 overflow-auto rounded bg-terminal-dark/5 p-2 text-[11px] leading-tight text-terminal-dark whitespace-pre [overflow-wrap:normal]">
          {diff}
        </pre>
      ) : (
        <div className="rounded bg-terminal-dark/5 p-2 text-xs text-terminal-muted">
          No diff — target matches component source.
        </div>
      )}
      {diffTruncated && (
        <div className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
          Diff was truncated for size — render the full source via readSource
          if you need the complete picture.
        </div>
      )}
    </div>
  );
}

interface ImportSuccessCardProps {
  sourcePath: string | undefined;
  name: string | undefined;
  componentId: string | undefined;
  updated: boolean | undefined;
}

function ImportSuccessCard({
  sourcePath,
  name,
  componentId,
  updated,
}: ImportSuccessCardProps) {
  return (
    <div className="mt-2 rounded bg-terminal-dark/5 p-2 text-xs text-terminal-dark">
      <div className="flex items-center gap-2">
        <Upload className="h-3.5 w-3.5 text-terminal-green" />
        <span className="font-medium">
          {updated ? "Re-imported" : "Imported"}
          {name ? <span className="ml-1 text-terminal-dark">{name}</span> : null}
        </span>
      </div>
      {sourcePath && (
        <div className="mt-1 text-terminal-muted">
          Source: <span className="text-terminal-dark">{sourcePath}</span>
        </div>
      )}
      {componentId && (
        <div className="mt-1 text-terminal-muted">
          Opened in workspace (component <span className="text-terminal-dark">{componentId}</span>).
        </div>
      )}
    </div>
  );
}

interface PortApplySuccessCardProps {
  targetRelativePath: string | undefined;
  targetPath: string | undefined;
  bytesWritten: number | undefined;
  targetExistedBefore: boolean | undefined;
}

function PortApplySuccessCard({
  targetRelativePath,
  targetPath,
  bytesWritten,
  targetExistedBefore,
}: PortApplySuccessCardProps) {
  const displayPath = targetRelativePath ?? targetPath ?? "(unknown target)";
  return (
    <div className="mt-2 rounded bg-terminal-green/10 p-2 text-xs text-terminal-dark">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-3.5 w-3.5 text-terminal-green" />
        <span className="font-medium">
          {targetExistedBefore ? "Overwrote file" : "Wrote new file"}
        </span>
      </div>
      <div className="mt-1 text-terminal-muted">
        Path: <span className="text-terminal-dark">{displayPath}</span>
      </div>
      {typeof bytesWritten === "number" && (
        <div className="mt-0.5 text-terminal-muted">
          {bytesWritten} bytes written.
        </div>
      )}
    </div>
  );
}

interface AssetAliasErrorPanelProps {
  error: NonNullable<DesignWorkspaceResultData["assetAliasError"]>;
}

function AssetAliasErrorPanel({ error }: AssetAliasErrorPanelProps) {
  // Discriminate on `code` to surface the offending alias + declared list.
  // `ASSET_ALIAS_NOT_FOUND` guarantees `alias` + `declaredAliases`; the rest
  // have them optional, hence the `?? []` / conditional renders below.
  const offendingAlias = error.alias;
  const declaredAliases =
    error.code === "ASSET_ALIAS_NOT_FOUND"
      ? error.declaredAliases
      : (error.declaredAliases ?? []);
  return (
    <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <AlertCircle className="h-3.5 w-3.5" />
        <span>Asset alias error</span>
        <span className="ml-auto rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-mono text-red-600">
          {error.code}
        </span>
      </div>
      <div className="text-red-700">{error.message}</div>
      {declaredAliases.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
          <span className="text-red-600">Declared aliases:</span>
          {declaredAliases.map((alias) => (
            <span
              key={alias}
              className={cn(
                "rounded px-1 py-0.5 font-mono",
                alias === offendingAlias
                  ? "bg-red-600 text-white"
                  : "bg-red-100 text-red-700",
              )}
            >
              @asset/{alias}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-red-600">
          No aliases declared on this call.
        </div>
      )}
      {offendingAlias && !declaredAliases.includes(offendingAlias) && (
        <div className="mt-1 text-[11px]">
          Offending alias:{" "}
          <span className="rounded bg-red-600 px-1 py-0.5 font-mono text-white">
            @asset/{offendingAlias}
          </span>
        </div>
      )}
    </div>
  );
}

interface GlobalsCssErrorPanelProps {
  error: NonNullable<DesignWorkspaceResultData["globalsCssError"]>;
}

function GlobalsCssErrorPanel({ error }: GlobalsCssErrorPanelProps) {
  return (
    <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <AlertCircle className="h-3.5 w-3.5" />
        <span>globals.css error</span>
        <span className="ml-auto rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-mono text-red-600">
          {error.code}
        </span>
      </div>
      <div className="text-red-700">{error.message}</div>
      <div className="mt-1 text-[11px] text-red-600">
        Path: <span className="font-mono text-red-700">{error.path}</span>
      </div>
      {error.code === "GLOBALS_CSS_TOO_LARGE" && (
        <div className="mt-0.5 text-[11px] text-red-600">
          {error.bytes} bytes / limit {error.limit} bytes.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sprint 3 W3.3 — reference-image overlay render cards.
//
// Both cards are pure-presentational. The success note is intentionally small
// (one-line, inline icon + truncated URL) so it doesn't dominate the tool-UI
// tree; the error panel matches the asset/globals error-card visual vocabulary
// so all structured-error rejections feel consistent. No store reads, no
// network calls. Lives here (no new folder, no barrel) per hard constraint 1.
// ---------------------------------------------------------------------------

/**
 * Truncate a URL for display. Keeps the scheme + first 32 chars + ellipsis +
 * last 16 chars so data: URIs + long CDN paths stay legible without wrapping.
 * The full URL is always available via the `title` attribute on the caller.
 */
function truncateReferenceUrl(url: string): string {
  if (url.length <= 56) return url;
  return `${url.slice(0, 32)}…${url.slice(-16)}`;
}

interface ReferenceImageSuccessNoteProps {
  referenceImage: NonNullable<DesignWorkspaceResultData["referenceImage"]>;
}

function ReferenceImageSuccessNote({ referenceImage }: ReferenceImageSuccessNoteProps) {
  return (
    <div
      className="mt-2 flex items-center gap-2 rounded bg-terminal-dark/5 px-2 py-1.5 text-xs text-terminal-dark"
      title={referenceImage.url}
    >
      <ImageIcon className="h-3.5 w-3.5 text-terminal-green" />
      <span className="font-medium">Reference overlay applied</span>
      <span className="ml-1 truncate font-mono text-[11px] text-terminal-muted">
        {truncateReferenceUrl(referenceImage.url)}
      </span>
    </div>
  );
}

interface ReferenceImageErrorPanelProps {
  error: NonNullable<DesignWorkspaceResultData["referenceImageError"]>;
}

function ReferenceImageErrorPanel({ error }: ReferenceImageErrorPanelProps) {
  return (
    <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <AlertCircle className="h-3.5 w-3.5" />
        <span>Reference image error</span>
        <span className="ml-auto rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-mono text-red-600">
          {error.code}
        </span>
      </div>
      <div className="text-red-700">{error.message}</div>
      {error.rejectedUrl && (
        <div className="mt-1 text-[11px] text-red-600">
          Rejected URL:{" "}
          <span
            className="font-mono text-red-700 [overflow-wrap:anywhere]"
            title={error.rejectedUrl}
          >
            {error.rejectedUrl}
          </span>
        </div>
      )}
      {typeof error.bytes === "number" && typeof error.limit === "number" && (
        <div className="mt-0.5 text-[11px] text-red-600">
          {error.bytes} bytes / limit {error.limit} bytes.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sprint 3 W3.4 — renderMany grid render cards.
//
// Success note is one-line ("Rendered N cells in grid"); error panel matches
// the asset/globals structured-error visual; warnings use an amber list that
// matches the PortStaleDiffBanner palette so partial-success feels consistent
// with other "work-succeeded-with-caveats" affordances.
// ---------------------------------------------------------------------------

interface RenderManySuccessNoteProps {
  renderMany: NonNullable<DesignWorkspaceResultData["renderMany"]>;
}

function RenderManySuccessNote({ renderMany }: RenderManySuccessNoteProps) {
  const { count, cellsEmitted } = renderMany;
  return (
    <div className="mt-2 flex items-center gap-2 rounded bg-terminal-dark/5 px-2 py-1.5 text-xs text-terminal-dark">
      <Grid2x2 className="h-3.5 w-3.5 text-terminal-green" />
      <span className="font-medium">
        Rendered {cellsEmitted} cell{cellsEmitted === 1 ? "" : "s"} in grid
      </span>
      {count !== cellsEmitted && (
        <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
          {cellsEmitted} of {count} emitted
        </span>
      )}
    </div>
  );
}

interface RenderManyErrorPanelProps {
  error: NonNullable<DesignWorkspaceResultData["renderManyError"]>;
}

function RenderManyErrorPanel({ error }: RenderManyErrorPanelProps) {
  return (
    <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <AlertCircle className="h-3.5 w-3.5" />
        <span>renderMany error</span>
        <span className="ml-auto rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-mono text-red-600">
          {error.code}
        </span>
      </div>
      <div className="text-red-700">{error.message}</div>
      {/* All three diagnostic fields are optional — the backend emits `count`
          + `limit` for RENDER_MANY_TOO_MANY and `index` for
          RENDER_MANY_INVALID_PROPS. Render each line only when present so
          we don't emit stray "undefined" labels. */}
      {(typeof error.count === "number" || typeof error.limit === "number") && (
        <div className="mt-1 text-[11px] text-red-600">
          {typeof error.count === "number" && (
            <>Requested: <span className="font-mono text-red-700">{error.count}</span></>
          )}
          {typeof error.count === "number" && typeof error.limit === "number" && (
            <span className="mx-1 text-red-400">/</span>
          )}
          {typeof error.limit === "number" && (
            <>Limit: <span className="font-mono text-red-700">{error.limit}</span></>
          )}
        </div>
      )}
      {typeof error.index === "number" && (
        <div className="mt-0.5 text-[11px] text-red-600">
          Offending cell index:{" "}
          <span className="font-mono text-red-700">{error.index}</span>
        </div>
      )}
    </div>
  );
}

interface RenderManyWarningsPanelProps {
  warnings: NonNullable<DesignWorkspaceResultData["renderManyWarnings"]>;
}

function RenderManyWarningsPanel({ warnings }: RenderManyWarningsPanelProps) {
  if (warnings.length === 0) return null;
  return (
    <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>
          renderMany partial warnings ({warnings.length})
        </span>
      </div>
      <ul className="mt-1 space-y-0.5 text-[11px]">
        {warnings.map((warning) => (
          <li
            key={`${warning.index}-${warning.message}`}
            className="flex items-start gap-2"
          >
            <span className="shrink-0 rounded bg-amber-100 px-1 py-0.5 font-mono text-amber-700">
              [{warning.index}]
            </span>
            <span className="text-amber-800">{warning.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sprint 4 W4.1 Rev-J3 — pseudo-state screenshots panel.
//
// M2 fix: the backend state harness persists one PNG per
// hover/focus-visible/active/disabled entry and surfaces it on
// `data.stateScreenshots`, but the tool-UI previously forwarded the payload
// through `toBridgeData` without rendering it. The user saw no end-to-end
// evidence that the CDP state capture actually produced visible artifacts.
//
// This panel renders each captured state screenshot alongside its label +
// pseudo-class and surfaces per-entry error envelopes with the same
// agent-actionable shape the backend emits. Each entry's visual matches the
// reference-image success note for consistency with the rest of the
// design-workspace tool-UI; error rows reuse the renderMany/referenceImage
// red-panel styling. No store mutations — this is pure presentational UI
// over the settled tool result.
// ---------------------------------------------------------------------------

interface StateScreenshotsPanelProps {
  stateScreenshots: NonNullable<DesignWorkspaceResultData["stateScreenshots"]>;
}

function StateScreenshotsPanel({ stateScreenshots }: StateScreenshotsPanelProps) {
  if (!stateScreenshots || stateScreenshots.length === 0) {
    return null;
  }

  const successCount = stateScreenshots.filter(
    (entry) => !("error" in entry),
  ).length;
  const errorCount = stateScreenshots.length - successCount;

  return (
    <div className="mt-2 rounded border border-terminal-dark/10 bg-terminal-dark/5 p-2 text-xs">
      <div className="mb-2 flex items-center gap-2 font-medium text-terminal-dark">
        <ImageIcon className="h-3.5 w-3.5 text-terminal-green" />
        <span>Pseudo-state captures</span>
        <span className="ml-1 rounded bg-terminal-dark/10 px-1.5 py-0.5 text-[10px] text-terminal-muted">
          {successCount} captured
          {errorCount > 0 ? ` · ${errorCount} error${errorCount === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {stateScreenshots.map((entry, idx) => {
          const key = `${entry.pseudo}-${entry.selector}-${idx}`;
          if ("error" in entry) {
            return (
              <li
                key={key}
                className="rounded border border-red-200 bg-red-50 p-2 text-red-700"
              >
                <div className="mb-1 flex items-center gap-2 font-medium">
                  <AlertCircle className="h-3.5 w-3.5" />
                  <span className="truncate" title={entry.label}>
                    {entry.label}
                  </span>
                  <span className="ml-auto rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-mono text-red-600">
                    {entry.error.code}
                  </span>
                </div>
                <div className="text-[11px] text-red-700 [overflow-wrap:anywhere]">
                  {entry.error.message}
                </div>
                <div className="mt-1 text-[11px] text-red-600">
                  <span className="font-mono">{entry.pseudo}</span>
                  {" on "}
                  <span className="font-mono [overflow-wrap:anywhere]">
                    {entry.selector || "(empty selector)"}
                  </span>
                </div>
              </li>
            );
          }
          return (
            <li
              key={key}
              className="overflow-hidden rounded border border-terminal-dark/10 bg-white"
            >
              <div className="flex items-center gap-2 border-b border-terminal-dark/10 px-2 py-1 text-[11px] text-terminal-dark">
                <span className="rounded bg-terminal-green/15 px-1.5 py-0.5 font-mono text-[10px] text-terminal-green">
                  {entry.pseudo}
                </span>
                <span className="truncate font-medium" title={entry.label}>
                  {entry.label}
                </span>
                <span
                  className="ml-auto truncate font-mono text-[10px] text-terminal-muted"
                  title={entry.selector}
                >
                  {entry.selector}
                </span>
              </div>
              {/* Using a plain <img> (not next/image) because the URL is a
                  persisted /api/media/… path produced by `saveFile`; layout
                  size follows the captured viewport so the thumbnail scales
                  to fit the card. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={entry.screenshot.url}
                alt={`${entry.pseudo} state of ${entry.selector}`}
                width={entry.screenshot.width}
                height={entry.screenshot.height}
                className="block h-auto w-full object-contain"
                loading="lazy"
              />
              <div className="border-t border-terminal-dark/10 px-2 py-1 text-[10px] font-mono text-terminal-muted">
                {entry.screenshot.width}×{entry.screenshot.height} @ {entry.screenshot.dpr}x
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface PortStaleDiffBannerProps {
  stalePortInfo: DesignWorkspaceResultData["stalePortInfo"];
}

/**
 * Trim a SHA-256 hex digest for display. Keeps the first 10 chars which is
 * enough entropy to disambiguate in practice while staying legible next to
 * the "current" / "expected" labels.
 */
function shortSha(sha: string | undefined): string {
  if (!sha || sha.length < 10) return sha ?? "(unknown)";
  return `${sha.slice(0, 10)}…`;
}

/**
 * Format a POSIX mtime (ms since epoch, possibly null) as an ISO-8601 string.
 * Null / undefined fall through as the literal string "unknown" so the row
 * stays in the rendered layout but the consumer knows the backend couldn't
 * stat() the file.
 */
function formatMtime(mtimeMs: number | null | undefined): string {
  if (mtimeMs == null) return "unknown";
  try {
    return new Date(mtimeMs).toISOString();
  } catch {
    return "unknown";
  }
}

/**
 * Exported for unit testing. Production callers render it through
 * `DesignWorkspaceToolUI`; the bridge test suite drives it directly to
 * assert the `stalePortInfo` → hashes + mtime rendering contract without
 * mounting the full tool-UI tree (which pulls the chat-provider runtime).
 */
export function PortStaleDiffBanner({ stalePortInfo }: PortStaleDiffBannerProps) {
  return (
    <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
      <div className="flex items-center gap-2 font-medium">
        <RotateCcw className="h-3.5 w-3.5" />
        <span>Target file changed since dry-run</span>
      </div>
      <div className="mt-1 text-[11px]">
        Re-run the port action with <span className="font-mono">dryRun: true</span>{" "}
        to see the new diff before applying.
      </div>
      {stalePortInfo && (
        <div className="mt-2 grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5 rounded bg-amber-100/60 p-2 text-[11px] text-amber-900">
          <span className="text-amber-700">current sha256:</span>
          <span
            className="font-mono text-amber-900"
            title={stalePortInfo.currentSha256}
          >
            {shortSha(stalePortInfo.currentSha256)}
          </span>
          <span className="text-amber-700">expected sha256:</span>
          <span
            className="font-mono text-amber-900"
            title={stalePortInfo.expectedSha256}
          >
            {shortSha(stalePortInfo.expectedSha256)}
          </span>
          <span className="text-amber-700">mtime:</span>
          <span className="font-mono text-amber-900">
            {formatMtime(stalePortInfo.mtimeMs)}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sprint 3 W3.1 — persisted design snapshot render cards.
//
// All cards are pure presentational components scoped to the tool-UI boundary
// — no store reads, no network calls. They render from the `data` slot of a
// settled tool result. Per the constraint list, these live in this file (no
// new folder, no barrel export).
// ---------------------------------------------------------------------------

type PersistedSnapshotView = NonNullable<DesignWorkspaceResultData["snapshot"]>;

function formatSnapshotTimestamp(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

interface SnapshotSaveCardProps {
  snapshot: PersistedSnapshotView;
}

function SnapshotSaveCard({ snapshot }: SnapshotSaveCardProps) {
  return (
    <div className="mt-2 rounded bg-terminal-dark/5 p-2 text-xs text-terminal-dark">
      <div className="flex items-center gap-2">
        <Save className="h-3.5 w-3.5 text-terminal-green" />
        <span className="font-medium">Snapshot saved</span>
        {snapshot.isPinned && (
          <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
            <Pin className="h-2.5 w-2.5" />
            pinned
          </span>
        )}
      </div>
      {snapshot.name && (
        <div className="mt-1 text-terminal-muted">
          Name: <span className="text-terminal-dark">{snapshot.name}</span>
        </div>
      )}
      <div className="mt-1 text-terminal-muted">
        Component: <span className="text-terminal-dark">{snapshot.componentId}</span>
      </div>
      <div className="mt-0.5 text-terminal-muted">
        Snapshot id: <span className="font-mono text-terminal-dark">{snapshot.id}</span>
      </div>
      <div className="mt-0.5 text-terminal-muted">
        Created: <span className="text-terminal-dark">{formatSnapshotTimestamp(snapshot.createdAt)}</span>
      </div>
    </div>
  );
}

interface SnapshotRowCardProps {
  snapshot: PersistedSnapshotView;
  headingIcon: typeof Pin;
  heading: string;
}

/**
 * Summary card for `snapshot.pin` and `snapshot.rename` — shows the
 * post-update row so the agent can see the new `isPinned` / `name` without
 * re-listing. Factored out because both actions render the same shape.
 */
function SnapshotRowCard({ snapshot, headingIcon: HeadingIcon, heading }: SnapshotRowCardProps) {
  return (
    <div className="mt-2 rounded bg-terminal-dark/5 p-2 text-xs text-terminal-dark">
      <div className="flex items-center gap-2">
        <HeadingIcon className="h-3.5 w-3.5 text-terminal-green" />
        <span className="font-medium">{heading}</span>
        {snapshot.isPinned ? (
          <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
            <Pin className="h-2.5 w-2.5" />
            pinned
          </span>
        ) : (
          <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-terminal-dark/10 px-1.5 py-0.5 text-[10px] text-terminal-muted">
            <PinOff className="h-2.5 w-2.5" />
            unpinned
          </span>
        )}
      </div>
      <div className="mt-1 text-terminal-muted">
        Name:{" "}
        <span className="text-terminal-dark">
          {snapshot.name ?? <span className="italic text-terminal-muted">(none)</span>}
        </span>
      </div>
      <div className="mt-0.5 text-terminal-muted">
        Snapshot id: <span className="font-mono text-terminal-dark">{snapshot.id}</span>
      </div>
      <div className="mt-0.5 text-terminal-muted">
        Updated: <span className="text-terminal-dark">{formatSnapshotTimestamp(snapshot.updatedAt)}</span>
      </div>
    </div>
  );
}

interface SnapshotListCardProps {
  snapshots: PersistedSnapshotView[];
  truncated: boolean | undefined;
}

function SnapshotListCard({ snapshots, truncated }: SnapshotListCardProps) {
  if (snapshots.length === 0) {
    return (
      <div className="mt-2 rounded bg-terminal-dark/5 p-2 text-xs text-terminal-muted">
        No snapshots saved yet for this session.
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center gap-2 rounded bg-terminal-dark/5 px-2 py-1.5 text-xs text-terminal-dark">
        <List className="h-3.5 w-3.5 text-terminal-green" />
        <span className="font-medium">
          {snapshots.length} snapshot{snapshots.length === 1 ? "" : "s"}
        </span>
        {truncated && (
          <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
            truncated
          </span>
        )}
      </div>
      <div className="max-h-72 overflow-auto rounded bg-terminal-dark/5 text-[11px] text-terminal-dark">
        <table className="w-full text-left">
          <thead className="bg-terminal-dark/5 text-terminal-muted">
            <tr>
              <th className="px-2 py-1 font-medium">Pin</th>
              <th className="px-2 py-1 font-medium">Name</th>
              <th className="px-2 py-1 font-medium">Snapshot id</th>
              <th className="px-2 py-1 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((row) => (
              <tr key={row.id} className="border-t border-terminal-dark/5">
                <td className="px-2 py-1">
                  {row.isPinned ? (
                    <Pin className="h-3 w-3 text-amber-600" />
                  ) : (
                    <PinOff className="h-3 w-3 text-terminal-muted" />
                  )}
                </td>
                <td className="px-2 py-1">
                  {row.name ?? <span className="italic text-terminal-muted">(unnamed)</span>}
                </td>
                <td className="px-2 py-1 font-mono text-terminal-muted">{row.id}</td>
                <td className="px-2 py-1 text-terminal-muted">
                  {formatSnapshotTimestamp(row.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface SnapshotDeleteCardProps {
  deleted: boolean | undefined;
  snapshotId: string | undefined;
}

function SnapshotDeleteCard({ deleted, snapshotId }: SnapshotDeleteCardProps) {
  return (
    <div className="mt-2 rounded bg-terminal-dark/5 p-2 text-xs text-terminal-dark">
      <div className="flex items-center gap-2">
        <Trash2 className="h-3.5 w-3.5 text-terminal-green" />
        <span className="font-medium">
          {deleted ? "Snapshot deleted" : "Snapshot not found"}
        </span>
      </div>
      {snapshotId && (
        <div className="mt-1 text-terminal-muted">
          Snapshot id: <span className="font-mono text-terminal-dark">{snapshotId}</span>
        </div>
      )}
      {!deleted && (
        <div className="mt-1 text-[11px] text-terminal-muted">
          No row matched the requested id in the current session — it may have
          been deleted already or belongs to another session.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sprint 3 W3.2 — snapshot.diff render panel.
//
// Pattern mirrors `PortDryRunDiff`: a header row ("Diff between A and B"),
// a `<pre>` with the unified diff (or an "identical" placeholder), and a
// truncation banner when `diffTruncated` is true. The panel is purely
// presentational — no store reads, no network calls.
// ---------------------------------------------------------------------------

type SnapshotDiffSideView = NonNullable<DesignWorkspaceResultData["a"]>;

/** Display label: the snapshot's user-provided name wins; fall back to a short id. */
function snapshotDiffLabel(side: SnapshotDiffSideView | undefined): string {
  if (!side) return "(unknown)";
  if (side.name && side.name.length > 0) return side.name;
  return side.id.slice(0, 8);
}

interface SnapshotDiffCardProps {
  a: SnapshotDiffSideView | undefined;
  b: SnapshotDiffSideView | undefined;
  diff: string | undefined;
  diffTruncated: boolean | undefined;
  sameContent: boolean | undefined;
  totalLines: number | undefined;
}

function SnapshotDiffCard({
  a,
  b,
  diff,
  diffTruncated,
  sameContent,
  totalLines,
}: SnapshotDiffCardProps) {
  const aLabel = snapshotDiffLabel(a);
  const bLabel = snapshotDiffLabel(b);
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2 rounded bg-terminal-dark/5 px-2 py-1.5 text-xs text-terminal-dark">
        <FileDiff className="h-3.5 w-3.5 text-terminal-green" />
        <span className="font-medium">
          Diff between {aLabel} and {bLabel}
        </span>
        {sameContent && (
          <span className="ml-1 rounded bg-terminal-green/10 px-1.5 py-0.5 text-[10px] text-terminal-green">
            identical
          </span>
        )}
        {typeof totalLines === "number" && !sameContent && (
          <span className="ml-1 rounded bg-terminal-dark/10 px-1.5 py-0.5 text-[10px] text-terminal-muted">
            {totalLines} line{totalLines === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {sameContent ? (
        <div className="rounded bg-terminal-dark/5 p-2 text-xs text-terminal-muted">
          Snapshots have identical source — no diff to show.
        </div>
      ) : diff ? (
        <pre className="max-h-96 overflow-auto rounded bg-terminal-dark/5 p-2 text-[11px] leading-tight text-terminal-dark whitespace-pre [overflow-wrap:normal]">
          {diff}
        </pre>
      ) : (
        <div className="rounded bg-terminal-dark/5 p-2 text-xs text-terminal-muted">
          Diff output unavailable.
        </div>
      )}
      {diffTruncated && (
        <div className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
          Diff was truncated for size — re-run with a larger{" "}
          <span className="font-mono">maxLines</span> (up to 5000) to see more.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sprint 3 Rev-G B3 — dedicated SNAPSHOT_* error panel.
//
// Addresses the block-severity frontend review finding that snapshot failures
// fell back to the generic red error banner, swallowing actionable structured
// fields (`errorCode`, `snapshotId`, `missingId`, `componentId`, and the
// `a`/`b` diff-side summaries). This panel renders whenever the current
// action is in the `snapshot.*` family AND the envelope carries a
// `SNAPSHOT_*` `errorCode`, surfacing the agent-actionable metadata inline
// instead of hiding it in `[object Object]`-style fallbacks. Presentational
// only — no store reads, no network.
// ---------------------------------------------------------------------------

type SnapshotErrorCode =
  | "SNAPSHOT_COMPONENT_NOT_FOUND"
  | "SNAPSHOT_NOT_FOUND"
  | "SNAPSHOT_NAME_TOO_LONG"
  | "SNAPSHOT_SAVE_FAILED"
  | "SNAPSHOT_PIN_FAILED"
  | "SNAPSHOT_RENAME_FAILED"
  | "SNAPSHOT_DELETE_FAILED"
  | "SNAPSHOT_DIFF_INVALID_INPUT"
  | "SNAPSHOT_DIFF_FAILED";

interface SnapshotErrorPanelProps {
  action: string;
  errorCode: SnapshotErrorCode;
  message: string | undefined;
  componentId?: string;
  snapshotId?: string;
  missingId?: string;
  a?: DesignWorkspaceResultData["a"];
  b?: DesignWorkspaceResultData["b"];
}

/** Friendly, action-oriented headline per `errorCode`. */
function snapshotErrorHeading(code: SnapshotErrorCode): string {
  switch (code) {
    case "SNAPSHOT_COMPONENT_NOT_FOUND":
      return "Component not found in this session";
    case "SNAPSHOT_NOT_FOUND":
      return "Snapshot not found";
    case "SNAPSHOT_NAME_TOO_LONG":
      return "Snapshot name too long";
    case "SNAPSHOT_SAVE_FAILED":
      return "Snapshot save failed";
    case "SNAPSHOT_PIN_FAILED":
      return "Snapshot pin failed";
    case "SNAPSHOT_RENAME_FAILED":
      return "Snapshot rename failed";
    case "SNAPSHOT_DELETE_FAILED":
      return "Snapshot delete failed";
    case "SNAPSHOT_DIFF_INVALID_INPUT":
      return "Snapshot diff input invalid";
    case "SNAPSHOT_DIFF_FAILED":
      return "Snapshot diff failed";
  }
}

export function SnapshotErrorPanel({
  action,
  errorCode,
  message,
  componentId,
  snapshotId,
  missingId,
  a,
  b,
}: SnapshotErrorPanelProps) {
  const heading = snapshotErrorHeading(errorCode);
  return (
    <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-900">
      <div className="flex items-center gap-2">
        <AlertCircle className="h-3.5 w-3.5 text-red-600" />
        <span className="font-medium">{heading}</span>
        <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-mono text-red-700">
          {errorCode}
        </span>
      </div>
      {message && (
        <div className="mt-1 text-red-800 [overflow-wrap:anywhere]">{message}</div>
      )}
      <div className="mt-1.5 space-y-0.5 text-[11px] text-red-700">
        <div>
          Action: <span className="font-mono text-red-900">{action}</span>
        </div>
        {snapshotId && (
          <div>
            Snapshot id:{" "}
            <span className="font-mono text-red-900">{snapshotId}</span>
          </div>
        )}
        {missingId && missingId !== snapshotId && (
          <div>
            Missing id:{" "}
            <span className="font-mono text-red-900">{missingId}</span>
          </div>
        )}
        {componentId && (
          <div>
            Component id:{" "}
            <span className="font-mono text-red-900">{componentId}</span>
          </div>
        )}
        {a?.id && (
          <div>
            A:{" "}
            <span className="font-mono text-red-900">
              {a.id}
              {a.name ? ` (${a.name})` : ""}
            </span>
          </div>
        )}
        {b?.id && (
          <div>
            B:{" "}
            <span className="font-mono text-red-900">
              {b.id}
              {b.name ? ` (${b.name})` : ""}
            </span>
          </div>
        )}
      </div>
      {errorCode === "SNAPSHOT_COMPONENT_NOT_FOUND" && (
        <div className="mt-1.5 text-[11px] text-red-700">
          The referenced component isn't in the current session's workspace —
          re-check <span className="font-mono">componentId</span> or re-open
          the workspace before retrying.
        </div>
      )}
      {errorCode === "SNAPSHOT_NOT_FOUND" && (
        <div className="mt-1.5 text-[11px] text-red-700">
          No row matched this id in the current session — it may have been
          deleted, belong to another session, or been typed with a stale id.
          Call <span className="font-mono">snapshot.list</span> to see the
          current roster.
        </div>
      )}
      {errorCode === "SNAPSHOT_NAME_TOO_LONG" && (
        <div className="mt-1.5 text-[11px] text-red-700">
          Shorten the <span className="font-mono">name</span> argument and
          retry — the server enforces the cap to keep history panels
          readable.
        </div>
      )}
      {errorCode === "SNAPSHOT_DIFF_INVALID_INPUT" && (
        <div className="mt-1.5 text-[11px] text-red-700">
          Provide two snapshot ids via <span className="font-mono">aId</span>{" "}
          and <span className="font-mono">bId</span>, or one id plus{" "}
          <span className="font-mono">compareAgainst: &quot;current&quot;</span>.
        </div>
      )}
    </div>
  );
}

/** Type guard: narrows an arbitrary `errorCode` string to the SNAPSHOT_* subset. */
export function isSnapshotErrorCode(code: string | undefined): code is SnapshotErrorCode {
  return (
    code === "SNAPSHOT_COMPONENT_NOT_FOUND" ||
    code === "SNAPSHOT_NOT_FOUND" ||
    code === "SNAPSHOT_NAME_TOO_LONG" ||
    code === "SNAPSHOT_SAVE_FAILED" ||
    code === "SNAPSHOT_PIN_FAILED" ||
    code === "SNAPSHOT_RENAME_FAILED" ||
    code === "SNAPSHOT_DELETE_FAILED" ||
    code === "SNAPSHOT_DIFF_INVALID_INPUT" ||
    code === "SNAPSHOT_DIFF_FAILED"
  );
}

export const DesignWorkspaceToolUI: ToolCallContentPartComponent = memo(({
  args,
  result,
  output,
  state,
  errorText,
  toolCallId,
}) => {
  const resolvedResult = useMemo(
    () => normalizeDesignWorkspaceResult(result ?? output),
    [output, result],
  );
  const action = args?.action || resolvedResult?.action;
  const isRunning = !resolvedResult && !errorText && !state?.startsWith("output");
  const success = resolvedResult?.success === true;
  const error = errorText || (resolvedResult?.success === false ? resolvedResult.error : null);
  const Icon = getActionIcon(action);
  const dispatchedRef = useRef<string | null>(null);
  const sessionId = useChatSessionId();

  // `sawLiveStateRef` flips to true when we have direct evidence that this
  // tool call is executing NOW in the current browser session (vs. replayed
  // from persisted chat history). We flip on three signals, any of which
  // alone is sufficient:
  //
  //  1. We observed `state === "input-streaming" | "input-available"` — the
  //     assistant-ui runtime explicitly told us the tool is streaming.
  //  2. We observed `resolvedResult === undefined` on any render — the
  //     tool-UI instance existed before the result arrived, so we watched
  //     the transition. This is the most reliable signal because chat-
  //     history replays always mount with `resolvedResult` already present.
  //
  // Previously we only relied on signal (1), which missed the case where
  // the SDK delivers the final `output-available` state in a single render
  // commit (fast backend, batched state updates). In that case the streaming
  // states are never observed via useEffect, `isLive` stayed false, and the
  // bridge treated a fresh generation as a replay — leaving the design
  // workspace inert. Signal (2) closes that gap.
  const sawLiveStateRef = useRef(false);
  if (!resolvedResult) {
    // Ref writes during render are safe (they don't trigger re-render) and
    // let the dispatch effect — which reads this ref after commit — see
    // the correct value even if the tool completes between the first render
    // and the first effect flush.
    sawLiveStateRef.current = true;
  }
  useEffect(() => {
    if (state === "input-streaming" || state === "input-available") {
      sawLiveStateRef.current = true;
    }
  }, [state]);

  useEffect(() => {
    if (!resolvedResult || !action) return;
    const baseKey = toolCallId
      ?? `${action}:${resolvedResult.data?.componentId || ""}:${resolvedResult.data?.snapshotId || ""}`;
    const key = sessionId ? `${sessionId}:${baseKey}` : baseKey;
    if (dispatchedRef.current === key) return;
    dispatchedRef.current = key;

    // Freshness fallback: for SSR-hydrated messages or same-render completion
    // paths where neither streaming state nor pre-result was observed, the
    // server-stamped `generatedAt` tells us this result was produced within
    // the last few seconds and should be treated as live. The window is
    // intentionally generous (2 minutes) to cover slow clients and
    // F5-right-after-generate flows; beyond that, treat as replay.
    const rawData = isDesignWorkspaceResultData(resolvedResult.data) ? resolvedResult.data : undefined;
    const generatedAt = typeof rawData?.generatedAt === "number" ? rawData.generatedAt : undefined;
    const freshByTimestamp =
      generatedAt !== undefined && Date.now() - generatedAt < 2 * 60_000;
    const isLive = sawLiveStateRef.current || freshByTimestamp;

    const detail = {
      action,
      success: Boolean(resolvedResult.success),
      sessionId: sessionId ?? undefined,
      isLive,
      data: toBridgeData(rawData),
      error: resolvedResult.error,
    };
    dispatchDesignToolResult(detail);
  }, [action, resolvedResult, sessionId, toolCallId]);

  const data = isDesignWorkspaceResultData(resolvedResult?.data) ? resolvedResult.data : undefined;
  const validation = data?.postEditValidation;
  const compileReport = data?.compileReport;
  const history = data?.history;
  const missingPackages = getMissingPackages(data);
  const showSource = shouldShowSource(action, data?.code);

  // Rev-G B2 — suppress the generic red error banner when a richer
  // structured panel will render below. The structured panels
  // (SnapshotErrorPanel, AssetAliasErrorPanel, GlobalsCssErrorPanel)
  // already echo the human-readable message alongside agent-actionable
  // metadata, so rendering the generic banner too just duplicates the
  // string and buries the structured fields under a wall of red text
  // (the block-severity frontend review finding was specifically that
  // snapshot failures "still fall back to the generic red error banner").
  // Keep the banner for every other failure mode so we don't regress the
  // existing behavior for errors without a dedicated panel.
  const willRenderSnapshotErrorPanel =
    typeof action === "string"
    && action.startsWith("snapshot.")
    && !success
    && isSnapshotErrorCode(data?.errorCode);
  const willRenderAssetAliasPanel = !!data?.assetAliasError;
  const willRenderGlobalsCssPanel = !!data?.globalsCssError;
  const suppressGenericErrorBanner =
    willRenderSnapshotErrorPanel
    || willRenderAssetAliasPanel
    || willRenderGlobalsCssPanel;

  return (
    <div
      className={cn(
        "my-2 rounded-lg p-3 font-mono shadow-sm transition-all duration-150",
        "bg-terminal-cream/80",
        isRunning && "animate-pulse",
      )}
    >
      <div className="mb-1 flex items-center gap-2">
        <div className={cn(
          "flex h-8 w-8 items-center justify-center rounded-lg",
          isRunning ? "bg-terminal-green/10 text-terminal-green" : error ? "bg-red-50 text-red-600" : "bg-terminal-green/10 text-terminal-green",
        )}>
          {isRunning ? <Icon className="h-4 w-4 animate-pulse" /> : success ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
        </div>
        <span className="text-sm font-medium text-terminal-dark">{getActionLabel(action)}</span>
        <span className={cn(
          "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium",
          isRunning ? "bg-terminal-green/10 text-terminal-green" : error ? "bg-red-50 text-red-600" : "bg-terminal-green/10 text-terminal-green",
        )}>
          {isRunning ? "running" : error ? "failed" : "done"}
        </span>
      </div>

      <div className="ml-10 break-words text-xs text-terminal-muted [overflow-wrap:anywhere]">
        {isRunning
          ? "Running..."
          : error
            ? /* When a structured error panel will render below, point the
                 reader at it instead of saying "Completed" (which contradicts
                 the "failed" badge). When no panel will render, surface the
                 backend message or raw error string inline. */
              suppressGenericErrorBanner
              ? data?.message || "See details below"
              : data?.message || error
            : data?.message || "Completed"}
      </div>

      {error && !suppressGenericErrorBanner && (
        <div className="mt-2 rounded bg-red-50 p-2 text-xs font-mono text-red-600">
          {error}
        </div>
      )}

      {missingPackages && (
        <div className="mt-2 rounded bg-red-50 p-2 text-xs font-mono text-red-600">
          Missing packages: {missingPackages.join(", ")}
        </div>
      )}

      {compileReport?.errors && compileReport.errors.length > 0 && (
        <details className="mt-2 text-xs text-terminal-muted">
          <summary className="cursor-pointer hover:text-terminal-dark">Compilation details</summary>
          <div className="mt-1 space-y-1 rounded bg-terminal-dark/5 p-2 text-terminal-dark">
            {compileReport.errors.map((issue, index) => (
              <div key={`${issue.message || "issue"}-${index}`}>
                <div>{issue.message}</div>
                {issue.suggestion ? <div className="text-terminal-muted">{issue.suggestion}</div> : null}
              </div>
            ))}
          </div>
        </details>
      )}

      {validation && (
        <details className="mt-2 text-xs text-terminal-muted">
          <summary className="cursor-pointer hover:text-terminal-dark">
            Post-edit checks ({validation.passed ? "passed" : "issues found"})
          </summary>
          <div className="mt-1 space-y-1 rounded bg-terminal-dark/5 p-2 text-terminal-dark">
            {(validation.checks ?? []).map((check, index) => (
              <div key={`${check.name}-${index}`} className="flex items-start gap-2">
                <span className={cn(
                  "mt-0.5 inline-block h-2 w-2 rounded-full",
                  check.status === "pass" ? "bg-terminal-green" : check.status === "fail" ? "bg-red-500" : "bg-terminal-muted",
                )} />
                <div>
                  <div>{check.name}</div>
                  {check.message ? <div className="text-terminal-muted">{check.message}</div> : null}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {history?.actions && history.actions.length > 0 && action === "close" && (
        <details className="mt-2 text-xs text-terminal-muted">
          <summary className="cursor-pointer hover:text-terminal-dark">
            Workspace history ({history.actions.length} actions)
          </summary>
          <div className="mt-1 space-y-1 rounded bg-terminal-dark/5 p-2 text-terminal-dark">
            {history.actions.map((record, index) => (
              <div key={`${record.seq ?? index}-${record.action ?? "action"}`} className="flex items-center gap-2">
                <span className={cn(
                  "inline-block h-2 w-2 rounded-full",
                  record.success ? "bg-terminal-green" : "bg-red-500",
                )} />
                <span>{record.action ?? "action"}</span>
                {typeof record.durationMs === "number" ? <span className="text-terminal-muted">{record.durationMs}ms</span> : null}
                {record.error ? <span className="text-red-600">{record.error}</span> : null}
              </div>
            ))}
          </div>
        </details>
      )}

      {showSource && data?.code && (
        <details className="mt-2 text-xs text-terminal-muted">
          <summary className="cursor-pointer hover:text-terminal-dark">Source</summary>
          <pre className="mt-1 max-h-96 overflow-auto rounded bg-terminal-dark/5 p-2 text-terminal-dark whitespace-pre-wrap [overflow-wrap:anywhere]">
            {data.code}
          </pre>
        </details>
      )}

      {/* Sprint 2 W2.1 — successful import: show source + imported-component card. */}
      {action === "import" && success && data?.componentId && (
        <ImportSuccessCard
          sourcePath={data.sourcePath}
          name={data.name}
          componentId={data.componentId}
          updated={data.updated}
        />
      )}

      {/* Sprint 2 W2.2 — port dry-run: render the unified diff + file-state indicator. */}
      {action === "port" && success && data?.applied === false && (
        <PortDryRunDiff
          diff={data.diff ?? ""}
          diffTruncated={data.diffTruncated === true}
          targetExistedBefore={data.targetExistedBefore === true}
          targetRelativePath={data.targetRelativePath}
          targetPath={data.targetPath}
        />
      )}

      {/* Sprint 2 W2.2 — port apply success: confirmation card. */}
      {action === "port" && success && data?.applied === true && (
        <PortApplySuccessCard
          targetRelativePath={data.targetRelativePath}
          targetPath={data.targetPath}
          bytesWritten={data.bytesWritten}
          targetExistedBefore={data.targetExistedBefore}
        />
      )}

      {/* Sprint 2 W2.2 — PORT_STALE_DIFF: dedicated re-run-dry-run banner. */}
      {action === "port" && data?.errorCode === "PORT_STALE_DIFF" && (
        <PortStaleDiffBanner stalePortInfo={data.stalePortInfo} />
      )}

      {/* Sprint 2 W2.3 — structured asset-alias error panel. */}
      {data?.assetAliasError && (
        <AssetAliasErrorPanel error={data.assetAliasError} />
      )}

      {/* Sprint 2 W2.4 — structured globals.css error panel. */}
      {data?.globalsCssError && (
        <GlobalsCssErrorPanel error={data.globalsCssError} />
      )}

      {/* Sprint 3 W3.3 — reference-image overlay cards. Success note is
          one-line; error panel is structured. Mutually exclusive at the
          backend boundary (a given tool result is either a success with
          `referenceImage` OR a failure with `referenceImageError`). */}
      {data?.referenceImage && (
        <ReferenceImageSuccessNote referenceImage={data.referenceImage} />
      )}
      {data?.referenceImageError && (
        <ReferenceImageErrorPanel error={data.referenceImageError} />
      )}

      {/* Sprint 3 W3.4 — renderMany grid cards. Success is a one-liner, error
          is a structured card, and warnings are an amber list shown only when
          the array is non-empty. Success + warnings CAN co-occur (partial
          success), but success + error cannot (mutually exclusive). */}
      {data?.renderMany && (
        <RenderManySuccessNote renderMany={data.renderMany} />
      )}
      {data?.renderManyError && (
        <RenderManyErrorPanel error={data.renderManyError} />
      )}
      {data?.renderManyWarnings && data.renderManyWarnings.length > 0 && (
        <RenderManyWarningsPanel warnings={data.renderManyWarnings} />
      )}

      {/* Sprint 4 W4.1 Rev-J3 — pseudo-state captures panel (M2 fix).
          Renders hover/focus-visible/active/disabled screenshots with their
          labels so the user sees end-to-end proof of the CDP state harness
          instead of the capture being forwarded through the bridge as dead
          data. Successful captures and per-entry error envelopes are
          rendered in the same grid; the panel is hidden entirely when the
          array is missing or empty. */}
      {Array.isArray(data?.stateScreenshots) && data.stateScreenshots.length > 0 && (
        <StateScreenshotsPanel stateScreenshots={data.stateScreenshots} />
      )}

      {/* Sprint 3 W3.1 — persisted design snapshot cards. */}
      {action === "snapshot.save" && success && data?.snapshot && (
        <SnapshotSaveCard snapshot={data.snapshot} />
      )}
      {action === "snapshot.pin" && success && data?.snapshot && (
        <SnapshotRowCard
          snapshot={data.snapshot}
          headingIcon={data.snapshot.isPinned ? Pin : PinOff}
          heading={data.snapshot.isPinned ? "Snapshot pinned" : "Snapshot unpinned"}
        />
      )}
      {action === "snapshot.rename" && success && data?.snapshot && (
        <SnapshotRowCard
          snapshot={data.snapshot}
          headingIcon={Tag}
          heading="Snapshot renamed"
        />
      )}
      {action === "snapshot.list" && success && Array.isArray(data?.snapshots) && (
        <SnapshotListCard snapshots={data.snapshots} truncated={data.truncated} />
      )}
      {action === "snapshot.delete" && success && (
        <SnapshotDeleteCard deleted={data?.deleted} snapshotId={data?.snapshotId} />
      )}
      {/* Sprint 3 W3.2 — snapshot.diff result panel. */}
      {action === "snapshot.diff" && success && (
        <SnapshotDiffCard
          a={data?.a}
          b={data?.b}
          diff={data?.diff}
          diffTruncated={data?.diffTruncated}
          sameContent={data?.sameContent}
          totalLines={data?.totalLines}
        />
      )}

      {/* Sprint 3 Rev-G B3 — dedicated SNAPSHOT_* error panel.
          Surfaces the structured failure envelope (errorCode, snapshotId,
          missingId, componentId, a/b) inline so the agent and the user
          both see actionable metadata instead of the generic red banner
          fallback. Gated on `action` so we never collide with the
          port/import/reference-image/renderMany panels. */}
      {typeof action === "string"
        && action.startsWith("snapshot.")
        && !success
        && isSnapshotErrorCode(data?.errorCode) && (
          <SnapshotErrorPanel
            action={action}
            errorCode={data!.errorCode as SnapshotErrorCode}
            message={resolvedResult?.error ?? data?.message}
            componentId={data?.componentId}
            snapshotId={data?.snapshotId}
            missingId={data?.missingId}
            a={data?.a}
            b={data?.b}
          />
        )}

      {args?.prompt && (
        <div className="mt-3 rounded-md bg-terminal-dark/5 px-3 py-2 text-xs text-terminal-muted">
          Prompt: <span className="text-terminal-dark">{args.prompt}</span>
        </div>
      )}

      {data?.name && data?.componentId && (
        <div className="mt-3 text-xs text-terminal-muted">
          Component: <span className="text-terminal-dark">{data.name}</span>
        </div>
      )}
    </div>
  );
});

DesignWorkspaceToolUI.displayName = "DesignWorkspaceToolUI";

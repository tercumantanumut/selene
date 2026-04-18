/**
 * Design Workspace Tool
 *
 * Minimal iteration-first control surface for the design workspace.
 * The durable source of truth is persisted design source code plus preview,
 * not transient server cache state.
 */

import { tool, jsonSchema } from "ai";
import { withToolLogging } from "@/lib/ai/tool-registry/logging";
import { loadSettings } from "@/lib/settings/settings-manager";
import { generateCard, editCard } from "../../design";
import type { AssetContext } from "../../design/types";
import {
  detectAvailableLibraries,
  getAvailableLibrariesPrompt,
  type DesignLibrary,
} from "../../design/libraries";
import {
  buildDesignPreviewErrorHtml,
} from "../../design/workspace/preview";
import {
  buildTailwindPreviewWithMetadata,
  isDesignWorkspaceCompileError,
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
import { updateDesignComponent } from "../../design/gallery/queries";
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

interface DesignWorkspaceToolOptions {
  sessionId?: string;
  userId?: string;
  characterId?: string;
  /** Inspect context from the user's message, when available. */
  inspectContext?: InspectMessageContext | null;
}

interface DesignWorkspaceInput {
  action: "open" | "generate" | "edit" | "patch" | "readSource" | "list" | "status" | "close" | "install";

  /** npm package names to install. Required for "install" action. */
  packages?: string[];

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

async function compilePreviewForTool(
  code: string,
  componentName: string,
  source: string,
): Promise<CompiledPreviewSuccess | CompiledPreviewFailure> {
  try {
    const { html, report } = await buildTailwindPreviewWithMetadata(code, componentName, {
      autoInstallMissingDependencies: true,
      source,
    });

    return {
      ok: true,
      previewHtml: html,
      compileReport: report,
    };
  } catch (error) {
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
): DesignWorkspaceResult {
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
    },
  };
}

function buildMissingComponentError(componentId: string, action: "edit" | "patch" | "readSource" | "status"): string {
  return `Design "${componentId}" is not available for ${action}. Run action "list" to discover persisted designs for this session, or pass the latest source with "activeComponentCode".`;
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

function stripHeavyFields(result: DesignWorkspaceResult): DesignWorkspaceResult {
  if (!result.data) {
    return result;
  }

  const HEAVY_THRESHOLD = 5_000;
  const { previewHtml, renderedHtml: _renderedHtml, ...lightData } = result.data as DesignWorkspaceResultData & {
    renderedHtml?: string;
  };

  const keep: Record<string, unknown> = {};
  if (previewHtml && previewHtml.length < HEAVY_THRESHOLD) {
    keep.previewHtml = previewHtml;
  }

  return { ...result, data: { ...lightData, ...keep } };
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
    default:
      result = { success: false, action: String(input.action), error: `Unknown action: ${input.action}` };
  }

  return stripHeavyFields(result);
}

export function createDesignWorkspaceTool(options: DesignWorkspaceToolOptions = {}) {
  const executeWithLogging = withToolLogging(
    "designWorkspace",
    options.sessionId,
    async (input: DesignWorkspaceInput) => executeDesignWorkspace(options, input),
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
- "close": Close the design workspace panel.`,
    inputSchema: jsonSchema<DesignWorkspaceInput>({
      type: "object",
      title: "DesignWorkspaceInput",
      description: "Input for design workspace operations",
      properties: {
        action: {
          type: "string",
          enum: ["open", "generate", "edit", "patch", "readSource", "list", "status", "close", "install"],
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
      },
      required: ["action"],
      additionalProperties: false,
    }),
    execute: executeWithLogging,
  });
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

  const previewResult = await compilePreviewForTool(finalCode, persisted.name, "design-workspace-generate");
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
    return buildCompileFailureResult("generate", baseData, previewResult);
  }

  recordHistory(sessionId, "generate", startedAt, true, {
    componentId: persisted.id,
    metadata: {
      recovered: previewResult.compileReport.recovered,
    },
  });

  return {
    success: true,
    action: "generate",
    data: {
      ...baseData,
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

  const previewResult = await compilePreviewForTool(finalCode.trim(), persisted.name, "design-workspace-edit");
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
    }, previewResult);
  }

  const validationMessage = buildValidationMessage(validation);
  recordHistory(sessionId, "edit", startedAt, true, {
    componentId: persisted.id,
    validation,
  });

  return {
    success: true,
    action: "edit",
    data: {
      ...baseData,
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
    },
  };
}

// findUnclosedJsxTag is now imported from ../../design/workspace/patch-logic
// Re-export for backwards compatibility with any external consumers
export { findUnclosedJsxTag } from "../../design/workspace/patch-logic";

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

  const previewResult = await compilePreviewForTool(patchedCode, persisted.name, "design-workspace-patch");
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
    }, previewResult);
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

  return {
    success: true,
    action: "patch",
    data: {
      ...baseData,
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

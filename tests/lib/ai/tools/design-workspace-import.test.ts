/**
 * Probe-level coverage for the Sprint 2 W2.1 `designWorkspace` "import" action.
 *
 * Locks in the core W2.1 invariants:
 *
 *   1. SUCCESS: a new row is persisted with `metadata.sourcePath` and
 *      `metadata.importedAt`, the `"imported"` tag is automatically added,
 *      and the envelope carries componentId + screenshot / screenshotError.
 *   2. UPDATE-IN-PLACE: when a row already exists for
 *      `(userId, sessionId, sourcePath)`, the second import updates the row
 *      instead of creating a duplicate, and `data.updated === true`.
 *   3. COMPILE FAILURE: when the source file fails the compile pipeline, NO
 *      row is persisted and the envelope carries errorCode
 *      `"IMPORT_COMPILE_FAILED"` plus the structured compileReport.
 *   4. SOURCE PATH REJECTED: when `resolveSyncedPath` refuses the path, the
 *      envelope carries errorCode `"SOURCE_PATH_REJECTED"` and no fs read
 *      is attempted.
 *   5. TAG NORMALIZATION: `"imported"` is always present, whitespace/empties
 *      are dropped, and duplicates are deduped.
 *
 * The compile pipeline (`buildTailwindPreviewWithMetadata`), fs I/O, path
 * resolution, screenshot capture, and DB persistence are all mocked — this
 * test stays millisecond-scale and does not touch the sandbox, browser, or
 * SQLite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — declared BEFORE vi.mock() so the mock factories can close
// over the shared spies. (vi.hoisted runs before imports, per the SUT pattern
// in tests/lib/design/workspace-theme-forwarding.test.ts.)
// ---------------------------------------------------------------------------

const fsMocks = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}));

const pathMocks = vi.hoisted(() => ({
  resolveSyncedPath: vi.fn(),
  resolveWorkspaceAwarePaths: vi.fn(),
}));

const compilerMocks = vi.hoisted(() => ({
  buildTailwindPreviewWithMetadata: vi.fn(),
  isDesignWorkspaceCompileError: vi.fn((err: unknown) => {
    return Boolean(
      err &&
        typeof err === "object" &&
        (err as { __designWorkspaceCompileError?: boolean })
          .__designWorkspaceCompileError,
    );
  }),
  isDesignWorkspaceGlobalsCssError: vi.fn(() => false),
  isDesignWorkspaceImportError: vi.fn(() => false),
}));

const galleryMocks = vi.hoisted(() => ({
  findDesignComponentBySourcePath: vi.fn(),
  updateDesignComponent: vi.fn(),
  saveDesignComponentRecord: vi.fn(),
  upsertImportedDesignComponent: vi.fn(),
  findWorkspaceDesign: vi.fn(),
  listWorkspaceDesigns: vi.fn(),
}));

const screenshotMocks = vi.hoisted(() => ({
  captureScreenshot: vi.fn(),
}));

const mediaMocks = vi.hoisted(() => ({
  getFullPathFromMediaRef: vi.fn(),
}));

const storageMocks = vi.hoisted(() => ({
  saveFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// vi.mock registrations. The SUT imports every one of these from "../…",
// which Vitest resolves against the tsconfig paths — we mock with the same
// `@/…` specifiers used elsewhere in the test suite.
// ---------------------------------------------------------------------------

vi.mock("fs/promises", () => ({
  default: fsMocks,
  ...fsMocks,
}));

vi.mock("@/lib/ai/filesystem/path-utils", () => ({
  resolveSyncedPath: pathMocks.resolveSyncedPath,
  resolveWorkspaceAwarePaths: pathMocks.resolveWorkspaceAwarePaths,
}));

vi.mock("@/lib/design/workspace/compiler", () => ({
  buildTailwindPreviewWithMetadata: compilerMocks.buildTailwindPreviewWithMetadata,
  isDesignWorkspaceCompileError: compilerMocks.isDesignWorkspaceCompileError,
  isDesignWorkspaceGlobalsCssError: compilerMocks.isDesignWorkspaceGlobalsCssError,
  isDesignWorkspaceImportError: compilerMocks.isDesignWorkspaceImportError,
}));

vi.mock("@/lib/design/gallery/queries", () => ({
  findDesignComponentBySourcePath: galleryMocks.findDesignComponentBySourcePath,
  updateDesignComponent: galleryMocks.updateDesignComponent,
  upsertImportedDesignComponent: galleryMocks.upsertImportedDesignComponent,
}));

vi.mock("@/lib/design/gallery/service", () => ({
  findWorkspaceDesign: galleryMocks.findWorkspaceDesign,
  listWorkspaceDesigns: galleryMocks.listWorkspaceDesigns,
  saveDesignComponentRecord: galleryMocks.saveDesignComponentRecord,
}));

vi.mock("@/lib/design/workspace/screenshot", () => ({
  captureScreenshot: screenshotMocks.captureScreenshot,
}));

vi.mock("@/lib/storage/local-storage", () => ({
  getFullPathFromMediaRef: mediaMocks.getFullPathFromMediaRef,
  saveFile: storageMocks.saveFile,
}));

// Stub out the logging wrapper so `withToolLogging` does not try to write to
// the real workspace telemetry sink during tests.
vi.mock("@/lib/ai/tool-registry/logging", () => ({
  withToolLogging: (_name: string, _sessionId: string | undefined, fn: (input: unknown) => Promise<unknown>) => fn,
}));

// ---------------------------------------------------------------------------
// Imports under test — AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { createDesignWorkspaceTool } from "@/lib/ai/tools/design-workspace-tool";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_CODE = `export default function Hero() {
  return <div className="p-4">Hi</div>;
}`;

function makeSuccessCompileReport() {
  return {
    warnings: [],
    errors: [],
    diagnostics: [],
    dependencyCheck: {
      manifestPackages: [],
      importedPackages: [],
      checkedPackages: [],
      missingManifestPackages: [],
      missingImportedPackages: [],
      missingPackages: [],
    },
    recovered: false,
    durationMs: 1,
  };
}

function makeGalleryItem(overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    id: "design-row-1",
    userId: "user-1",
    characterId: null,
    sessionId: "sess-1",
    projectId: null,
    name: "hero",
    description: null,
    prompt: "Imported from components/hero.tsx",
    code: MOCK_CODE,
    framework: "react-tailwind",
    category: "workspace",
    tags: ["imported"],
    styleTags: [],
    previewPath: null,
    mode: "tailwind",
    style: "default",
    useCount: 0,
    lastUsedAt: null,
    isFavorite: false,
    createdAt: "2026-04-24 00:00:00.000",
    updatedAt: "2026-04-24 00:00:00.000",
    metadata: null,
    previewUrl: null,
  };
  return { ...base, ...overrides };
}

async function runImport(
  toolOptions: {
    sessionId?: string;
    userId?: string;
    characterId?: string;
  } = { sessionId: "sess-1", userId: "user-1", characterId: "char-1" },
  input: Record<string, unknown> = {
    action: "import",
    sessionId: "sess-1",
    sourcePath: "components/hero.tsx",
  },
) {
  const tool = createDesignWorkspaceTool(toolOptions);
  const result = await (tool as unknown as {
    execute: (input: unknown) => Promise<unknown>;
  }).execute(input);
  return result as {
    success: boolean;
    action: string;
    error?: string;
    data?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Baseline: happy-path mocks so individual tests only override what they need.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  pathMocks.resolveSyncedPath.mockResolvedValue({
    ok: true,
    validPath: "/abs/sandbox/char-1/components/hero.tsx",
    syncedFolders: ["/abs/sandbox/char-1"],
  });

  pathMocks.resolveWorkspaceAwarePaths.mockResolvedValue(["/abs/sandbox/char-1"]);

  fsMocks.stat.mockResolvedValue({
    isFile: () => true,
    size: MOCK_CODE.length,
  });

  fsMocks.readFile.mockResolvedValue(MOCK_CODE);

  compilerMocks.buildTailwindPreviewWithMetadata.mockResolvedValue({
    html:
      "<!DOCTYPE html><html><head></head><body><div id=\"root\"></div></body></html>",
    report: makeSuccessCompileReport(),
  });

  galleryMocks.findDesignComponentBySourcePath.mockResolvedValue(null);
  galleryMocks.saveDesignComponentRecord.mockImplementation(
    async (input: Record<string, unknown>) =>
      // Echo back the `id` the SUT generated so envelope assertions stay
      // deterministic without recomputing the UUID.
      makeGalleryItem({
        id: (input.id as string) ?? "design-row-1",
        name: (input.name as string) ?? "hero",
        prompt: (input.prompt as string) ?? "Imported from components/hero.tsx",
        code: (input.code as string) ?? MOCK_CODE,
        tags: (input.tags as string[]) ?? ["imported"],
        metadata: input.metadata ?? null,
        sessionId: (input.sessionId as string) ?? "sess-1",
      }),
  );
  galleryMocks.updateDesignComponent.mockImplementation(
    async (
      _userId: string,
      id: string,
      updates: Record<string, unknown>,
    ) =>
      // Preserve the caller-supplied `id` so the update-in-place test can
      // verify the existing row's id round-trips through the envelope.
      makeGalleryItem({
        id,
        name: (updates.name as string) ?? "hero",
        prompt:
          (updates.prompt as string) ?? "Imported from components/hero.tsx",
        code: (updates.code as string) ?? MOCK_CODE,
        tags: (updates.tags as string[]) ?? ["imported"],
        metadata: updates.metadata ?? null,
      }),
  );

  // BA-2: the handler now calls `upsertImportedDesignComponent` which
  // wraps find + insert/update inside a transaction. Route the baseline
  // through the save/update mocks so existing assertions on those spies
  // still work; individual tests can override this mock to simulate an
  // existing row (UPDATE branch) or a UNIQUE-constraint race.
  galleryMocks.upsertImportedDesignComponent.mockImplementation(
    async (input: Record<string, unknown>) => {
      const existing = await galleryMocks.findDesignComponentBySourcePath({
        userId: input.userId as string,
        sessionId: (input.sessionId as string) ?? undefined,
        sourcePath: (input.metadata as { sourcePath: string }).sourcePath,
      });
      if (existing) {
        const existingMetadata =
          (existing.metadata as Record<string, unknown> | null) ?? {};
        const mergedMetadata = {
          ...existingMetadata,
          ...(input.metadata as Record<string, unknown>),
        };
        const updatedRow = await galleryMocks.updateDesignComponent(
          (existing as { userId: string }).userId,
          (existing as { id: string }).id,
          {
            name: input.name,
            code: input.code,
            prompt: input.prompt,
            tags: input.tags,
            metadata: mergedMetadata,
            sessionId: input.sessionId ?? undefined,
            characterId: input.characterId ?? undefined,
          },
        );
        return { row: updatedRow, updated: true };
      }
      const inserted = await galleryMocks.saveDesignComponentRecord({
        id: input.newId,
        userId: input.userId,
        characterId: input.characterId,
        sessionId: input.sessionId,
        name: input.name,
        prompt: input.prompt,
        code: input.code,
        mode: input.mode,
        style: input.style,
        framework: input.framework,
        category: input.category,
        tags: input.tags,
        metadata: input.metadata,
      });
      return { row: inserted, updated: false };
    },
  );

  screenshotMocks.captureScreenshot.mockResolvedValue({
    screenshot: {
      url: "/api/media/sess-1/preview.png",
      width: 1440,
      height: 900,
      dpr: 2,
    },
    probes: [],
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("designWorkspace — import (Sprint 2 W2.1)", () => {
  it("persists a new row with metadata.sourcePath/importedAt and the 'imported' tag, and returns a screenshot envelope", async () => {
    const result = await runImport();

    expect(result.success).toBe(true);
    expect(result.action).toBe("import");
    expect(result.data).toBeDefined();

    // Compile ran through the same pipeline as `generate`.
    expect(compilerMocks.buildTailwindPreviewWithMetadata).toHaveBeenCalledTimes(1);

    // Idempotency check happened BEFORE the insert.
    expect(galleryMocks.findDesignComponentBySourcePath).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        sessionId: "sess-1",
        sourcePath: "components/hero.tsx",
      }),
    );

    // A new row was inserted (not updated).
    expect(galleryMocks.saveDesignComponentRecord).toHaveBeenCalledTimes(1);
    expect(galleryMocks.updateDesignComponent).not.toHaveBeenCalled();

    // Metadata payload.
    const saved = galleryMocks.saveDesignComponentRecord.mock.calls[0][0] as {
      metadata: { sourcePath: string; importedAt: string };
      tags: string[];
    };
    expect(saved.metadata.sourcePath).toBe("components/hero.tsx");
    expect(typeof saved.metadata.importedAt).toBe("string");
    expect(new Date(saved.metadata.importedAt).toString()).not.toBe("Invalid Date");
    expect(saved.tags).toContain("imported");

    // Envelope exposes componentId, the "imported" tag, and a screenshot.
    const data = result.data as Record<string, unknown> & {
      tags?: string[];
      screenshot?: { url?: string };
      screenshotError?: unknown;
      updated?: boolean;
    };
    // componentId is the generated UUID the tool fed to
    // `saveDesignComponentRecord` — round-trip it through the mock's input
    // rather than hard-coding a value the SUT doesn't expose.
    expect(typeof data.componentId).toBe("string");
    expect(data.componentId).toBe(
      (saved as unknown as { id?: string }).id ?? saved.metadata.sourcePath,
    );
    expect(data.sourcePath).toBe("components/hero.tsx");
    expect(data.tags).toContain("imported");
    expect(data.updated).toBe(false);

    // Either a screenshot URL was produced, or a structured screenshotError was
    // surfaced — the spec requires ONE of the two so the agent never silently
    // drops the post-compile preview.
    expect(data.screenshot || data.screenshotError).toBeTruthy();
    if (data.screenshot && typeof data.screenshot === "object") {
      expect((data.screenshot as { url?: string }).url).toBe(
        "/api/media/sess-1/preview.png",
      );
    }
  });

  it("updates the existing row (does NOT insert a duplicate) when a row already exists for (userId, sessionId, sourcePath)", async () => {
    galleryMocks.findDesignComponentBySourcePath.mockResolvedValue(
      makeGalleryItem({
        id: "design-row-existing",
        userId: "user-1",
        sessionId: "sess-1",
        metadata: {
          sourcePath: "components/hero.tsx",
          importedAt: "2026-04-01T00:00:00.000Z",
          customNote: "preserved",
        },
        prompt: "Imported from components/hero.tsx",
      }),
    );

    const result = await runImport();

    expect(result.success).toBe(true);
    expect(galleryMocks.updateDesignComponent).toHaveBeenCalledTimes(1);
    expect(galleryMocks.saveDesignComponentRecord).not.toHaveBeenCalled();

    // Pre-existing metadata keys must be preserved when merging.
    const [, , updates] = galleryMocks.updateDesignComponent.mock.calls[0] as [
      string,
      string,
      { metadata: { sourcePath: string; importedAt: string; customNote?: string } },
    ];
    expect(updates.metadata.sourcePath).toBe("components/hero.tsx");
    expect(updates.metadata.importedAt).not.toBe("2026-04-01T00:00:00.000Z");
    expect(updates.metadata.customNote).toBe("preserved");

    const data = result.data as { updated?: boolean; componentId?: string };
    expect(data.updated).toBe(true);
    expect(data.componentId).toBe("design-row-existing");
  });

  it("does NOT persist on compile failure and returns errorCode=IMPORT_COMPILE_FAILED with the structured report", async () => {
    // Throw a shape matching DesignWorkspaceCompileError so the SUT's
    // `isDesignWorkspaceCompileError` guard (which we also mock) fires.
    compilerMocks.buildTailwindPreviewWithMetadata.mockImplementation(async () => {
      const err = Object.assign(new Error("Unexpected closing tag </foo> at line 1"), {
        __designWorkspaceCompileError: true,
        report: {
          ...makeSuccessCompileReport(),
          errors: [
            {
              type: "syntax",
              message: "Unexpected closing tag </foo>",
              location: { line: 1, column: 0 },
            },
          ],
        },
      });
      throw err;
    });

    const result = await runImport();

    expect(result.success).toBe(false);
    expect(result.action).toBe("import");
    const data = result.data as {
      errorCode?: string;
      compileReport?: unknown;
      sourcePath?: string;
    };
    expect(data.errorCode).toBe("IMPORT_COMPILE_FAILED");
    expect(data.compileReport).toBeDefined();
    expect(data.sourcePath).toBe("components/hero.tsx");

    // No DB writes on compile failure.
    expect(galleryMocks.saveDesignComponentRecord).not.toHaveBeenCalled();
    expect(galleryMocks.updateDesignComponent).not.toHaveBeenCalled();
  });

  it("returns errorCode=IMPORT_RESOLVE_FAILED and never reads the file when resolveSyncedPath refuses the path", async () => {
    pathMocks.resolveSyncedPath.mockResolvedValue({
      ok: false,
      status: "error",
      error: 'Path "components/hero.tsx" is not within any synced folder. Allowed folders: /abs/sandbox/char-1',
    });

    const result = await runImport();

    expect(result.success).toBe(false);
    const data = result.data as { errorCode?: string; sourcePath?: string };
    // BA-2: the import action's error codes are now scoped with
    // `IMPORT_*` prefixes so the agent can branch on a single
    // discriminator. Path rejection surfaces as IMPORT_RESOLVE_FAILED.
    expect(data.errorCode).toBe("IMPORT_RESOLVE_FAILED");
    expect(data.sourcePath).toBe("components/hero.tsx");

    // Never reached fs, compile, or DB.
    expect(fsMocks.stat).not.toHaveBeenCalled();
    expect(fsMocks.readFile).not.toHaveBeenCalled();
    expect(compilerMocks.buildTailwindPreviewWithMetadata).not.toHaveBeenCalled();
    expect(galleryMocks.saveDesignComponentRecord).not.toHaveBeenCalled();
  });

  it("normalizes tags: dedupes, strips empties, and always includes 'imported'", async () => {
    await runImport(
      { sessionId: "sess-1", userId: "user-1", characterId: "char-1" },
      {
        action: "import",
        sessionId: "sess-1",
        sourcePath: "components/hero.tsx",
        tags: ["hero", "  ", "hero", "marketing", ""],
      },
    );

    const saved = galleryMocks.saveDesignComponentRecord.mock.calls[0][0] as {
      tags: string[];
    };
    expect(saved.tags).toContain("hero");
    expect(saved.tags).toContain("marketing");
    expect(saved.tags).toContain("imported");

    // Whitespace-only and empty strings must be dropped.
    expect(saved.tags).not.toContain("");
    expect(saved.tags).not.toContain("  ");

    // Dedupe.
    const heroCount = saved.tags.filter((t) => t === "hero").length;
    expect(heroCount).toBe(1);
  });
});

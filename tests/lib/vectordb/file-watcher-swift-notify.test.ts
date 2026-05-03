/**
 * Tests for the Swift index.notifyChange dispatch wired into the file watcher
 * (W7.1.D). The default-config / "lance" mode must be a strict no-op; the
 * "swift" mode must coalesce bursts, dispatch one batched call per folder per
 * 200ms quiet window, queue while the sidecar isn't ready, drop the oldest
 * entries on overflow, and never block the LanceDB pipeline on Swift errors.
 *
 * The sidecar singleton is mocked because lib/swift-engine/sidecar.ts is owned
 * by a different work item (W7.1.E) and may not exist on this branch yet.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { SwiftEngineUnavailableError } from "@/lib/swift-engine/types";

// ---------------------------------------------------------------------------
// Hoisted mocks — chokidar emitters, sidecar fake, indexing/db stubs.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const emitters: Array<EventEmitter & { close: () => Promise<void> }> = [];
  const watchSpy = vi.fn((_path: string) => {
    const em = new EventEmitter() as EventEmitter & { close: () => Promise<void> };
    em.close = vi.fn(async () => {});
    emitters.push(em);
    return em;
  });

  const sendRequest = vi.fn(async () => ({ result: { accepted: 0, queued: 0 } }));
  const isReady = vi.fn(() => true);
  const sidecarFake = {
    sendRequest,
    isReady,
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    health: vi.fn(() => ({
      state: "ready" as const,
      pid: 1,
      uptimeMs: 0,
      totals: { requests: 0, errors: 0, restarts: 0 },
    })),
  };
  const getSwiftEngineSidecar = vi.fn(() => sidecarFake);

  return {
    emitters,
    watchSpy,
    sendRequest,
    isReady,
    sidecarFake,
    getSwiftEngineSidecar,
    indexFileToVectorDB: vi.fn(async () => {}),
    removeFileFromVectorDB: vi.fn(async () => {}),
    update: vi.fn(),
    updateSet: vi.fn(),
    updateWhere: vi.fn(),
    eq: vi.fn(),
    and: vi.fn(),
    getOpenFdCount: vi.fn(async () => 100 as number | null),
  };
});

vi.mock("chokidar", () => ({
  default: { watch: mocks.watchSpy },
}));

// NB: lib/swift-engine/sidecar.ts is owned by W7.1.E and may not exist on the
// branch. Instead of mocking the module path, we inject the factory directly
// via __setSwiftEngineFactoryForTests in beforeEach.

vi.mock("@/lib/vectordb/file-watcher-utils", () => ({
  getMaxConcurrency: () => 5,
  getOpenFileDescriptorCount: mocks.getOpenFdCount,
  getWatcherFdBudget: () => 3000,
  getWatcherFdWarnThreshold: () => 2400,
  isProjectRootDirectory: vi.fn(async () => false),
  processWithConcurrency: vi.fn(async (items: unknown[], _c: number, fn: (i: unknown) => Promise<void>) => {
    for (const it of items) {
      try { await fn(it); } catch { /* swallow */ }
    }
  }),
}));

vi.mock("drizzle-orm", () => ({
  eq: mocks.eq,
  and: mocks.and,
}));

// folder rows returned by db.select().from(agentSyncFolders).where(...)
// Tests can override this list to drive batch-processor branches.
const folderRows: Array<Record<string, unknown>> = [];
function setFolderRow(row: Record<string, unknown>): void {
  folderRows.length = 0;
  folderRows.push(row);
}

vi.mock("@/lib/db/sqlite-client", () => ({
  db: {
    update: mocks.update,
    delete: vi.fn(() => ({ where: vi.fn() })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => folderRows),
      })),
    })),
    insert: vi.fn(),
  },
}));

vi.mock("@/lib/db/sqlite-character-schema", () => ({
  agentSyncFolders: { id: "id-column" },
  agentSyncFiles: {
    id: "id-column",
    folderId: "folderId-column",
    filePath: "filePath-column",
  },
}));

vi.mock("@/lib/vectordb/indexing", () => ({
  indexFileToVectorDB: mocks.indexFileToVectorDB,
  removeFileFromVectorDB: mocks.removeFileFromVectorDB,
}));

vi.mock("@/lib/background-tasks/registry", () => ({
  taskRegistry: {
    list: () => ({ tasks: [] }),
    on: vi.fn(),
  },
}));

vi.mock("@/lib/vectordb/sync-mode-resolver", () => ({
  resolveChunkingOverrides: vi.fn(() => ({ useOverrides: false })),
  resolveFolderSyncBehavior: vi.fn(() => ({
    syncMode: "auto",
    shouldCreateEmbeddings: true,
    maxFileSizeBytes: 1024 * 1024,
  })),
  shouldRunForTrigger: vi.fn(() => true),
}));

import {
  startWatching,
  stopAllWatchers,
  __resetSwiftEngineCacheForTests,
  __setSwiftEngineFactoryForTests,
} from "@/lib/vectordb/file-watcher";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupUpdateChain(): void {
  mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
  mocks.update.mockReturnValue({ set: mocks.updateSet });
  mocks.updateWhere.mockResolvedValue(undefined);
}

async function startWatcherFor(folderId: string, folderPath: string): Promise<EventEmitter & { close: () => Promise<void> }> {
  const startBefore = mocks.watchSpy.mock.calls.length;
  const promise = startWatching({
    folderId,
    characterId: "char-1",
    folderPath,
    recursive: false,
    includeExtensions: ["ts", "md", "txt"],
    excludePatterns: [],
  });
  promise.catch(() => {});
  // Wait for chokidar.watch to be called
  for (let i = 0; i < 50; i++) {
    if (mocks.watchSpy.mock.calls.length > startBefore) break;
    await new Promise((r) => setImmediate(r));
  }
  const em = mocks.emitters[mocks.emitters.length - 1];
  em.emit("ready");
  await promise;
  return em;
}

function getNotifyCalls(): Array<{ method: string; params: { folderId: string; changes: Array<{ path: string; op: string; oldPath?: string }> } }> {
  return mocks.sendRequest.mock.calls
    .map((c) => c[0] as { method: string; params: { folderId: string; changes: Array<{ path: string; op: string; oldPath?: string }> } })
    .filter((req) => req?.method === "index.notifyChange");
}

const ORIGINAL_SEARCH_ENGINE = process.env.SEARCH_ENGINE;

beforeEach(() => {
  setupUpdateChain();
  __resetSwiftEngineCacheForTests();
  __setSwiftEngineFactoryForTests(mocks.getSwiftEngineSidecar);
  mocks.watchSpy.mockClear();
  mocks.emitters.length = 0;
  mocks.sendRequest.mockClear();
  mocks.sendRequest.mockResolvedValue({ result: { accepted: 0, queued: 0 } });
  mocks.isReady.mockReset();
  mocks.isReady.mockReturnValue(true);
  mocks.indexFileToVectorDB.mockClear();
  mocks.getSwiftEngineSidecar.mockClear();
  mocks.getOpenFdCount.mockResolvedValue(100);
  // Provide a folder row so the batch processor doesn't bail early.
  setFolderRow({
    id: "row-id",
    folderId: "any",
    indexingMode: "auto",
    syncMode: "auto",
    maxFileSizeBytes: 1024 * 1024,
    chunkPreset: "default",
    chunkSizeOverride: null,
    chunkOverlapOverride: null,
    reindexPolicy: "default",
    fileTypeFilters: "[]",
    includeExtensions: "[\"ts\",\"md\",\"txt\"]",
  });
});

afterEach(async () => {
  await stopAllWatchers();
  __setSwiftEngineFactoryForTests(null);
  __resetSwiftEngineCacheForTests();
  if (ORIGINAL_SEARCH_ENGINE === undefined) {
    delete process.env.SEARCH_ENGINE;
  } else {
    process.env.SEARCH_ENGINE = ORIGINAL_SEARCH_ENGINE;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("file-watcher Swift notifyChange dispatch", () => {
  it("(a) default config (SEARCH_ENGINE=lance): never calls sidecar.sendRequest", async () => {
    delete process.env.SEARCH_ENGINE;

    const em = await startWatcherFor("folder-lance", "/work/lance");

    em.emit("add", "/work/lance/foo.ts");
    em.emit("change", "/work/lance/foo.ts");
    em.emit("unlink", "/work/lance/bar.ts");

    // Wait well past the 200ms debounce window.
    await new Promise((r) => setTimeout(r, 350));

    expect(mocks.sendRequest).not.toHaveBeenCalled();
    expect(mocks.getSwiftEngineSidecar).not.toHaveBeenCalled();
  });

  it("(b) swift + ready sidecar: a single add fires exactly one notifyChange with op=add", async () => {
    process.env.SEARCH_ENGINE = "swift";

    const em = await startWatcherFor("folder-b", "/work/b");
    em.emit("add", "/work/b/foo.ts");

    // Allow debounce window to elapse + microtasks for the dispatch.
    await new Promise((r) => setTimeout(r, 250));

    const calls = getNotifyCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].params.folderId).toBe("folder-b");
    expect(calls[0].params.changes).toEqual([{ path: "/work/b/foo.ts", op: "add" }]);
  });

  it("(c) swift + ready sidecar: 50 rapid events coalesce to ONE notifyChange call", async () => {
    process.env.SEARCH_ENGINE = "swift";

    const em = await startWatcherFor("folder-c", "/work/c");

    for (let i = 0; i < 50; i++) {
      em.emit("add", `/work/c/file${i}.ts`);
    }

    await new Promise((r) => setTimeout(r, 250));

    const calls = getNotifyCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].params.folderId).toBe("folder-c");
    expect(calls[0].params.changes.length).toBe(50);
    // All paths preserved in the batch.
    const paths = new Set(calls[0].params.changes.map((c) => c.path));
    expect(paths.size).toBe(50);
  });

  it("(d) swift + multi-folder events emit separate notifyChange calls per folder", async () => {
    process.env.SEARCH_ENGINE = "swift";

    const emA = await startWatcherFor("folder-da", "/work/da");
    const emB = await startWatcherFor("folder-db", "/work/db");

    emA.emit("add", "/work/da/x.ts");
    emA.emit("change", "/work/da/x.ts");
    emB.emit("add", "/work/db/y.ts");
    emB.emit("unlink", "/work/db/z.ts");

    await new Promise((r) => setTimeout(r, 250));

    const calls = getNotifyCalls();
    expect(calls.length).toBe(2);
    const byFolder = new Map(calls.map((c) => [c.params.folderId, c.params.changes]));
    // folder-da: add+change for the same path collapses to "change" (latest wins).
    expect(byFolder.get("folder-da")).toEqual([{ path: "/work/da/x.ts", op: "change" }]);
    // folder-db: add y.ts + unlink z.ts (distinct paths kept).
    const dbChanges = byFolder.get("folder-db");
    expect(dbChanges).toBeDefined();
    expect(dbChanges!.length).toBe(2);
    expect(dbChanges).toEqual(
      expect.arrayContaining([
        { path: "/work/db/y.ts", op: "add" },
        { path: "/work/db/z.ts", op: "unlink" },
      ])
    );
  });

  it("(e) swift + sidecar not ready: events queue, flushed on ready transition", async () => {
    process.env.SEARCH_ENGINE = "swift";
    mocks.isReady.mockReturnValue(false);

    const em = await startWatcherFor("folder-e", "/work/e");
    em.emit("add", "/work/e/a.ts");
    em.emit("change", "/work/e/b.ts");

    await new Promise((r) => setTimeout(r, 250));

    // No call yet — sidecar wasn't ready.
    expect(getNotifyCalls().length).toBe(0);

    // Flip to ready; the schedulePendingDrain timer (500ms cadence) flushes.
    mocks.isReady.mockReturnValue(true);
    await new Promise((r) => setTimeout(r, 700));

    const calls = getNotifyCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].params.folderId).toBe("folder-e");
    expect(calls[0].params.changes.length).toBe(2);
    const paths = new Set(calls[0].params.changes.map((c) => c.path));
    expect(paths.has("/work/e/a.ts")).toBe(true);
    expect(paths.has("/work/e/b.ts")).toBe(true);
  });

  it("(f) swift + buffer overflow: oldest events dropped with console.warn", async () => {
    process.env.SEARCH_ENGINE = "swift";
    mocks.isReady.mockReturnValue(false);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const em = await startWatcherFor("folder-f", "/work/f");

      // Push >1000 unique paths so the bucket map has >1000 entries; the
      // not-ready buffer then mirrors them and overflows past 1000.
      for (let i = 0; i < 1100; i++) {
        em.emit("add", `/work/f/file${i}.ts`);
      }

      // Allow debounce window to fire and the not-ready buffer path to run.
      await new Promise((r) => setTimeout(r, 300));

      const overflowWarnings = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === "string" && args[0].includes("Swift notifyChange buffer overflow")
      );
      expect(overflowWarnings.length).toBeGreaterThan(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("(g) swift + sendRequest throws: LanceDB pipeline still proceeds", async () => {
    // sendRequest rejects; LanceDB batching (processWithConcurrency mock) must
    // still run on the same cadence. We measure by counting how many times
    // processWithConcurrency was invoked across both modes.
    const procMock = (await import("@/lib/vectordb/file-watcher-utils"))
      .processWithConcurrency as ReturnType<typeof vi.fn>;
    procMock.mockClear();

    // Lance mode baseline.
    delete process.env.SEARCH_ENGINE;
    const emLance = await startWatcherFor("folder-g-lance", "/work/g-lance");
    emLance.emit("add", "/work/g-lance/foo.ts");
    await new Promise((r) => setTimeout(r, 1300));
    const lanceCalls = procMock.mock.calls.length;
    expect(lanceCalls).toBeGreaterThan(0);

    // Swift mode with sendRequest throwing.
    procMock.mockClear();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.sendRequest.mockRejectedValue(
        new SwiftEngineUnavailableError("degraded", "boom"),
      );
      process.env.SEARCH_ENGINE = "swift";
      const emSwift = await startWatcherFor("folder-g-swift", "/work/g-swift");
      emSwift.emit("add", "/work/g-swift/foo.ts");
      await new Promise((r) => setTimeout(r, 1300));
      const swiftCalls = procMock.mock.calls.length;

      // LanceDB pipeline ran the same number of times despite Swift errors.
      expect(swiftCalls).toBe(lanceCalls);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("(h) op mapping: add → add, change → change, unlink → unlink", async () => {
    process.env.SEARCH_ENGINE = "swift";

    const emAdd = await startWatcherFor("folder-h-add", "/work/h-add");
    emAdd.emit("add", "/work/h-add/a.ts");
    await new Promise((r) => setTimeout(r, 250));

    const emChange = await startWatcherFor("folder-h-change", "/work/h-change");
    emChange.emit("change", "/work/h-change/b.ts");
    await new Promise((r) => setTimeout(r, 250));

    const emUnlink = await startWatcherFor("folder-h-unlink", "/work/h-unlink");
    emUnlink.emit("unlink", "/work/h-unlink/c.ts");
    await new Promise((r) => setTimeout(r, 250));

    const calls = getNotifyCalls();
    const byFolder = new Map(calls.map((c) => [c.params.folderId, c.params.changes]));
    expect(byFolder.get("folder-h-add")).toEqual([{ path: "/work/h-add/a.ts", op: "add" }]);
    expect(byFolder.get("folder-h-change")).toEqual([{ path: "/work/h-change/b.ts", op: "change" }]);
    expect(byFolder.get("folder-h-unlink")).toEqual([{ path: "/work/h-unlink/c.ts", op: "unlink" }]);
  });
});

/**
 * Tests for FD-pressure handling in startWatching.
 *
 * Covers the regressions from the EMFILE -> EBADF cascade where parallel
 * recursive watchers exhausted the process FD table and poisoned every
 * subsequent spawn() (MCP servers, node probes).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  // Each chokidar.watch call returns a fresh emitter so the test can drive
  // ready/error events independently per path.
  const emitters: Array<EventEmitter & { close: () => Promise<void> }> = [];
  const watchSpy = vi.fn((_path: string, _options?: Record<string, unknown>) => {
    const em = new EventEmitter() as EventEmitter & { close: () => Promise<void> };
    em.close = vi.fn(async () => {});
    emitters.push(em);
    return em;
  });
  return {
    emitters,
    watchSpy,
    getOpenFdCount: vi.fn<[], Promise<number | null>>(),
    fdBudget: 3000,
    fdWarnThreshold: 2400, // 80% of 3000
    update: vi.fn(),
    updateSet: vi.fn(),
    updateWhere: vi.fn(),
    eq: vi.fn(),
    and: vi.fn(),
  };
});

vi.mock("chokidar", () => ({
  default: { watch: mocks.watchSpy },
}));

vi.mock("@/lib/vectordb/file-watcher-utils", () => ({
  getMaxConcurrency: () => 5,
  getOpenFileDescriptorCount: mocks.getOpenFdCount,
  getWatcherFdBudget: () => mocks.fdBudget,
  getWatcherFdWarnThreshold: () => mocks.fdWarnThreshold,
  isProjectRootDirectory: vi.fn(async () => false),
  processWithConcurrency: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: mocks.eq,
  and: mocks.and,
}));

vi.mock("@/lib/db/sqlite-client", () => ({
  db: {
    update: mocks.update,
    delete: vi.fn(() => ({ where: vi.fn() })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })),
    insert: vi.fn(),
  },
}));

vi.mock("@/lib/db/sqlite-character-schema", () => ({
  agentSyncFolders: { id: "id-column" },
  agentSyncFiles: { id: "id-column", folderId: "folderId-column", filePath: "filePath-column" },
}));

vi.mock("@/lib/vectordb/indexing", () => ({
  indexFileToVectorDB: vi.fn(),
  removeFileFromVectorDB: vi.fn(),
}));

vi.mock("@/lib/background-tasks/registry", () => ({
  taskRegistry: {
    list: () => ({ tasks: [] }),
    on: vi.fn(),
  },
}));

vi.mock("@/lib/vectordb/sync-mode-resolver", () => ({
  resolveChunkingOverrides: vi.fn(),
  resolveFolderSyncBehavior: vi.fn(),
  shouldRunForTrigger: vi.fn(() => true),
}));

import {
  isWatching,
  startWatching,
  stopAllWatchers,
} from "@/lib/vectordb/file-watcher";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fireReady(emitterIndex: number): void {
  const em = mocks.emitters[emitterIndex];
  if (!em) throw new Error(`No emitter at index ${emitterIndex}`);
  em.emit("ready");
}

/**
 * startWatching has several awaits before chokidar.watch is called
 * (registry resolution, cleanup, FD-count check). Yield until the spy
 * has reached the expected call count or we time out.
 */
async function waitForWatch(callCount: number, label = ""): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (mocks.watchSpy.mock.calls.length >= callCount) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(
    `chokidar.watch was not called ${callCount} time(s) within 50 ticks${label ? ` (${label})` : ""}; ` +
    `actual: ${mocks.watchSpy.mock.calls.length}`
  );
}

function makeConfig(folderId: string, folderPath: string, recursive = true) {
  return {
    folderId,
    characterId: "char-1",
    folderPath,
    recursive,
    includeExtensions: ["ts"],
    excludePatterns: [],
  };
}

function setupUpdateChain() {
  mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
  mocks.update.mockReturnValue({ set: mocks.updateSet });
  mocks.updateWhere.mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startWatching FD-pressure handling", () => {
  beforeEach(() => {
    mocks.emitters.length = 0;
    mocks.watchSpy.mockClear();
    setupUpdateChain();
  });

  afterEach(async () => {
    await stopAllWatchers();
  });

  it("defers a watcher and never calls chokidar.watch when FDs are at warn threshold", async () => {
    mocks.getOpenFdCount.mockResolvedValue(mocks.fdWarnThreshold + 1);

    await startWatching(makeConfig("f-warn", "/tmp/warn"));

    expect(mocks.watchSpy).not.toHaveBeenCalled();
    // Last update call sets status: "paused" with a Deferred: lastError
    const setCalls = mocks.updateSet.mock.calls;
    const deferredCall = setCalls.find(
      (call) => typeof call[0]?.lastError === "string" && call[0].lastError.startsWith("Deferred:")
    );
    expect(deferredCall, "expected a Deferred: lastError update").toBeTruthy();
    expect(deferredCall![0].status).toBe("paused");
  });

  it("hard-fails with a Paused: message when FDs are at or above the budget", async () => {
    mocks.getOpenFdCount.mockResolvedValue(mocks.fdBudget + 1);

    await startWatching(makeConfig("f-budget", "/tmp/budget"));

    expect(mocks.watchSpy).not.toHaveBeenCalled();
    const setCalls = mocks.updateSet.mock.calls;
    const pausedCall = setCalls.find(
      (call) =>
        typeof call[0]?.lastError === "string" &&
        call[0].lastError.startsWith("Paused: this sync would exceed")
    );
    expect(pausedCall, "expected a Paused (budget) lastError update").toBeTruthy();
  });

  it("creates the watcher when FDs are well below threshold and chokidar fires ready", async () => {
    mocks.getOpenFdCount.mockResolvedValue(100);

    const promise = startWatching(makeConfig("f-ok", "/tmp/ok"));
    // Catch the rejection (if any) early to avoid an unhandled-rejection warning
    // before we await it — the same pattern startWatching uses internally.
    promise.catch(() => {});

    await waitForWatch(1, "f-ok");
    expect(mocks.watchSpy).toHaveBeenCalledTimes(1);

    // startWatching must NOT resolve before "ready" fires.
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });
    // Yield a few ticks; resolution should still be pending.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);

    fireReady(0);
    await promise;
    expect(resolved).toBe(true);
  });

  it("passes an early directory-pruning matcher to chokidar", async () => {
    mocks.getOpenFdCount.mockResolvedValue(100);

    const promise = startWatching(makeConfig("f-ignore", "/tmp/ignore"));
    promise.catch(() => {});
    await waitForWatch(1, "f-ignore");

    const options = mocks.watchSpy.mock.calls[0]?.[1] as {
      ignored?: (path: string) => boolean;
    };
    expect(options.ignored).toBeTypeOf("function");
    expect(options.ignored!("/tmp/ignore/node_modules")).toBe(true);
    expect(options.ignored!("/tmp/ignore/.venv")).toBe(true);
    expect(options.ignored!("/tmp/ignore/public/images")).toBe(true);
    expect(options.ignored!("/tmp/ignore/src/icons/ButtonIcon.tsx")).toBe(false);

    fireReady(0);
    await promise;
  });

  it("handles ENFILE during watcher startup with a clear warning and cleanup", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      mocks.getOpenFdCount.mockResolvedValue(100);

      const promise = startWatching(makeConfig("f-enfile", "/tmp/enfile"));
      promise.catch(() => {});

      await waitForWatch(1, "f-enfile");
      const error = Object.assign(new Error("ENFILE: file table overflow, watch '/tmp/enfile'"), {
        code: "ENFILE",
        path: "/tmp/enfile",
      });
      mocks.emitters[0].emit("error", error);

      await expect(promise).rejects.toMatchObject({ code: "ENFILE" });
      expect(mocks.emitters[0].close).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/ENFILE.*watcher resource limit/i));
    } finally {
      vi.clearAllTimers();
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("coalesces duplicate ENFILE events into one recovery attempt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      mocks.getOpenFdCount.mockResolvedValue(100);

      const promise = startWatching(makeConfig("f-enfile-duplicate", "/tmp/enfile-duplicate"));
      promise.catch(() => {});
      await waitForWatch(1, "f-enfile-duplicate");

      const error = Object.assign(new Error("ENFILE: file table overflow, watch '/tmp/enfile-duplicate'"), {
        code: "ENFILE",
        path: "/tmp/enfile-duplicate",
      });
      mocks.emitters[0].emit("error", error);
      mocks.emitters[0].emit("error", error);

      await expect(promise).rejects.toMatchObject({ code: "ENFILE" });
      await Promise.resolve();

      const resourceWarnings = warnSpy.mock.calls.filter(([message]) =>
        typeof message === "string" && /ENFILE.*watcher resource limit/i.test(message)
      );
      expect(resourceWarnings).toHaveLength(1);
    } finally {
      vi.clearAllTimers();
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("cleans subscriber state when chokidar throws ENFILE synchronously", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      mocks.getOpenFdCount.mockResolvedValue(100);
      const error = Object.assign(new Error("ENFILE: file table overflow, watch '/tmp/sync-enfile'"), {
        code: "ENFILE",
        path: "/tmp/sync-enfile",
      });
      mocks.watchSpy.mockImplementationOnce(() => {
        throw error;
      });

      await expect(
        startWatching(makeConfig("f-sync-enfile", "/tmp/sync-enfile"))
      ).rejects.toMatchObject({ code: "ENFILE" });

      expect(isWatching("f-sync-enfile")).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/ENFILE.*watcher resource limit/i));
    } finally {
      vi.clearAllTimers();
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("defers the 4th recursive watcher on darwin once 3 are already active", async () => {
    if (process.platform !== "darwin") {
      // The cap is 8 elsewhere; this test asserts the darwin behavior.
      return;
    }
    mocks.getOpenFdCount.mockResolvedValue(100);

    // First three: succeed by firing ready immediately.
    for (let i = 0; i < 3; i++) {
      const p = startWatching(makeConfig(`f-${i}`, `/tmp/p${i}`));
      p.catch(() => {});
      await waitForWatch(i + 1, `p${i}`);
      fireReady(i);
      await p;
    }

    expect(mocks.watchSpy).toHaveBeenCalledTimes(3);
    mocks.updateSet.mockClear();

    // Fourth: should be deferred without ever calling chokidar.watch again.
    await startWatching(makeConfig("f-3", "/tmp/p3"));

    expect(mocks.watchSpy).toHaveBeenCalledTimes(3);
    const deferredCall = mocks.updateSet.mock.calls.find(
      (call) =>
        typeof call[0]?.lastError === "string" &&
        call[0].lastError.startsWith("Deferred: max concurrent recursive watchers")
    );
    expect(deferredCall, "expected a max-concurrent Deferred lastError update").toBeTruthy();
  });

  it("does not count non-recursive watchers against the recursive cap", async () => {
    if (process.platform !== "darwin") return;
    mocks.getOpenFdCount.mockResolvedValue(100);

    // Three non-recursive watchers should not consume cap slots.
    for (let i = 0; i < 3; i++) {
      const p = startWatching(makeConfig(`f-nr-${i}`, `/tmp/nr${i}`, /* recursive */ false));
      p.catch(() => {});
      await waitForWatch(i + 1, `nr${i}`);
      fireReady(i);
      await p;
    }

    // A recursive watcher should still go through.
    const p4 = startWatching(makeConfig("f-r", "/tmp/r0", true));
    p4.catch(() => {});
    await waitForWatch(4, "r0");
    fireReady(3);
    await p4;

    expect(mocks.watchSpy).toHaveBeenCalledTimes(4);
  });
});

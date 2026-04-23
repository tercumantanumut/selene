/**
 * Tests for FffBackend reviewer-driven behavior:
 *   - Explicit file paths are respected (file → parent dir + filter).
 *   - respectGitignore=false bails out with a fallback-eligible error
 *     instead of silently ignoring the flag.
 *   - Regex syntax errors from fff are NOT wrapped as transient (permanent).
 *   - Context is synthesized from a shared file cache so one file read
 *     serves multiple hits in the same search.
 *
 * @ff-labs/fff-node is not installed here; we inject a mocked module via
 * vi.mock so the test exercises the adapter end-to-end.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
    SearchBackendTransientError,
    SearchBackendUnavailableError,
} from "@/lib/ai/search/types";

type FffHit = {
    relativePath: string;
    lineNumber: number;
    lineContent: string;
    gitStatus?: string;
    totalFrecencyScore?: number;
    isDefinition?: boolean;
};

const moduleMock = vi.hoisted(() => {
    const state: {
        hitsByRoot: Map<string, FffHit[]>;
        grepError: Error | null;
        createCalls: string[];
        grepCalls: Array<{ root: string; pattern: string; options: unknown }>;
    } = {
        hitsByRoot: new Map(),
        grepError: null,
        createCalls: [],
        grepCalls: [],
    };

    const FileFinder = {
        create({ basePath }: { basePath: string }) {
            state.createCalls.push(basePath);
            return {
                value: {
                    async grep(pattern: string, options: unknown) {
                        state.grepCalls.push({ root: basePath, pattern, options });
                        if (state.grepError) throw state.grepError;
                        return state.hitsByRoot.get(basePath) ?? [];
                    },
                    dispose: vi.fn(),
                },
            };
        },
    };

    return { state, FileFinder };
});

vi.mock("@ff-labs/fff-node", () => ({ FileFinder: moduleMock.FileFinder }));

// Dispose finder cache between tests but DO NOT reset modules — resetting creates
// a fresh types.ts instance and `instanceof` would stop matching the top-level imports.
async function getFreshBackend() {
    const mod = await import("@/lib/ai/search/backends/fff-backend");
    const backend = new mod.FffBackend();
    await backend.dispose();
    return backend;
}

async function writeTempFile(name: string, contents: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fff-backend-test-"));
    const abs = path.join(dir, name);
    await fs.writeFile(abs, contents, "utf8");
    return abs;
}

describe("FffBackend", () => {
    beforeEach(() => {
        moduleMock.state.hitsByRoot.clear();
        moduleMock.state.grepError = null;
        moduleMock.state.createCalls.length = 0;
        moduleMock.state.grepCalls.length = 0;
    });

    it("respects explicit file paths by filtering hits to the given file", async () => {
        const backend = await getFreshBackend();
        const fileA = await writeTempFile("a.ts", "line1\nfoo bar\nline3\n");
        const dir = path.dirname(fileA);
        const fileB = path.join(dir, "b.ts");
        await fs.writeFile(fileB, "unrelated\nfoo bar\n", "utf8");

        moduleMock.state.hitsByRoot.set(dir, [
            { relativePath: "a.ts", lineNumber: 2, lineContent: "foo bar" },
            { relativePath: "b.ts", lineNumber: 2, lineContent: "foo bar" },
        ]);

        const result = await backend.search({
            pattern: "foo",
            paths: [fileA], // explicit FILE path, not dir
            maxResults: 10,
        });

        // Only the hit whose absolute path matches fileA survives.
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]?.file).toBe(path.resolve(fileA));
        expect(moduleMock.state.createCalls).toContain(path.resolve(dir));
    });

    it("throws SearchBackendUnavailableError when respectGitignore=false", async () => {
        const backend = await getFreshBackend();
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fff-backend-test-"));

        await expect(
            backend.search({
                pattern: "anything",
                paths: [tmp],
                respectGitignore: false,
            }),
        ).rejects.toBeInstanceOf(SearchBackendUnavailableError);
    });

    it("bubbles regex syntax errors from fff WITHOUT wrapping as transient", async () => {
        const backend = await getFreshBackend();
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fff-backend-test-"));
        moduleMock.state.grepError = new Error("regex parse error: unclosed group");

        let caught: unknown;
        try {
            await backend.search({
                pattern: "(",
                paths: [tmp],
                regex: true,
            });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(Error);
        expect(caught).not.toBeInstanceOf(SearchBackendTransientError);
        expect(caught).not.toBeInstanceOf(SearchBackendUnavailableError);
        expect((caught as Error).message).toContain("regex parse error");
    });

    it("classifies spawn/ebadf-ish errors as transient so the chain can fall back", async () => {
        const backend = await getFreshBackend();
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fff-backend-test-"));
        moduleMock.state.grepError = new Error("ebadf: bad file descriptor");

        await expect(
            backend.search({
                pattern: "anything",
                paths: [tmp],
            }),
        ).rejects.toBeInstanceOf(SearchBackendTransientError);
    });

    it("reads each context file only once even when many hits target it", async () => {
        const backend = await getFreshBackend();
        const fileA = await writeTempFile("big.ts", Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n"));
        const dir = path.dirname(fileA);

        moduleMock.state.hitsByRoot.set(dir, [
            { relativePath: "big.ts", lineNumber: 3, lineContent: "line3" },
            { relativePath: "big.ts", lineNumber: 10, lineContent: "line10" },
            { relativePath: "big.ts", lineNumber: 17, lineContent: "line17" },
        ]);

        const readFileSpy = vi.spyOn(fs, "readFile");

        try {
            const result = await backend.search({
                pattern: "line",
                paths: [dir],
                contextLines: 2,
                maxResults: 10,
            });

            expect(result.matches).toHaveLength(3);
            // File read should happen at most once despite three hits in the same file.
            const bigReads = readFileSpy.mock.calls.filter(
                (args) => typeof args[0] === "string" && String(args[0]).endsWith("big.ts"),
            );
            expect(bigReads.length).toBeLessThanOrEqual(1);

            // Context should actually be populated for at least one hit.
            expect(result.matches[0]?.beforeContext?.length).toBeGreaterThan(0);
            expect(result.matches[0]?.afterContext?.length).toBeGreaterThan(0);
        } finally {
            readFileSpy.mockRestore();
        }
    });

    it("isAvailable returns true when the module can be resolved", async () => {
        const backend = await getFreshBackend();
        await expect(backend.isAvailable()).resolves.toBe(true);
    });

    it("coalesces multiple explicit file paths in the same directory into a single grep call", async () => {
        const backend = await getFreshBackend();
        const fileA = await writeTempFile("a.ts", "hit\n");
        const dir = path.dirname(fileA);
        const fileB = path.join(dir, "b.ts");
        const fileC = path.join(dir, "c.ts");
        await fs.writeFile(fileB, "hit\n", "utf8");
        await fs.writeFile(fileC, "hit\n", "utf8");

        moduleMock.state.hitsByRoot.set(dir, [
            { relativePath: "a.ts", lineNumber: 1, lineContent: "hit" },
            { relativePath: "b.ts", lineNumber: 1, lineContent: "hit" },
            { relativePath: "c.ts", lineNumber: 1, lineContent: "hit" },
            { relativePath: "d.ts", lineNumber: 1, lineContent: "hit" }, // not requested → filtered out
        ]);

        const result = await backend.search({
            pattern: "hit",
            paths: [fileA, fileB, fileC], // three files, one directory
            maxResults: 10,
        });

        // One grep call for the shared parent directory, not three.
        const grepsForDir = moduleMock.state.grepCalls.filter((call) => call.root === path.resolve(dir));
        expect(grepsForDir).toHaveLength(1);

        // Exactly the three requested files surface; d.ts is filtered out.
        expect(result.matches.map((m) => m.file).sort()).toEqual(
            [fileA, fileB, fileC].map((p) => path.resolve(p)).sort(),
        );
    });

    it("applies frecency ranking BEFORE truncating to maxResults", async () => {
        const backend = await getFreshBackend();
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fff-backend-test-"));
        // Create three files so normalized paths are real.
        const fileLow = path.join(tmp, "low.ts");
        const fileMid = path.join(tmp, "mid.ts");
        const fileHigh = path.join(tmp, "high.ts");
        await fs.writeFile(fileLow, "x", "utf8");
        await fs.writeFile(fileMid, "x", "utf8");
        await fs.writeFile(fileHigh, "x", "utf8");

        // Low-score hits come FIRST in the hit stream; high-score comes LAST.
        // If truncation happened before sorting, the high-score hit would be lost.
        moduleMock.state.hitsByRoot.set(path.resolve(tmp), [
            { relativePath: "low.ts", lineNumber: 1, lineContent: "x", totalFrecencyScore: 1 },
            { relativePath: "mid.ts", lineNumber: 1, lineContent: "x", totalFrecencyScore: 5 },
            { relativePath: "high.ts", lineNumber: 1, lineContent: "x", totalFrecencyScore: 99 },
        ]);

        const result = await backend.search({
            pattern: "x",
            paths: [tmp],
            maxResults: 1,
            rankByFrecency: true,
        });

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]?.frecencyScore).toBe(99);
        expect(result.matches[0]?.file).toBe(path.resolve(fileHigh));
        expect(result.wasTruncated).toBe(true);
        expect(result.totalMatches).toBe(3);
    });
});

describe("search module shutdown handlers", () => {
    // HMR-safe init sentinels live on globalThis so normal module reload doesn't
    // stack listeners. Tests must reset them between cases to exercise the
    // first-load code path repeatedly.
    const GLOBAL_KEY = Symbol.for("@seline/search-init-sentinels");
    beforeEach(() => {
        (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] = {
            registered: false,
            cleanupRegistered: false,
        };
    });

    it("registerCleanupHandlers awaits disposal and exits on SIGINT", async () => {
        vi.resetModules();
        const listeners: Record<string, Array<(...args: unknown[]) => unknown>> = {};
        const fakeProcess = {
            once: (event: string, cb: (...args: unknown[]) => unknown) => {
                (listeners[event] ??= []).push(cb);
                return fakeProcess;
            },
            exit: vi.fn(),
        };
        const originalProcess = (globalThis as { process?: unknown }).process;
        (globalThis as { process?: unknown }).process = fakeProcess;

        try {
            const mod = await import("@/lib/ai/search");
            // Module-load side effect registers handlers with our fakeProcess.
            expect(listeners.SIGINT?.length ?? 0).toBeGreaterThan(0);
            expect(listeners.SIGTERM?.length ?? 0).toBeGreaterThan(0);
            expect(listeners.beforeExit?.length ?? 0).toBeGreaterThan(0);

            // Register a fake backend so disposeSearchBackends has something to await.
            const reg = mod.getSearchBackendRegistry();
            const disposeCalls: number[] = [];
            reg.register({
                id: "ripgrep", // overwrite; safe for this test
                displayName: "fake",
                isAvailable: async () => true,
                supports: () => false,
                search: async () => ({ matches: [], totalMatches: 0, wasTruncated: false, backend: "ripgrep" }),
                dispose: async () => {
                    await new Promise((r) => setTimeout(r, 5));
                    disposeCalls.push(Date.now());
                },
            });

            // Fire SIGINT handler and assert it awaits dispose BEFORE exit.
            const handler = listeners.SIGINT?.[0];
            expect(handler).toBeDefined();
            await handler!();

            expect(disposeCalls).toHaveLength(1);
            expect(fakeProcess.exit).toHaveBeenCalledWith(130);
        } finally {
            (globalThis as { process?: unknown }).process = originalProcess;
            vi.resetModules();
        }
    });

    it("shutdown handler exits even when dispose hangs longer than the timeout", async () => {
        vi.resetModules();
        const listeners: Record<string, Array<(...args: unknown[]) => unknown>> = {};
        const fakeProcess = {
            once: (event: string, cb: (...args: unknown[]) => unknown) => {
                (listeners[event] ??= []).push(cb);
                return fakeProcess;
            },
            exit: vi.fn(),
        };
        const originalProcess = (globalThis as { process?: unknown }).process;
        (globalThis as { process?: unknown }).process = fakeProcess;

        try {
            const mod = await import("@/lib/ai/search");
            const reg = mod.getSearchBackendRegistry();

            let disposeResolved = false;
            reg.register({
                id: "ripgrep",
                displayName: "hang",
                isAvailable: async () => true,
                supports: () => false,
                search: async () => ({ matches: [], totalMatches: 0, wasTruncated: false, backend: "ripgrep" }),
                // Never resolves within the 2s SHUTDOWN_DISPOSE_TIMEOUT_MS window.
                dispose: () =>
                    new Promise<void>((resolve) => {
                        setTimeout(() => {
                            disposeResolved = true;
                            resolve();
                        }, 10_000).unref?.();
                    }),
            });

            const handler = listeners.SIGTERM?.[0];
            expect(handler).toBeDefined();

            const started = Date.now();
            await handler!();
            const elapsed = Date.now() - started;

            // Must have exited promptly (within timeout + small buffer) without
            // waiting for the hung dispose.
            expect(elapsed).toBeLessThan(3_000);
            expect(fakeProcess.exit).toHaveBeenCalledWith(143);
            expect(disposeResolved).toBe(false);
        } finally {
            (globalThis as { process?: unknown }).process = originalProcess;
            vi.resetModules();
        }
    });
});

/**
 * Tests for SearchBackendRegistry selection + fallback chain logic.
 *
 * These tests use synthetic SearchBackend fakes so we don't touch the real
 * ripgrep binary, the optional fff package, or the database. The registry
 * is constructed directly (not via getInstance) so global state is isolated.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    SearchBackendRegistry,
    isFallbackEligibleError,
} from "@/lib/ai/search/backend-registry";
import {
    SearchBackendTransientError,
    SearchBackendUnavailableError,
    type SearchBackend,
    type SearchFeature,
    type SearchOptions,
    type SearchResult,
} from "@/lib/ai/search/types";

function makeBackend(
    id: "ripgrep" | "fff",
    opts: { available?: boolean; searchImpl?: (o: SearchOptions) => Promise<SearchResult> } = {},
): SearchBackend & { searchCalls: SearchOptions[]; isAvailableCalls: number } {
    const searchCalls: SearchOptions[] = [];
    let isAvailableCalls = 0;
    const backend = {
        id,
        displayName: id,
        async isAvailable(): Promise<boolean> {
            isAvailableCalls += 1;
            return opts.available ?? true;
        },
        supports(_feature: SearchFeature): boolean {
            return true;
        },
        async search(options: SearchOptions): Promise<SearchResult> {
            searchCalls.push(options);
            if (opts.searchImpl) return opts.searchImpl(options);
            return { matches: [], totalMatches: 0, wasTruncated: false, backend: id };
        },
    } as const;
    return Object.assign(
        { ...backend },
        {
            get searchCalls() { return searchCalls; },
            get isAvailableCalls() { return isAvailableCalls; },
        },
    );
}

describe("SearchBackendRegistry.resolveChain", () => {
    let registry: SearchBackendRegistry;

    beforeEach(() => {
        registry = new SearchBackendRegistry();
    });

    it("auto prefers fff when it reports available", async () => {
        const rg = makeBackend("ripgrep", { available: true });
        const fff = makeBackend("fff", { available: true });
        registry.register(rg);
        registry.register(fff);

        const chain = await registry.resolveChain("auto", true);

        expect(chain.map((b) => b.id)).toEqual(["fff", "ripgrep"]);
    });

    it("auto falls back to ripgrep when fff is unavailable", async () => {
        const rg = makeBackend("ripgrep", { available: true });
        const fff = makeBackend("fff", { available: false });
        registry.register(rg);
        registry.register(fff);

        const chain = await registry.resolveChain("auto", true);

        expect(chain[0]?.id).toBe("ripgrep");
        expect(chain.map((b) => b.id)).toContain("fff");
    });

    it("auto still works when fff is not registered at all", async () => {
        const rg = makeBackend("ripgrep", { available: true });
        registry.register(rg);

        const chain = await registry.resolveChain("auto", true);

        expect(chain).toHaveLength(1);
        expect(chain[0]?.id).toBe("ripgrep");
    });

    it("explicit ripgrep selection uses ripgrep first even if fff is available", async () => {
        const rg = makeBackend("ripgrep", { available: true });
        const fff = makeBackend("fff", { available: true });
        registry.register(rg);
        registry.register(fff);

        const chain = await registry.resolveChain("ripgrep", true);

        expect(chain[0]?.id).toBe("ripgrep");
    });

    it("explicit fff selection uses fff first", async () => {
        const rg = makeBackend("ripgrep", { available: true });
        const fff = makeBackend("fff", { available: true });
        registry.register(rg);
        registry.register(fff);

        const chain = await registry.resolveChain("fff", true);

        expect(chain[0]?.id).toBe("fff");
    });

    it("allowFallback=false returns only the preferred backend", async () => {
        const rg = makeBackend("ripgrep", { available: true });
        const fff = makeBackend("fff", { available: true });
        registry.register(rg);
        registry.register(fff);

        const chain = await registry.resolveChain("fff", false);

        expect(chain).toHaveLength(1);
        expect(chain[0]?.id).toBe("fff");
    });

    it("isAvailable throw is treated as unavailable in auto mode", async () => {
        const rg = makeBackend("ripgrep", { available: true });
        const fff: SearchBackend = {
            id: "fff",
            displayName: "fff",
            isAvailable: vi.fn().mockRejectedValue(new Error("boom")),
            supports: () => true,
            search: async () => ({ matches: [], totalMatches: 0, wasTruncated: false, backend: "fff" }),
        };
        registry.register(rg);
        registry.register(fff);

        const chain = await registry.resolveChain("auto", true);

        expect(chain[0]?.id).toBe("ripgrep");
    });
});

describe("isFallbackEligibleError", () => {
    it("recognizes SearchBackendUnavailableError as fallback-eligible", () => {
        expect(isFallbackEligibleError(new SearchBackendUnavailableError("fff", "missing"))).toBe(true);
    });

    it("recognizes SearchBackendTransientError as fallback-eligible", () => {
        expect(isFallbackEligibleError(new SearchBackendTransientError("ripgrep", "spawn"))).toBe(true);
    });

    it("does NOT mark plain Error as fallback-eligible (permanent)", () => {
        expect(isFallbackEligibleError(new Error("regex parse error"))).toBe(false);
    });

    it("does NOT mark TypeError as fallback-eligible", () => {
        expect(isFallbackEligibleError(new TypeError("bad input"))).toBe(false);
    });
});

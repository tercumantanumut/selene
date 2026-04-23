/**
 * Search Backend Registry
 *
 * Owns the set of registered SearchBackends and builds the ordered chain the
 * tool layer walks. Fallback is CLASSIFIED, not blind:
 *   - SearchBackendUnavailableError / SearchBackendTransientError  → try next
 *   - anything else (e.g. user regex syntax error)                 → re-throw
 *
 * The tool layer (createLocalGrepTool) handles the per-call iteration; this
 * module is intentionally dumb state + selection logic.
 */

import {
    SearchBackendTransientError,
    SearchBackendUnavailableError,
    type SearchBackend,
    type SearchBackendId,
    type SearchBackendSelection,
} from "@/lib/ai/search/types";

type GlobalForRegistry = { searchBackendRegistryInstance?: SearchBackendRegistry };
const globalForRegistry = globalThis as unknown as GlobalForRegistry;

export class SearchBackendRegistry {
    private backends = new Map<SearchBackendId, SearchBackend>();

    static getInstance(): SearchBackendRegistry {
        if (!globalForRegistry.searchBackendRegistryInstance) {
            globalForRegistry.searchBackendRegistryInstance = new SearchBackendRegistry();
        }
        return globalForRegistry.searchBackendRegistryInstance;
    }

    register(backend: SearchBackend): void {
        this.backends.set(backend.id, backend);
    }

    unregister(id: SearchBackendId): void {
        this.backends.delete(id);
    }

    has(id: SearchBackendId): boolean {
        return this.backends.has(id);
    }

    get(id: SearchBackendId): SearchBackend | undefined {
        return this.backends.get(id);
    }

    list(): SearchBackend[] {
        return Array.from(this.backends.values());
    }

    /**
     * Build the ordered chain of backends to try for a given selection.
     *
     * @param selection  User preference ("auto" | "ripgrep" | "fff").
     * @param allowFallback If true, any remaining registered backends are appended
     *   after the preferred one so a transient failure can still resolve to a result.
     *
     * Semantics:
     *   - "auto": prefer fff when it reports available, else ripgrep.
     *   - explicit id: start with the chosen backend (even if unavailable — we'll
     *     still try it and let its error classify; fallback appends the rest).
     *   - Unknown or unregistered ids are skipped silently.
     */
    async resolveChain(
        selection: SearchBackendSelection,
        allowFallback: boolean,
    ): Promise<SearchBackend[]> {
        const chain: SearchBackend[] = [];
        const rip = this.backends.get("ripgrep");
        const fff = this.backends.get("fff");

        if (selection === "ripgrep" && rip) {
            chain.push(rip);
        } else if (selection === "fff" && fff) {
            chain.push(fff);
        } else {
            // "auto" (or unknown explicit id): pick preferred dynamically.
            let preferred: SearchBackend | undefined;
            if (fff && (await safeIsAvailable(fff))) {
                preferred = fff;
            } else if (rip) {
                preferred = rip;
            } else {
                preferred = fff ?? undefined;
            }
            if (preferred) chain.push(preferred);
        }

        if (allowFallback) {
            for (const b of this.backends.values()) {
                if (!chain.includes(b)) chain.push(b);
            }
        }

        return chain;
    }
}

async function safeIsAvailable(b: SearchBackend): Promise<boolean> {
    try {
        return await b.isAvailable();
    } catch {
        return false;
    }
}

/**
 * Re-export classification helpers so callers can identify fallback-eligible errors.
 */
export function isFallbackEligibleError(err: unknown): boolean {
    return err instanceof SearchBackendUnavailableError || err instanceof SearchBackendTransientError;
}

export { SearchBackendUnavailableError, SearchBackendTransientError };

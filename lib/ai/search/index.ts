/**
 * Search module public surface.
 *
 * Side-effect import: this module registers the default backends
 * (ripgrep + fff) with the singleton registry on first load. The tool layer
 * imports from here rather than touching backends directly so load order is
 * deterministic.
 */

import { FffBackend } from "./backends/fff-backend";
import { RipgrepBackend } from "./backends/ripgrep-backend";
import { SearchBackendRegistry } from "./backend-registry";

export {
    SearchBackendRegistry,
    isFallbackEligibleError,
    SearchBackendTransientError,
    SearchBackendUnavailableError,
} from "./backend-registry";

export type {
    SearchBackend,
    SearchBackendId,
    SearchBackendSelection,
    SearchFeature,
    SearchMatch,
    SearchOptions,
    SearchResult,
} from "./types";

export { RipgrepBackend } from "./backends/ripgrep-backend";
export { FffBackend } from "./backends/fff-backend";

// Sentinels live on globalThis so hot-reload (Next.js dev, Electron reload)
// doesn't re-run registration or stack signal handlers when this module is
// re-evaluated. The registry itself is already global; these flags must be too.
const GLOBAL_KEY = Symbol.for("@seline/search-init-sentinels");
interface InitSentinels {
    registered: boolean;
    cleanupRegistered: boolean;
}
const globalSentinels: { [k: symbol]: InitSentinels } = globalThis as unknown as {
    [k: symbol]: InitSentinels;
};
if (!globalSentinels[GLOBAL_KEY]) {
    globalSentinels[GLOBAL_KEY] = { registered: false, cleanupRegistered: false };
}
const sentinels = globalSentinels[GLOBAL_KEY];

/** Upper bound on how long disposal may take during signal shutdown. */
const SHUTDOWN_DISPOSE_TIMEOUT_MS = 2000;

async function disposeSearchBackends(): Promise<void> {
    const reg = SearchBackendRegistry.getInstance();
    for (const backend of reg.list()) {
        try {
            await backend.dispose?.();
        } catch {
            // Best-effort cleanup only.
        }
    }
}

function registerCleanupHandlers(): void {
    if (sentinels.cleanupRegistered || typeof process === "undefined" || typeof process.once !== "function") {
        return;
    }

    sentinels.cleanupRegistered = true;

    // beforeExit: runtime already exiting, best-effort async disposal is fine.
    process.once("beforeExit", () => {
        void disposeSearchBackends();
    });

    // SIGINT/SIGTERM: attaching a listener suppresses Node's default exit
    // behavior, so we MUST await disposal and then re-exit with the conventional
    // 128 + signal code. Otherwise the app hangs on Ctrl+C.
    //
    // The disposal is bounded by SHUTDOWN_DISPOSE_TIMEOUT_MS: if a backend
    // (e.g. fff's native watcher) wedges, shutdown still completes instead of
    // hanging forever.
    const makeSignalHandler = (_signal: "SIGINT" | "SIGTERM", exitCode: number) => {
        return async () => {
            try {
                const disposal = disposeSearchBackends();
                const timeout = new Promise<void>((resolve) =>
                    setTimeout(resolve, SHUTDOWN_DISPOSE_TIMEOUT_MS).unref?.(),
                );
                await Promise.race([disposal, timeout]);
            } catch {
                // Disposal errors must not block shutdown.
            } finally {
                // Use process.exit rather than re-raising the signal: re-raising
                // is cross-platform fragile (kill(process.pid, signal) behaves
                // differently on Windows) and we've already cleaned up.
                if (typeof process.exit === "function") {
                    process.exit(exitCode);
                }
            }
        };
    };

    process.once("SIGINT", makeSignalHandler("SIGINT", 130));
    process.once("SIGTERM", makeSignalHandler("SIGTERM", 143));
}

function ensureDefaultBackends(): void {
    if (sentinels.registered) return;
    const reg = SearchBackendRegistry.getInstance();
    if (!reg.has("ripgrep")) reg.register(new RipgrepBackend());
    if (!reg.has("fff")) reg.register(new FffBackend());
    registerCleanupHandlers();
    sentinels.registered = true;
}

// Execute on module load so anyone importing from `@/lib/ai/search` gets
// a fully-populated registry without an extra init call.
ensureDefaultBackends();

/** Convenience: get the singleton registry with defaults registered. */
export function getSearchBackendRegistry(): SearchBackendRegistry {
    ensureDefaultBackends();
    return SearchBackendRegistry.getInstance();
}

export { disposeSearchBackends };

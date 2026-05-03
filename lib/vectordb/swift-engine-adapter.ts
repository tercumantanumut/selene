/**
 * Swift Engine Search Adapter (Sprint 7 W7.1.C)
 *
 * Pipes `VectorDBSearchOptions` calls through the SwiftEngineSidecar's MCP
 * `vector.search` tool. Returns the same `VectorSearchHit[]` shape as the
 * existing LanceDB path so `searchWithRouter` can swap engines transparently.
 *
 * # Wire contract
 *
 * The sidecar singleton lives at `@/lib/swift-engine/sidecar` and is created
 * by W7.1.E. That file MUST export `getSwiftEngineSidecar()` returning a
 * value (or Promise of one) satisfying the `SwiftEngineSidecar` interface
 * from `@/lib/swift-engine/types`. We resolve via dynamic `import()` so this
 * adapter compiles cleanly even before W7.1.E lands; tests use a separate
 * `__setSwiftEngineSidecarAccessorForTests` seam to inject a fake.
 *
 * # Failure model
 *
 * - If the sidecar is not yet ready (`isReady() === false`), throws
 *   `SwiftEngineUnavailableError` so `search-router.ts` can fall back to the
 *   LanceDB code path with a `console.warn`. We do NOT swallow this error —
 *   the router decides the policy.
 * - If the MCP call returns `response.error`, we surface a thrown Error with
 *   the inner code/message intact for telemetry.
 * - Per-folder failures embedded in `response.result.errors[]` (mirroring the
 *   tolerance pattern from `lib/vectordb/v2/hybrid-search.ts:171-174`) are
 *   logged via `console.warn` but DO NOT block returning the partial hits.
 */

import type {
  SwiftEngineSidecar,
} from "@/lib/swift-engine/types";
import { SwiftEngineUnavailableError } from "@/lib/swift-engine/types";
import type {
  VectorDBSearchOptions,
  VectorSearchHit,
} from "@/lib/vectordb/search";
import { getVectorSearchConfig } from "@/lib/config/vector-search";

/**
 * Public import path where the production sidecar singleton lives.
 *
 * W7.1.E will create `lib/swift-engine/sidecar.ts` exporting an async
 * `getSwiftEngineSidecar(): Promise<SwiftEngineSidecar>` (or a sync function
 * returning the same shape). Until that lands the path may not exist on
 * disk; we resolve it through `await import(SIDECAR_MODULE_PATH)` so this
 * adapter compiles today and the import failure is handled gracefully.
 *
 * Tests bypass the dynamic import entirely via
 * `__setSwiftEngineSidecarAccessorForTests` (see below) — so unit tests do
 * NOT depend on the W7.1.E module existing.
 */
const SIDECAR_MODULE_PATH = "@/lib/swift-engine/sidecar";

interface SidecarModule {
  getSwiftEngineSidecar?: () => SwiftEngineSidecar | Promise<SwiftEngineSidecar>;
}

/**
 * Wire shape sent to the sidecar's `vector.search` tool. We mirror the Swift
 * `VectorSearchToolRequest` and add `queries` for multi-query expansion (the
 * per-folder fan-out is owned by the engine when this list is present).
 *
 * NOTE: Only fields with defined values are forwarded — undefineds are dropped
 * before send so the JSON-RPC payload stays minimal and the engine's defaults
 * apply.
 */
interface SwiftVectorSearchParams {
  characterId: string;
  query: string;
  queries?: string[];
  topK?: number;
  minScore?: number;
  folderIds?: string[];
}

/**
 * Wire shape returned from `vector.search`. Matches the Swift
 * `VectorSearchToolResult` (single `hits[]` array).
 *
 * `errors[]` is forward-compat: the JS hybrid path tolerates per-folder errors
 * by returning whatever partial hits exist (see hybrid-search.ts). When the
 * Swift engine starts emitting per-folder errors alongside the hits, we honor
 * that same tolerance contract here.
 */
interface SwiftVectorSearchResult {
  hits: SwiftVectorSearchHit[];
  errors?: SwiftVectorSearchPartialError[];
}

interface SwiftVectorSearchHit {
  id: string;
  score: number;
  text: string;
  filePath: string;
  relativePath: string;
  chunkIndex: number;
  folderId: string;
  startLine?: number;
  endLine?: number;
  tokenOffset?: number;
  tokenCount?: number;
  version?: number;
}

interface SwiftVectorSearchPartialError {
  folderId?: string;
  code?: string | number;
  message: string;
}

/**
 * Test seam: a sidecar accessor that, if set, takes precedence over the
 * dynamic import below. Unit tests use this to plant a fake sidecar without
 * needing the (W7.1.E-owned) `@/lib/swift-engine/sidecar` module to exist on
 * disk. Production code MUST NOT call this — it leaves the seam null so the
 * dynamic-import path runs.
 */
let testSidecarAccessor: (() => SwiftEngineSidecar | Promise<SwiftEngineSidecar>) | null = null;

export function __setSwiftEngineSidecarAccessorForTests(
  accessor: (() => SwiftEngineSidecar | Promise<SwiftEngineSidecar>) | null,
): void {
  testSidecarAccessor = accessor;
}

/**
 * Resolve the sidecar singleton.
 *
 * Resolution order:
 *   1. The test seam (`__setSwiftEngineSidecarAccessorForTests`) — used by
 *      unit tests; production never sets this.
 *   2. Dynamic import of `SIDECAR_MODULE_PATH` (== `@/lib/swift-engine/sidecar`).
 *      W7.1.E lands the real module exporting `getSwiftEngineSidecar()`.
 *
 * Any failure surfaces as `SwiftEngineUnavailableError` so `search-router.ts`
 * falls back to LanceDB.
 */
async function resolveSwiftEngineSidecar(): Promise<SwiftEngineSidecar> {
  if (testSidecarAccessor !== null) {
    return await testSidecarAccessor();
  }

  // Indirect via a string variable so TypeScript does not statically resolve
  // the (W7.1.E-owned) module that may not exist on disk yet.
  let mod: SidecarModule;
  try {
    mod = (await import(SIDECAR_MODULE_PATH)) as SidecarModule;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SwiftEngineUnavailableError(
      "idle",
      `failed to load ${SIDECAR_MODULE_PATH}: ${message}`,
    );
  }

  if (typeof mod.getSwiftEngineSidecar !== "function") {
    throw new SwiftEngineUnavailableError(
      "idle",
      `${SIDECAR_MODULE_PATH} must export getSwiftEngineSidecar()`,
    );
  }

  return await mod.getSwiftEngineSidecar();
}

/**
 * Search via the Swift engine sidecar.
 *
 * Throws `SwiftEngineUnavailableError` when the sidecar is not in the `ready`
 * state — `search-router.ts` is responsible for catching this and falling
 * back to the LanceDB path.
 */
export async function searchSwiftEngine(params: {
  characterId: string;
  query: string;
  options?: VectorDBSearchOptions;
}): Promise<VectorSearchHit[]> {
  const sidecar = await resolveSwiftEngineSidecar();

  if (!sidecar.isReady()) {
    const state = sidecar.health().state;
    throw new SwiftEngineUnavailableError(
      state,
      "Swift engine sidecar is not ready; falling back to LanceDB",
    );
  }

  const config = getVectorSearchConfig();
  const mcpParams = buildVectorSearchParams(params, config.enableQueryExpansion);

  let envelope: Awaited<ReturnType<typeof sidecar.callTool<SwiftVectorSearchResult>>>;
  try {
    // The Swift binary requires the standard MCP `tools/call` envelope —
    // calling raw `vector.search` returns "Method not found". The
    // SwiftEngineSidecar.callTool helper wraps + parses the envelope.
    envelope = await sidecar.callTool<SwiftVectorSearchResult>(
      "vector.search",
      mcpParams as unknown as Record<string, unknown>,
    );
  } catch (err) {
    // Transport-level failure (process died mid-request, request timed out, etc.)
    // is treated as "unavailable" so the router falls back rather than crashing.
    if (err instanceof SwiftEngineUnavailableError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new SwiftEngineUnavailableError(sidecar.health().state, message);
  }

  if (envelope.error) {
    const code = envelope.error.code;
    const message = envelope.error.message ?? "vector.search failed";
    throw new Error(`[SwiftEngineAdapter] vector.search error (${code}): ${message}`);
  }

  const toolResult = envelope.result;
  // Tool reported a typed error envelope (e.g. embedding model unavailable).
  // Surface it as an Error so search-router can record telemetry and decide.
  if (toolResult?.isError) {
    const errText = toolResult.rawTexts[0] ?? "tool reported isError";
    throw new Error(`[SwiftEngineAdapter] vector.search tool-error: ${errText}`);
  }

  const result = toolResult?.parsed;
  if (!result || !Array.isArray(result.hits)) {
    return [];
  }

  // Mirror hybrid-search.ts's tolerance: log partial-failure entries but still
  // return whatever hits the engine could collect.
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    for (const partial of result.errors) {
      const scope = partial.folderId ? `folder=${partial.folderId}` : "global";
      console.warn(
        `[SwiftEngineAdapter] partial failure (${scope}): ${partial.message}`,
      );
    }
  }

  return result.hits.map(toVectorSearchHit);
}

/**
 * Build the MCP `vector.search` params from `VectorDBSearchOptions`.
 *
 * Multi-query expansion: when `enableQueryExpansion` is true on the global
 * config, we forward the original query AND a `queries` array (currently
 * `[query]`; richer expansion lives in `lib/vectordb/v2/query-expansion.ts`
 * and is applied client-side when the V2 hybrid path runs). The Swift engine
 * fans out per-query retrieval and merges hits server-side.
 */
function buildVectorSearchParams(
  input: { characterId: string; query: string; options?: VectorDBSearchOptions },
  enableQueryExpansion: boolean,
): SwiftVectorSearchParams {
  const { characterId, query, options } = input;
  const params: SwiftVectorSearchParams = { characterId, query };

  if (options?.topK !== undefined) params.topK = options.topK;
  if (options?.minScore !== undefined) params.minScore = options.minScore;
  if (options?.folderIds && options.folderIds.length > 0) {
    params.folderIds = options.folderIds;
  }

  if (enableQueryExpansion) {
    params.queries = [query];
  }

  return params;
}

function toVectorSearchHit(hit: SwiftVectorSearchHit): VectorSearchHit {
  return {
    id: hit.id,
    score: hit.score,
    text: hit.text,
    filePath: hit.filePath,
    relativePath: hit.relativePath,
    chunkIndex: hit.chunkIndex,
    folderId: hit.folderId,
    startLine: hit.startLine,
    endLine: hit.endLine,
    tokenOffset: hit.tokenOffset,
    tokenCount: hit.tokenCount,
    version: hit.version,
  };
}

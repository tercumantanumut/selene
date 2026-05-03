/**
 * Search Router: V1 / V2 / Swift Engine dispatch.
 *
 * Reference:
 *   - docs/vector-search-v2-analysis.md Section 6.2 (V1/V2 side-by-side)
 *   - lib/swift-engine/types.ts (Phase 1 Swift sidecar contract)
 *
 * Three dispatch branches, in priority order:
 *   1. `searchEngine === "swift"` -> Swift engine sidecar (Sprint 7 W7.1.C).
 *      Falls back to LanceDB on `SwiftEngineUnavailableError`.
 *   2. `enableHybridSearch === true` -> V2 hybrid search (dense + lexical RRF).
 *   3. Default -> V1 dense LanceDB search.
 */

import { searchVectorDB, type VectorSearchHit, type VectorDBSearchOptions } from "./search";
import { hybridSearchV2 } from "./v2/hybrid-search";
import { searchSwiftEngine } from "./swift-engine-adapter";
import { SwiftEngineUnavailableError } from "@/lib/swift-engine/types";
import { getVectorSearchConfig } from "@/lib/config/vector-search";
import { recordEngineSelection } from "@/lib/swift-engine/telemetry";

/**
 * Router that picks the active vector-search engine based on global config.
 * Replace direct calls to `searchVectorDB` with this.
 */
export async function searchWithRouter(params: {
  characterId: string;
  query: string;
  options?: VectorDBSearchOptions;
}): Promise<VectorSearchHit[]> {
  const config = getVectorSearchConfig();

  if (config.searchEngine === "swift") {
    const startedAt = Date.now();
    try {
      const hits = await searchSwiftEngine(params);
      recordEngineSelection({
        engine: "swift",
        outcome: "primary",
        durationMs: Date.now() - startedAt,
      });
      return hits;
    } catch (err) {
      if (err instanceof SwiftEngineUnavailableError) {
        console.warn(
          `[SearchRouter] Swift engine unavailable (${err.state}); falling back to LanceDB.`,
        );
        recordEngineSelection({
          engine: "lance",
          outcome: "fallback-unavailable",
          durationMs: Date.now() - startedAt,
          errorCode: `swift_unavailable:${err.state}`,
        });
        return runLanceFallback(params, config.enableHybridSearch);
      }
      // Non-availability adapter errors propagate (preserves prior behaviour);
      // record the fallback-style telemetry so operators still see the spike.
      recordEngineSelection({
        engine: "swift",
        outcome: "fallback-error",
        durationMs: Date.now() - startedAt,
        errorCode: err instanceof Error ? err.name || "swift_error" : "swift_error",
      });
      throw err;
    }
  }

  const startedAt = Date.now();
  const hits = config.enableHybridSearch
    ? await hybridSearchV2(params)
    : await searchVectorDB(params);
  recordEngineSelection({
    engine: "lance",
    outcome: "primary",
    durationMs: Date.now() - startedAt,
  });
  return hits;
}

function runLanceFallback(
  params: { characterId: string; query: string; options?: VectorDBSearchOptions },
  hybridEnabled: boolean,
): Promise<VectorSearchHit[]> {
  return hybridEnabled ? hybridSearchV2(params) : searchVectorDB(params);
}

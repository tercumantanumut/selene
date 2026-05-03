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
    try {
      return await searchSwiftEngine(params);
    } catch (err) {
      if (err instanceof SwiftEngineUnavailableError) {
        console.warn(
          `[SearchRouter] Swift engine unavailable (${err.state}); falling back to LanceDB.`,
        );
        return runLanceFallback(params, config.enableHybridSearch);
      }
      throw err;
    }
  }

  if (config.enableHybridSearch) {
    return hybridSearchV2(params);
  }

  return searchVectorDB(params);
}

function runLanceFallback(
  params: { characterId: string; query: string; options?: VectorDBSearchOptions },
  hybridEnabled: boolean,
): Promise<VectorSearchHit[]> {
  return hybridEnabled ? hybridSearchV2(params) : searchVectorDB(params);
}

/**
 * Search Router: V1/V2 Side-by-Side Operation
 * Reference: docs/vector-search-v2-analysis.md Section 6.2
 */

import { searchVectorDB, type VectorSearchHit, type VectorDBSearchOptions } from "./search";
import { hybridSearchV2 } from "./v2/hybrid-search";
import { getVectorSearchConfig } from "@/lib/config/vector-search";

/**
 * Router that enables switching between standard and hybrid search.
 * Replace direct calls to searchVectorDB with this.
 */
export async function searchWithRouter(params: {
  characterId: string;
  query: string;
  options?: VectorDBSearchOptions;
}): Promise<VectorSearchHit[]> {
  const config = getVectorSearchConfig();

  if (config.enableHybridSearch) {
    return hybridSearchV2(params);
  }

  return searchVectorDB(params);
}

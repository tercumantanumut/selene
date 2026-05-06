/**
 * V2 Vector Search Configuration
 * Reference: docs/vector-search-v2-analysis.md Section 3.3
 */

interface VectorSearchV2Config {
  // Feature flags - all default to false for V1 compatibility
  enableHybridSearch: boolean;
  enableTokenChunking: boolean;
  enableReranking: boolean;
  enableQueryExpansion: boolean;

  // Chunking (Section 2.1)
  chunkingStrategy: "character" | "token" | "ast";
  tokenChunkSize: number;
  tokenChunkStride: number;
  maxChunksPerFile: number;

  // Embedding
  embeddingBatchSize: number;

  // Search (Section 2.2)
  searchMode: "semantic" | "lexical" | "hybrid";
  denseWeight: number;
  lexicalWeight: number;
  rrfK: number;

  // Reranking (Section 2.4)
  rerankModel: string;
  rerankTopK: number;

  // V1 preserved feature
  enableLLMSynthesis: boolean;

  // File size limit for indexing
  maxFileLines: number;
  maxLineLength: number;
}

const defaultConfig: VectorSearchV2Config = {
  // V2 features enabled by default based on 300-test diagnosis (93% coverage)
  // optimal-v3-max-recall settings from extreme testing
  enableHybridSearch: true,
  enableTokenChunking: false,
  enableReranking: false,
  enableQueryExpansion: false,

  chunkingStrategy: "character",
  tokenChunkSize: 96,
  tokenChunkStride: 48,
  maxChunksPerFile: 200,

  embeddingBatchSize: 64,

  // Optimal hybrid search settings (93% coverage on extreme cases)
  // High lexical weight (2x) for better keyword/exact-match handling
  searchMode: "hybrid",
  denseWeight: 1.0,
  lexicalWeight: 2.0,
  rrfK: 50,

  rerankModel: "cross-encoder/ms-marco-MiniLM-L-6-v2",
  rerankTopK: 20,

  enableLLMSynthesis: true,

  // Default max file lines (files larger than this are skipped)
  maxFileLines: 5000,
  maxLineLength: 2000,
};

let currentConfig: VectorSearchV2Config = { ...defaultConfig };

export function getVectorSearchConfig(): VectorSearchV2Config {
  return currentConfig;
}

export function updateVectorSearchConfig(
  updates: Partial<VectorSearchV2Config>
): void {
  currentConfig = { ...currentConfig, ...updates };
}

export function resetVectorSearchConfig(): void {
  currentConfig = { ...defaultConfig };
}

function parseOptionalBoolean(value?: string): boolean | undefined {
  if (value === undefined) return undefined;
  return value.toLowerCase() === "true";
}

function parseNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Environment variable overrides
export function loadConfigFromEnv(): void {
  const hybridEnabled = parseOptionalBoolean(process.env.VECTOR_SEARCH_HYBRID);
  if (hybridEnabled !== undefined) {
    currentConfig.enableHybridSearch = hybridEnabled;
    currentConfig.searchMode = hybridEnabled ? "hybrid" : "semantic";
  }

  const tokenChunkingEnabled = parseOptionalBoolean(process.env.VECTOR_SEARCH_TOKEN_CHUNKING);
  if (tokenChunkingEnabled !== undefined) {
    currentConfig.enableTokenChunking = tokenChunkingEnabled;
    currentConfig.chunkingStrategy = tokenChunkingEnabled ? "token" : "character";
  }

  const rerankingEnabled = parseOptionalBoolean(process.env.VECTOR_SEARCH_RERANKING);
  if (rerankingEnabled !== undefined) {
    currentConfig.enableReranking = rerankingEnabled;
  }

  const queryExpansionEnabled = parseOptionalBoolean(process.env.VECTOR_SEARCH_QUERY_EXPANSION);
  if (queryExpansionEnabled !== undefined) {
    currentConfig.enableQueryExpansion = queryExpansionEnabled;
  }

  const llmSynthesisEnabled = parseOptionalBoolean(process.env.VECTOR_SEARCH_LLM_SYNTHESIS);
  if (llmSynthesisEnabled !== undefined) {
    currentConfig.enableLLMSynthesis = llmSynthesisEnabled;
  }

  const rrfK = parseNumber(process.env.VECTOR_SEARCH_RRF_K);
  if (rrfK !== undefined) currentConfig.rrfK = rrfK;

  const denseWeight = parseNumber(process.env.VECTOR_SEARCH_DENSE_WEIGHT);
  if (denseWeight !== undefined) currentConfig.denseWeight = denseWeight;

  const lexicalWeight = parseNumber(process.env.VECTOR_SEARCH_LEXICAL_WEIGHT);
  if (lexicalWeight !== undefined) currentConfig.lexicalWeight = lexicalWeight;

  const tokenChunkSize = parseNumber(process.env.VECTOR_SEARCH_TOKEN_CHUNK_SIZE);
  if (tokenChunkSize !== undefined) currentConfig.tokenChunkSize = tokenChunkSize;

  const tokenChunkStride = parseNumber(process.env.VECTOR_SEARCH_TOKEN_CHUNK_STRIDE);
  if (tokenChunkStride !== undefined) currentConfig.tokenChunkStride = tokenChunkStride;

  const maxChunksPerFile = parseNumber(process.env.VECTOR_SEARCH_MAX_CHUNKS_PER_FILE);
  if (maxChunksPerFile !== undefined) {
    currentConfig.maxChunksPerFile = Math.max(0, Math.floor(maxChunksPerFile));
  }

  const embeddingBatchSize = parseNumber(process.env.VECTOR_SEARCH_EMBED_BATCH_SIZE);
  if (embeddingBatchSize !== undefined) {
    currentConfig.embeddingBatchSize = Math.max(1, Math.floor(embeddingBatchSize));
  }

  if (process.env.VECTOR_SEARCH_RERANK_MODEL) {
    currentConfig.rerankModel = process.env.VECTOR_SEARCH_RERANK_MODEL;
  }

  const rerankTopK = parseNumber(process.env.VECTOR_SEARCH_RERANK_TOPK);
  if (rerankTopK !== undefined) currentConfig.rerankTopK = rerankTopK;

  const maxFileLines = parseNumber(process.env.VECTOR_SEARCH_MAX_FILE_LINES);
  if (maxFileLines !== undefined) {
    currentConfig.maxFileLines = Math.max(100, Math.floor(maxFileLines));
  }

  const maxLineLength = parseNumber(process.env.VECTOR_SEARCH_MAX_LINE_LENGTH);
  if (maxLineLength !== undefined) {
    currentConfig.maxLineLength = Math.max(100, Math.floor(maxLineLength));
  }
}

// Rollback capability (Section 6.4)
function rollbackToV1(): void {
  currentConfig = { ...defaultConfig };
  console.log("[VectorSearch] Rolled back to V1 configuration");
}

loadConfigFromEnv();

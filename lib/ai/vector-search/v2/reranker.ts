/**
 * Transformers.js Cross-Encoder Reranking
 * Reference: docs/vector-search-v2-analysis.md Section 2.4
 */

import { VectorSearchHit } from "@/lib/vectordb/search";
import { getVectorSearchConfig } from "@/lib/config/vector-search";
import path from "path";
import fs from "fs";
import { loadSettings } from "@/lib/settings/settings-manager";
import {
  type TransformerDevice,
  resolvePreferredDevice as resolvePreferredDeviceShared,
  isRecoverableGpuRuntimeError,
} from "@/lib/ai/transformer-device";
import { loadTransformersRuntime } from "@/lib/ai/transformers-runtime";

let cachedPipeline: any = null;
let cachedPipelinePromise: Promise<any> | null = null;
let failedToLoad = false;
let runtimeFallbackDevice: TransformerDevice | null = null;
let lastPipelineDevice: TransformerDevice | null = null;

/**
 * Valid ONNX dtypes for the reranker text-classification pipeline.
 * Mirrors the embedding-side type — kept local to avoid a cross-module import.
 */
type RerankerDtype =
  | "fp32"
  | "fp16"
  | "q8"
  | "int8"
  | "uint8"
  | "q4"
  | "bnb4"
  | "q4f16";

const VALID_RERANKER_DTYPES: ReadonlySet<RerankerDtype> = new Set([
  "fp32", "fp16", "q8", "int8", "uint8", "q4", "bnb4", "q4f16",
]);

const DEFAULT_RERANKER_DTYPE: RerankerDtype = "fp32";

function resolveRerankerDtype(): RerankerDtype {
  const candidate = process.env.LOCAL_RERANKER_DTYPE;
  if (!candidate) return DEFAULT_RERANKER_DTYPE;
  if (VALID_RERANKER_DTYPES.has(candidate as RerankerDtype)) {
    return candidate as RerankerDtype;
  }
  console.warn(
    `[Reranker] Invalid LOCAL_RERANKER_DTYPE "${candidate}". ` +
    `Valid: ${Array.from(VALID_RERANKER_DTYPES).join(", ")}. Falling back to fp32.`
  );
  return DEFAULT_RERANKER_DTYPE;
}

/**
 * Legacy reranker IDs whose HF repos do NOT ship ONNX exports.
 * Routed silently to the corresponding `onnx-community/...-ONNX` build so
 * existing user configs keep working after the registry cleanup.
 */
const LEGACY_RERANKER_ALIASES: Readonly<Record<string, string>> = {
  "BAAI/bge-reranker-base": "onnx-community/bge-reranker-base-ONNX",
  "BAAI/bge-reranker-large": "onnx-community/bge-reranker-v2-m3-ONNX",
};

function resolvePreferredDevice(): TransformerDevice {
  return resolvePreferredDeviceShared(runtimeFallbackDevice);
}

function resetPipelineState(): void {
  cachedPipeline = null;
  cachedPipelinePromise = null;
  lastPipelineDevice = null;
}

/**
 * Configure Transformers.js environment
 */
async function configureEnv() {
  const { env } = await loadTransformersRuntime();
  const settings = loadSettings();

  const basePath = process.env.LOCAL_DATA_PATH || path.join(process.cwd(), ".local-data");
  env.cacheDir = path.join(basePath, "transformers-cache");
  env.useBrowserCache = false;
  env.allowLocalModels = true;
  env.allowRemoteModels = true;

  const modelDir = process.env.EMBEDDING_MODEL_DIR || settings.embeddingModelDir;
  if (modelDir) {
    env.localModelPath = modelDir;
  }
}

function normalizeRerankModelId(rawModelId: string): string | null {
  if (!rawModelId) return null;

  let modelId = rawModelId.trim().replace(/\\/g, "/");

  // Legacy config sometimes stores hub IDs prefixed with "models/".
  if (modelId.toLowerCase().startsWith("models/")) {
    modelId = modelId.slice("models/".length);
  }

  // Legacy ONNX file path from older reranker implementation.
  if (modelId.toLowerCase().endsWith(".onnx")) {
    const base = path.basename(modelId).toLowerCase();
    if (base === "ms-marco-minilm-l-6-v2.onnx") {
      return "cross-encoder/ms-marco-MiniLM-L-6-v2";
    }
    console.warn(`[Reranker] Unsupported ONNX file path in rerankModel: ${rawModelId}`);
    return null;
  }

  // Auto-redirect IDs whose HF repos lack ONNX (BAAI/bge-reranker-{base,large})
  // to the official onnx-community ONNX builds. Without this, the pipeline load
  // would fail with an opaque "model not found" error.
  const aliasTarget = LEGACY_RERANKER_ALIASES[modelId];
  if (aliasTarget) {
    console.log(
      `[Reranker] Aliasing legacy reranker ID "${modelId}" → "${aliasTarget}" (no ONNX in original repo)`
    );
    modelId = aliasTarget;
  }

  return modelId || null;
}

/**
 * Load the reranker pipeline (Transformers.js handles cross-encoders via text-classification or feature-extraction)
 */
async function getPipeline(): Promise<any> {
  if (failedToLoad) return null;
  if (cachedPipeline) return cachedPipeline;
  if (cachedPipelinePromise) return cachedPipelinePromise;

  const config = getVectorSearchConfig();
  const modelPath = normalizeRerankModelId(config.rerankModel);
  if (!modelPath) {
    failedToLoad = true;
    return null;
  }

  cachedPipelinePromise = (async () => {
    try {
      await configureEnv();
      const { pipeline } = await loadTransformersRuntime();
      const preferredDevice = resolvePreferredDevice();
      const dtype = resolveRerankerDtype();

      console.log(`[Reranker] Loading model via Transformers.js: ${modelPath} (dtype=${dtype})`);

      // Attempt to load as text-classification (standard for cross-encoders)
      let pipe: any;
      let actualDevice: TransformerDevice = preferredDevice;
      try {
        pipe = await pipeline("text-classification", modelPath, {
          device: preferredDevice,
          dtype,
        });
      } catch (error) {
        if (preferredDevice !== "cpu") {
          console.warn(
            `[Reranker] Failed to initialize on device "${preferredDevice}", falling back to cpu:`,
            error
          );
          pipe = await pipeline("text-classification", modelPath, {
            device: "cpu",
            dtype,
          });
          actualDevice = "cpu";
        } else {
          throw error;
        }
      }

      console.log("[Reranker] Model loaded successfully");
      cachedPipeline = pipe;
      lastPipelineDevice = actualDevice;
      return pipe;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Reranker] Failed to load model: ${errorMsg}`);
      failedToLoad = true;
      return null;
    } finally {
      cachedPipelinePromise = null;
    }
  })();

  return cachedPipelinePromise;
}

/**
 * Rerank search results using Transformers.js.
 * Falls back to original order if reranking unavailable.
 */
export async function rerankResults(
  query: string,
  hits: VectorSearchHit[]
): Promise<VectorSearchHit[]> {
  const config = getVectorSearchConfig();

  if (!config.enableReranking || hits.length === 0 || failedToLoad) {
    return hits;
  }

  const pipe = await getPipeline();
  if (!pipe) {
    return hits;
  }

  const rerankLimit = Math.min(config.rerankTopK, hits.length);
  const toRerank = hits.slice(0, rerankLimit);
  const remainder = hits.slice(rerankLimit);

  const scoreWithPipeline = async (pipe: any): Promise<number[] | null> => {
    const scores: number[] = [];

    for (const hit of toRerank) {
      // Cross-encoders typically take a pair of sentences
      const result = await pipe(query, hit.text);

      // Diagnostic: Check if output looks like a classification result (score)
      // result is typically [{label: 'LABEL_0', score: 0.99}]
      if (Array.isArray(result) && result[0]?.score !== undefined) {
        scores.push(result[0].score);
      } else {
        // If it doesn't look like classification, it might be an embedding model
        console.warn("[Reranker] Unexpected output format. This model may be an EMBEDDING model, not a CROSS-ENCODER.");
        console.warn("[Reranker] Switching to silent fallback (standard search results).");
        failedToLoad = true;
        return null;
      }
    }
    return scores;
  };

  try {
    let scores: number[] | null;
    try {
      scores = await scoreWithPipeline(pipe);
      if (!scores) {
        return hits;
      }
    } catch (error) {
      if (!isRecoverableGpuRuntimeError(error) || lastPipelineDevice === "cpu") {
        throw error;
      }

      console.warn(
        "[Reranker] GPU runtime error detected; switching reranker to CPU for this process:",
        error
      );
      runtimeFallbackDevice = "cpu";
      resetPipelineState();
      const cpuPipe = await getPipeline();
      if (!cpuPipe) {
        return hits;
      }
      scores = await scoreWithPipeline(cpuPipe);
      if (!scores) {
        return hits;
      }
    }

    const reranked = toRerank
      .map((hit, i) => ({ hit, score: scores[i] }))
      .sort((a, b) => b.score - a.score)
      .map(({ hit, score }) => ({ ...hit, score }));

    console.log(`[Reranker] Reranked ${toRerank.length} results using Transformers.js`);
    return [...reranked, ...remainder];
  } catch (error) {
    console.error("[Reranker] Error during reranking:", error);
    return hits;
  }
}

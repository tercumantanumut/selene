import fs from "node:fs";
import path from "node:path";
import type { EmbeddingModelV2, EmbeddingModelV2Embedding } from "@ai-sdk/provider";
import {
  type TransformerDevice,
  resolvePreferredDevice as resolvePreferredDeviceShared,
  isRecoverableGpuRuntimeError,
  detectAppleSiliconInfo,
  isM4OrLater,
} from "@/lib/ai/transformer-device";

export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/bge-large-en-v1.5";
const DEFAULT_QUERY_PREFIX = "Represent this code for search:";
const DEFAULT_QUERY_MAX_CHARS = 512;
const DEFAULT_MAX_BATCH = 64;

/**
 * Valid ONNX dtypes accepted by @huggingface/transformers v4.x for the
 * `feature-extraction` pipeline. fp32 = full precision (largest, safest);
 * q8/int8/uint8 = ~4× smaller; q4/bnb4 = ~8× smaller; fp16 = ~2× smaller
 * but unsupported on some models (notably EmbeddingGemma).
 */
type LocalEmbeddingDtype =
  | "fp32"
  | "fp16"
  | "q8"
  | "int8"
  | "uint8"
  | "q4"
  | "bnb4"
  | "q4f16";

const VALID_LOCAL_EMBEDDING_DTYPES: ReadonlySet<LocalEmbeddingDtype> = new Set([
  "fp32", "fp16", "q8", "int8", "uint8", "q4", "bnb4", "q4f16",
]);

const DEFAULT_LOCAL_EMBEDDING_DTYPE: LocalEmbeddingDtype = "fp32";

/**
 * Resolve the ONNX dtype for the embedding pipeline.
 * Source priority: explicit option > LOCAL_EMBEDDING_DTYPE env var > "fp32".
 * Invalid values fall back to fp32 with a warning so a typo never crashes load.
 */
function resolveEmbeddingDtype(override?: string): LocalEmbeddingDtype {
  const candidate = override ?? process.env.LOCAL_EMBEDDING_DTYPE;
  if (!candidate) return DEFAULT_LOCAL_EMBEDDING_DTYPE;
  if (VALID_LOCAL_EMBEDDING_DTYPES.has(candidate as LocalEmbeddingDtype)) {
    return candidate as LocalEmbeddingDtype;
  }
  console.warn(
    `[LocalEmbeddings] Invalid LOCAL_EMBEDDING_DTYPE "${candidate}". ` +
    `Valid: ${Array.from(VALID_LOCAL_EMBEDDING_DTYPES).join(", ")}. Falling back to fp32.`
  );
  return DEFAULT_LOCAL_EMBEDDING_DTYPE;
}

// Define a type that matches the actual pipeline return value
type FeatureExtractionPipeline = (
  texts: string[],
  options?: { pooling?: string; normalize?: boolean }
) => Promise<unknown>;

interface LocalEmbeddingOptions {
  modelId?: string;
  modelDir?: string;
  cacheDir?: string;
  allowRemoteModels?: boolean;
  queryPrefix?: string;
  queryPrefixMaxChars?: number;
  /**
   * ONNX dtype to load. Defaults to LOCAL_EMBEDDING_DTYPE env var, then "fp32".
   * Use "q8" or "int8" to roughly quarter the on-disk + RAM footprint of
   * larger multilingual models (Snowflake L v2, Qwen3 0.6B) at minor quality cost.
   */
  dtype?: string;
}

let cachedPipelineKey: string | null = null;
let cachedPipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
let embeddingLock: Promise<void> = Promise.resolve();
let runtimeFallbackDevice: TransformerDevice | null = null;

function resolvePreferredDevice(): TransformerDevice {
  return resolvePreferredDeviceShared(runtimeFallbackDevice);
}

function resetPipelineCache(): void {
  cachedPipelineKey = null;
  cachedPipelinePromise = null;
}

function resolveCacheDir(override?: string): string {
  if (override) return override;
  if (process.env.EMBEDDING_CACHE_DIR) return process.env.EMBEDDING_CACHE_DIR;
  const basePath = process.env.LOCAL_DATA_PATH || path.join(process.cwd(), ".local-data");
  return path.join(basePath, "transformers-cache");
}

function resolveModelDir(override?: string): string | undefined {
  if (override) return override;
  if (process.env.EMBEDDING_MODEL_DIR) return process.env.EMBEDDING_MODEL_DIR;

  // Fallback: read from settings.json (for Next.js dev server which doesn't have Electron env vars)
  try {
    const basePath = process.env.LOCAL_DATA_PATH || path.join(process.cwd(), ".local-data");
    const settingsPath = path.join(basePath, "settings.json");
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (settings.embeddingModelDir && fs.existsSync(settings.embeddingModelDir)) {
        return settings.embeddingModelDir;
      }
    }
  } catch {
    // Ignore errors reading settings
  }

  return undefined;
}

/**
 * Check whether the required model files exist locally before
 * attempting to load the pipeline.  This avoids the opaque
 * "@huggingface/transformers model not found" error.
 */
export function validateLocalModelExists(modelId?: string): {
  exists: boolean;
  modelId: string;
  expectedPath: string;
  missingFiles: string[];
} {
  const id = modelId ?? DEFAULT_LOCAL_EMBEDDING_MODEL;
  const modelDir = resolveModelDir();

  if (!modelDir) {
    return {
      exists: false,
      modelId: id,
      expectedPath: "(EMBEDDING_MODEL_DIR not set)",
      missingFiles: ["EMBEDDING_MODEL_DIR not configured"],
    };
  }

  const modelPath = path.join(modelDir, ...id.split("/"));

  if (!fs.existsSync(modelPath)) {
    return {
      exists: false,
      modelId: id,
      expectedPath: modelPath,
      missingFiles: ["(entire model directory missing)"],
    };
  }

  // These are the minimum files @huggingface/transformers needs
  const requiredFiles = ["config.json", "tokenizer.json"];
  const missing = requiredFiles.filter(
    (f) => !fs.existsSync(path.join(modelPath, f)),
  );

  // Also verify at least one .onnx model file exists in the directory tree
  const hasOnnxFile = (dir: string): boolean => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".onnx")) return true;
        if (entry.isDirectory()) {
          if (hasOnnxFile(path.join(dir, entry.name))) return true;
        }
      }
    } catch {
      // Ignore read errors
    }
    return false;
  };

  if (!hasOnnxFile(modelPath)) {
    missing.push("*.onnx (no ONNX model file found)");
  }

  return {
    exists: missing.length === 0,
    modelId: id,
    expectedPath: modelPath,
    missingFiles: missing,
  };
}

function resolveQueryPrefix(override?: string | null): string {
  if (override !== undefined) return override ?? "";
  if (process.env.LOCAL_EMBEDDING_QUERY_PREFIX !== undefined) {
    return process.env.LOCAL_EMBEDDING_QUERY_PREFIX;
  }
  return DEFAULT_QUERY_PREFIX;
}

function resolveQueryMaxChars(override?: number): number {
  if (Number.isFinite(override)) return Number(override);
  const envValue = process.env.LOCAL_EMBEDDING_QUERY_MAX_CHARS;
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed)) return parsed;
  }
  return DEFAULT_QUERY_MAX_CHARS;
}

function applyQueryPrefix(text: string, prefix: string, maxChars: number): string {
  if (!prefix) return text;
  if (text.length > maxChars) return text;
  return `${prefix} ${text}`.trim();
}

export function resolveTokenizerPath(cacheDir: string, modelId: string): string {
  const parts = modelId.split("/");
  return path.join(cacheDir, ...parts, "tokenizer.json");
}

export function patchTokenizerMerges(tokenizerPath: string): boolean {
  if (!tokenizerPath || !fs.existsSync(tokenizerPath)) {
    return false;
  }
  const raw = fs.readFileSync(tokenizerPath, "utf8");
  const data = JSON.parse(raw);
  const merges = data?.merges ?? data?.model?.merges;
  if (!Array.isArray(merges) || merges.length === 0) {
    return false;
  }
  if (!Array.isArray(merges[0])) {
    return false;
  }
  const converted = merges.map((pair) => pair.join(" "));
  if (data.merges) {
    data.merges = converted;
  } else if (data.model) {
    data.model.merges = converted;
  }
  fs.writeFileSync(tokenizerPath, JSON.stringify(data));
  return true;
}

async function loadPipelineWithPatch(
  modelId: string,
  cacheDir: string,
  dtype: LocalEmbeddingDtype
): Promise<FeatureExtractionPipeline> {
  const { pipeline } = await import("@huggingface/transformers");
  const preferredDevice = resolvePreferredDevice();

  const tryLoad = async (device: TransformerDevice): Promise<FeatureExtractionPipeline> => {
    try {
      return (await pipeline("feature-extraction", modelId, {
        device,
        dtype,
      })) as unknown as FeatureExtractionPipeline;
    } catch (error) {
      const message = String(error);
      if (message.includes("x.split is not a function")) {
        const tokenizerPath = resolveTokenizerPath(cacheDir, modelId);
        if (patchTokenizerMerges(tokenizerPath)) {
          return (await pipeline("feature-extraction", modelId, {
            device,
            dtype,
          })) as unknown as FeatureExtractionPipeline;
        }
      }
      throw error;
    }
  };

  try {
    return await tryLoad(preferredDevice);
  } catch (error) {
    if (preferredDevice !== "cpu") {
      console.warn(
        `[LocalEmbeddings] Failed to initialize on device "${preferredDevice}", falling back to cpu:`,
        error
      );
      return tryLoad("cpu");
    }

    // Enrich the error with M4-specific guidance if applicable
    const baseMsg = error instanceof Error ? error.message : String(error);
    if (isM4OrLater()) {
      const info = detectAppleSiliconInfo();
      throw new Error(
        `[LocalEmbeddings] ONNX pipeline failed on ${info.chipModel ?? "Apple M4"}. ` +
        `Known fix: upgrade @huggingface/transformers to >=4.0.1 and onnxruntime-node to >=1.24.3. ` +
        `Quick workaround: switch to OpenRouter embeddings in Settings → Embedding Provider, ` +
        `or set LOCAL_EMBEDDING_DEVICE=wasm in your .env file. ` +
        `Original error: ${baseMsg}`
      );
    }

    if (detectAppleSiliconInfo().isAppleSilicon) {
      console.warn(
        `[LocalEmbeddings] Pipeline failed on Apple Silicon. If running M4, upgrade onnxruntime-node to >=1.24.3.`
      );
    }

    throw error;
  }
}

async function getPipeline(options: LocalEmbeddingOptions): Promise<FeatureExtractionPipeline> {
  const modelId = options.modelId ?? DEFAULT_LOCAL_EMBEDDING_MODEL;
  const cacheDir = resolveCacheDir(options.cacheDir);
  const modelDir = resolveModelDir(options.modelDir);
  const allowRemoteModels = options.allowRemoteModels ?? !modelDir;
  const dtype = resolveEmbeddingDtype(options.dtype);

  // Validate model completeness before attempting to load (prevents server crash)
  if (!allowRemoteModels) {
    const validation = validateLocalModelExists(modelId);
    if (!validation.exists) {
      // Check if download is in progress (only if we have a real path)
      const hasRealPath = validation.expectedPath && !validation.expectedPath.startsWith('(');
      const lockPath = hasRealPath ? path.join(validation.expectedPath, '_downloading.lock') : null;
      if (lockPath && fs.existsSync(lockPath)) {
        throw new Error(
          `Embedding model "${modelId}" is still downloading. Please wait for the download to complete before indexing files.`
        );
      }
      throw new Error(
        `Embedding model "${modelId}" is incomplete or not downloaded. ` +
        `Missing files: ${validation.missingFiles.join(', ')}. ` +
        `Expected path: ${validation.expectedPath}. ` +
        `Please download the model from Settings > Embedding before using local embeddings.`
      );
    }
  }

  const preferredDevice = resolvePreferredDevice();
  const cacheKey = [
    modelId,
    cacheDir,
    modelDir ?? "",
    allowRemoteModels ? "remote" : "local",
    preferredDevice,
    dtype,
  ].join("|");

  if (cachedPipelinePromise && cachedPipelineKey === cacheKey) {
    return cachedPipelinePromise;
  }

  cachedPipelineKey = cacheKey;
  cachedPipelinePromise = (async () => {
    const { env } = await import("@huggingface/transformers");
    env.cacheDir = cacheDir;
    env.useBrowserCache = false;
    env.allowLocalModels = true;
    env.allowRemoteModels = allowRemoteModels;
    if (modelDir) {
      env.localModelPath = modelDir;
      if (!fs.existsSync(modelDir)) {
        console.warn(`[LocalEmbeddings] Model dir not found: ${modelDir}`);
      }
    }

    return loadPipelineWithPatch(modelId, cacheDir, dtype);
  })();

  return cachedPipelinePromise;
}

function toEmbeddings(output: unknown, expectedCount: number): EmbeddingModelV2Embedding[] {
  if (!output) return [];

  if (Array.isArray(output)) {
    return (output as Array<Array<number>>).map((row) =>
      row.map((value) => Number(value))
    );
  }

  const tensor = output as { data?: Float32Array | Float64Array | number[]; dims?: number[] };
  if (!tensor.data || !tensor.dims) {
    return [];
  }

  if (tensor.dims.length !== 2) {
    throw new Error(`Unexpected embedding dims: ${tensor.dims.join("x")}`);
  }

  const [rows, cols] = tensor.dims;
  if (rows !== expectedCount) {
    throw new Error(`Embedding count mismatch: expected ${expectedCount}, got ${rows}`);
  }

  const data = Array.from(tensor.data);
  const embeddings: EmbeddingModelV2Embedding[] = [];
  for (let i = 0; i < rows; i += 1) {
    const start = i * cols;
    embeddings.push(data.slice(start, start + cols));
  }
  return embeddings;
}

export interface ValidationResult {
  success: boolean;
  durationMs: number;
  /** Embedding dimensions returned by the model (0 on failure). */
  dims: number;
  error?: string;
}

/**
 * Run a minimal test embedding to confirm the ONNX pipeline is functional.
 *
 * Safe to call after model download; it creates a temporary model instance
 * so it doesn't pollute the shared pipeline cache.
 */
export async function runValidationEmbedding(
  options: LocalEmbeddingOptions = {}
): Promise<ValidationResult> {
  const start = Date.now();
  try {
    const model = createLocalEmbeddingModel(options);
    const result = await model.doEmbed({ values: ["Selene validation probe"] });
    const dims = result.embeddings[0]?.length ?? 0;
    if (dims === 0) throw new Error("Zero-dimension embedding returned");
    return { success: true, durationMs: Date.now() - start, dims };
  } catch (err) {
    return {
      success: false,
      durationMs: Date.now() - start,
      dims: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function createLocalEmbeddingModel(
  options: LocalEmbeddingOptions = {}
): EmbeddingModelV2<string> {
  const modelId = options.modelId ?? DEFAULT_LOCAL_EMBEDDING_MODEL;
  const queryPrefix = resolveQueryPrefix(options.queryPrefix ?? null);
  const queryMaxChars = resolveQueryMaxChars(options.queryPrefixMaxChars);

  return {
    specificationVersion: "v2",
    provider: "local",
    modelId,
    maxEmbeddingsPerCall: DEFAULT_MAX_BATCH,
    supportsParallelCalls: false,
    async doEmbed({ values }) {
      if (!values.length) {
        return { embeddings: [] };
      }

      const previousLock = embeddingLock;
      let releaseLock: (() => void) | undefined;
      embeddingLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      await previousLock;

      try {
        const texts = values.map((value) => applyQueryPrefix(String(value), queryPrefix, queryMaxChars));
        let pipeline = await getPipeline({ ...options, modelId });
        let output: unknown;
        try {
          output = await pipeline(texts, { pooling: "mean", normalize: true });
        } catch (error) {
          if (!isRecoverableGpuRuntimeError(error) || resolvePreferredDevice() === "cpu") {
            throw error;
          }

          console.warn(
            '[LocalEmbeddings] GPU runtime error detected; switching local embeddings to CPU for this process:',
            error
          );
          runtimeFallbackDevice = "cpu";
          resetPipelineCache();
          pipeline = await getPipeline({ ...options, modelId });
          output = await pipeline(texts, { pooling: "mean", normalize: true });
        }

        const embeddings = toEmbeddings(output, values.length);

        return {
          embeddings,
          usage: { tokens: 0, totalTokens: 0 },
          warnings: [],
        };
      } finally {
        releaseLock?.();
      }
    },
  };
}

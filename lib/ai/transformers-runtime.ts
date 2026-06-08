import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export interface TransformersRuntimeModule {
  env: {
    cacheDir?: string;
    useBrowserCache?: boolean;
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
    localModelPath?: string;
  };
  pipeline: (...args: any[]) => Promise<unknown>;
  AutoTokenizer?: unknown;
}

let cachedTransformers: Promise<TransformersRuntimeModule> | null = null;

function resolvePackagedTransformersEntry(): string | null {
  const override = process.env.SELENE_TRANSFORMERS_RUNTIME_PATH;
  if (override && fs.existsSync(override)) return override;

  const resourcesPath = process.resourcesPath ?? process.env.ELECTRON_RESOURCES_PATH;
  if (!resourcesPath) return null;

  const candidate = path.join(
    resourcesPath,
    "standalone",
    "node_modules",
    "@huggingface",
    "transformers",
    "dist",
    "transformers.node.cjs"
  );

  return fs.existsSync(candidate) ? candidate : null;
}

async function importPackageTransformers(): Promise<TransformersRuntimeModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<TransformersRuntimeModule>;
  return dynamicImport("@huggingface/transformers");
}

export async function loadTransformersRuntime(): Promise<TransformersRuntimeModule> {
  cachedTransformers ??= (async () => {
    const packagedEntry = resolvePackagedTransformersEntry();
    if (packagedEntry) {
      const requireFromRuntime = createRequire(path.join(process.cwd(), "transformers-runtime.js"));
      return requireFromRuntime(packagedEntry) as TransformersRuntimeModule;
    }

    return importPackageTransformers();
  })();

  return cachedTransformers;
}

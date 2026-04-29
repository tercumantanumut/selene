import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export interface HuggingFaceHubRuntimeModule {
  listFiles: (...args: any[]) => AsyncIterable<{ type?: string; path: string; size?: number }>;
  downloadFile: (...args: any[]) => Promise<Blob | null>;
}

let cachedHub: HuggingFaceHubRuntimeModule | null = null;

function resolvePackagedHubEntry(): string | null {
  const override = process.env.SELENE_HF_HUB_RUNTIME_PATH;
  if (override && fs.existsSync(override)) return override;

  const resourcesPath = process.resourcesPath ?? process.env.ELECTRON_RESOURCES_PATH;
  if (!resourcesPath) return null;

  const candidate = path.join(
    resourcesPath,
    "standalone",
    "node_modules",
    "@huggingface",
    "hub",
    "dist",
    "index.js"
  );

  return fs.existsSync(candidate) ? candidate : null;
}

export function loadHuggingFaceHubRuntime(): HuggingFaceHubRuntimeModule {
  if (cachedHub) return cachedHub;

  const requireFromRuntime = createRequire(path.join(process.cwd(), "huggingface-hub-runtime.js"));
  const packagedEntry = resolvePackagedHubEntry();
  cachedHub = requireFromRuntime(packagedEntry ?? "@huggingface/hub") as HuggingFaceHubRuntimeModule;
  return cachedHub;
}

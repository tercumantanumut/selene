import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

interface TokenizerRuntimeModule {
  encode: (text: string) => number[];
  decode: (tokens: number[]) => string;
}

let cachedTokenizer: TokenizerRuntimeModule | null = null;

function resolvePackagedTokenizerEntry(): string | null {
  const override = process.env.SELENE_GPT_TOKENIZER_RUNTIME_PATH;
  if (override && fs.existsSync(override)) return override;

  const resourcesPath = process.resourcesPath ?? process.env.ELECTRON_RESOURCES_PATH;
  if (!resourcesPath) return null;

  const candidate = path.join(
    resourcesPath,
    "standalone",
    "node_modules",
    "gpt-tokenizer",
    "cjs",
    "encoding",
    "o200k_base.js"
  );

  return fs.existsSync(candidate) ? candidate : null;
}

export function loadTokenizerRuntime(): TokenizerRuntimeModule {
  if (cachedTokenizer) return cachedTokenizer;

  const packagedEntry = resolvePackagedTokenizerEntry();
  if (packagedEntry) {
    const requireFromRuntime = createRequire(path.join(process.cwd(), "tokenizer-runtime.js"));
    cachedTokenizer = requireFromRuntime(packagedEntry) as TokenizerRuntimeModule;
    return cachedTokenizer;
  }

  const requireFromRuntime = createRequire(path.join(process.cwd(), "package.json"));
  cachedTokenizer = requireFromRuntime("gpt-tokenizer/encoding/o200k_base") as TokenizerRuntimeModule;
  return cachedTokenizer;
}

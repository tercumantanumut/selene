import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

type PdfParseModule = Record<string, unknown>;

let cachedPdfParse: PdfParseModule | null = null;

function resolvePackagedPdfParseEntry(): string | null {
  const override = process.env.SELENE_PDF_PARSE_RUNTIME_PATH;
  if (override && fs.existsSync(override)) return override;

  const resourcesPath = process.resourcesPath ?? process.env.ELECTRON_RESOURCES_PATH;
  if (!resourcesPath) return null;

  const candidate = path.join(
    resourcesPath,
    "standalone",
    "node_modules",
    "pdf-parse",
    "dist",
    "pdf-parse",
    "cjs",
    "index.cjs"
  );

  return fs.existsSync(candidate) ? candidate : null;
}

export async function loadPdfParseRuntime(): Promise<PdfParseModule> {
  if (cachedPdfParse) return cachedPdfParse;

  const packagedEntry = resolvePackagedPdfParseEntry();
  if (packagedEntry) {
    const requireFromRuntime = createRequire(path.join(process.cwd(), "pdf-parse-runtime.js"));
    cachedPdfParse = requireFromRuntime(packagedEntry) as PdfParseModule;
    return cachedPdfParse;
  }

  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<PdfParseModule>;
  cachedPdfParse = await dynamicImport("pdf-parse");
  return cachedPdfParse;
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const GITHUB_API_RELEASES = "https://api.github.com/repos/openai/codex/releases/latest";
const GITHUB_HTML_RELEASES = "https://github.com/openai/codex/releases/latest";

const CACHE_TTL_MS = 15 * 60 * 1000;

type CacheMetadata = {
  etag: string | null;
  tag: string | null;
  lastChecked: number;
  url: string;
};

type CodexModelFamily =
  | "gpt-6-astra"
  | "gpt-5.5"
  | "gpt-5.4"
  | "gpt-5.2-codex"
  | "codex-max"
  | "codex"
  | "gpt-5.2"
  | "gpt-5.1";

// Paths are relative to `codex-rs/` in the openai/codex release tag.
const PROMPT_FILES: Record<CodexModelFamily, string> = {
  // GPT-6 Astra ships with `base_instructions: null` in openai/codex
  // models-manager/models.json, so the CLI uses the shared models-manager
  // base prompt for it.
  "gpt-6-astra": "models-manager/prompt.md",
  // GPT-5.5 doesn't have its own prompt file in the openai/codex repo yet;
  // fall back to the gpt-5.2-codex prompt (same fallback used for 5.4).
  "gpt-5.5": "core/gpt-5.2-codex_prompt.md",
  // GPT-5.4 doesn't have its own prompt file yet; fall back to gpt-5.2-codex prompt
  "gpt-5.4": "core/gpt-5.2-codex_prompt.md",
  "gpt-5.2-codex": "core/gpt-5.2-codex_prompt.md",
  "codex-max": "core/gpt-5.1-codex-max_prompt.md",
  "codex": "core/gpt_5_codex_prompt.md",
  "gpt-5.2": "core/gpt_5_2_prompt.md",
  "gpt-5.1": "core/gpt_5_1_prompt.md",
};

const CACHE_FILES: Record<CodexModelFamily, string> = {
  "gpt-6-astra": "gpt-6-astra-instructions.md",
  "gpt-5.5": "gpt-5.5-instructions.md",
  "gpt-5.4": "gpt-5.4-instructions.md",
  "gpt-5.2-codex": "gpt-5.2-codex-instructions.md",
  "codex-max": "codex-max-instructions.md",
  "codex": "codex-instructions.md",
  "gpt-5.2": "gpt-5.2-instructions.md",
  "gpt-5.1": "gpt-5.1-instructions.md",
};

function getCacheDir(): string {
  const baseDir = process.env.LOCAL_DATA_PATH || join(process.cwd(), ".local-data");
  return join(baseDir, "codex-cache");
}

function getModelFamily(normalizedModel: string): CodexModelFamily {
  if (normalizedModel.includes("gpt-6-astra") || normalizedModel.includes("gpt 6 astra")) {
    return "gpt-6-astra";
  }
  if (normalizedModel.includes("gpt-5.5") || normalizedModel.includes("gpt 5.5")) {
    return "gpt-5.5";
  }
  if (normalizedModel.includes("gpt-5.4") || normalizedModel.includes("gpt 5.4")) {
    return "gpt-5.4";
  }
  if (normalizedModel.includes("gpt-5.3-codex") || normalizedModel.includes("gpt 5.3 codex")) {
    return "gpt-5.2-codex";
  }
  if (normalizedModel.includes("gpt-5.2-codex") || normalizedModel.includes("gpt 5.2 codex")) {
    return "gpt-5.2-codex";
  }
  if (normalizedModel.includes("codex-max")) {
    return "codex-max";
  }
  if (normalizedModel.includes("codex") || normalizedModel.startsWith("codex-")) {
    return "codex";
  }
  if (normalizedModel.includes("gpt-5.2")) {
    return "gpt-5.2";
  }
  return "gpt-5.1";
}

async function getLatestReleaseTag(): Promise<string> {
  try {
    const response = await fetch(GITHUB_API_RELEASES);
    if (response.ok) {
      const data = (await response.json()) as { tag_name?: string };
      if (data.tag_name) {
        return data.tag_name;
      }
    }
  } catch {
    // Fall back to HTML parsing.
  }

  const htmlResponse = await fetch(GITHUB_HTML_RELEASES);
  if (!htmlResponse.ok) {
    throw new Error(`Failed to fetch latest release: ${htmlResponse.status}`);
  }

  const finalUrl = htmlResponse.url;
  if (finalUrl) {
    const parts = finalUrl.split("/tag/");
    const last = parts[parts.length - 1];
    if (last && !last.includes("/")) {
      return last;
    }
  }

  const html = await htmlResponse.text();
  const match = html.match(/\/openai\/codex\/releases\/tag\/([^"]+)/);
  if (match?.[1]) {
    return match[1];
  }

  throw new Error("Failed to determine latest release tag from GitHub");
}

export async function getCodexInstructions(
  normalizedModel = "gpt-5.4",
): Promise<string> {
  const modelFamily = getModelFamily(normalizedModel);
  const cacheDir = getCacheDir();
  const cacheFile = join(cacheDir, CACHE_FILES[modelFamily]);
  const cacheMetaFile = join(cacheDir, `${CACHE_FILES[modelFamily].replace(".md", "-meta.json")}`);

  try {
    let cachedETag: string | null = null;
    let cachedTag: string | null = null;
    let cachedTimestamp: number | null = null;

    if (existsSync(cacheMetaFile)) {
      const metadata = JSON.parse(readFileSync(cacheMetaFile, "utf8")) as CacheMetadata;
      cachedETag = metadata.etag;
      cachedTag = metadata.tag;
      cachedTimestamp = metadata.lastChecked;
    }

    if (
      cachedTimestamp &&
      Date.now() - cachedTimestamp < CACHE_TTL_MS &&
      existsSync(cacheFile)
    ) {
      return readFileSync(cacheFile, "utf8");
    }

    const latestTag = await getLatestReleaseTag();
    const promptFile = PROMPT_FILES[modelFamily];
    const instructionsUrl = `https://raw.githubusercontent.com/openai/codex/${latestTag}/codex-rs/${promptFile}`;

    if (cachedTag !== latestTag) {
      cachedETag = null;
    }

    const headers: Record<string, string> = {};
    if (cachedETag) {
      headers["If-None-Match"] = cachedETag;
    }

    const response = await fetch(instructionsUrl, { headers });

    if (response.status === 304 && existsSync(cacheFile)) {
      return readFileSync(cacheFile, "utf8");
    }

    if (response.ok) {
      const instructions = await response.text();
      const newETag = response.headers.get("etag");

      if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true });
      }

      writeFileSync(cacheFile, instructions, "utf8");
      writeFileSync(
        cacheMetaFile,
        JSON.stringify({
          etag: newETag,
          tag: latestTag,
          lastChecked: Date.now(),
          url: instructionsUrl,
        } satisfies CacheMetadata),
        "utf8",
      );

      return instructions;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[CodexInstructions] Failed to fetch ${modelFamily}:`, message);
  }

  if (existsSync(cacheFile)) {
    return readFileSync(cacheFile, "utf8");
  }

  return "";
}

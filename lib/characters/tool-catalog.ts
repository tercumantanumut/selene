export type ToolDependency =
  | "syncedFolders"
  | "embeddings"
  | "vectorDbEnabled"
  | "webScraper"
  | "openrouterKey"
  | "comfyuiEnabled"
  | "localGrepEnabled"
  | "devWorkspaceEnabled"
  | "runwayApiSecret"
  | "vertexAIProjectId";

export type CharacterToolCatalogItem = {
  id: string;
  category: string;
  dependencies?: ToolDependency[];
  displayName?: string;
  description?: string;
};

type RegistryToolCatalogItem = {
  id: string;
  category: string;
  displayName: string;
  description: string;
};

/**
 * Legacy single-action image tools and broad aggregate wrappers remain registered
 * for backwards compatibility and direct execution, but character tool selection
 * exposes per-provider/model multi-action tools instead.
 */
export const HIDDEN_CHARACTER_TOOL_IDS = new Set<string>([
  "generateImageFlux2Flex",
  "editImageFlux2Flex",
  "referenceImageFlux2Flex",
  "generateImageFlux2Pro",
  "editImageFlux2Pro",
  "referenceImageFlux2Pro",
  "generateImageFlux2Max",
  "editImageFlux2Max",
  "referenceImageFlux2Max",
  "generateImageFlux2Klein4B",
  "editImageFlux2Klein4B",
  "referenceImageFlux2Klein4B",
  "generateImageGpt5Mini",
  "editImageGpt5Mini",
  "referenceImageGpt5Mini",
  "generateImageGpt5",
  "editImageGpt5",
  "referenceImageGpt5",
  "generateImageGpt54Image2",
  "editImageGpt54Image2",
  "referenceImageGpt54Image2",
  "generateImageGemini31Flash",
  "editImageGemini31Flash",
  "referenceImageGemini31Flash",
  "generateImageGemini3Pro",
  "editImageGemini3Pro",
  "referenceImageGemini3Pro",
  "generateImageGrokImagine",
  "editImageGrokImagine",
  "referenceImageGrokImagine",
  "generateImageSeedream45",
  "editImageSeedream45",
  "referenceImageSeedream45",
  "generateImageGptImage2",
  "editImageGptImage2",
  "referenceImageGptImage2",
  "openRouterImage",
  "openRouterVideo",
]);

/**
 * Shared base catalog for character picker and creation wizard capabilities.
 */
export const CHARACTER_TOOL_CATALOG: CharacterToolCatalogItem[] = [
  { id: "vectorSearch", category: "knowledge", dependencies: ["syncedFolders", "embeddings", "vectorDbEnabled"] },
  { id: "readFile", category: "knowledge", dependencies: ["syncedFolders"] },
  { id: "editFile", category: "knowledge", dependencies: ["syncedFolders"] },
  { id: "writeFile", category: "knowledge", dependencies: ["syncedFolders"] },
  { id: "patchFile", category: "knowledge", dependencies: ["syncedFolders"] },
  { id: "localGrep", category: "knowledge", dependencies: ["syncedFolders", "localGrepEnabled"] },
  { id: "promptLibrary", category: "knowledge" },
  { id: "webSearch", category: "search" },
  { id: "firecrawlCrawl", category: "search", dependencies: ["webScraper"] },
  { id: "describeImage", category: "analysis" },
  { id: "showProductImages", category: "utility" },
  { id: "bash", category: "utility", dependencies: ["syncedFolders"] },
  { id: "executeCommand", category: "utility", dependencies: ["syncedFolders"] },
  { id: "scheduleTask", category: "scheduling" },
  { id: "skill", category: "utility" },
  { id: "memorize", category: "utility" },
  { id: "calculator", category: "utility" },
  { id: "updatePlan", category: "utility" },
  { id: "searchSessions", category: "utility" },
  { id: "compactSession", category: "utility" },
  { id: "sendMessageToChannel", category: "utility" },
  { id: "delegateToSubagent", category: "utility" },
  { id: "askUserQuestion", category: "utility" },
  { id: "speakAloud", category: "utility" },
  { id: "transcribe", category: "utility" },
  { id: "workspace", category: "utility", dependencies: ["devWorkspaceEnabled"] },
  { id: "chromiumWorkspace", category: "browser" },
  { id: "ghostOs", category: "computer-use", displayName: "Ghost OS", description: "macOS desktop automation via accessibility tree — click, type, scroll any app" },
  { id: "openRouterImageFlux2Flex", category: "image-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Image — Flux.2 Flex", description: "Generate, edit, and reference with Flux.2 Flex; strong text/typography rendering" },
  { id: "openRouterImageFlux2Pro", category: "image-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Image — Flux.2 Pro", description: "Generate, edit, and reference with Flux.2 Pro; photorealism and up to 4MP output" },
  { id: "openRouterImageFlux2Max", category: "image-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Image — Flux.2 Max", description: "Generate, edit, and reference with Flux.2 Max; top-tier Flux quality" },
  { id: "openRouterImageFlux2Klein4B", category: "image-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Image — Flux.2 Klein 4B", description: "Generate, edit, and reference with Flux.2 Klein 4B; fastest and most cost-effective Flux option" },
  { id: "openRouterImageGpt5Mini", category: "image-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Image — GPT-5 Image Mini", description: "Generate, edit, and reference with GPT-5 Image Mini; fast OpenAI image workflows" },
  { id: "openRouterImageGpt5", category: "image-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Image — GPT-5 Image", description: "Generate, edit, and reference with GPT-5 Image; premium OpenAI image quality" },
  { id: "openRouterImageGpt54Image2", category: "image-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Image — GPT-5.4 Image 2", description: "Generate, edit, and reference with GPT-5.4 Image 2; reasoning-backed OpenAI image workflows" },
  { id: "openRouterImageGemini31Flash", category: "image-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Image — Nano Banana 2", description: "Generate, edit, and reference with Gemini 3.1 Flash Image; high quality at Flash speed" },
  { id: "openRouterImageGemini3Pro", category: "image-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Image — Gemini 3 Pro", description: "Generate, edit, and reference with Gemini 3 Pro Image; advanced detailed image work" },
  { id: "openRouterImageGrokImagine", category: "image-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Image — Grok Imagine", description: "Generate, edit, and reference with Grok Imagine; photorealism, brands, named entities, and multilingual text" },
  { id: "openRouterImageSeedream45", category: "image-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Image — Seedream 4.5", description: "Generate, edit, and reference with Seedream 4.5; editing consistency and multi-image composition" },
  {
    id: "codexImage",
    category: "image-generation",
    displayName: "Codex Image (gpt-image-2)",
    description: "Unified image tool for generate, edit, and reference workflows with OpenAI gpt-image-2 via Codex",
  },
  { id: "openRouterVideoGrokImagine", category: "video-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Video — Grok Imagine", description: "Text-to-video, image-to-video, and reference-to-video; 1-15s at 24fps" },
  { id: "openRouterVideoKlingV3Pro", category: "video-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Video — Kling v3.0 Pro", description: "Premium text/image video with first-frame and last-frame controls, 3-15s, optional audio" },
  { id: "openRouterVideoKlingV3Standard", category: "video-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Video — Kling v3.0 Standard", description: "Balanced text/image video with first-frame and last-frame controls, 3-15s" },
  { id: "openRouterVideoKlingO1", category: "video-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Video — Kling O1", description: "Cinematic text/image video with first-frame and last-frame controls, 5-10s" },
  { id: "openRouterVideoVeo31Fast", category: "video-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Video — Veo 3.1 Fast", description: "Google Veo fast model with native audio and first-frame/last-frame controls" },
  { id: "openRouterVideoVeo31Lite", category: "video-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Video — Veo 3.1 Lite", description: "Cost-effective Google Veo text/image video with native audio, 4-8s" },
  { id: "openRouterVideoHailuo23", category: "video-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Video — Hailuo 2.3", description: "Realistic motion and character animation for text/image video" },
  { id: "openRouterVideoSeedance20Fast", category: "video-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Video — Seedance 2.0 Fast", description: "Speed-prioritized text/image video with first-frame and last-frame controls" },
  { id: "openRouterVideoSeedance20", category: "video-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Video — Seedance 2.0", description: "Character consistency, camera control, references, and first-frame/last-frame controls" },
  { id: "openRouterVideoWan27", category: "video-generation", dependencies: ["openrouterKey"], displayName: "OpenRouter Video — Wan 2.7", description: "Text/image/reference video with first-frame and last-frame controls" },
  { id: "generateImageZImage", category: "image-generation", dependencies: ["comfyuiEnabled"] },
  { id: "generateVideoRunway", category: "video-generation", dependencies: ["runwayApiSecret"] },
  { id: "generateVideoVertexAI", category: "video-generation", dependencies: ["vertexAIProjectId"] },
];

export function mergeCharacterToolCatalog(
  baseTools: CharacterToolCatalogItem[],
  registryTools: RegistryToolCatalogItem[],
  options?: { excludeMcp?: boolean }
): CharacterToolCatalogItem[] {
  const merged = new Map<string, CharacterToolCatalogItem>();
  for (const tool of baseTools) {
    if (!HIDDEN_CHARACTER_TOOL_IDS.has(tool.id)) {
      merged.set(tool.id, tool);
    }
  }

  for (const tool of registryTools) {
    if (HIDDEN_CHARACTER_TOOL_IDS.has(tool.id)) continue;
    if (options?.excludeMcp && (tool.category === "mcp" || tool.id.startsWith("mcp_"))) {
      continue;
    }

    const existing = merged.get(tool.id);
    if (!existing) {
      merged.set(tool.id, {
        id: tool.id,
        category: tool.category,
        displayName: tool.displayName,
        description: tool.description,
      });
      continue;
    }

    merged.set(tool.id, {
      ...existing,
      category: existing.category || tool.category,
      displayName:
        existing.displayName && existing.displayName !== existing.id
          ? existing.displayName
          : tool.displayName,
      description:
        existing.description && existing.description.length > 0
          ? existing.description
          : tool.description,
    });
  }

  return Array.from(merged.values());
}

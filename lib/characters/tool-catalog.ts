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
  { id: "generateImageFlux2Flex", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "editImageFlux2Flex", category: "image-editing", dependencies: ["openrouterKey"] },
  { id: "referenceImageFlux2Flex", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "generateImageFlux2Pro", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "editImageFlux2Pro", category: "image-editing", dependencies: ["openrouterKey"] },
  { id: "referenceImageFlux2Pro", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "generateImageFlux2Max", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "editImageFlux2Max", category: "image-editing", dependencies: ["openrouterKey"] },
  { id: "referenceImageFlux2Max", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "generateImageFlux2Klein4B", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "editImageFlux2Klein4B", category: "image-editing", dependencies: ["openrouterKey"] },
  { id: "referenceImageFlux2Klein4B", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "generateImageGpt5Mini", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "editImageGpt5Mini", category: "image-editing", dependencies: ["openrouterKey"] },
  { id: "referenceImageGpt5Mini", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "generateImageGpt5", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "editImageGpt5", category: "image-editing", dependencies: ["openrouterKey"] },
  { id: "referenceImageGpt5", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "generateImageGpt54Image2", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "editImageGpt54Image2", category: "image-editing", dependencies: ["openrouterKey"] },
  { id: "referenceImageGpt54Image2", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "generateImageGemini31Flash", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "editImageGemini31Flash", category: "image-editing", dependencies: ["openrouterKey"] },
  { id: "referenceImageGemini31Flash", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "generateImageGemini3Pro", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "editImageGemini3Pro", category: "image-editing", dependencies: ["openrouterKey"] },
  { id: "referenceImageGemini3Pro", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "generateImageGrokImagine", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "editImageGrokImagine", category: "image-editing", dependencies: ["openrouterKey"] },
  { id: "referenceImageGrokImagine", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "generateImageSeedream45", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "editImageSeedream45", category: "image-editing", dependencies: ["openrouterKey"] },
  { id: "referenceImageSeedream45", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "openRouterImage", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "codexImage", category: "image-generation", dependencies: ["openrouterKey"] },
  { id: "openRouterVideo", category: "video-generation", dependencies: ["openrouterKey"] },
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
  for (const tool of baseTools) merged.set(tool.id, tool);

  for (const tool of registryTools) {
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

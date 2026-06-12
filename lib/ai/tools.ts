// ==========================================================================
// lib/ai/tools.ts
//
// Public API barrel file. All tool creator functions are implemented in
// sub-modules under lib/ai/tools/ and re-exported here for backward
// compatibility with existing import sites.
// ==========================================================================

// Retrieve full content tool (for truncated content access)
export {
  createRetrieveFullContentTool,
} from "@/lib/ai/tools/retrieve-full-content-tool";

// Image tools (edit, describe, flux2, wan22 imagen)
export {
  createImageEditTool,
  createDescribeImageTool,
  createFlux2GenerateTool,
  createWan22ImagenTool,
} from "@/lib/ai/tools/image-tools";

// Video tools (wan22 video, wan22 pixel video)
export {
  createWan22VideoTool,
  createWan22PixelVideoTool,
} from "@/lib/ai/tools/video-tools";

// OpenRouter image tools (Flux2 Flex, GPT-5 Image Mini, GPT-5 Image,
// Gemini 2.5 Flash, Gemini 3 Pro – generate / edit / reference variants)
export {
  createOpenRouterFlux2FlexGenerate,
  createOpenRouterFlux2FlexEdit,
  createOpenRouterFlux2FlexReference,
  createOpenRouterGpt5ImageMiniGenerate,
  createOpenRouterGpt5ImageMiniEdit,
  createOpenRouterGpt5ImageMiniReference,
  createOpenRouterGpt5ImageGenerate,
  createOpenRouterGpt5ImageEdit,
  createOpenRouterGpt5ImageReference,
  createOpenRouterGemini31FlashImageGenerate,
  createOpenRouterGemini31FlashImageEdit,
  createOpenRouterGemini31FlashImageReference,
  createOpenRouterGemini3ProImageGenerate,
  createOpenRouterGemini3ProImageEdit,
  createOpenRouterGemini3ProImageReference,
  createOpenRouterFlux2ProGenerate,
  createOpenRouterFlux2ProEdit,
  createOpenRouterFlux2ProReference,
  createOpenRouterFlux2MaxGenerate,
  createOpenRouterFlux2MaxEdit,
  createOpenRouterFlux2MaxReference,
  createOpenRouterFlux2Klein4BGenerate,
  createOpenRouterFlux2Klein4BEdit,
  createOpenRouterFlux2Klein4BReference,
  createOpenRouterGpt54Image2Generate,
  createOpenRouterGpt54Image2Edit,
  createOpenRouterGpt54Image2Reference,
  createOpenRouterGrokImagineGenerate,
  createOpenRouterGrokImagineEdit,
  createOpenRouterGrokImagineReference,
  createOpenRouterSeedream45Generate,
  createOpenRouterSeedream45Edit,
  createOpenRouterSeedream45Reference,
  createOpenRouterFlux2FlexImageTool,
  createOpenRouterGpt5ImageMiniImageTool,
  createOpenRouterGpt5ImageImageTool,
  createOpenRouterGemini31FlashImageTool,
  createOpenRouterGemini3ProImageTool,
  createOpenRouterFlux2ProImageTool,
  createOpenRouterFlux2MaxImageTool,
  createOpenRouterFlux2Klein4BImageTool,
  createOpenRouterGpt54Image2ImageTool,
  createOpenRouterGrokImagineImageTool,
  createOpenRouterSeedream45ImageTool,
  createOpenRouterImageTool,
} from "@/lib/ai/tools/openrouter-image-tools";

// Codex gpt-image-2 (via the CLIProxyAPI sidecar) — generate / edit / reference.
export {
  createGenerateCodexImageTool,
  createEditCodexImageTool,
  createReferenceCodexImageTool,
  createCodexImageTool,
} from "@/lib/ai/tools/codex-image-tools";

// Runway and Vertex AI video tools

// OpenRouter video tool (Phase 3 — 10 models, async polling via /api/v1/videos)
export {
  createOpenRouterGrokImagineVideoTool,
  createOpenRouterKlingV3ProVideoTool,
  createOpenRouterKlingV3StandardVideoTool,
  createOpenRouterKlingO1VideoTool,
  createOpenRouterVeo31FastVideoTool,
  createOpenRouterVeo31LiteVideoTool,
  createOpenRouterHailuo23VideoTool,
  createOpenRouterSeedance20FastVideoTool,
  createOpenRouterSeedance20VideoTool,
  createOpenRouterWan27VideoTool,
  createOpenRouterVideoTool,
} from "@/lib/ai/tools/openrouter-video-tools";


/**
 * Web Browse Orchestrator
 *
 * Coordinates the web browsing workflow:
 * 1. Fetch web content using Firecrawl
 * 2. Store in session-scoped cache
 * 3. Synthesize answer using secondary LLM
 *
 * Returns a consolidated response - no visible sub-tool calls.
 */

import { addWebContent, setSessionRecentUrls } from "./session-store";
import { synthesizeWebContent } from "./synthesizer";
import type {
  WebBrowseOptions,
  WebBrowseEvent,
  WebBrowseEventEmitter,
  WebBrowsePhase,
} from "./types";
import { loadSettings } from "@/lib/settings/settings-manager";
import { getWebScraperProvider } from "@/lib/ai/web-scraper/provider";
import { localScrapePage } from "@/lib/ai/web-scraper/local";
import { logToolEvent } from "@/lib/ai/tool-registry/logging";

// ============================================================================
// Firecrawl Configuration
// ============================================================================

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const FIRECRAWL_TIMEOUT_MS = 120000;

function getFirecrawlApiKey(): string | undefined {
  // Ensure settings are loaded so process.env is updated (Electron standalone).
  loadSettings();
  return process.env.FIRECRAWL_API_KEY;
}

// ============================================================================
// Helper Functions
// ============================================================================

function emitPhaseChange(
  emit: WebBrowseEventEmitter,
  phase: WebBrowsePhase,
  message: string,
  url?: string
): void {
  emit({
    type: "phase_change",
    phase,
    message,
    url,
    timestamp: new Date(),
  });
}

function createAbortError(): Error {
  const error = new Error("Operation cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

// ============================================================================
// Fetch Web Content
// ============================================================================

interface FetchResult {
  success: boolean;
  url: string;
  title: string;
  content: string;
  images?: string[];
  ogImage?: string;
  error?: string;
}

// Image extension pattern for filtering URLs
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|avif|svg|bmp)([?#]|$)/i;

// Filter for likely product images (exclude tiny icons, logos, etc.)
function filterProductImages(links: string[]): string[] {
  const imageUrls = links.filter((link) => IMAGE_EXTENSIONS.test(link));
  // Filter out common non-product patterns
  return imageUrls.filter((url) => {
    const lowerUrl = url.toLowerCase();
    // Exclude common icon/logo patterns
    if (lowerUrl.includes("/icon") || lowerUrl.includes("/logo") || lowerUrl.includes("/favicon")) {
      return false;
    }
    // Exclude very small dimension indicators (often icons)
    if (/[_-](16|20|24|32|48|64)x?\d*\.(png|gif|svg)/i.test(url)) {
      return false;
    }
    return true;
  });
}

function dedupeStrings(items: string[]): string[] {
  return Array.from(new Set(items));
}

function normalizeImageUrl(candidate: string, baseUrl: string): string | null {
  const trimmed = candidate.trim().replace(/^<|>$/g, "");
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:")) {
    return null;
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractImageUrlsFromMarkdown(markdown: string, baseUrl: string): string[] {
  if (!markdown) return [];

  const urls: string[] = [];
  const markdownImageRegex = /!\[[^\]]*]\(([^)]+)\)/g;
  const htmlImageRegex = /<img[^>]+(?:src|data-src|data-original)=["']([^"']+)["'][^>]*>/gi;
  const srcsetRegex = /srcset=["']([^"']+)["']/gi;

  for (const match of markdown.matchAll(markdownImageRegex)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const urlPart = raw.split(/\s+/)[0];
    const normalized = normalizeImageUrl(urlPart, baseUrl);
    if (normalized) urls.push(normalized);
  }

  for (const match of markdown.matchAll(htmlImageRegex)) {
    const normalized = normalizeImageUrl(match[1], baseUrl);
    if (normalized) urls.push(normalized);
  }

  for (const match of markdown.matchAll(srcsetRegex)) {
    const srcset = match[1];
    if (!srcset) continue;
    for (const part of srcset.split(",")) {
      const urlPart = part.trim().split(/\s+/)[0];
      const normalized = normalizeImageUrl(urlPart, baseUrl);
      if (normalized) urls.push(normalized);
    }
  }

  return dedupeStrings(urls);
}

async function fetchWebContent(
  url: string,
  sessionId?: string,
  abortSignal?: AbortSignal
): Promise<FetchResult> {
  const provider = getWebScraperProvider();
  const startTime = Date.now();
  throwIfAborted(abortSignal);

  // Log start event to observability system
  logToolEvent({
    level: "info",
    toolName: "webBrowse.fetchContent",
    sessionId,
    event: "start",
    args: { url, provider },
  });

  if (provider === "local") {
    try {
      const localResult = await localScrapePage(url, { onlyMainContent: true });
      throwIfAborted(abortSignal);
      const title = localResult.title || new URL(url).hostname;

      const imageCandidates = localResult.images.length > 0 ? localResult.images : localResult.links;
      const images = filterProductImages(imageCandidates);
      const durationMs = Date.now() - startTime;

      // Log success with detailed extraction metadata
      logToolEvent({
        level: "info",
        toolName: "webBrowse.fetchContent",
        sessionId,
        event: "success",
        durationMs,
        result: {
          provider: "local",
          url,
          title,
          contentLength: localResult.markdown.length,
          rawImagesExtracted: localResult.images.length,
          rawLinksExtracted: localResult.links.length,
          imageCandidateSource: localResult.images.length > 0 ? "images" : "links",
          imageCandidatesCount: imageCandidates.length,
          filteredImagesCount: images.length,
          hasOgImage: !!localResult.ogImage,
          sampleImages: images.slice(0, 3),
        },
      });

      return {
        success: true,
        url,
        title,
        content: localResult.markdown,
        images: images.length > 0 ? images : undefined,
        ogImage: localResult.ogImage,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown fetch error";

      // Log error event
      logToolEvent({
        level: "error",
        toolName: "webBrowse.fetchContent",
        sessionId,
        event: "error",
        durationMs,
        error: errorMessage,
        metadata: { url, provider: "local" },
      });

      return {
        success: false,
        url,
        title: "",
        content: "",
        error: errorMessage,
      };
    }
  }

  // Firecrawl provider
  const apiKey = getFirecrawlApiKey();
  if (!apiKey) {
    logToolEvent({
      level: "error",
      toolName: "webBrowse.fetchContent",
      sessionId,
      event: "error",
      durationMs: Date.now() - startTime,
      error: "Firecrawl API key not configured",
      metadata: { url, provider: "firecrawl" },
    });
    return {
      success: false,
      url,
      title: "",
      content: "",
      error: "Firecrawl API key not configured",
    };
  }

  try {
    const response = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown", "links"],
        onlyMainContent: true,
        timeout: FIRECRAWL_TIMEOUT_MS,
      }),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const durationMs = Date.now() - startTime;
      logToolEvent({
        level: "error",
        toolName: "webBrowse.fetchContent",
        sessionId,
        event: "error",
        durationMs,
        error: `Firecrawl API error: ${response.status} - ${errorText.slice(0, 200)}`,
        metadata: { url, provider: "firecrawl", statusCode: response.status },
      });
      return {
        success: false,
        url,
        title: "",
        content: "",
        error: `Failed to fetch: ${response.status}`,
      };
    }

    const data = await response.json();
    const markdown = data.data?.markdown || "";
    const title = data.data?.metadata?.title || new URL(url).hostname;
    const ogImage = data.data?.metadata?.ogImage;
    const links: string[] = data.data?.links || [];
    const apiImages: string[] = data.data?.images || data.data?.metadata?.images || [];
    const markdownImages = extractImageUrlsFromMarkdown(markdown, url);
    const imageCandidates = dedupeStrings([
      ...links,
      ...apiImages,
      ...markdownImages,
    ])
      .map((link) => normalizeImageUrl(link, url))
      .filter((link): link is string => Boolean(link));
    const images = filterProductImages(imageCandidates);
    const durationMs = Date.now() - startTime;

    // Log success with detailed metadata
    logToolEvent({
      level: "info",
      toolName: "webBrowse.fetchContent",
      sessionId,
      event: "success",
      durationMs,
      result: {
        provider: "firecrawl",
        url,
        title,
        contentLength: markdown.length,
        rawLinksExtracted: links.length,
        filteredImagesCount: images.length,
        hasOgImage: !!ogImage,
        sampleImages: images.slice(0, 3),
      },
    });

    return {
      success: true,
      url,
      title,
      content: markdown,
      images: images.length > 0 ? images : undefined,
      ogImage,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : "Unknown fetch error";

    logToolEvent({
      level: "error",
      toolName: "webBrowse.fetchContent",
      sessionId,
      event: "error",
      durationMs,
      error: errorMessage,
      metadata: { url, provider: "firecrawl" },
    });

    return {
      success: false,
      url,
      title: "",
      content: "",
      error: errorMessage,
    };
  }
}

// ============================================================================
// Main Orchestration Function
// ============================================================================

interface BrowseAndSynthesizeParams {
  urls: string[];
  query: string;
  options: WebBrowseOptions;
  emit?: WebBrowseEventEmitter;
  abortSignal?: AbortSignal;
}

interface BrowseAndSynthesizeResult {
  success: boolean;
  synthesis: string;
  fetchedUrls: string[];
  failedUrls: string[];
  error?: string;
}

/**
 * Fetch URLs, cache content, and synthesize an answer.
 * This is the main entry point for the web browse workflow.
 */
export async function browseAndSynthesize(
  params: BrowseAndSynthesizeParams
): Promise<BrowseAndSynthesizeResult> {
  const { urls, query, options, emit, abortSignal } = params;
  const { sessionId } = options;

  const doEmit: WebBrowseEventEmitter = emit || (() => {});
  const fetchedUrls: string[] = [];
  const failedUrls: string[] = [];

  try {
    throwIfAborted(abortSignal);
    // Phase 1: Fetch all URLs
    emitPhaseChange(doEmit, "fetching", `Fetching ${urls.length} page(s)...`);

    const fetchPromises = urls.map(async (url) => {
      throwIfAborted(abortSignal);
      emitPhaseChange(doEmit, "fetching", `Fetching: ${url}`, url);
      const result = await fetchWebContent(url, sessionId, abortSignal);

      if (result.success) {
        // Store in session cache with images
        await addWebContent(sessionId, result.url, result.title, result.content, {
          images: result.images,
          ogImage: result.ogImage,
        });
        fetchedUrls.push(url);

        doEmit({
          type: "content_fetched",
          url: result.url,
          title: result.title,
          contentLength: result.content.length,
          timestamp: new Date(),
        });
      } else {
        failedUrls.push(url);
        console.warn(`[WebBrowse] Failed to fetch ${url}: ${result.error}`);
      }

      return result;
    });

    await Promise.all(fetchPromises);
    throwIfAborted(abortSignal);

    if (fetchedUrls.length === 0) {
      emitPhaseChange(doEmit, "error", "Failed to fetch any URLs");
      doEmit({
        type: "error",
        error: "Failed to fetch any of the requested URLs",
        timestamp: new Date(),
      });
      return {
        success: false,
        synthesis: "",
        fetchedUrls: [],
        failedUrls,
        error: "Failed to fetch any of the requested URLs",
      };
    }

    if (fetchedUrls.length > 0) {
      await setSessionRecentUrls(sessionId, fetchedUrls).catch((error) => {
        console.warn("[WebBrowse] Failed to record recent URLs:", error);
      });
    }

    // Phase 2: Synthesize answer
    emitPhaseChange(doEmit, "synthesizing", "Analyzing content...");

    const synthesisResult = await synthesizeWebContent({
      sessionId,
      query,
      urls: fetchedUrls,
      sessionMetadata: options.sessionMetadata,
      abortSignal,
    });

    if (!synthesisResult.success) {
      emitPhaseChange(doEmit, "error", synthesisResult.error || "Synthesis failed");
      doEmit({
        type: "error",
        error: synthesisResult.error || "Synthesis failed",
        timestamp: new Date(),
      });
      return {
        success: false,
        synthesis: "",
        fetchedUrls,
        failedUrls,
        error: synthesisResult.error,
      };
    }

    // Phase 3: Complete
    emitPhaseChange(doEmit, "complete", "Done");

    doEmit({
      type: "synthesis_complete",
      synthesis: synthesisResult.synthesis,
      sourcesUsed: synthesisResult.sourcesUsed,
      timestamp: new Date(),
    });

    return {
      success: true,
      synthesis: synthesisResult.synthesis,
      fetchedUrls,
      failedUrls,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[WebBrowse] Orchestrator error:", error);

    emitPhaseChange(doEmit, "error", errorMessage);
    doEmit({
      type: "error",
      error: errorMessage,
      timestamp: new Date(),
    });

    return {
      success: false,
      synthesis: "",
      fetchedUrls,
      failedUrls,
      error: errorMessage,
    };
  }
}

/**
 * Query existing session content without fetching new URLs.
 * Useful for follow-up questions about already-fetched content.
 */
async function querySessionContent(
  sessionId: string,
  query: string,
  urls?: string[],
  abortSignal?: AbortSignal,
  sessionMetadata?: Record<string, unknown> | null
): Promise<BrowseAndSynthesizeResult> {
  try {
    const synthesisResult = await synthesizeWebContent({
      sessionId,
      query,
      urls,
      sessionMetadata,
      abortSignal,
    });

    if (!synthesisResult.success) {
      return {
        success: false,
        synthesis: "",
        fetchedUrls: [],
        failedUrls: [],
        error: synthesisResult.error,
      };
    }

    return {
      success: true,
      synthesis: synthesisResult.synthesis,
      fetchedUrls: synthesisResult.sourcesUsed,
      failedUrls: [],
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    return {
      success: false,
      synthesis: "",
      fetchedUrls: [],
      failedUrls: [],
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}


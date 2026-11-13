/**
 * Firecrawl Web Scraping Tools
 *
 * Tools for scraping and crawling web content using Firecrawl API.
 * - firecrawlScrape: Extract content from a single URL
 * - firecrawlCrawl: Crawl multiple pages from a starting URL
 */

import { tool, jsonSchema } from "ai";
import { withToolLogging } from "@/lib/ai/tool-registry/logging";
import { loadSettings } from "@/lib/settings/settings-manager";
import { getWebScraperProvider } from "@/lib/ai/web-scraper/provider";
import { localScrapePage, localCrawlSite } from "@/lib/ai/web-scraper/local";

// ============================================================================
// Firecrawl API Configuration
// ============================================================================

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const FIRECRAWL_CRAWL_URL = "https://api.firecrawl.dev/v2/crawl";

function getFirecrawlApiKey(): string | undefined {
  // Ensure settings are loaded so process.env is updated (Electron standalone).
  loadSettings();
  return process.env.FIRECRAWL_API_KEY;
}

// ============================================================================
// Types
// ============================================================================

export interface FirecrawlScrapeResult {
  status: "success" | "error" | "no_api_key";
  url: string;
  markdown?: string;
  title?: string;
  description?: string;
  message?: string;
  /** All image URLs extracted from the page (when extractImages is true) */
  images?: string[];
  /** All links extracted from the page */
  links?: string[];
  /** Open Graph image URL - often the hero/product image */
  ogImage?: string;
}

interface FirecrawlCrawlResult {
  status: "success" | "error" | "no_api_key" | "pending";
  url: string;
  pages?: Array<{ url: string; title?: string; markdown?: string }>;
  totalPages?: number;
  jobId?: string;
  message?: string;
}

// ============================================================================
// Scrape Tool
// ============================================================================

const scrapeSchema = jsonSchema<{
  url: string;
  onlyMainContent?: boolean;
  waitFor?: number;
  extractImages?: boolean;
}>({
  type: "object",
  title: "FirecrawlScrapeInput",
  description: "Input schema for web page scraping",
  properties: {
    url: {
      type: "string",
      format: "uri",
      description: "The URL to scrape",
    },
    onlyMainContent: {
      type: "boolean",
      description: "Extract only main content, excluding headers/footers/sidebars (default: true)",
    },
    waitFor: {
      type: "number",
      description: "Milliseconds to wait for JavaScript rendering before scraping",
    },
    extractImages: {
      type: "boolean",
      description: "Extract all image URLs from the page. Returns images array with absolute URLs. Use for product pages to get hero images. Also returns ogImage (Open Graph image) when available.",
    },
  },
  required: ["url"],
  additionalProperties: false,
});

interface FirecrawlToolOptions {
  userId?: string;
  characterId?: string | null;
  sessionId?: string;
}

// Args interface for firecrawlScrape
interface FirecrawlScrapeArgs {
  url: string;
  onlyMainContent?: boolean;
  waitFor?: number;
  extractImages?: boolean;
}

/**
 * Core firecrawlScrape execution logic (extracted for logging wrapper)
 */
async function executeFirecrawlScrape(
  args: FirecrawlScrapeArgs
): Promise<FirecrawlScrapeResult> {
  const { url, onlyMainContent = true, waitFor, extractImages = false } = args;

  try {
    const provider = getWebScraperProvider();
    let markdown = "";
    let title = url;
    let description: string | undefined;
    let ogImage: string | undefined;
    let links: string[] = [];
    let imageSources: string[] = [];

    if (provider === "local") {
      const localResult = await localScrapePage(url, { onlyMainContent, waitFor });
      markdown = localResult.markdown;
      title = localResult.title || url;
      description = localResult.description;
      ogImage = localResult.ogImage;
      links = localResult.links;
      imageSources = localResult.images;
    } else {
      const apiKey = getFirecrawlApiKey();

      if (!apiKey) {
        return {
          status: "no_api_key",
          url,
          message:
            "Firecrawl is not configured. Please set FIRECRAWL_API_KEY in Settings > API Keys.",
        };
      }

      // Build formats array based on options
      const formats: string[] = ["markdown"];
      if (extractImages) {
        formats.push("links"); // Links format includes image URLs
      }

      const response = await fetch(FIRECRAWL_SCRAPE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          formats,
          onlyMainContent,
          waitFor,
          timeout: 30000,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[FIRECRAWL] Scrape failed:", errorText);
        throw new Error(`Firecrawl API error: ${response.status}`);
      }

      const data = await response.json();

      markdown = data.data?.markdown || "";
      title = data.data?.metadata?.title || url;
      description = data.data?.metadata?.description;
      ogImage = data.data?.metadata?.ogImage;
      links = data.data?.links || [];
      imageSources = links;
    }

    // Extract image URLs from links (filter for common image extensions)
    const imageExtensions = /\.(jpg|jpeg|png|gif|webp|avif|svg|bmp|ico)([?#]|$)/i;
    const sourceImages = imageSources.length > 0 ? imageSources : links;
    const images = extractImages
      ? sourceImages.filter((link: string) => imageExtensions.test(link))
      : undefined;
    const extractedLinks = extractImages ? links : undefined;

    return {
      status: "success",
      url,
      markdown,
      title,
      description,
      images,
      ogImage,
      links: extractedLinks,
    };
  } catch (error) {
    console.error("[FIRECRAWL] Scrape error:", error);
    return {
      status: "error",
      url,
      message: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

/**
 * Create the Firecrawl scrape tool for single page extraction.
 */
export function createFirecrawlScrapeTool(options: FirecrawlToolOptions = {}) {
  const { sessionId } = options;

  // Wrap the execute function with logging
  const executeWithLogging = withToolLogging(
    "firecrawlScrape",
    sessionId,
    (args: FirecrawlScrapeArgs) => executeFirecrawlScrape(args)
  );

  return tool({
    description: `Scrape and extract content from a single webpage as clean markdown.

Use when you need to read the full content of a specific URL.
Returns clean, structured markdown content suitable for analysis.

**DO NOT use for:**
- General web search (use webSearch instead)
- When you need multiple pages (use firecrawlCrawl instead)

**DO use for:**
- Reading full content of a specific URL
- Extracting article text, documentation, or web pages
- Getting structured content from a known URL
- **Extracting product images**: Set extractImages=true to get all image URLs from the page.
  Returns 'images' array with absolute URLs and 'ogImage' (hero/product image when available).
  Best results on product detail pages (not category/listing pages).`,
    inputSchema: scrapeSchema,
    execute: executeWithLogging,
  });
}

// ============================================================================
// Crawl Tool
// ============================================================================

const crawlSchema = jsonSchema<{
  url: string;
  maxPages?: number;
  includePaths?: string[];
  excludePaths?: string[];
}>({
  type: "object",
  title: "FirecrawlCrawlInput",
  description: "Input schema for website crawling",
  properties: {
    url: {
      type: "string",
      format: "uri",
      description: "Starting URL to crawl from",
    },
    maxPages: {
      type: "number",
      minimum: 1,
      maximum: 50,
      description: "Maximum number of pages to crawl (1-50, default: 10)",
    },
    includePaths: {
      type: "array",
      items: { type: "string" },
      description: 'URL path patterns to include (e.g., ["/docs/*", "/api/*"])',
    },
    excludePaths: {
      type: "array",
      items: { type: "string" },
      description: 'URL path patterns to exclude (e.g., ["/blog/*", "/pricing"])',
    },
  },
  required: ["url"],
  additionalProperties: false,
});

// Args interface for firecrawlCrawl
interface FirecrawlCrawlArgs {
  url: string;
  maxPages?: number;
  includePaths?: string[];
  excludePaths?: string[];
}

/**
 * Core firecrawlCrawl execution logic (extracted for logging wrapper)
 */
async function executeFirecrawlCrawl(args: FirecrawlCrawlArgs): Promise<FirecrawlCrawlResult> {
  const { url, maxPages = 10, includePaths, excludePaths } = args;

  try {
    const provider = getWebScraperProvider();
    if (provider === "local") {
      const result = await localCrawlSite({ url, maxPages, includePaths, excludePaths });
      return {
        status: "success",
        url,
        totalPages: result.totalPages,
        pages: result.pages,
      };
    }

    const apiKey = getFirecrawlApiKey();

    if (!apiKey) {
      return {
        status: "no_api_key",
        url,
        message:
          "Firecrawl is not configured. Please set FIRECRAWL_API_KEY in Settings > API Keys.",
      };
    }

    // Start crawl job
    const startResponse = await fetch(FIRECRAWL_CRAWL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        limit: maxPages,
        includePaths,
        excludePaths,
        scrapeOptions: {
          formats: ["markdown"],
        },
      }),
    });

    if (!startResponse.ok) {
      const errorText = await startResponse.text();
      console.error("[FIRECRAWL] Crawl start failed:", errorText);
      throw new Error(`Crawl start failed: ${startResponse.status}`);
    }

    const { id: jobId } = await startResponse.json();
    console.log(`[FIRECRAWL] Crawl job started: ${jobId}`);

    // Poll for completion (max 60 seconds)
    const maxWait = 60000;
    const pollInterval = 2000;
    let elapsed = 0;

    while (elapsed < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      elapsed += pollInterval;

      const statusResponse = await fetch(`${FIRECRAWL_CRAWL_URL}/${jobId}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      const statusData = await statusResponse.json();

      if (statusData.status === "completed") {
        console.log(
          `[FIRECRAWL] Crawl completed: ${statusData.data?.length || 0} pages`
        );
        return {
          status: "success",
          url,
          jobId,
          totalPages: statusData.data?.length || 0,
          pages: (statusData.data || []).map((page: any) => ({
            url: page.metadata?.sourceURL || page.url,
            title: page.metadata?.title,
            markdown: page.markdown,
          })),
        };
      }

      if (statusData.status === "failed") {
        throw new Error("Crawl job failed");
      }

      console.log(
        `[FIRECRAWL] Crawl in progress... (${elapsed / 1000}s elapsed)`
      );
    }

    // Timeout - return pending status with job ID for potential follow-up
    return {
      status: "pending",
      url,
      jobId,
      message: `Crawl still in progress after 60 seconds. Job ID: ${jobId}`,
    };
  } catch (error) {
    console.error("[FIRECRAWL] Crawl error:", error);
    return {
      status: "error",
      url,
      message: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

/**
 * Create the Firecrawl crawl tool for multi-page extraction
 */
export function createFirecrawlCrawlTool(sessionId?: string) {
  // Wrap the execute function with logging
  const executeWithLogging = withToolLogging(
    "firecrawlCrawl",
    sessionId,
    (args: FirecrawlCrawlArgs) => executeFirecrawlCrawl(args)
  );

  return tool({
    description: `Crawl multiple pages from a website starting from a URL.

Returns markdown content for each crawled page. Useful for:
- Reading documentation sites
- Extracting content from multiple related pages
- Building knowledge from an entire section of a website

Note: Crawling is async and may take up to 60 seconds depending on page count.`,
    inputSchema: crawlSchema,
    execute: executeWithLogging,
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if Firecrawl is available (API key configured)
 */
function isFirecrawlAvailable(): boolean {
  const provider = getWebScraperProvider();
  if (provider === "local") {
    return true;
  }
  return !!getFirecrawlApiKey();
}

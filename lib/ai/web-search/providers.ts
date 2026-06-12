/**
 * Web Search Providers
 *
 * Abstraction layer for multiple web search backends.
 * Currently supports Tavily (API-based, paid) and DuckDuckGo (scraping-based, free).
 *
 * DuckDuckGo uses a vendored copy of `@phukon/duckduckgo-search@1.1.0`
 * with the `lite` backend for reliability.
 * It returns { title, href, body } per result — no relevance scores or AI answers.
 */

import { loadSettings } from "@/lib/settings/settings-manager";
import { createDDGS } from "./ddgs";

// ============================================================================
// Shared Types
// ============================================================================

export interface WebSearchSource {
  url: string;
  title: string;
  snippet: string;
  relevanceScore: number;
}

// ============================================================================
// Provider Interface
// ============================================================================

interface WebSearchProviderResult {
  sources: WebSearchSource[];
  /** AI-generated answer summary (Tavily only) */
  answer?: string;
  /** Provider that produced this result, useful for auto-mode fallback diagnostics. */
  providerUsed?: "tavily" | "duckduckgo";
  /** Provider-level error. Consumers may use this to decide fallback behavior. */
  error?: string;
}

interface WebSearchProviderOptions {
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
  includeAnswer?: boolean;
}

interface WebSearchProvider {
  name: string;
  search(query: string, options?: WebSearchProviderOptions): Promise<WebSearchProviderResult>;
  isAvailable(): boolean;
}

interface WebSearchProviderStatus {
  configuredProvider: WebSearchProviderType;
  activeProvider: "tavily" | "duckduckgo";
  available: boolean;
  tavilyConfigured: boolean;
  enhanced: boolean;
  supportsAnswerSummary: boolean;
  isFallback: boolean;
}

// ============================================================================
// Tavily Provider
// ============================================================================

const TAVILY_API_URL = "https://api.tavily.com/search";

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  results: TavilySearchResult[];
  query: string;
  answer?: string;
}

function getTavilyApiKey(): string | undefined {
  loadSettings();
  return process.env.TAVILY_API_KEY;
}

class TavilyProvider implements WebSearchProvider {
  name = "tavily";

  isAvailable(): boolean {
    return !!getTavilyApiKey();
  }

  async search(query: string, options: WebSearchProviderOptions = {}): Promise<WebSearchProviderResult> {
    const apiKey = getTavilyApiKey();
    if (!apiKey) {
      console.warn("[WEB-SEARCH] Tavily API key not configured");
      return {
        sources: [],
        providerUsed: "tavily",
        error: "Tavily API key not configured",
      };
    }

    const { maxResults = 10, searchDepth = "basic", includeAnswer = true } = options;

    try {
      const response = await fetch(TAVILY_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: maxResults,
          search_depth: searchDepth,
          include_answer: includeAnswer,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[WEB-SEARCH] Tavily search failed:", errorText);
        throw new Error(`Tavily search failed: ${response.status}`);
      }

      const data: TavilyResponse = await response.json();

      return {
        sources: data.results.map((result) => ({
          url: result.url,
          title: result.title,
          snippet: result.content,
          relevanceScore: result.score,
        })),
        answer: data.answer,
        providerUsed: "tavily",
      };
    } catch (error) {
      console.error("[WEB-SEARCH] Tavily search error:", error);
      const message = error instanceof Error ? error.message : "Unknown Tavily error";
      return {
        sources: [],
        providerUsed: "tavily",
        error: message,
      };
    }
  }
}

// ============================================================================
// DuckDuckGo Provider
// ============================================================================

type DuckDuckGoRawResult = { title?: string; href?: string; body?: string };

function resolveDuckDuckGoRedirect(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  const asAbsolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(asAbsolute, "https://duckduckgo.com");
  } catch {
    return null;
  }

  const isDuckDuckGoRedirect =
    parsed.hostname.endsWith("duckduckgo.com") && (parsed.pathname === "/l" || parsed.pathname.startsWith("/l/"));

  if (isDuckDuckGoRedirect) {
    const uddg = parsed.searchParams.get("uddg")?.trim();
    if (!uddg) return null;

    let decoded = uddg;
    try {
      decoded = decodeURIComponent(uddg);
    } catch {
      // Keep original value if decoding fails.
    }

    if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
      return decoded;
    }
    return null;
  }

  if (asAbsolute.startsWith("http://") || asAbsolute.startsWith("https://")) {
    return asAbsolute;
  }

  return null;
}

function normalizeDuckDuckGoResults(raw: DuckDuckGoRawResult[]): WebSearchSource[] {
  return raw
    .map((r, index) => {
      const url = resolveDuckDuckGoRedirect(r.href ?? "");
      if (!url) return null;
      if (url.includes("duckduckgo.com/y.js") || url.includes("google.com/search?q=")) return null;

      return {
        url: url.trim(),
        title: r.title?.trim() || "",
        snippet: r.body?.replace(/\s+/g, " ").trim().substring(0, 500) || "",
        // Position-based heuristic (DDG doesn't provide relevance scores)
        relevanceScore: Math.max(0.5, 1.0 - index * 0.05),
      };
    })
    .filter((source): source is WebSearchSource => source !== null);
}

export class DuckDuckGoProvider implements WebSearchProvider {
  // fallow-ignore-next-line unused-class-member
  name = "duckduckgo";

  // fallow-ignore-next-line unused-class-member
  isAvailable(): boolean {
    // DDG is always available (no API key needed)
    return true;
  }

  async search(query: string, options: WebSearchProviderOptions = {}): Promise<WebSearchProviderResult> {
    const { maxResults = 10 } = options;

    try {
      const ddgs = await createDDGS();

      const backends: Array<"lite" | "html" | "auto"> = ["lite", "html", "auto"];
      let sources: WebSearchSource[] = [];
      let lastError: unknown;

      for (const backend of backends) {
        try {
          const candidate = await ddgs.text({
            keywords: query,
            maxResults,
            backend,
          });

          const raw = Array.isArray(candidate) ? (candidate as DuckDuckGoRawResult[]) : [];
          const normalized = normalizeDuckDuckGoResults(raw);

          if (normalized.length > 0) {
            sources = normalized;
            if (backend !== "lite") {
              console.warn(`[WEB-SEARCH] DuckDuckGo fallback backend succeeded: ${backend}`);
            }
            break;
          }

          if (raw.length > 0) {
            console.warn(`[WEB-SEARCH] DuckDuckGo backend returned unusable URLs: ${backend}`);
          }
        } catch (error) {
          lastError = error;
          console.warn(`[WEB-SEARCH] DuckDuckGo backend failed: ${backend}`);
        }
      }

      if (sources.length === 0 && lastError) {
        throw lastError;
      }

      console.log(`[WEB-SEARCH] DuckDuckGo returned ${sources.length} results for: ${query}`);

      return {
        sources,
        answer: undefined, // DDG doesn't provide AI answer summaries
        providerUsed: "duckduckgo",
      };
    } catch (error: any) {
      // Check for rate limit error specifically
      if (error?.message?.includes("Ratelimit") || error?.message?.includes("202")) {
        console.warn(`[WEB-SEARCH] DuckDuckGo rate limited for query: ${query}`);
      } else {
        console.error("[WEB-SEARCH] DuckDuckGo search error:", error);
      }
      const message = error instanceof Error ? error.message : "Unknown DuckDuckGo error";
      return {
        sources: [],
        providerUsed: "duckduckgo",
        error: message,
      };
    }
  }
}

// ============================================================================
// Provider Selection
// ============================================================================

type WebSearchProviderType = "tavily" | "duckduckgo" | "auto";

/**
 * Get the runtime search provider based on settings and availability.
 *
 * DuckDuckGo is treated as baselene so search works out of the box.
 */
export function getSearchProvider(override?: WebSearchProviderType): WebSearchProvider {
  const status = getWebSearchProviderStatus(override);
  return status.activeProvider === "tavily" ? new TavilyProvider() : new DuckDuckGoProvider();
}

/**
 * Resolve runtime status for web search across APIs/UI.
 * DuckDuckGo is the baselene provider, while Tavily is an optional enhancement.
 */
export function getWebSearchProviderStatus(override?: WebSearchProviderType): WebSearchProviderStatus {
  const configuredProvider = override ?? getConfiguredProvider();
  const tavily = new TavilyProvider();
  const tavilyConfigured = tavily.isAvailable();

  if (configuredProvider === "tavily") {
    return {
      configuredProvider,
      activeProvider: "tavily",
      available: tavilyConfigured,
      tavilyConfigured,
      enhanced: tavilyConfigured,
      supportsAnswerSummary: tavilyConfigured,
      isFallback: false,
    };
  }

  if (configuredProvider === "duckduckgo") {
    return {
      configuredProvider,
      activeProvider: "duckduckgo",
      available: true,
      tavilyConfigured,
      enhanced: false,
      supportsAnswerSummary: false,
      isFallback: false,
    };
  }

  // auto mode: prefer Tavily when configured, otherwise fall back to DuckDuckGo
  if (tavilyConfigured) {
    return {
      configuredProvider,
      activeProvider: "tavily",
      available: true,
      tavilyConfigured,
      enhanced: true,
      supportsAnswerSummary: true,
      isFallback: false,
    };
  }

  return {
    configuredProvider,
    activeProvider: "duckduckgo",
    available: true,
    tavilyConfigured,
    enhanced: false,
    supportsAnswerSummary: false,
    isFallback: true,
  };
}

/**
 * Check if any web search provider is available.
 */
export function isAnySearchProviderAvailable(): boolean {
  return getWebSearchProviderStatus().available;
}

function getConfiguredProvider(): WebSearchProviderType {
  loadSettings();
  const setting = process.env.WEB_SEARCH_PROVIDER as WebSearchProviderType | undefined;
  if (setting === "tavily" || setting === "duckduckgo") return setting;
  return "auto";
}

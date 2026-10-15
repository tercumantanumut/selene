export function getCanonicalToolName(toolName: string): string {
  const match = /^mcp__.+?__(.+)$/.exec(toolName);
  return match?.[1] || toolName;
}

/**
 * Auto-generate a human-readable display name from a tool identifier.
 * Handles snake_case, camelCase, kebab-case, and acronym runs.
 *
 * "vectorSearch" → "Vector Search"
 * "execute_command" → "Execute Command"
 * "readFile" → "Read File"
 * "getHTTPStatus" → "Get HTTP Status"
 * "parseURLToHTML" → "Parse URL To HTML"
 */
export function humanizeToolName(name: string): string {
  let result = name
    // camelCase boundary: lowercase/digit followed by uppercase
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // acronym boundary: uppercase run followed by uppercase+lowercase (e.g. "HTTPStatus" → "HTTP Status")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  // snake_case / kebab-case → space-separated
  result = result.replace(/[_-]/g, " ");
  // Title Case each word
  return result.replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

// ---------------------------------------------------------------------------
// Shared tool-name cache (fetched once from /api/tools)
// ---------------------------------------------------------------------------

let _toolNameCache: Record<string, string> | null = null;
let _toolNameCachePromise: Promise<Record<string, string>> | null = null;

/**
 * Lazily load and cache the displayName map from /api/tools.
 * Shared between tool-call-group and tool-fallback so both resolve the same
 * registry-backed display names.
 */
export async function loadToolNameCache(): Promise<Record<string, string>> {
  if (_toolNameCache) return _toolNameCache;
  if (_toolNameCachePromise) return _toolNameCachePromise;

  // Assign the promise before the first await: every ToolCallGroup calls this
  // on mount, and a late assignment let each of them start its own fetch.
  _toolNameCachePromise = (async () => {
    // Dynamic import to avoid pulling resilientFetch into test bundles
    const { resilientFetch } = await import("@/lib/utils/resilient-fetch");
    const { data, error } = await resilientFetch<{
      tools?: Array<{ id: string; displayName: string }>;
    }>("/api/tools?includeDisabled=true&includeAlwaysLoad=true");
    if (error || !data) throw new Error(error ?? "Empty /api/tools response");
    const map: Record<string, string> = {};
    (data.tools || []).forEach((tool) => {
      if (tool.id && tool.displayName) {
        map[tool.id] = tool.displayName;
      }
    });
    _toolNameCache = map;
    return map;
  })().catch(() => {
    // Leave the cache empty so the next caller retries; callers fall back to
    // humanized names for this render.
    _toolNameCachePromise = null;
    return {};
  });

  return _toolNameCachePromise;
}


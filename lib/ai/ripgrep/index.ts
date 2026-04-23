/**
 * ripgrep Module (back-compat barrel)
 *
 * Historically this module exposed the types + the tool factory. As of the
 * pluggable-search-backends migration those live in `lib/ai/search/*`. Keep
 * these re-exports so existing `import ... from "@/lib/ai/ripgrep"` lines
 * compile unchanged.
 */

export {
    type RipgrepMatch,
    type RipgrepOptions,
    type RipgrepSearchResult,
} from "./ripgrep";

export { createLocalGrepTool } from "./tool";

// New, preferred surface. Prefer these in new code.
export type {
    SearchBackend,
    SearchBackendId,
    SearchBackendSelection,
    SearchFeature,
    SearchMatch,
    SearchOptions,
    SearchResult,
} from "@/lib/ai/search";

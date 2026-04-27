import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/sqlite-client";
import { agentSyncFiles } from "@/lib/db/sqlite-character-schema";
import { eq, like, and } from "drizzle-orm";
import { searchWithRouter, type VectorSearchHit } from "@/lib/vectordb";

/**
 * GET /api/files/search?characterId=xxx&query=...&limit=15&mode=auto
 *
 * @-mention picker for the chat composer (v2 — vector-aware).
 *
 * Modes:
 *   files     legacy substring LIKE on relativePath only (fast, name-only)
 *   semantic  hybrid vector search via `searchWithRouter` only (chunk previews)
 *   auto      (default) blends both:
 *                  - always returns name-matched files
 *                  - additionally returns top-K semantic chunks when query
 *                    looks like a phrase (length >= 3 chars and contains
 *                    a space OR is >= 5 chars). Empty query returns the
 *                    most-recently-indexed files only.
 *
 * Response (always wrapped in { mode, files, chunks }):
 *   {
 *     mode: "files" | "semantic" | "hybrid",
 *     files: Array<{ relativePath, filePath, folderId?, score? }>,
 *     chunks: Array<{
 *       relativePath, filePath, folderId,
 *       text, startLine?, endLine?, chunkIndex,
 *       score, tokenCount?
 *     }>,
 *   }
 *
 * Backwards compatibility: callers that only read `.files` keep working.
 */

interface FileResult {
  relativePath: string;
  filePath: string;
  folderId?: string;
  score?: number;
}

interface ChunkResult {
  relativePath: string;
  filePath: string;
  folderId: string;
  text: string;
  startLine?: number;
  endLine?: number;
  chunkIndex: number;
  score: number;
  tokenCount?: number;
}

const SNIPPET_PREVIEW_CHARS = 320; // shown in dropdown — kept tight so the popover stays compact

function shouldRunSemantic(query: string, mode: string): boolean {
  if (mode === "semantic") return true;
  if (mode === "files") return false;
  // mode === "auto"
  if (query.length < 3) return false;
  if (query.includes(" ")) return true;
  return query.length >= 5;
}

function shouldRunFiles(mode: string): boolean {
  return mode === "files" || mode === "auto";
}

function clampSnippet(text: string): string {
  if (text.length <= SNIPPET_PREVIEW_CHARS) return text;
  return text.slice(0, SNIPPET_PREVIEW_CHARS) + "…";
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const characterId = searchParams.get("characterId");
    const query = (searchParams.get("query") || "").trim();
    const limit = Math.min(parseInt(searchParams.get("limit") || "15", 10), 50);
    const mode = (searchParams.get("mode") || "auto").toLowerCase();

    if (!characterId) {
      return NextResponse.json(
        { error: "characterId is required" },
        { status: 400 }
      );
    }
    if (!["auto", "files", "semantic"].includes(mode)) {
      return NextResponse.json(
        { error: "mode must be one of: auto, files, semantic" },
        { status: 400 }
      );
    }

    const filesResult: FileResult[] = [];
    const chunksResult: ChunkResult[] = [];

    // --- Files leg: SQL substring on relativePath (preserves v1 behaviour) ---
    if (shouldRunFiles(mode)) {
      const fileRows = await db
        .select({
          relativePath: agentSyncFiles.relativePath,
          filePath: agentSyncFiles.filePath,
          folderId: agentSyncFiles.folderId,
        })
        .from(agentSyncFiles)
        .where(
          query
            ? and(
                eq(agentSyncFiles.characterId, characterId),
                like(agentSyncFiles.relativePath, `%${query}%`)
              )
            : eq(agentSyncFiles.characterId, characterId)
        )
        .limit(limit);

      filesResult.push(
        ...fileRows.map((r) => ({
          relativePath: r.relativePath,
          filePath: r.filePath,
          folderId: r.folderId,
        }))
      );
    }

    // --- Semantic leg: hybrid vector search (V2 only — V1 is deprecated) ---
    if (shouldRunSemantic(query, mode) && query.length > 0) {
      let hits: VectorSearchHit[] = [];
      try {
        hits = await searchWithRouter({
          characterId,
          query,
          options: {
            // Pull more than needed so we can dedupe-by-file without losing variety.
            topK: Math.min(limit * 3, 60),
            minScore: 0.01,
          },
        });
      } catch (err) {
        // Embedding/LanceDB errors are non-fatal — degrade to files-only.
        console.warn("[files/search] hybrid search failed:", err);
      }

      const seenChunkIds = new Set<string>();
      for (const h of hits) {
        if (seenChunkIds.has(h.id)) continue;
        seenChunkIds.add(h.id);
        chunksResult.push({
          relativePath: h.relativePath,
          filePath: h.filePath,
          folderId: h.folderId,
          text: clampSnippet(h.text),
          startLine: h.startLine,
          endLine: h.endLine,
          chunkIndex: h.chunkIndex,
          score: h.score,
          tokenCount: h.tokenCount,
        });
        if (chunksResult.length >= limit) break;
      }

      // Promote any semantic-discovered file (not already in filesResult) into the
      // files list with its score — useful for "auto" mode dropdown that displays
      // both file matches and semantic snippet matches grouped by file.
      const seenFilePaths = new Set(filesResult.map((f) => f.filePath));
      for (const c of chunksResult) {
        if (!seenFilePaths.has(c.filePath)) {
          seenFilePaths.add(c.filePath);
          filesResult.push({
            relativePath: c.relativePath,
            filePath: c.filePath,
            folderId: c.folderId,
            score: c.score,
          });
        }
      }
    }

    const responseMode: "files" | "semantic" | "hybrid" =
      mode === "files"
        ? "files"
        : chunksResult.length > 0 && filesResult.length > 0
          ? "hybrid"
          : chunksResult.length > 0
            ? "semantic"
            : "files";

    return NextResponse.json({
      mode: responseMode,
      files: filesResult,
      chunks: chunksResult,
    });
  } catch (error) {
    console.error("[files/search] Error:", error);
    return NextResponse.json(
      { error: "Failed to search files" },
      { status: 500 }
    );
  }
}

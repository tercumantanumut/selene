"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FileIcon, FolderIcon, SparklesIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { resilientFetch } from "@/lib/utils/resilient-fetch";

// --- Types -----------------------------------------------------------------
// Kept identical-name to v1 callers where possible; new fields are optional
// so older imports keep compiling.

export interface FileResult {
  relativePath: string;
  filePath: string;
  folderId?: string;
  score?: number;
}

export interface ChunkResult {
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

export type MentionSelection =
  | { kind: "file"; file: FileResult }
  | { kind: "chunk"; chunk: ChunkResult };

interface FileMentionAutocompleteProps {
  characterId: string | null;
  inputValue: string;
  cursorPosition: number;
  /**
   * Called when the user picks a row. The returned `displayLabel` is the
   * text inserted in place of the @-trigger; the parent is expected to
   * also store the rich `MentionSelection` so it can be sent as message
   * metadata at submit time.
   */
  onInsertMention: (
    displayLabel: string,
    atIndex: number,
    queryLength: number,
    selection: MentionSelection,
  ) => void;
}

interface SearchResponse {
  mode: "files" | "semantic" | "hybrid";
  files?: FileResult[];
  chunks?: ChunkResult[];
}

const MAX_VISIBLE_FILES = 8;
const MAX_VISIBLE_CHUNKS = 6;

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

/**
 * v2 @-mention autocomplete.
 *
 * Empty / short query → file name matches (substring on relativePath).
 * Phrase queries     → file name matches + top semantic chunks from V2 hybrid.
 *
 * Selecting a file inserts `@<relativePath>` into the textarea; selecting a
 * chunk inserts `@<basename>:L<start>-<end>`. The structured `MentionSelection`
 * is forwarded to the parent so it can travel as metadata to the chat API.
 */
const FileMentionAutocomplete = forwardRef<HTMLDivElement, FileMentionAutocompleteProps>(({
  characterId,
  inputValue,
  cursorPosition,
  onInsertMention,
}, ref) => {
  const [isOpen, setIsOpen] = useState(false);
  const [files, setFiles] = useState<FileResult[]>([]);
  const [chunks, setChunks] = useState<ChunkResult[]>([]);
  const [mode, setMode] = useState<SearchResponse["mode"]>("files");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [atIndex, setAtIndex] = useState(-1);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  // The flattened row order so a single selectedIndex addresses both lists.
  const visibleFiles = files.slice(0, MAX_VISIBLE_FILES);
  const visibleChunks = chunks.slice(0, MAX_VISIBLE_CHUNKS);
  const totalRows = visibleFiles.length + visibleChunks.length;

  // Detect @ trigger and extract query
  useEffect(() => {
    if (!characterId) {
      setIsOpen(false);
      return;
    }

    const textBeforeCursor = inputValue.slice(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");

    if (lastAtIndex === -1) {
      setIsOpen(false);
      return;
    }

    if (lastAtIndex > 0 && !/\s/.test(textBeforeCursor[lastAtIndex - 1])) {
      setIsOpen(false);
      return;
    }

    const mentionQuery = textBeforeCursor.slice(lastAtIndex + 1);

    // Newlines always end a mention. Phrase queries (with spaces) are allowed
    // because v2 semantic search needs them — but we cap length and word count
    // so the picker eventually releases when the user is just writing prose.
    if (mentionQuery.includes("\n")) {
      setIsOpen(false);
      return;
    }
    if (mentionQuery.length > 80) {
      setIsOpen(false);
      return;
    }
    // A trailing double-space is the user's intent to drop the mention and
    // continue writing normally.
    if (mentionQuery.endsWith("  ")) {
      setIsOpen(false);
      return;
    }

    setAtIndex(lastAtIndex);
    setQuery(mentionQuery);
    setIsOpen(true);
    setSelectedIndex(0);

    // Debounced API call. Phrase queries trigger semantic; short ones stay file-only.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const params = new URLSearchParams({
        characterId,
        query: mentionQuery,
        limit: String(MAX_VISIBLE_FILES + MAX_VISIBLE_CHUNKS),
        mode: "auto",
      });
      setLoading(true);
      const { data } = await resilientFetch<SearchResponse>(
        `/api/files/search?${params}`,
        { retries: 0 },
      );
      setLoading(false);
      setFiles(data?.files ?? []);
      setChunks(data?.chunks ?? []);
      setMode(data?.mode ?? "files");
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [inputValue, cursorPosition, characterId]);

  // Resolve an index into either a file row or a chunk row.
  const resolveRow = useCallback(
    (index: number): MentionSelection | null => {
      if (index < visibleFiles.length) {
        return { kind: "file", file: visibleFiles[index] };
      }
      const chunkIdx = index - visibleFiles.length;
      const chunk = visibleChunks[chunkIdx];
      if (!chunk) return null;
      return { kind: "chunk", chunk };
    },
    [visibleFiles, visibleChunks],
  );

  const handleSelect = useCallback(
    (selection: MentionSelection) => {
      const displayLabel =
        selection.kind === "file"
          ? selection.file.relativePath
          : `${basename(selection.chunk.relativePath)}:L${selection.chunk.startLine ?? "?"}-${selection.chunk.endLine ?? "?"}`;
      onInsertMention(displayLabel, atIndex, query.length, selection);
      setIsOpen(false);
    },
    [onInsertMention, atIndex, query.length],
  );

  // Keyboard handler (called from parent textarea via imperative handle)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen || totalRows === 0) return false;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, totalRows - 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const sel = resolveRow(selectedIndex);
        if (sel) handleSelect(sel);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setIsOpen(false);
        return true;
      }
      return false;
    },
    [isOpen, totalRows, selectedIndex, resolveRow, handleSelect],
  );

  useImperativeHandle(ref, () => {
    const el = containerRef.current || document.createElement("div");
    (el as unknown as { handleKeyDown: typeof handleKeyDown }).handleKeyDown = handleKeyDown;
    return el;
  }, [handleKeyDown]);

  if (!isOpen || (!loading && totalRows === 0)) {
    return <div ref={containerRef} className="hidden" />;
  }

  return (
    <div ref={containerRef} className="absolute bottom-full left-0 right-0 mb-1 z-50">
      <div className="bg-background border border-border rounded-lg shadow-lg max-h-[360px] overflow-y-auto">
        {/* Files section */}
        {visibleFiles.length > 0 && (
          <>
            <div className="px-2 py-1.5 text-xs text-muted-foreground border-b border-border flex items-center justify-between">
              <span>Files — {visibleFiles.length} match{visibleFiles.length !== 1 ? "es" : ""}</span>
              {mode !== "files" && (
                <span className="text-[10px] uppercase tracking-wider opacity-70">{mode}</span>
              )}
            </div>
            {visibleFiles.map((file, idx) => {
              const isDir = file.relativePath.endsWith("/");
              const Icon = isDir ? FolderIcon : FileIcon;
              const rowIndex = idx;
              return (
                <button
                  key={`f-${file.filePath}`}
                  type="button"
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left",
                    "hover:bg-accent/50 transition-colors",
                    rowIndex === selectedIndex && "bg-accent",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelect({ kind: "file", file });
                  }}
                  onMouseEnter={() => setSelectedIndex(rowIndex)}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-xs">{file.relativePath}</span>
                  {file.score != null && (
                    <span className="ml-auto text-[10px] opacity-60 font-mono">
                      {file.score.toFixed(2)}
                    </span>
                  )}
                </button>
              );
            })}
          </>
        )}

        {/* Semantic chunks section */}
        {visibleChunks.length > 0 && (
          <>
            <div className="px-2 py-1.5 text-xs text-muted-foreground border-b border-t border-border flex items-center gap-1.5">
              <SparklesIcon className="h-3 w-3" />
              <span>Snippets — semantic matches</span>
            </div>
            {visibleChunks.map((chunk, idx) => {
              const rowIndex = visibleFiles.length + idx;
              const range =
                chunk.startLine != null && chunk.endLine != null
                  ? `:L${chunk.startLine}-${chunk.endLine}`
                  : "";
              return (
                <button
                  key={`c-${chunk.filePath}-${chunk.chunkIndex}`}
                  type="button"
                  className={cn(
                    "w-full flex flex-col gap-0.5 px-3 py-2 text-sm text-left",
                    "hover:bg-accent/50 transition-colors",
                    rowIndex === selectedIndex && "bg-accent",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelect({ kind: "chunk", chunk });
                  }}
                  onMouseEnter={() => setSelectedIndex(rowIndex)}
                >
                  <span className="flex items-center gap-2">
                    <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-xs">
                      {chunk.relativePath}
                      <span className="opacity-60">{range}</span>
                    </span>
                    <span className="ml-auto text-[10px] opacity-60 font-mono">
                      {chunk.score.toFixed(2)}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-[11px] text-muted-foreground/90 font-mono whitespace-pre-wrap">
                    {chunk.text}
                  </span>
                </button>
              );
            })}
          </>
        )}

        {loading && totalRows === 0 && (
          <div className="px-3 py-3 text-xs text-muted-foreground">Searching…</div>
        )}
      </div>
    </div>
  );
});

FileMentionAutocomplete.displayName = "FileMentionAutocomplete";

export default FileMentionAutocomplete;

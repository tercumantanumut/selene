import type { UIMessageChunk } from "ai";

import { sanitizeAssistantOutputText } from "./content-sanitizer";

const STREAM_TEXT_PROBE_CHARS = 240;

// Match a sentence-ending punctuation that is at end-of-buffer or followed
// by whitespace. We deliberately do NOT flush on a `.` followed by a letter
// (e.g. inside `functions.tool` or version strings like `v1.2`) — flushing
// mid-token would split a leak fragment so neither half carries enough
// signal for `isInternalAssistantLeakText` to detect it.
const SAFE_SENTENCE_BOUNDARY = /[.!?](?=\s|$)|\n/;

function shouldFlushBufferedText(buffer: string): boolean {
  return (
    buffer.length >= STREAM_TEXT_PROBE_CHARS ||
    SAFE_SENTENCE_BOUNDARY.test(buffer)
  );
}

function sanitizeAssistantOutputTextPreserveWhitespace(text: string): string {
  if (!text) {
    return "";
  }

  const leadingWhitespace = text.match(/^\s*/)?.[0] ?? "";
  const trailingWhitespace = text.match(/\s*$/)?.[0] ?? "";
  const core = text.slice(leadingWhitespace.length, text.length - trailingWhitespace.length);

  if (!core) {
    return text;
  }

  const cleaned = sanitizeAssistantOutputText(core);
  return cleaned ? `${leadingWhitespace}${cleaned}${trailingWhitespace}` : "";
}

export function createVisibleAssistantChunkSanitizer() {
  let activeTextId: string | undefined;
  let pendingTextStart: UIMessageChunk | undefined;
  let bufferedText = "";
  let suppressRemainingText = false;
  let emittedVisibleTextInBlock = false;

  const flushBufferedText = (): UIMessageChunk[] => {
    if (!bufferedText) {
      return [];
    }

    const cleanedDelta = sanitizeAssistantOutputTextPreserveWhitespace(bufferedText);
    bufferedText = "";

    if (!cleanedDelta) {
      suppressRemainingText = true;
      return [];
    }

    if (!activeTextId) {
      return [];
    }

    const chunks: UIMessageChunk[] = [];
    if (pendingTextStart) {
      chunks.push(pendingTextStart);
      pendingTextStart = undefined;
    }
    emittedVisibleTextInBlock = true;
    chunks.push({ type: "text-delta", id: activeTextId, delta: cleanedDelta } as UIMessageChunk);
    return chunks;
  };

  return {
    process(chunk: UIMessageChunk): UIMessageChunk[] {
      if (chunk.type === "text-start") {
        bufferedText = "";
        suppressRemainingText = false;
        emittedVisibleTextInBlock = false;
        pendingTextStart = chunk;
        const chunkId = (chunk as { id?: unknown }).id;
        if (typeof chunkId === "string") {
          activeTextId = chunkId;
        }
        return [];
      }

      if (chunk.type === "text-delta") {
        const chunkId = (chunk as { id?: unknown }).id;
        if (typeof chunkId === "string") {
          activeTextId = chunkId;
        }

        const delta = (chunk as { delta?: unknown }).delta;
        if (typeof delta !== "string" || delta.length === 0 || suppressRemainingText) {
          return [];
        }

        bufferedText += delta;
        return shouldFlushBufferedText(bufferedText) ? flushBufferedText() : [];
      }

      if (chunk.type === "text-end") {
        const flushed = suppressRemainingText ? [] : flushBufferedText();
        const textEnd = emittedVisibleTextInBlock ? [chunk] : [];
        activeTextId = undefined;
        pendingTextStart = undefined;
        suppressRemainingText = false;
        emittedVisibleTextInBlock = false;
        return [...flushed, ...textEnd];
      }

      if (chunk.type === "finish" || chunk.type === "finish-step" || chunk.type === "error") {
        const flushed = suppressRemainingText ? [] : flushBufferedText();
        return [...flushed, chunk];
      }

      return [chunk];
    },

    flush(): UIMessageChunk[] {
      return suppressRemainingText ? [] : flushBufferedText();
    },
  };
}

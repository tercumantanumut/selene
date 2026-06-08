/**
 * ReFRAG-style Token-Based Micro-Chunking
 * Reference: docs/vector-search-v2-analysis.md Section 5.2
 */

import { loadTokenizerRuntime } from "./tokenizer-runtime";

interface MicroChunk {
  index: number;
  text: string;
  startLine: number;
  endLine: number;
  tokenOffset: number;
  tokenCount: number;
}

interface TokenChunkingOptions {
  windowTokens?: number;
  strideTokens?: number;
}

/**
 * Chunk text into token-aligned micro-chunks with line number mapping.
 */
export function chunkByTokens(
  text: string,
  options: TokenChunkingOptions = {}
): MicroChunk[] {
  const windowTokens = options.windowTokens ?? 16;
  const strideTokens = options.strideTokens ?? 8;

  if (!text.trim()) return [];

  const { decode, encode } = loadTokenizerRuntime();
  const tokens = encode(text);
  const chunks: MicroChunk[] = [];
  const lineStarts = buildLineStartIndex(text);

  let chunkIndex = 0;
  for (let tokenStart = 0; tokenStart < tokens.length; tokenStart += strideTokens) {
    const tokenEnd = Math.min(tokenStart + windowTokens, tokens.length);
    const windowTokenSlice = tokens.slice(tokenStart, tokenEnd);
    const chunkText = decode(windowTokenSlice);

    const startChar = decode(tokens.slice(0, tokenStart)).length;
    const endChar = decode(tokens.slice(0, tokenEnd)).length;

    const startLine = findLineNumber(lineStarts, startChar);
    const endLine = findLineNumber(lineStarts, endChar);

    chunks.push({
      index: chunkIndex++,
      text: chunkText,
      startLine,
      endLine,
      tokenOffset: tokenStart,
      tokenCount: tokenEnd - tokenStart,
    });

    if (tokenEnd >= tokens.length) break;
  }

  return chunks;
}

function buildLineStartIndex(text: string): number[] {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      lineStarts.push(i + 1);
    }
  }
  return lineStarts;
}

function findLineNumber(lineStarts: number[], charOffset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (lineStarts[mid] <= charOffset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1;
}


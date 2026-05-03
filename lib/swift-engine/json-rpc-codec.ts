/**
 * Line-delimited JSON-RPC 2.0 framing for the selene-engine `--stdio` mode.
 *
 * The Swift CLI emits one JSON object per line on stdout and consumes one
 * JSON object per line on stdin. This codec encodes outbound requests and
 * decodes inbound bytes in a way that's safe across partial reads.
 *
 * Wire format:
 *   <json-object>\n
 *
 * Where each JSON object follows JSON-RPC 2.0:
 *   { jsonrpc: "2.0", id: <number|string>, method: <string>, params: <any> }
 *   { jsonrpc: "2.0", id: <number|string>, result: <any> }
 *   { jsonrpc: "2.0", id: <number|string>, error: { code, message, data? } }
 *   { jsonrpc: "2.0", method: <string>, params: <any> }   // notification
 *
 * Invalid JSON lines are dropped with a warning rather than crashing the
 * supervisor — the Swift binary may emit informational stderr-style chatter
 * if mis-configured, and we don't want a single malformed line to take down
 * the entire pipe.
 */

export type JsonRpcId = number | string;

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse;

export type DecodedFrame =
  | { kind: "response"; message: JsonRpcResponse }
  | { kind: "notification"; message: JsonRpcNotification }
  | { kind: "request"; message: JsonRpcRequest };

export interface DecodeResult {
  frames: DecodedFrame[];
  remaining: string;
}

/** Encode a JSON-RPC request to a single line ending with \n. */
export function encodeRequest<TParams = unknown>(
  id: JsonRpcId,
  method: string,
  params?: TParams,
): string {
  const envelope: JsonRpcRequest<TParams> = {
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  };
  return JSON.stringify(envelope) + "\n";
}

/** Encode a JSON-RPC notification (no id) to a single line ending with \n. */
export function encodeNotification<TParams = unknown>(
  method: string,
  params?: TParams,
): string {
  const envelope: JsonRpcNotification<TParams> = {
    jsonrpc: "2.0",
    method,
    ...(params !== undefined ? { params } : {}),
  };
  return JSON.stringify(envelope) + "\n";
}

function classify(message: unknown): DecodedFrame | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if ("result" in m || "error" in m) {
    return { kind: "response", message: m as unknown as JsonRpcResponse };
  }
  if ("method" in m && "id" in m) {
    return { kind: "request", message: m as unknown as JsonRpcRequest };
  }
  if ("method" in m) {
    return { kind: "notification", message: m as unknown as JsonRpcNotification };
  }
  return null;
}

/**
 * Decode whatever complete \n-terminated frames can be parsed out of `buffer`,
 * returning them plus any unfinished trailing fragment for the caller to keep
 * around until the next read.
 *
 * Defensive: malformed JSON lines and lines that aren't JSON-RPC envelopes
 * are dropped with a console.warn so a single bad frame doesn't poison the
 * whole stream.
 */
export function decodeResponses(buffer: string): DecodeResult {
  const frames: DecodedFrame[] = [];
  let cursor = 0;
  let newlineIndex = buffer.indexOf("\n", cursor);

  while (newlineIndex !== -1) {
    const rawLine = buffer.slice(cursor, newlineIndex);
    cursor = newlineIndex + 1;
    newlineIndex = buffer.indexOf("\n", cursor);

    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      console.warn(
        `[SwiftEngine] dropping malformed JSON-RPC line: ${
          err instanceof Error ? err.message : String(err)
        } (line=${trimmed.slice(0, 200)}${trimmed.length > 200 ? "..." : ""})`,
      );
      continue;
    }

    const frame = classify(parsed);
    if (frame) {
      frames.push(frame);
    } else {
      console.warn(
        `[SwiftEngine] dropping JSON-RPC frame without recognizable shape: ${trimmed.slice(0, 200)}`,
      );
    }
  }

  return { frames, remaining: buffer.slice(cursor) };
}

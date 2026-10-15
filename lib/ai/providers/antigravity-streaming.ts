/**
 * Antigravity Streaming & Fetch Utilities
 *
 * Custom fetch wrapper and SSE stream transformer for the Antigravity API
 * gateway. Handles request body transformation, response unwrapping, and
 * mid-stream retry logic for quota/resource-exhaustion errors.
 */

import {
  ANTIGRAVITY_CONFIG,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
} from "@/lib/auth/antigravity-auth";
import {
  classifyRecoverability,
  getRetryDelayMs,
  shouldRetry,
  sleepWithAbort,
  type RecoveryClassification,
} from "@/lib/ai/retry/stream-recovery";
import { normalizeAntigravityToolSchemas } from "./antigravity-schema";
import { readRequestBody } from "./provider-utils";

// ---- Constants ---------------------------------------------------------------

const ANTIGRAVITY_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

// thoughtSignature sanitization constants (ported from opencode-antigravity-auth v1.6.0)
const MIN_SIGNATURE_LENGTH = 50;
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

// Retry configuration for Antigravity quota/resource exhaustion errors
const ANTIGRAVITY_RETRY_CONFIG = {
  maxRetries: 3,
};

// ---- ID Generators -----------------------------------------------------------

function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `req-${timestamp}-${random}`;
}

function generateSessionId(): string {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`;
}

function generateClaudeToolCallId(): string {
  return `toolu_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
}

// ---- Helpers -----------------------------------------------------------------

function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}


/**
 * Check if this is a Google Generative Language API request that should be
 * intercepted and forwarded to Antigravity.
 */
function isGenerativeLanguageRequest(url: string): boolean {
  return (
    url.includes("generativelanguage.googleapis.com") ||
    (url.includes("/models/") &&
      (url.includes(":generateContent") || url.includes(":streamGenerateContent")))
  );
}

/**
 * Ensure Claude functionCall/functionResponse parts share stable matching IDs.
 *
 * The Antigravity Claude gateway expects strict call/result pairing by ID.
 * We only fill in missing IDs and preserve any IDs already provided by the SDK.
 */
function ensureClaudeFunctionPartIds(contents: unknown): void {
  if (!Array.isArray(contents)) return;

  const pendingIdsByName = new Map<string, string[]>();

  for (const content of contents) {
    if (!content || typeof content !== "object") continue;
    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const partRecord = part as Record<string, unknown>;

      const functionCall = partRecord.functionCall;
      if (functionCall && typeof functionCall === "object") {
        const callRecord = functionCall as Record<string, unknown>;
        const functionName = getNonEmptyString(callRecord.name) ?? "__unknown_tool__";
        const callId = getNonEmptyString(callRecord.id) ?? generateClaudeToolCallId();
        callRecord.id = callId;

        const queue = pendingIdsByName.get(functionName) ?? [];
        queue.push(callId);
        pendingIdsByName.set(functionName, queue);
        continue;
      }

      const functionResponse = partRecord.functionResponse;
      if (!functionResponse || typeof functionResponse !== "object") {
        continue;
      }

      const responseRecord = functionResponse as Record<string, unknown>;
      const functionName = getNonEmptyString(responseRecord.name) ?? "__unknown_tool__";
      const existingId = getNonEmptyString(responseRecord.id);
      const queue = pendingIdsByName.get(functionName);

      if (existingId) {
        if (queue && queue.length > 0) {
          const matchIndex = queue.indexOf(existingId);
          if (matchIndex !== -1) {
            queue.splice(matchIndex, 1);
          }
          if (queue.length === 0) {
            pendingIdsByName.delete(functionName);
          }
        }
        continue;
      }

      if (!queue || queue.length === 0) {
        continue;
      }

      const matchedId = queue.shift();
      if (queue.length === 0) {
        pendingIdsByName.delete(functionName);
      }
      if (matchedId) {
        responseRecord.id = matchedId;
      }
    }
  }
}

// ---- Request payload sanitization (ported from opencode-antigravity-auth v1.6.0) ---

function isValidRequestPart(part: unknown): boolean {
  if (!part || typeof part !== "object") {
    return false;
  }

  const record = part as Record<string, unknown>;

  return (
    Object.prototype.hasOwnProperty.call(record, "text") ||
    Object.prototype.hasOwnProperty.call(record, "functionCall") ||
    Object.prototype.hasOwnProperty.call(record, "functionResponse") ||
    Object.prototype.hasOwnProperty.call(record, "inlineData") ||
    Object.prototype.hasOwnProperty.call(record, "fileData") ||
    Object.prototype.hasOwnProperty.call(record, "executableCode") ||
    Object.prototype.hasOwnProperty.call(record, "codeExecutionResult") ||
    Object.prototype.hasOwnProperty.call(record, "thought")
  );
}

function sanitizeRequestPayloadForAntigravity(payload: Record<string, unknown>): void {
  const anyPayload = payload as any;

  if (Array.isArray(anyPayload.contents)) {
    anyPayload.contents = anyPayload.contents
      .map((content: unknown) => {
        if (!content || typeof content !== "object") {
          return null;
        }

        const contentRecord = content as Record<string, unknown>;
        const rawParts = Array.isArray(contentRecord.parts) ? contentRecord.parts : [];
        let foundFirstFunctionCall = false;

        const sanitizedParts = rawParts.filter(isValidRequestPart).map((part: any) => {
          if (part && typeof part === "object" && part.functionCall) {
            let sig = part.thoughtSignature || part.thought_signature;

            if (!foundFirstFunctionCall) {
              foundFirstFunctionCall = true;
              if (!sig || sig.length < MIN_SIGNATURE_LENGTH) {
                sig = SKIP_THOUGHT_SIGNATURE;
              }
            } else {
              sig = undefined;
            }

            if (sig) {
              return { ...part, thought_signature: sig, thoughtSignature: sig };
            }

            const newPart = { ...part };
            delete newPart.thoughtSignature;
            delete newPart.thought_signature;
            return newPart;
          }
          return part;
        });

        if (sanitizedParts.length === 0) {
          return null;
        }

        return {
          ...contentRecord,
          parts: sanitizedParts,
        };
      })
      .filter((content: unknown): content is Record<string, unknown> => content !== null);
  }

  const systemInstruction = anyPayload.systemInstruction;
  if (systemInstruction && typeof systemInstruction === "object" && !Array.isArray(systemInstruction)) {
    const sys = systemInstruction as Record<string, unknown>;
    if (Array.isArray(sys.parts)) {
      const sanitizedSystemParts = sys.parts.filter(isValidRequestPart);
      if (sanitizedSystemParts.length > 0) {
        sys.parts = sanitizedSystemParts;
      } else {
        delete anyPayload.systemInstruction;
      }
    }
  }
}

// ---- Response unwrap helpers -------------------------------------------------

/**
 * Ensure functionCall parts in an unwrapped candidate list always carry an
 * `args` field (even if empty), which the Google AI SDK requires.
 */
function fixFunctionCallArgs(unwrapped: Record<string, unknown>): void {
  if (!unwrapped?.candidates || !Array.isArray(unwrapped.candidates)) return;
  for (const candidate of unwrapped.candidates) {
    if (candidate?.content?.parts && Array.isArray(candidate.content.parts)) {
      for (const part of candidate.content.parts) {
        if (part?.functionCall && typeof part.functionCall === "object") {
          if (!("args" in part.functionCall)) {
            part.functionCall.args = {};
          }
        }
      }
    }
  }
}

/**
 * Unwrap a non-streaming Antigravity response.
 */
function unwrapResponse(text: string): string {
  try {
    const parsed = JSON.parse(text);
    const unwrapped = parsed.response !== undefined ? parsed.response : parsed;
    fixFunctionCallArgs(unwrapped);
    return JSON.stringify(unwrapped);
  } catch {
    return text;
  }
}

// ---- SSE stream transformer --------------------------------------------------

/**
 * Transform SSE stream to unwrap response objects with retry support for quota
 * errors.
 *
 * This stream transformer detects quota/resource exhaustion errors in the SSE
 * stream and can trigger a retry callback to get a new stream, transparently
 * continuing the response to the client.
 *
 * @param onComplete - Called when stream completes successfully
 * @param onRetryNeeded - Callback to get a new stream on retryable error, returns null if retry fails
 */
function createResponseTransformStreamWithRetry(
  onComplete?: () => void,
  onRetryNeeded?: (errorText: string) => Promise<ReadableStream<string> | null>
): TransformStream<string, string> {
  let buffer = "";
  let retryReader: ReadableStreamDefaultReader<string> | null = null;

  const classifyRecoverableStreamPayload = (parsed: unknown): RecoveryClassification | null => {
    if (typeof parsed !== "object" || parsed === null) return null;

    const obj = parsed as Record<string, unknown>;

    if (obj.error && typeof obj.error === "object") {
      const error = obj.error as Record<string, unknown>;
      const message = String(error.message || error.error || "");
      const classification = classifyRecoverability({ provider: "antigravity", message });
      if (classification.recoverable) {
        return classification;
      }
    }

    if (obj.message && typeof obj.message === "string") {
      const classification = classifyRecoverability({
        provider: "antigravity",
        message: obj.message,
      });
      if (classification.recoverable) {
        return classification;
      }
    }

    if (obj.candidates && Array.isArray(obj.candidates)) {
      for (const candidate of obj.candidates) {
        if (candidate && typeof candidate === "object") {
          const c = candidate as Record<string, unknown>;
          if (c.finishReason === "OTHER" || c.finishReason === "RECITATION") {
            const content = c.content as Record<string, unknown> | undefined;
            if (content?.parts && Array.isArray(content.parts)) {
              for (const part of content.parts) {
                if (part && typeof part === "object" && "text" in part) {
                  const text = String((part as Record<string, unknown>).text || "");
                  const classification = classifyRecoverability({
                    provider: "antigravity",
                    message: text,
                  });
                  if (classification.recoverable) {
                    return classification;
                  }
                }
              }
            }
          }
        }
      }
    }

    return null;
  };

  const processLines = (
    lines: string[],
    controller: TransformStreamDefaultController<string>
  ) => {
    for (const line of lines) {
      if (!line.startsWith("data:")) {
        controller.enqueue(line + "\n");
        continue;
      }

      const json = line.slice(5).trim();
      if (!json) {
        controller.enqueue(line + "\n");
        continue;
      }

      try {
        const parsed = JSON.parse(json);
        const unwrapped = parsed.response !== undefined ? parsed.response : parsed;
        fixFunctionCallArgs(unwrapped);
        controller.enqueue(`data: ${JSON.stringify(unwrapped)}\n`);
      } catch {
        controller.enqueue(line + "\n");
      }
    }
  };

  /**
   * Drain the accumulated retry stream into the controller.
   */
  const processRetryData = async (controller: TransformStreamDefaultController<string>) => {
    if (!retryReader) return;

    try {
      while (true) {
        const { done, value } = await retryReader.read();
        if (done) break;

        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        processLines(lines, controller);
      }
    } finally {
      retryReader.releaseLock();
      retryReader = null;
    }
  };

  return new TransformStream<string, string>({
    async transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) {
          controller.enqueue(line + "\n");
          continue;
        }

        const json = line.slice(5).trim();
        if (!json) {
          controller.enqueue(line + "\n");
          continue;
        }

        try {
          const parsed = JSON.parse(json);

          const retryClassification = classifyRecoverableStreamPayload(parsed);
          if (retryClassification && onRetryNeeded) {
            const message = retryClassification.normalized.message;
            console.log("[Antigravity] Detected recoverable mid-stream payload", {
              reason: retryClassification.reason,
              message: message.substring(0, 100),
            });

            const newStream = await onRetryNeeded(message);
            if (newStream) {
              console.log(`[Antigravity] Got retry stream, continuing response...`);
              retryReader = newStream.getReader();
              await processRetryData(controller);
              return;
            } else {
              console.log(`[Antigravity] Retry failed, forwarding error to client`);
            }
          }

          // Unwrap the response field if present
          const unwrapped = parsed.response !== undefined ? parsed.response : parsed;
          fixFunctionCallArgs(unwrapped);
          controller.enqueue(`data: ${JSON.stringify(unwrapped)}\n`);
        } catch {
          controller.enqueue(line + "\n");
        }
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(buffer);
      }
      onComplete?.();
    },
  });
}

// ---- Custom fetch factory ----------------------------------------------------

/**
 * Create a custom fetch wrapper that intercepts Google Generative Language API
 * requests and routes them through the Antigravity gateway.
 */
export function createAntigravityFetch(
  accessToken: string,
  projectId: string,
  resolveModelName: (modelId: string) => string
): typeof fetch {
  const sessionId = generateSessionId();

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : input.url;

    // Only intercept generative language requests
    if (!isGenerativeLanguageRequest(url)) {
      return fetch(input, init);
    }

    // Extract model and action from URL
    // Format: .../models/{model}:{action}
    const match = url.match(/\/models\/([^:/?]+):(\w+)/);
    if (!match) {
      return fetch(input, init);
    }

    const [, rawModel, action] = match;
    const effectiveModel = resolveModelName(rawModel || "");
    const streaming = action === "streamGenerateContent";

    // Build Antigravity endpoint URL
    const baseUrl = ANTIGRAVITY_CONFIG.API_BASE_URL;
    const antigravityUrl = `${baseUrl}/${ANTIGRAVITY_CONFIG.API_VERSION}:${action}${streaming ? "?alt=sse" : ""}`;

    // Parse and transform the request body
    let transformedBody: string | undefined;
    if (init?.body) {
      try {
        const bodyText = await readRequestBody(init.body);
        const parsedBody = JSON.parse(bodyText);

        // Inject Antigravity system instruction (role must be "user")
        if (parsedBody.systemInstruction) {
          const sys = parsedBody.systemInstruction;
          if (typeof sys === "object") {
            sys.role = "user";
            if (Array.isArray(sys.parts) && sys.parts.length > 0) {
              const firstPart = sys.parts[0];
              if (firstPart && typeof firstPart.text === "string") {
                firstPart.text = ANTIGRAVITY_SYSTEM_INSTRUCTION + "\n\n" + firstPart.text;
              } else {
                sys.parts = [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, ...sys.parts];
              }
            } else {
              sys.parts = [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }];
            }
          } else if (typeof sys === "string") {
            parsedBody.systemInstruction = {
              role: "user",
              parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION + "\n\n" + sys }],
            };
          }
        } else {
          parsedBody.systemInstruction = {
            role: "user",
            parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }],
          };
        }

        // Normalize tool schemas (Gemini requires string enums, etc.)
        if (parsedBody.tools) {
          normalizeAntigravityToolSchemas(parsedBody.tools);
        }

        // For Claude models, ensure functionCall/functionResponse parts use
        // stable shared IDs for strict call/result validation.
        const isClaudeModel = effectiveModel.includes("claude");
        if (isClaudeModel) {
          ensureClaudeFunctionPartIds(parsedBody.contents);
        }

        // Sanitize request: filter invalid parts, handle thoughtSignature for Gemini 3.1
        sanitizeRequestPayloadForAntigravity(parsedBody);

        // Wrap request in Antigravity's expected format
        const wrappedBody = {
          project: projectId,
          model: effectiveModel,
          userAgent: "antigravity",
          requestId: generateRequestId(),
          requestType: "agent", // Required in v1.2.8
          request: {
            ...parsedBody,
            sessionId,
          },
        };

        transformedBody = JSON.stringify(wrappedBody);
      } catch (e) {
        console.error("[Antigravity] Failed to transform request body:", e);
        throw e;
      }
    }

    // Build headers
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", streaming ? "text/event-stream" : "application/json");
    headers.set("User-Agent", ANTIGRAVITY_CONFIG.HEADERS["User-Agent"]);
    headers.set("X-Goog-Api-Client", ANTIGRAVITY_CONFIG.HEADERS["X-Goog-Api-Client"]);
    headers.set("Client-Metadata", ANTIGRAVITY_CONFIG.HEADERS["Client-Metadata"]);
    // Remove any API key header — we use OAuth Bearer token
    headers.delete("x-goog-api-key");

    console.debug(`[Antigravity] Request: ${action} for model ${effectiveModel}`);
    console.debug(`[Antigravity] URL: ${antigravityUrl}`);

    // Helper to make a single request attempt (with recursive retry)
    const makeRequest = async (attempt: number): Promise<Response> => {
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const clearTimeoutOnce = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };
      timeoutId = setTimeout(() => {
        clearTimeoutOnce();
        controller.abort(new Error("Antigravity request timed out"));
      }, ANTIGRAVITY_REQUEST_TIMEOUT_MS);

      const upstreamSignal = init?.signal;
      if (upstreamSignal) {
        if (upstreamSignal.aborted) {
          controller.abort(upstreamSignal.reason);
        } else {
          upstreamSignal.addEventListener(
            "abort",
            () => controller.abort(upstreamSignal.reason),
            { once: true }
          );
        }
      }

      let response: Response;
      try {
        response = await fetch(antigravityUrl, {
          ...init,
          method: init?.method || "POST",
          headers,
          body: transformedBody,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeoutOnce();
        throw error;
      }

      if (!response.ok) {
        clearTimeoutOnce();
        const errorText = await response.clone().text();
        console.error(
          `[Antigravity] Error (attempt ${attempt + 1}): ${response.status} ${response.statusText}`
        );
        console.error(`[Antigravity] Response: ${errorText.substring(0, 500)}`);

        const classification = classifyRecoverability({
          provider: "antigravity",
          statusCode: response.status,
          headers: response.headers,
          message: errorText,
        });
        const shouldAttemptRetry = shouldRetry({
          classification,
          attempt,
          maxAttempts: ANTIGRAVITY_RETRY_CONFIG.maxRetries,
          aborted: init?.signal?.aborted ?? false,
        });

        if (shouldAttemptRetry) {
          const delay = getRetryDelayMs({ attempt, classification });
          console.log("[Antigravity] Scheduling HTTP stream recovery retry", {
            attempt: attempt + 1,
            reason: classification.reason,
            delayMs: delay,
            outcome: "scheduled",
          });
          await sleepWithAbort(delay, init?.signal ?? undefined);
          return makeRequest(attempt + 1);
        }

        return response;
      }

      // For streaming responses, transform SSE data with retry support
      if (streaming && response.body) {
        const streamBody = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(
            createResponseTransformStreamWithRetry(
              clearTimeoutOnce,
              async (errorText: string): Promise<ReadableStream<string> | null> => {
                const classification = classifyRecoverability({
                  provider: "antigravity",
                  message: errorText,
                });
                const shouldAttemptRetry = shouldRetry({
                  classification,
                  attempt,
                  maxAttempts: ANTIGRAVITY_RETRY_CONFIG.maxRetries,
                  aborted: init?.signal?.aborted ?? false,
                });
                if (!shouldAttemptRetry) {
                  console.error(
                    "[Antigravity] Stream error not retryable or max retries exceeded",
                    { attempt: attempt + 1, reason: classification.reason }
                  );
                  return null;
                }
                const delay = getRetryDelayMs({ attempt, classification });
                console.log("[Antigravity] Scheduling mid-stream recovery retry", {
                  attempt: attempt + 1,
                  reason: classification.reason,
                  delayMs: delay,
                  outcome: "scheduled",
                });
                await sleepWithAbort(delay, init?.signal ?? undefined);

                try {
                  const retryResponse = await makeRequest(attempt + 1);
                  if (retryResponse.ok && retryResponse.body) {
                    return retryResponse.body.pipeThrough(new TextDecoderStream());
                  }
                } catch (retryError) {
                  console.error(`[Antigravity] Retry failed:`, retryError);
                }
                return null;
              }
            )
          )
          .pipeThrough(new TextEncoderStream());

        return new Response(streamBody, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // Non-streaming: unwrap the response
      const text = await response.text();
      clearTimeoutOnce();
      const unwrappedText = unwrapResponse(text);

      return new Response(unwrappedText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };

    return makeRequest(0);
  };
}

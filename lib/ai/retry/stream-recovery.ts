/**
 * Deliberate, provider-agnostic recovery cadence. Five retries occupy 7.5
 * minutes before jitter, rather than immediately replaying failed requests.
 */
export const PROVIDER_RECOVERY_RETRY_SCHEDULE_MS = [30_000, 60_000, 90_000, 120_000, 150_000] as const;
export const PROVIDER_RECOVERY_MAX_RETRIES = PROVIDER_RECOVERY_RETRY_SCHEDULE_MS.length;
const RETRY_MAX_DELAY_MS = PROVIDER_RECOVERY_RETRY_SCHEDULE_MS[PROVIDER_RECOVERY_RETRY_SCHEDULE_MS.length - 1];
const RETRY_AFTER_MAX_DELAY_MS = 10 * 60_000;

const RECOVERABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const CONFLICT_STATUS_CODE = 409;

const PROVIDER_OVERLOAD_PATTERNS = [
  /temporar(?:y|ily) overloaded/i,
  /currently overloaded/i,
  /servers? (?:are|is) .*overloaded/i,
  /\boverloaded\b/i,
];

const TRANSIENT_PAYLOAD_PATTERNS = [
  /resource exhausted/i,
  /quota/i,
  /rate\s*limit/i,
  /too many requests/i,
  /temporar(?:y|ily) unavailable/i,
  /upstream.*(closed|reset|interrupted)/i,
  /stream.*(closed|interrupted|terminated)/i,
  /incomplete chunk/i,
  /controller was closed/i,
  /connection (reset|terminated|dropped)/i,
  /timeout/i,
  /deadline exceeded/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /econnrefused/i,
  /econnreset/i,
  /etimedout/i,
  /eai_again/i,
  /other side closed/i,
  /UND_ERR_SOCKET/i,
  /broken pipe/i,
  /failed to pipe/i,
  /server_error/i,
];

const TERMINAL_PAYLOAD_PATTERNS = [
  /invalid api key/i,
  /authentication required/i,
  /unauthorized/i,
  /forbidden/i,
  /insufficient permissions?/i,
  /unsupported/i,
  /invalid request/i,
  /malformed/i,
  /context length/i,
  /maximum context/i,
];

const USER_ABORT_PATTERNS = [
  /user.?cancel/i,
  /cancelled by user/i,
  /aborted by user/i,
  /request aborted by caller/i,
];

const UPSTREAM_ABORT_PATTERNS = [
  /aborterror/i,
  /^aborted$/i,          // bare "aborted" from H2Proxy mid-stream teardown
  /stream.*aborted/i,
  /upstream.*aborted/i,
  /connection closed/i,
  /socket hang up/i,
];

type RecoveryReason =
  | "provider_overloaded"
  | "recoverable_status"
  | "conflict"
  | "recoverable_payload"
  | "recoverable_abort"
  | "user_abort"
  | "terminal_status"
  | "terminal_payload"
  | "unknown";

interface NormalizedStreamError {
  message: string;
  statusCode?: number;
  code?: string;
  provider?: string;
  retryAfterMs?: number;
  isAbort: boolean;
  isUserAbort: boolean;
  raw: unknown;
}

export interface RecoveryClassification {
  recoverable: boolean;
  reason: RecoveryReason;
  normalized: NormalizedStreamError;
}

type HeaderSource = Headers | Record<string, unknown>;

function parseStatusCode(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === "string") {
    const parsed = Number.parseInt(input, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseDurationMs(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isFinite(input) && input >= 0) {
    return input;
  }
  if (typeof input === "string") {
    const parsed = Number.parseFloat(input);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function toRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null
    ? input as Record<string, unknown>
    : undefined;
}

function toHeaderSource(input: unknown): HeaderSource | undefined {
  if (typeof Headers !== "undefined" && input instanceof Headers) return input;
  return toRecord(input);
}

function getHeaderValue(headers: HeaderSource | undefined, headerName: string): string | undefined {
  if (!headers) return undefined;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(headerName) ?? undefined;
  }

  const target = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function parseRetryAfterMs(headers?: HeaderSource): number | undefined {
  const retryAfterMs = parseDurationMs(getHeaderValue(headers, "retry-after-ms"));
  if (retryAfterMs !== undefined) return retryAfterMs;

  const raw = getHeaderValue(headers, "retry-after");
  if (!raw) return undefined;

  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(raw);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return undefined;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((v) => typeof v === "string") as string | undefined;
}

function unwrapRetryError(input: unknown): unknown {
  const record = toRecord(input);
  if (!record) return input;

  const name = firstString(record.name);
  if (name !== "AI_RetryError" && name !== "RetryError") return input;

  if (record.lastError !== undefined) return record.lastError;

  const errors = record.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors[errors.length - 1];
  }

  return input;
}

export function normalizeStreamError(input: unknown): NormalizedStreamError {
  if (input instanceof Response) {
    const msg = `${input.status} ${input.statusText}`.trim();
    return {
      message: msg,
      statusCode: input.status,
      retryAfterMs: parseRetryAfterMs(input.headers),
      isAbort: false,
      isUserAbort: false,
      raw: input,
    };
  }

  const effectiveInput = unwrapRetryError(input);
  const objectLike = toRecord(effectiveInput);
  const nestedError = unwrapRetryError(objectLike?.error);
  const nestedErrorObj = toRecord(nestedError);
  const dataObj = toRecord(objectLike?.data);
  const dataErrorObj = toRecord(dataObj?.error);
  const nestedErrorDataObj = toRecord(nestedErrorObj?.data);
  const nestedErrorDataErrorObj = toRecord(nestedErrorDataObj?.error);
  const responseObj = toRecord(objectLike?.response);
  const responseErrorObj = toRecord(responseObj?.error);
  const nestedErrorResponseObj = toRecord(nestedErrorObj?.response);
  const nestedErrorResponseErrorObj = toRecord(nestedErrorResponseObj?.error);
  const nestedCause = objectLike?.cause;
  const nestedCauseObj = toRecord(nestedCause);

  const message = firstString(
    objectLike?.message,
    objectLike?.responseBody,
    dataErrorObj?.message,
    nestedErrorDataErrorObj?.message,
    dataObj?.message,
    nestedErrorDataObj?.message,
    responseErrorObj?.message,
    nestedErrorResponseErrorObj?.message,
    responseObj?.message,
    nestedErrorResponseObj?.message,
    nestedError instanceof Error ? nestedError.message : undefined,
    nestedErrorObj?.message,
    nestedErrorObj?.responseBody,
    nestedErrorObj?.error,
    nestedCause instanceof Error ? nestedCause.message : undefined,
    nestedCauseObj?.message,
    nestedCauseObj?.responseBody,
    effectiveInput instanceof Error ? effectiveInput.message : undefined,
    input instanceof Error ? input.message : undefined,
  );

  const statusCode =
    parseStatusCode(objectLike?.statusCode) ??
    parseStatusCode(objectLike?.status) ??
    parseStatusCode(dataErrorObj?.statusCode) ??
    parseStatusCode(dataErrorObj?.status) ??
    parseStatusCode(nestedErrorDataErrorObj?.statusCode) ??
    parseStatusCode(nestedErrorDataErrorObj?.status) ??
    parseStatusCode(dataObj?.statusCode) ??
    parseStatusCode(dataObj?.status) ??
    parseStatusCode(nestedErrorDataObj?.statusCode) ??
    parseStatusCode(nestedErrorDataObj?.status) ??
    parseStatusCode(responseErrorObj?.statusCode) ??
    parseStatusCode(responseErrorObj?.status) ??
    parseStatusCode(nestedErrorResponseErrorObj?.statusCode) ??
    parseStatusCode(nestedErrorResponseErrorObj?.status) ??
    parseStatusCode(responseObj?.statusCode) ??
    parseStatusCode(responseObj?.status) ??
    parseStatusCode(nestedErrorResponseObj?.statusCode) ??
    parseStatusCode(nestedErrorResponseObj?.status) ??
    parseStatusCode(nestedErrorObj?.statusCode) ??
    parseStatusCode(nestedErrorObj?.status) ??
    parseStatusCode(nestedCauseObj?.statusCode) ??
    parseStatusCode(nestedCauseObj?.status);

  const code = firstString(
    dataErrorObj?.code,
    dataErrorObj?.errorType,
    dataErrorObj?.type,
    nestedErrorDataErrorObj?.code,
    nestedErrorDataErrorObj?.errorType,
    nestedErrorDataErrorObj?.type,
    responseErrorObj?.code,
    responseErrorObj?.errorType,
    responseErrorObj?.type,
    nestedErrorResponseErrorObj?.code,
    nestedErrorResponseErrorObj?.errorType,
    nestedErrorResponseErrorObj?.type,
    nestedErrorObj?.code,
    nestedErrorObj?.errorType,
    nestedErrorObj?.type,
    nestedError instanceof Error ? nestedError.name : undefined,
    nestedCauseObj?.code,
    nestedCauseObj?.errorType,
    nestedCauseObj?.type,
    nestedCause instanceof Error ? nestedCause.name : undefined,
    dataObj?.code,
    dataObj?.errorType,
    dataObj?.type,
    nestedErrorDataObj?.code,
    nestedErrorDataObj?.errorType,
    nestedErrorDataObj?.type,
    responseObj?.code,
    responseObj?.errorType,
    responseObj?.type,
    nestedErrorResponseObj?.code,
    nestedErrorResponseObj?.errorType,
    nestedErrorResponseObj?.type,
    objectLike?.code,
    objectLike?.errorType,
    objectLike?.type,
    effectiveInput instanceof Error ? effectiveInput.name : undefined,
    input instanceof Error ? input.name : undefined,
  );

  const provider = firstString(
    objectLike?.provider,
    dataErrorObj?.provider,
    nestedErrorDataErrorObj?.provider,
    dataObj?.provider,
    nestedErrorDataObj?.provider,
    responseErrorObj?.provider,
    nestedErrorResponseErrorObj?.provider,
    responseObj?.provider,
    nestedErrorResponseObj?.provider,
    nestedErrorObj?.provider,
    nestedCauseObj?.provider,
  );

  const retryAfterMs =
    parseDurationMs(objectLike?.retryAfterMs) ??
    parseDurationMs(objectLike?.retryAfter) ??
    parseRetryAfterMs(toHeaderSource(objectLike?.headers)) ??
    parseRetryAfterMs(toHeaderSource(objectLike?.responseHeaders)) ??
    parseRetryAfterMs(toHeaderSource(dataErrorObj?.headers)) ??
    parseRetryAfterMs(toHeaderSource(dataErrorObj?.responseHeaders)) ??
    parseRetryAfterMs(toHeaderSource(nestedErrorDataErrorObj?.headers)) ??
    parseRetryAfterMs(toHeaderSource(nestedErrorDataErrorObj?.responseHeaders)) ??
    parseRetryAfterMs(toHeaderSource(dataObj?.headers)) ??
    parseRetryAfterMs(toHeaderSource(dataObj?.responseHeaders)) ??
    parseRetryAfterMs(toHeaderSource(nestedErrorDataObj?.headers)) ??
    parseRetryAfterMs(toHeaderSource(nestedErrorDataObj?.responseHeaders)) ??
    parseRetryAfterMs(toHeaderSource(responseErrorObj?.headers)) ??
    parseRetryAfterMs(toHeaderSource(responseErrorObj?.responseHeaders)) ??
    parseRetryAfterMs(toHeaderSource(nestedErrorResponseErrorObj?.headers)) ??
    parseRetryAfterMs(toHeaderSource(nestedErrorResponseErrorObj?.responseHeaders)) ??
    parseRetryAfterMs(toHeaderSource(responseObj?.headers)) ??
    parseRetryAfterMs(toHeaderSource(responseObj?.responseHeaders)) ??
    parseRetryAfterMs(toHeaderSource(nestedErrorResponseObj?.headers)) ??
    parseRetryAfterMs(toHeaderSource(nestedErrorResponseObj?.responseHeaders)) ??
    parseRetryAfterMs(toHeaderSource(nestedErrorObj?.headers)) ??
    parseRetryAfterMs(toHeaderSource(nestedErrorObj?.responseHeaders)) ??
    parseRetryAfterMs(toHeaderSource(nestedCauseObj?.headers)) ??
    parseRetryAfterMs(toHeaderSource(nestedCauseObj?.responseHeaders));

  const messageText = message ?? safeStringify(input);
  const lower = messageText.toLowerCase();
  const isAbort = UPSTREAM_ABORT_PATTERNS.some((pattern) => pattern.test(lower));
  const isUserAbort = USER_ABORT_PATTERNS.some((pattern) => pattern.test(lower));

  return {
    message: messageText,
    statusCode,
    code,
    provider,
    retryAfterMs,
    isAbort,
    isUserAbort,
    raw: input,
  };
}

export function classifyRecoverability(input: unknown): RecoveryClassification {
  const normalized = normalizeStreamError(input);
  const haystack = `${normalized.code ?? ""} ${normalized.message}`.toLowerCase();

  if (normalized.isUserAbort) {
    return { recoverable: false, reason: "user_abort", normalized };
  }

  if (normalized.statusCode === CONFLICT_STATUS_CODE) {
    // 409 can be transient in some provider gateways, but default to non-recoverable.
    return { recoverable: false, reason: "conflict", normalized };
  }

  if (
    typeof normalized.statusCode === "number" &&
    normalized.statusCode >= 400 &&
    normalized.statusCode < 500 &&
    !RECOVERABLE_STATUS_CODES.has(normalized.statusCode)
  ) {
    return { recoverable: false, reason: "terminal_status", normalized };
  }

  if (TERMINAL_PAYLOAD_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { recoverable: false, reason: "terminal_payload", normalized };
  }

  if (PROVIDER_OVERLOAD_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { recoverable: true, reason: "provider_overloaded", normalized };
  }

  if (typeof normalized.statusCode === "number" && RECOVERABLE_STATUS_CODES.has(normalized.statusCode)) {
    return { recoverable: true, reason: "recoverable_status", normalized };
  }

  if (TRANSIENT_PAYLOAD_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { recoverable: true, reason: "recoverable_payload", normalized };
  }

  if (normalized.isAbort) {
    return { recoverable: true, reason: "recoverable_abort", normalized };
  }

  return { recoverable: false, reason: "unknown", normalized };
}

export function getFriendlyErrorMessage(normalized: NormalizedStreamError): string | null {
  const msg = normalized.message;

  if (/econnrefused/i.test(msg) && /11434/.test(msg)) {
    return "Ollama is not running. Start it with `ollama serve` and try again.";
  }

  if (normalized.statusCode === 404 && /model/i.test(msg)) {
    return "Model not found. Run `ollama pull <model>` to download it first.";
  }

  return null;
}

export function getBackoffDelayMs(attempt: number, jitterRatio = 0.2): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const base = PROVIDER_RECOVERY_RETRY_SCHEDULE_MS[Math.min(safeAttempt, PROVIDER_RECOVERY_RETRY_SCHEDULE_MS.length - 1)];
  const jitter = base * jitterRatio * (Math.random() * 2 - 1);
  return Math.min(Math.max(0, Math.round(base + jitter)), RETRY_MAX_DELAY_MS);
}

export function getRetryDelayMs(args: {
  attempt: number;
  classification: RecoveryClassification;
  jitterRatio?: number;
}): number {
  const retryAfterMs = args.classification.normalized.retryAfterMs;
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(Math.round(retryAfterMs), RETRY_AFTER_MAX_DELAY_MS);
  }

  return getBackoffDelayMs(args.attempt, args.jitterRatio);
}

export function shouldRetry(args: {
  classification: RecoveryClassification;
  attempt: number;
  maxAttempts: number;
  aborted?: boolean;
}): boolean {
  const { classification, attempt, maxAttempts, aborted = false } = args;
  if (aborted) return false;
  if (!classification.recoverable) return false;
  return attempt < maxAttempts;
}

export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }

  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

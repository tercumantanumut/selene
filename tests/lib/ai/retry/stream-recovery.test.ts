import { describe, expect, it } from "vitest";

import {
  classifyRecoverability,
  getBackoffDelayMs,
  getRetryDelayMs,
  getFriendlyErrorMessage,
  normalizeStreamError,
  PROVIDER_RECOVERY_MAX_RETRIES,
  PROVIDER_RECOVERY_RETRY_SCHEDULE_MS,
  shouldRetry,
} from "@/lib/ai/retry/stream-recovery";

describe("stream-recovery", () => {
  describe("ECONNREFUSED transient pattern", () => {
    it("classifies ECONNREFUSED as recoverable", () => {
      const result = classifyRecoverability(
        new Error("connect ECONNREFUSED 127.0.0.1:11434"),
      );
      expect(result.recoverable).toBe(true);
      expect(result.reason).toBe("recoverable_payload");
    });

    it("classifies lowercase econnrefused as recoverable", () => {
      const result = classifyRecoverability(
        new Error("connect econnrefused 127.0.0.1:11434"),
      );
      expect(result.recoverable).toBe(true);
      expect(result.reason).toBe("recoverable_payload");
    });

    it("classifies ECONNREFUSED on non-standard port as recoverable", () => {
      const result = classifyRecoverability(
        new Error("connect ECONNREFUSED 192.168.1.10:8080"),
      );
      expect(result.recoverable).toBe(true);
      expect(result.reason).toBe("recoverable_payload");
    });
  });

  describe("provider overload recovery", () => {
    it("classifies OpenAI/Codex overload messages as recoverable", () => {
      const result = classifyRecoverability(
        new Error("Our servers are currently overloaded. Please try again later."),
      );

      expect(result.recoverable).toBe(true);
      expect(result.reason).toBe("provider_overloaded");
    });

    it("uses a paced retry window of five to ten minutes", () => {
      expect(PROVIDER_RECOVERY_RETRY_SCHEDULE_MS).toEqual([
        30_000, 60_000, 90_000, 120_000, 150_000,
      ]);
      expect(PROVIDER_RECOVERY_MAX_RETRIES).toBe(5);
      const totalDelayMs = PROVIDER_RECOVERY_RETRY_SCHEDULE_MS.reduce((total, delay) => total + delay, 0);
      expect(totalDelayMs).toBeGreaterThanOrEqual(5 * 60_000);
      expect(totalDelayMs).toBeLessThanOrEqual(10 * 60_000);
      expect(getBackoffDelayMs(0, 0)).toBe(30_000);
      expect(getBackoffDelayMs(4, 0)).toBe(150_000);
    });

    it("stops after the shared recovery budget", () => {
      const classification = classifyRecoverability(new Error("servers are currently overloaded"));

      expect(shouldRetry({ classification, attempt: 4, maxAttempts: PROVIDER_RECOVERY_MAX_RETRIES })).toBe(true);
      expect(shouldRetry({ classification, attempt: 5, maxAttempts: PROVIDER_RECOVERY_MAX_RETRIES })).toBe(false);
    });

    it("classifies Codex provider error metadata even when the message is generic", () => {
      class CodexStreamError extends Error {
        public readonly errorType = "server_error";
      }

      const classification = classifyRecoverability({
        provider: "codex",
        error: new CodexStreamError("Codex API error: Chat session failed"),
      });

      expect(classification.recoverable).toBe(true);
      expect(classification.reason).toBe("recoverable_payload");
      expect(classification.normalized.code).toBe("server_error");
    });

    it("classifies OpenAI APICallError data metadata", () => {
      const classification = classifyRecoverability({
        provider: "codex",
        type: "error",
        message: "Codex API error",
        data: {
          error: {
            type: "server_error",
            message: "Chat session failed",
          },
        },
      });

      expect(classification.recoverable).toBe(true);
      expect(classification.reason).toBe("recoverable_payload");
      expect(classification.normalized.code).toBe("server_error");
      expect(classification.normalized.message).toBe("Codex API error");
    });

    it("classifies APICallError data metadata through the route wrapper", () => {
      const classification = classifyRecoverability({
        provider: "codex",
        message: "Codex API error",
        error: {
          type: "error",
          message: "Chat session failed",
          data: {
            error: {
              type: "server_error",
              message: "Our servers are currently overloaded. Please try again later.",
            },
          },
        },
      });

      expect(classification.recoverable).toBe(true);
      expect(classification.reason).toBe("recoverable_payload");
      expect(classification.normalized.code).toBe("server_error");
      expect(classification.normalized.message).toBe("Codex API error");
    });

    it("classifies APICallError data metadata through an AI SDK RetryError wrapper", () => {
      const classification = classifyRecoverability({
        provider: "codex",
        message: "Codex API error",
        error: {
          name: "AI_RetryError",
          message: "Failed after 3 attempts",
          reason: "maxRetriesExceeded",
          lastError: {
            type: "error",
            message: "Chat session failed",
            data: {
              error: {
                type: "server_error",
                message: "Our servers are currently overloaded. Please try again later.",
              },
            },
          },
          errors: [],
        },
      });

      expect(classification.recoverable).toBe(true);
      expect(classification.reason).toBe("recoverable_payload");
      expect(classification.normalized.code).toBe("server_error");
      expect(classification.normalized.message).toBe("Codex API error");
    });

    it("honors Retry-After headers when selecting a retry delay", () => {
      const classification = classifyRecoverability({
        provider: "codex",
        statusCode: 503,
        responseHeaders: { "retry-after": "120" },
        message: "provider overloaded",
      });

      expect(classification.normalized.retryAfterMs).toBe(120_000);
      expect(getRetryDelayMs({ attempt: 0, classification, jitterRatio: 0 })).toBe(120_000);
    });
  });

  describe("getFriendlyErrorMessage", () => {
    it("returns Ollama-not-running message for ECONNREFUSED on port 11434", () => {
      const normalized = normalizeStreamError(
        new Error("connect ECONNREFUSED 127.0.0.1:11434"),
      );
      expect(getFriendlyErrorMessage(normalized)).toBe(
        "Ollama is not running. Start it with `ollama serve` and try again.",
      );
    });

    it("returns null for ECONNREFUSED on a different port", () => {
      const normalized = normalizeStreamError(
        new Error("connect ECONNREFUSED 127.0.0.1:8080"),
      );
      expect(getFriendlyErrorMessage(normalized)).toBeNull();
    });

    it("returns model-not-found message for 404 with model mention", () => {
      const normalized = normalizeStreamError({
        message: "model 'llama3' not found",
        statusCode: 404,
      });
      expect(getFriendlyErrorMessage(normalized)).toBe(
        "Model not found. Run `ollama pull <model>` to download it first.",
      );
    });

    it("returns null for 404 without model mention", () => {
      const normalized = normalizeStreamError({
        message: "not found",
        statusCode: 404,
      });
      expect(getFriendlyErrorMessage(normalized)).toBeNull();
    });

    it("returns null for unrecognized errors", () => {
      const normalized = normalizeStreamError(
        new Error("something unexpected happened"),
      );
      expect(getFriendlyErrorMessage(normalized)).toBeNull();
    });
  });
});

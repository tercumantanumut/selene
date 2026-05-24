import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sidecarMocks = vi.hoisted(() => ({
  ensureSidecarReady: vi.fn(async () => ({
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKey: "selene-test-key",
    port: 8317,
  })),
}));

const bridgeMocks = vi.hoisted(() => ({
  ensureCodexCredentialBridged: vi.fn(async () => ({
    filePath: "/tmp/cliproxy-test/codex-user@example.com.json",
    email: "user@example.com",
    accountId: "acct-123",
  })),
}));

vi.mock("@/lib/ai/providers/cliproxy/sidecar", () => sidecarMocks);
vi.mock("@/lib/ai/providers/cliproxy/codex-bridge", () => bridgeMocks);

import {
  CODEX_IMAGE_MODEL,
  CodexImageError,
  editCodexImage,
  generateCodexImage,
} from "@/lib/ai/providers/cliproxy/images-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("cliproxy/images-client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    sidecarMocks.ensureSidecarReady.mockResolvedValue({
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKey: "selene-test-key",
      port: 8317,
    });
    bridgeMocks.ensureCodexCredentialBridged.mockResolvedValue({
      filePath: "/tmp/cliproxy-test/codex-user@example.com.json",
      email: "user@example.com",
      accountId: "acct-123",
    });

    fetchMock = vi.fn();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("generateCodexImage", () => {
    it("posts to /v1/images/generations with Bearer auth and a JSON body", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: [
            { b64_json: "aGVsbG8=", revised_prompt: "A red apple, pixel art." },
          ],
        }),
      );

      const items = await generateCodexImage({
        prompt: "a tiny red apple",
        options: { size: "1024x1024", quality: "high", outputFormat: "png" },
      });

      expect(items).toEqual([
        { b64: "aGVsbG8=", format: "png", revisedPrompt: "A red apple, pixel art." },
      ]);

      expect(sidecarMocks.ensureSidecarReady).toHaveBeenCalledOnce();
      expect(bridgeMocks.ensureCodexCredentialBridged).toHaveBeenCalledOnce();

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:8317/v1/images/generations");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Authorization"]).toBe("Bearer selene-test-key");

      const body = JSON.parse(init!.body as string);
      expect(body).toMatchObject({
        model: CODEX_IMAGE_MODEL,
        prompt: "a tiny red apple",
        response_format: "b64_json",
        size: "1024x1024",
        quality: "high",
        output_format: "png",
      });
    });

    it("throws a CodexImageError with the upstream message on non-2xx", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          { error: { message: "unknown provider for model gpt-image-2", type: "server_error" } },
          502,
        ),
      );

      const err = await generateCodexImage({ prompt: "x" }).catch((e) => e as unknown);
      expect(err).toBeInstanceOf(CodexImageError);
      expect((err as CodexImageError).message).toContain("unknown provider for model gpt-image-2");
      expect((err as CodexImageError).status).toBe(502);
      expect((err as CodexImageError).upstreamType).toBe("server_error");
    });

    it("throws a CodexImageError when the user is not signed in to Codex", async () => {
      bridgeMocks.ensureCodexCredentialBridged.mockResolvedValueOnce(null);
      await expect(generateCodexImage({ prompt: "x" })).rejects.toThrow(/Sign in to Codex/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects when the sidecar returns a URL instead of b64_json (we only support b64)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: [{ url: "https://example.com/foo.png" }] }),
      );
      await expect(generateCodexImage({ prompt: "x" })).rejects.toThrow(/URL instead of base64/);
    });

    it("rejects when the response has no data items", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
      await expect(generateCodexImage({ prompt: "x" })).rejects.toThrow(/no images/);
    });

    it("passes through every supported optional field", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: "Zg==" }] }));
      await generateCodexImage({
        prompt: "p",
        options: {
          size: "1536x1024",
          quality: "medium",
          background: "transparent",
          outputFormat: "webp",
          moderation: "low",
          outputCompression: 80,
          partialImages: 2,
        },
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
      expect(body).toMatchObject({
        size: "1536x1024",
        quality: "medium",
        background: "transparent",
        output_format: "webp",
        moderation: "low",
        output_compression: 80,
        partial_images: 2,
      });
    });
  });

  describe("editCodexImage", () => {
    it("posts a multipart form with prompt + image + optional mask to /v1/images/edits", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: "Yg==" }] }));

      const items = await editCodexImage({
        prompt: "make it night",
        images: ["data:image/png;base64,aGVsbG8="],
        mask: "data:image/png;base64,bWFzaw==",
        resolveLocal: () => null,
        options: { size: "1024x1024", inputFidelity: "high" },
      });

      expect(items).toEqual([{ b64: "Yg==", format: "png" }]);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:8317/v1/images/edits");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer selene-test-key");
      expect(init?.method).toBe("POST");
      // The body is FormData — sniff a couple of expected entries.
      expect(init?.body).toBeInstanceOf(FormData);
      const fd = init?.body as FormData;
      expect(fd.get("model")).toBe(CODEX_IMAGE_MODEL);
      expect(fd.get("prompt")).toBe("make it night");
      expect(fd.get("response_format")).toBe("b64_json");
      expect(fd.get("size")).toBe("1024x1024");
      expect(fd.get("input_fidelity")).toBe("high");
      expect(fd.get("image")).toBeInstanceOf(Blob);
      expect(fd.get("mask")).toBeInstanceOf(Blob);
    });

    it("rejects when no images are supplied", async () => {
      await expect(
        editCodexImage({
          prompt: "anything",
          images: [],
          resolveLocal: () => null,
        }),
      ).rejects.toThrow(/at least one source image/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects unresolvable references that aren't data: or http(s)", async () => {
      await expect(
        editCodexImage({
          prompt: "x",
          images: ["selene-ref-but-unresolvable"],
          resolveLocal: () => null,
        }),
      ).rejects.toThrow(/Unsupported image reference/);
    });
  });
});

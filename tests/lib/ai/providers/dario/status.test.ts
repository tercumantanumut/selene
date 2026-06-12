import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { getStatusMock, ensureDarioSidecarReadyMock } = vi.hoisted(() => ({
  getStatusMock: vi.fn(),
  ensureDarioSidecarReadyMock: vi.fn(),
}));

vi.mock("@askalf/dario", () => ({
  getStatus: getStatusMock,
}));

vi.mock("@/lib/ai/providers/dario/sidecar", () => ({
  ensureDarioSidecarReady: ensureDarioSidecarReadyMock,
}));

describe("dario/status", () => {
  let dataDir: string;
  let previousDataPath: string | undefined;
  let previousPort: string | undefined;
  let previousFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    getStatusMock.mockReset();
    ensureDarioSidecarReadyMock.mockReset();
    getStatusMock.mockResolvedValue({ authenticated: false, status: "none" });
    ensureDarioSidecarReadyMock.mockResolvedValue({ port: 4569, apiKey: "test-key", baseUrl: "http://127.0.0.1:4569/v1" });
    previousFetch = globalThis.fetch;
    previousDataPath = process.env.LOCAL_DATA_PATH;
    previousPort = process.env.SELENE_DARIO_PORT;
    dataDir = mkdtempSync(join(tmpdir(), "selene-dario-status-"));
    process.env.LOCAL_DATA_PATH = dataDir;
    process.env.SELENE_DARIO_PORT = "4569";
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    rmSync(dataDir, { recursive: true, force: true });
    if (previousDataPath === undefined) delete process.env.LOCAL_DATA_PATH;
    else process.env.LOCAL_DATA_PATH = previousDataPath;
    if (previousPort === undefined) delete process.env.SELENE_DARIO_PORT;
    else process.env.SELENE_DARIO_PORT = previousPort;
  });

  it("reads Dario OAuth status directly by default without starting the sidecar", async () => {
    getStatusMock.mockResolvedValueOnce({ authenticated: true, status: "healthy" });

    const { fetchDarioStatus } = await import("@/lib/ai/providers/dario/status");
    const status = await fetchDarioStatus();

    expect(status).toEqual({ authenticated: true, status: "healthy" });
    expect(ensureDarioSidecarReadyMock).not.toHaveBeenCalled();
  });

  it("checks authenticated /status through the sidecar when ensureReady is requested", async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: expect.stringMatching(/^Bearer selene-dario-/) });
      return new Response(JSON.stringify({ authenticated: true, status: "healthy" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { fetchDarioStatus } = await import("@/lib/ai/providers/dario/status");
    const status = await fetchDarioStatus({ ensureReady: true });

    expect(status.authenticated).toBe(true);
    expect(ensureDarioSidecarReadyMock).toHaveBeenCalledTimes(1);
    expect(getStatusMock).not.toHaveBeenCalled();
  });
});

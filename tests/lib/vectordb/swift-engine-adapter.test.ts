/**
 * Sprint 7 W7.1.C — Swift Engine Adapter unit tests.
 *
 * The sidecar singleton lives at `@/lib/swift-engine/sidecar` (created by
 * W7.1.E). Until that module ships we plant a fake via the adapter's
 * `__setSwiftEngineSidecarAccessorForTests` test seam so these tests run
 * independently of the sidecar lifecycle and cover purely the wire mapping
 * + error handling that the adapter owns.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SwiftEngineHealth,
  SwiftEngineRequest,
  SwiftEngineResponse,
  SwiftEngineSidecar,
  SwiftEngineSidecarState,
} from "@/lib/swift-engine/types";
import { SwiftEngineUnavailableError } from "@/lib/swift-engine/types";
import {
  resetVectorSearchConfig,
  updateVectorSearchConfig,
} from "@/lib/config/vector-search";
import {
  __setSwiftEngineSidecarAccessorForTests,
  searchSwiftEngine,
} from "@/lib/vectordb/swift-engine-adapter";

// ---------------------------------------------------------------------------
// Fake sidecar with pluggable hooks for each test.
// ---------------------------------------------------------------------------

interface FakeSidecarState {
  ready: boolean;
  state: SwiftEngineSidecarState;
  // Most tests want a fixed response; some want to capture the request payload.
  handleRequest: (
    req: SwiftEngineRequest<unknown>,
  ) => Promise<SwiftEngineResponse<unknown>> | SwiftEngineResponse<unknown>;
}

const fakeSidecarState: FakeSidecarState = {
  ready: true,
  state: "ready",
  handleRequest: () => ({ result: { hits: [] } }),
};

const sentRequests: Array<SwiftEngineRequest<unknown>> = [];

const fakeSidecar: SwiftEngineSidecar = {
  start: vi.fn(async () => undefined),
  isReady: () => fakeSidecarState.ready,
  health: (): SwiftEngineHealth => ({
    state: fakeSidecarState.state,
    pid: fakeSidecarState.ready ? 4242 : null,
    uptimeMs: 0,
    totals: { requests: 0, errors: 0, restarts: 0 },
  }),
  dispose: vi.fn(async () => undefined),
  sendRequest: async <TParams = unknown, TResult = unknown>(
    request: SwiftEngineRequest<TParams>,
  ): Promise<SwiftEngineResponse<TResult>> => {
    sentRequests.push(request as SwiftEngineRequest<unknown>);
    const result = await fakeSidecarState.handleRequest(
      request as SwiftEngineRequest<unknown>,
    );
    return result as SwiftEngineResponse<TResult>;
  },
  // Mirrors the production callTool helper: records a synthetic
  // `{method: name, params: args}` request so existing assertions on
  // `lastRequest()` still inspect the search params directly. The actual
  // wire-shape sent to the binary is `tools/call` (verified by the
  // integration smoke at tests/integration/swift-engine-e2e.test.ts).
  callTool: async <TResult = unknown>(
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const synthetic: SwiftEngineRequest<unknown> = {
      method: name,
      params: args,
    };
    sentRequests.push(synthetic);
    const inner = await fakeSidecarState.handleRequest(synthetic);
    if (inner.error) {
      return { error: inner.error };
    }
    // Wrap the test fixture result in the tool-call envelope shape.
    const parsed = inner.result as TResult | undefined;
    return {
      result: {
        parsed,
        rawTexts:
          parsed === undefined ? [] : [JSON.stringify(parsed)],
        isError: false,
      },
    };
  },
};

// Plant the fake via the adapter's test seam (the production
// `@/lib/swift-engine/sidecar` module is owned by W7.1.E and may not exist
// on disk during this test phase, so `vi.mock` against that path can't
// resolve). The seam keeps tests fully decoupled from the sidecar lifecycle.
__setSwiftEngineSidecarAccessorForTests(() => fakeSidecar);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setReady(ready: boolean, state: SwiftEngineSidecarState = "ready") {
  fakeSidecarState.ready = ready;
  fakeSidecarState.state = state;
}

function setResponse(
  response: SwiftEngineResponse<unknown> | ((req: SwiftEngineRequest<unknown>) => SwiftEngineResponse<unknown>),
) {
  fakeSidecarState.handleRequest =
    typeof response === "function" ? response : () => response;
}

function lastRequest<TParams = unknown>(): SwiftEngineRequest<TParams> {
  if (sentRequests.length === 0) {
    throw new Error("expected at least one sendRequest call");
  }
  return sentRequests[sentRequests.length - 1] as SwiftEngineRequest<TParams>;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  setReady(true);
  setResponse({ result: { hits: [] } });
  sentRequests.length = 0;
  resetVectorSearchConfig();
  // Force-disable expansion by default so passthrough tests are unambiguous.
  updateVectorSearchConfig({ enableQueryExpansion: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  __setSwiftEngineSidecarAccessorForTests(null);
});

describe("searchSwiftEngine", () => {
  it("happy path: returns mapped VectorSearchHit[] from a vector.search response", async () => {
    setResponse({
      result: {
        hits: [
          {
            id: "doc-1#0",
            score: 0.92,
            text: "Hello from Swift",
            filePath: "/abs/path/file.md",
            relativePath: "file.md",
            chunkIndex: 0,
            folderId: "folder-a",
            startLine: 1,
            endLine: 4,
            tokenOffset: 0,
            tokenCount: 16,
            version: 7,
          },
          {
            id: "doc-2#3",
            score: 0.51,
            text: "Second hit",
            filePath: "/abs/path/other.md",
            relativePath: "other.md",
            chunkIndex: 3,
            folderId: "folder-b",
          },
        ],
      },
    });

    const hits = await searchSwiftEngine({
      characterId: "char-1",
      query: "swift sidecar wiring",
    });

    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      id: "doc-1#0",
      score: 0.92,
      text: "Hello from Swift",
      filePath: "/abs/path/file.md",
      relativePath: "file.md",
      chunkIndex: 0,
      folderId: "folder-a",
      startLine: 1,
      endLine: 4,
      tokenOffset: 0,
      tokenCount: 16,
      version: 7,
    });
    expect(hits[1].folderId).toBe("folder-b");
    // Optional fields should pass through as undefined when omitted.
    expect(hits[1].startLine).toBeUndefined();

    const sent = lastRequest();
    expect(sent.method).toBe("vector.search");
  });

  it("throws SwiftEngineUnavailableError when sidecar is not ready (state=starting)", async () => {
    setReady(false, "starting");

    await expect(
      searchSwiftEngine({ characterId: "char-1", query: "anything" }),
    ).rejects.toBeInstanceOf(SwiftEngineUnavailableError);

    try {
      await searchSwiftEngine({ characterId: "char-1", query: "anything" });
    } catch (err) {
      expect(err).toBeInstanceOf(SwiftEngineUnavailableError);
      expect((err as SwiftEngineUnavailableError).state).toBe("starting");
    }
  });

  it("throws with the inner code/message when the MCP response carries an error", async () => {
    setResponse({
      error: {
        code: -32011,
        message: "embedding service unreachable",
      },
    });

    await expect(
      searchSwiftEngine({ characterId: "char-1", query: "boom" }),
    ).rejects.toThrow(/-32011/);
    await expect(
      searchSwiftEngine({ characterId: "char-1", query: "boom" }),
    ).rejects.toThrow(/embedding service unreachable/);
  });

  it("passes topK, minScore, folderIds through to vector.search params", async () => {
    setResponse({ result: { hits: [] } });

    await searchSwiftEngine({
      characterId: "char-1",
      query: "tunable",
      options: {
        topK: 25,
        minScore: 0.05,
        folderIds: ["folder-a", "folder-b"],
      },
    });

    const sent = lastRequest<{
      characterId: string;
      query: string;
      topK?: number;
      minScore?: number;
      folderIds?: string[];
      queries?: string[];
    }>();

    expect(sent.method).toBe("vector.search");
    expect(sent.params).toEqual({
      characterId: "char-1",
      query: "tunable",
      topK: 25,
      minScore: 0.05,
      folderIds: ["folder-a", "folder-b"],
    });
    // expansion disabled => no `queries` field
    expect(sent.params.queries).toBeUndefined();
  });

  it("forwards queries[] when enableQueryExpansion is true", async () => {
    updateVectorSearchConfig({ enableQueryExpansion: true });
    setResponse({ result: { hits: [] } });

    await searchSwiftEngine({
      characterId: "char-1",
      query: "expand me",
    });

    const sent = lastRequest<{
      query: string;
      queries?: string[];
    }>();
    expect(sent.params.query).toBe("expand me");
    expect(sent.params.queries).toEqual(["expand me"]);
  });

  it("tolerates partial folder errors and still returns the partial hits", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    setResponse({
      result: {
        hits: [
          {
            id: "doc-3#0",
            score: 0.71,
            text: "partial-success hit",
            filePath: "/abs/c.md",
            relativePath: "c.md",
            chunkIndex: 0,
            folderId: "folder-good",
          },
        ],
        errors: [
          {
            folderId: "folder-bad",
            code: "INDEX_LOCKED",
            message: "folder index lock contention",
          },
        ],
      },
    });

    const hits = await searchSwiftEngine({
      characterId: "char-1",
      query: "partial",
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].folderId).toBe("folder-good");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("partial failure"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("folder-bad"),
    );

    warnSpy.mockRestore();
  });
});

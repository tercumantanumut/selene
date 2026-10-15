import { describe, expect, it, vi } from "vitest";
import {
  getCanonicalToolName,
  humanizeToolName,
  loadToolNameCache,
} from "@/components/assistant-ui/tool-name-utils";

const resilientFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/utils/resilient-fetch", () => ({
  resilientFetch: resilientFetchMock,
}));

describe("getCanonicalToolName", () => {
  it("strips MCP server prefix from tool names", () => {
    expect(getCanonicalToolName("mcp__selene-platform__calculator")).toBe("calculator");
    expect(getCanonicalToolName("mcp__selene-platform__searchTools")).toBe("searchTools");
  });

  it("returns non-MCP tool names unchanged", () => {
    expect(getCanonicalToolName("calculator")).toBe("calculator");
    expect(getCanonicalToolName("executeCommand")).toBe("executeCommand");
  });
});

describe("humanizeToolName", () => {
  it("converts snake_case to Title Case", () => {
    expect(humanizeToolName("ghost_press")).toBe("Ghost Press");
    expect(humanizeToolName("read_file")).toBe("Read File");
    expect(humanizeToolName("execute_command")).toBe("Execute Command");
  });

  it("converts camelCase to Title Case", () => {
    expect(humanizeToolName("vectorSearch")).toBe("Vector Search");
    expect(humanizeToolName("executeCommand")).toBe("Execute Command");
    expect(humanizeToolName("readFile")).toBe("Read File");
  });

  it("converts kebab-case to Title Case", () => {
    expect(humanizeToolName("my-tool")).toBe("My Tool");
    expect(humanizeToolName("critical-tool")).toBe("Critical Tool");
  });

  it("handles MCP proxy-prefixed names", () => {
    expect(humanizeToolName("mcp_ghostos_ghost_press")).toBe("Mcp Ghostos Ghost Press");
    expect(humanizeToolName("mcp_filesystem_read_file")).toBe("Mcp Filesystem Read File");
  });

  it("handles single-word names", () => {
    expect(humanizeToolName("calculator")).toBe("Calculator");
    expect(humanizeToolName("grep")).toBe("Grep");
  });

  it("handles acronym runs correctly", () => {
    expect(humanizeToolName("getHTTPStatus")).toBe("Get HTTP Status");
    expect(humanizeToolName("parseURLToHTML")).toBe("Parse URL To HTML");
    expect(humanizeToolName("OAuthLogin")).toBe("O Auth Login");
  });
});


describe("loadToolNameCache", () => {
  it("issues a single fetch for concurrent callers", async () => {
    resilientFetchMock.mockResolvedValue({
      data: { tools: [{ id: "readFile", displayName: "Read File" }] },
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => loadToolNameCache()),
    );

    expect(resilientFetchMock).toHaveBeenCalledTimes(1);
    for (const map of results) {
      expect(map).toEqual({ readFile: "Read File" });
    }
  });

  it("retries after a failed load instead of caching an empty map", async () => {
    vi.resetModules();
    resilientFetchMock.mockReset();
    const { loadToolNameCache: freshLoad } = await import("@/components/assistant-ui/tool-name-utils");

    resilientFetchMock.mockResolvedValueOnce({ data: null, error: "HTTP 500", timedOut: false });
    expect(await freshLoad()).toEqual({});

    resilientFetchMock.mockResolvedValueOnce({
      data: { tools: [{ id: "readFile", displayName: "Read File" }] },
      error: null,
      timedOut: false,
    });
    expect(await freshLoad()).toEqual({ readFile: "Read File" });
    expect(await freshLoad()).toEqual({ readFile: "Read File" });
    expect(resilientFetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries after the loader throws", async () => {
    vi.resetModules();
    resilientFetchMock.mockReset();
    const { loadToolNameCache: freshLoad } = await import("@/components/assistant-ui/tool-name-utils");

    resilientFetchMock.mockRejectedValueOnce(new Error("boom"));
    expect(await freshLoad()).toEqual({});

    resilientFetchMock.mockResolvedValueOnce({
      data: { tools: [{ id: "grep", displayName: "Grep" }] },
      error: null,
      timedOut: false,
    });
    expect(await freshLoad()).toEqual({ grep: "Grep" });
  });
});

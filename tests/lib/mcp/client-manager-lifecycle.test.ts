import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({ count: 0 }));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {}
    async close() {}
    async listTools() {
      return { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] };
    }
    async callTool() {
      return { content: [{ type: "text", text: "ok" }] };
    }
  },
}));

vi.mock("@/lib/mcp/stdio-transport", () => ({
  StdioClientTransport: class {
    pid = 1234;
    onclose?: () => void;
    onerror?: (err: Error) => void;
    constructor() {
      spawned.count++;
    }
    async close() {}
  },
}));

vi.mock("@/lib/vectordb/folder-events", () => ({ onFolderChange: vi.fn() }));
vi.mock("@/lib/background-tasks/registry", () => ({ taskRegistry: { list: () => [] } }));

import { MCPClientManager } from "@/lib/mcp/client-manager";
import type { ResolvedMCPServer } from "@/lib/mcp/types";

const stdioConfig = (folder = "/a") =>
  ({ type: "stdio", command: "npx", args: ["-y", "server", folder], env: {} }) as unknown as ResolvedMCPServer;

describe("MCPClientManager lifecycle", () => {
  let manager: MCPClientManager;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    manager = MCPClientManager.getInstance();
    await manager.disconnectAll();
    spawned.count = 0;
  });

  afterEach(async () => {
    await manager.disconnectAll();
    vi.useRealTimers();
  });

  it("keeps a running server when another character resolves the same config", async () => {
    await manager.connect("srv", stdioConfig(), "parent");
    await manager.connect("srv", stdioConfig(), "subagent");

    expect(spawned.count).toBe(1);
    expect(manager.getConnectedCharacterId("srv")).toBe("subagent");
  });

  it("respawns when the resolved config differs", async () => {
    await manager.connect("srv", stdioConfig("/a"), "parent");
    await manager.connect("srv", stdioConfig("/b"), "subagent");

    expect(spawned.count).toBe(2);
  });

  it("stops idle stdio servers and revives them on the next tool call", async () => {
    await manager.connect("srv", stdioConfig(), "parent");
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);

    await (manager as unknown as { suspendIdleServers(): Promise<void> }).suspendIdleServers();
    expect(manager.isConnected("srv")).toBe(false);

    const result = await manager.executeTool("srv", "echo", {});

    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(manager.isConnected("srv")).toBe(true);
    expect(spawned.count).toBe(2);
    expect(manager.getConnectedCharacterId("srv")).toBe("parent");
  });

  it("does not stop a server that was used recently", async () => {
    await manager.connect("srv", stdioConfig(), "parent");
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);

    await (manager as unknown as { suspendIdleServers(): Promise<void> }).suspendIdleServers();

    expect(manager.isConnected("srv")).toBe(true);
  });
});

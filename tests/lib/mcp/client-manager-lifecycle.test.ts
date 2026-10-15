import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({ count: 0, lastArgs: [] as string[], failNextConnect: false }));
const characterConfig = vi.hoisted(() => ({ servers: {} as Record<string, unknown> }));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {
      if (spawned.failNextConnect) {
        spawned.failNextConnect = false;
        throw new Error("spawn failed");
      }
    }
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
    constructor(params: { args?: string[] }) {
      spawned.count++;
      spawned.lastArgs = params.args ?? [];
    }
    async close() {}
  },
}));

vi.mock("@/lib/vectordb/folder-events", () => ({ onFolderChange: vi.fn() }));
vi.mock("@/lib/background-tasks/registry", () => ({ taskRegistry: { list: () => ({ tasks: [] }) } }));
vi.mock("@/lib/settings/settings-manager", () => ({
  loadSettings: () => ({ mcpServers: { mcpServers: characterConfig.servers }, mcpEnvironment: {} }),
}));
vi.mock("@/lib/characters", () => ({
  getCharacter: async (id: string) => ({ id, metadata: {} }),
}));
vi.mock("@/lib/mcp/mcp-config-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/mcp-config-resolver")>()),
  resolveMCPConfig: async (_name: string, config: { args?: string[] }) =>
    ({ type: "stdio", command: "npx", args: config.args ?? [], env: {} }),
}));

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
    spawned.failNextConnect = false;
    characterConfig.servers = {};
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

  const suspend = () =>
    (manager as unknown as { suspendIdleServers(): Promise<void> }).suspendIdleServers();

  it("keeps the suspension record when a revival fails so the next call retries", async () => {
    await manager.connect("srv", stdioConfig(), "parent");
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    await suspend();

    spawned.failNextConnect = true;
    await expect(manager.executeTool("srv", "echo", {})).rejects.toThrow(/not connected/);

    const result = await manager.executeTool("srv", "echo", {});
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(manager.isConnected("srv")).toBe(true);
  });

  it("does not revive a suspended server that was removed from config", async () => {
    await manager.connect("srv", stdioConfig(), "parent");
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    await suspend();

    const removed = await manager.syncWithConfig(new Set());

    expect(removed).toEqual(["srv"]);
    await expect(manager.executeTool("srv", "echo", {})).rejects.toThrow(/not connected/);
  });

  it("refreshes suspended servers' folder args on folder change without spawning", async () => {
    await manager.connect("srv", stdioConfig("/a"), "parent");
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    await suspend();
    const spawnsBefore = spawned.count;

    characterConfig.servers = { srv: { command: "npx", args: ["-y", "server", "/b"] } };
    await (manager as unknown as { refreshSuspendedConfigs(id: string): Promise<void> })
      .refreshSuspendedConfigs("parent");
    expect(spawned.count).toBe(spawnsBefore);

    await manager.executeTool("srv", "echo", {});
    expect(spawned.lastArgs).toEqual(["-y", "server", "/b"]);
  });

  it("drops a suspended server disabled in settings on folder change", async () => {
    await manager.connect("srv", stdioConfig("/a"), "parent");
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    await suspend();

    characterConfig.servers = { srv: { command: "npx", args: ["/a"], enabled: false } };
    await (manager as unknown as { refreshSuspendedConfigs(id: string): Promise<void> })
      .refreshSuspendedConfigs("parent");

    await expect(manager.executeTool("srv", "echo", {})).rejects.toThrow(/not connected/);
  });

  it("does not stop a server that was used recently", async () => {
    await manager.connect("srv", stdioConfig(), "parent");
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);

    await (manager as unknown as { suspendIdleServers(): Promise<void> }).suspendIdleServers();

    expect(manager.isConnected("srv")).toBe(true);
  });
});

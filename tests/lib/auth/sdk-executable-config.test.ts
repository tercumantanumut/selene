import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMocks = vi.hoisted(() => ({
  isElectronProduction: vi.fn(() => false),
}));

const loginMocks = vi.hoisted(() => ({
  getNodeBinary: vi.fn(() => "/usr/local/bin/node"),
}));

const shellEnvMocks = vi.hoisted(() => ({
  getResolvedShellEnvironment: vi.fn(() => ({})),
}));

vi.mock("@/lib/utils/environment", () => ({
  isElectronProduction: envMocks.isElectronProduction,
}));

vi.mock("@/lib/auth/claude-login-process", () => ({
  getNodeBinary: loginMocks.getNodeBinary,
}));

vi.mock("@/lib/shell-env/resolver", () => ({
  getResolvedShellEnvironment: shellEnvMocks.getResolvedShellEnvironment,
}));

import { getSdkExecutableConfig } from "@/lib/auth/claude-agent-sdk-auth";

describe("getSdkExecutableConfig", () => {
  const originalPath = process.env.PATH;
  const originalPort = process.env.PORT;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalNextRuntime = process.env.NEXT_RUNTIME;
  const originalNextProcessed = process.env.__NEXT_PROCESSED_ENV;
  const originalElectronResourcesPath = process.env.ELECTRON_RESOURCES_PATH;
  const originalProcessResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PATH = originalPath;
    process.env.PORT = originalPort;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.NEXT_RUNTIME = originalNextRuntime;
    process.env.__NEXT_PROCESSED_ENV = originalNextProcessed;
    process.env.ELECTRON_RESOURCES_PATH = originalElectronResourcesPath;
    Object.defineProperty(process, "resourcesPath", { value: originalProcessResourcesPath, configurable: true });
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.CLAUDECODE = "1";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    process.env.PORT = originalPort;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.NEXT_RUNTIME = originalNextRuntime;
    process.env.__NEXT_PROCESSED_ENV = originalNextProcessed;
    process.env.ELECTRON_RESOURCES_PATH = originalElectronResourcesPath;
    Object.defineProperty(process, "resourcesPath", { value: originalProcessResourcesPath, configurable: true });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDECODE;
  });

  it("always returns executable as 'node' (SDK type constraint)", () => {
    const { executable } = getSdkExecutableConfig();
    expect(executable).toBe("node");
  });

  it("strips ANTHROPIC_API_KEY and CLAUDECODE from env", () => {
    const { env } = getSdkExecutableConfig();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });

  describe("production mode (isElectronProduction = true)", () => {
    beforeEach(() => {
      envMocks.isElectronProduction.mockReturnValue(true);
    });

    it("sets ELECTRON_RUN_AS_NODE=1", () => {
      const { env } = getSdkExecutableConfig();
      expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    });

    it("uses shell-resolved PATH when available", () => {
      const originalPlatform = process.platform;
      try {
        Object.defineProperty(process, "platform", { value: "darwin" });
        process.env.PATH = "/usr/bin:/bin";
        const shellPath = "/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
        shellEnvMocks.getResolvedShellEnvironment.mockReturnValue({ PATH: shellPath });

        const { env } = getSdkExecutableConfig();

        // Shell-resolved PATH should be used as the base
        expect(env.PATH).toContain("/opt/homebrew/opt/node@22/bin");
        expect(env.PATH).toContain("/opt/homebrew/bin");
        // Original process.env.PATH should not be mutated
        expect(process.env.PATH).toBe("/usr/bin:/bin");
        expect(loginMocks.getNodeBinary).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("falls back to getNodeBinary PATH augmentation when shell env has no PATH", () => {
      const originalPlatform = process.platform;
      try {
        Object.defineProperty(process, "platform", { value: "darwin" });
        process.env.PATH = "/usr/bin:/bin";
        delete process.env.ELECTRON_RESOURCES_PATH;
        Object.defineProperty(process, "resourcesPath", { value: undefined, configurable: true });
        shellEnvMocks.getResolvedShellEnvironment.mockReturnValue({});
        loginMocks.getNodeBinary.mockReturnValue("/opt/homebrew/bin/node");

        const { env } = getSdkExecutableConfig();

        expect(env.PATH).toContain("/opt/homebrew/bin");
        expect(loginMocks.getNodeBinary).toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("falls back to process.execPath dir when no shell env and no system node", () => {
      const originalPlatform = process.platform;
      const execDir = require("path").dirname(process.execPath);
      try {
        Object.defineProperty(process, "platform", { value: "darwin" });
        process.env.PATH = "/usr/bin:/bin";
        delete process.env.ELECTRON_RESOURCES_PATH;
        Object.defineProperty(process, "resourcesPath", { value: undefined, configurable: true });
        shellEnvMocks.getResolvedShellEnvironment.mockReturnValue({});
        loginMocks.getNodeBinary.mockReturnValue(process.execPath);

        const { env } = getSdkExecutableConfig();

        expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
        expect(env.PATH).toContain(execDir);
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });
  });

  describe("development mode (isElectronProduction = false)", () => {
    beforeEach(() => {
      envMocks.isElectronProduction.mockReturnValue(false);
    });

    it("does not set ELECTRON_RUN_AS_NODE", () => {
      const { env } = getSdkExecutableConfig();
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    });

    it("does not resolve shell env or modify PATH", () => {
      const pathBefore = process.env.PATH;
      getSdkExecutableConfig();

      expect(shellEnvMocks.getResolvedShellEnvironment).not.toHaveBeenCalled();
      expect(loginMocks.getNodeBinary).not.toHaveBeenCalled();
      expect(process.env.PATH).toBe(pathBefore);
    });
  });
});

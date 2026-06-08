import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLIPROXY_DEFAULT_PORT,
  CLIPROXY_HOST,
  ensureCliproxyConfig,
  getCliproxyAuthDir,
  getCliproxyBaseUrl,
} from "@/lib/ai/providers/cliproxy/config";

describe("cliproxy/config", () => {
  let dataDir: string;
  let prevDataPath: string | undefined;
  let prevAuthDir: string | undefined;
  let prevPort: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "selene-cliproxy-cfg-"));
    prevDataPath = process.env.LOCAL_DATA_PATH;
    prevAuthDir = process.env.SELENE_CLIPROXY_AUTH_DIR;
    prevPort = process.env.SELENE_CLIPROXY_PORT;
    process.env.LOCAL_DATA_PATH = dataDir;
    delete process.env.SELENE_CLIPROXY_AUTH_DIR;
    delete process.env.SELENE_CLIPROXY_PORT;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (prevDataPath === undefined) delete process.env.LOCAL_DATA_PATH;
    else process.env.LOCAL_DATA_PATH = prevDataPath;
    if (prevAuthDir === undefined) delete process.env.SELENE_CLIPROXY_AUTH_DIR;
    else process.env.SELENE_CLIPROXY_AUTH_DIR = prevAuthDir;
    if (prevPort === undefined) delete process.env.SELENE_CLIPROXY_PORT;
    else process.env.SELENE_CLIPROXY_PORT = prevPort;
  });

  it("writes a valid yaml config with a generated api-key on first call", () => {
    const result = ensureCliproxyConfig();

    expect(result.configPath).toBe(join(dataDir, "cliproxy", "config.yaml"));
    expect(result.port).toBe(CLIPROXY_DEFAULT_PORT);
    expect(result.apiKey).toMatch(/^selene-[a-f0-9]{48}$/);

    const yaml = readFileSync(result.configPath, "utf8");
    expect(yaml).toContain(`host: "${CLIPROXY_HOST}"`);
    expect(yaml).toContain(`port: ${CLIPROXY_DEFAULT_PORT}`);
    expect(yaml).toContain(`- "${result.apiKey}"`);
    expect(yaml).toContain(`auth-dir: "${result.authDir}"`);
  });

  it("reuses the same api-key across calls (stable across restarts)", () => {
    const first = ensureCliproxyConfig();
    const second = ensureCliproxyConfig();
    expect(second.apiKey).toBe(first.apiKey);
  });

  it("honors SELENE_CLIPROXY_PORT when valid", () => {
    process.env.SELENE_CLIPROXY_PORT = "9999";
    expect(ensureCliproxyConfig().port).toBe(9999);
  });

  it("falls back to the default port when SELENE_CLIPROXY_PORT is unparseable", () => {
    process.env.SELENE_CLIPROXY_PORT = "not-a-port";
    expect(ensureCliproxyConfig().port).toBe(CLIPROXY_DEFAULT_PORT);
  });

  it("honors SELENE_CLIPROXY_AUTH_DIR override for getCliproxyAuthDir", () => {
    process.env.SELENE_CLIPROXY_AUTH_DIR = "/tmp/selene-isolated-cliproxy";
    expect(getCliproxyAuthDir()).toBe("/tmp/selene-isolated-cliproxy");
  });

  it("builds the base URL with the right host + path", () => {
    expect(getCliproxyBaseUrl(8317)).toBe("http://127.0.0.1:8317/v1");
  });
});

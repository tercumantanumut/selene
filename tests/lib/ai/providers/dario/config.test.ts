import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DARIO_DEFAULT_PORT,
  DARIO_HOST,
  ensureDarioConfig,
  getDarioBaseUrl,
  getSeleneDarioDir,
} from "@/lib/ai/providers/dario/config";

describe("dario/config", () => {
  let dataDir: string;
  let prevDataPath: string | undefined;
  let prevPort: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "selene-dario-cfg-"));
    prevDataPath = process.env.LOCAL_DATA_PATH;
    prevPort = process.env.SELENE_DARIO_PORT;
    process.env.LOCAL_DATA_PATH = dataDir;
    delete process.env.SELENE_DARIO_PORT;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (prevDataPath === undefined) delete process.env.LOCAL_DATA_PATH;
    else process.env.LOCAL_DATA_PATH = prevDataPath;
    if (prevPort === undefined) delete process.env.SELENE_DARIO_PORT;
    else process.env.SELENE_DARIO_PORT = prevPort;
  });

  it("generates a stable Selene-owned Dario API key", () => {
    const first = ensureDarioConfig();
    const second = ensureDarioConfig();

    expect(first.dir).toBe(join(dataDir, "dario"));
    expect(first.port).toBe(DARIO_DEFAULT_PORT);
    expect(first.host).toBe(DARIO_HOST);
    expect(first.apiKey).toMatch(/^selene-dario-[a-f0-9]{48}$/);
    expect(second.apiKey).toBe(first.apiKey);
    expect(readFileSync(join(first.dir, "api-key"), "utf8").trim()).toBe(first.apiKey);
  });

  it("honors LOCAL_DATA_PATH for the Dario runtime directory", () => {
    expect(getSeleneDarioDir()).toBe(join(dataDir, "dario"));
  });

  it("honors SELENE_DARIO_PORT when valid", () => {
    process.env.SELENE_DARIO_PORT = "4567";
    expect(ensureDarioConfig().port).toBe(4567);
  });

  it("falls back to the default port when SELENE_DARIO_PORT is invalid", () => {
    process.env.SELENE_DARIO_PORT = "not-a-port";
    expect(ensureDarioConfig().port).toBe(DARIO_DEFAULT_PORT);
  });

  it("uses a default port that does not collide with packaged Electron's Next server", () => {
    expect(DARIO_DEFAULT_PORT).toBe(8575);
  });

  it("builds the Anthropic-compatible base URL with /v1", () => {
    expect(getDarioBaseUrl(DARIO_DEFAULT_PORT)).toBe("http://127.0.0.1:8575/v1");
  });
});

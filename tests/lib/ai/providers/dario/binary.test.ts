import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("dario/binary", () => {
  let tmp: string;
  let previousBin: string | undefined;
  let previousResourcesPath: string | undefined;
  let previousElectronIsDev: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tmp = join(tmpdir(), `selene-dario-binary-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    previousBin = process.env.SELENE_DARIO_BIN;
    previousResourcesPath = process.env.ELECTRON_RESOURCES_PATH;
    previousElectronIsDev = process.env.ELECTRON_IS_DEV;
    delete process.env.SELENE_DARIO_BIN;
    delete process.env.ELECTRON_RESOURCES_PATH;
    delete process.env.ELECTRON_IS_DEV;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (previousBin === undefined) delete process.env.SELENE_DARIO_BIN;
    else process.env.SELENE_DARIO_BIN = previousBin;
    if (previousResourcesPath === undefined) delete process.env.ELECTRON_RESOURCES_PATH;
    else process.env.ELECTRON_RESOURCES_PATH = previousResourcesPath;
    if (previousElectronIsDev === undefined) delete process.env.ELECTRON_IS_DEV;
    else process.env.ELECTRON_IS_DEV = previousElectronIsDev;
  });

  function createPackagedDarioRuntime(): { nodePath: string; cliPath: string } {
    const nodeName = process.platform === "win32" ? "node.exe" : "node";
    const nodePath = join(tmp, "standalone", "node_modules", ".bin", nodeName);
    const cliPath = join(tmp, "standalone", "node_modules", "@askalf", "dario", "dist", "cli.js");
    mkdirSync(join(nodePath, ".."), { recursive: true });
    mkdirSync(join(cliPath, ".."), { recursive: true });
    writeFileSync(nodePath, "node");
    writeFileSync(cliPath, "#!/usr/bin/env node\n");
    return { nodePath, cliPath };
  }

  it("uses the packaged Dario CLI and bundled Node when Electron resources are present", async () => {
    const { nodePath, cliPath } = createPackagedDarioRuntime();
    process.env.ELECTRON_RESOURCES_PATH = tmp;

    const { resolveDarioCommand, withDarioCommandArgs } = await import("@/lib/ai/providers/dario/binary");
    const resolution = resolveDarioCommand();

    expect(resolution.source).toBe("packaged");
    expect(resolution.command).toBe(nodePath);
    expect(resolution.argsPrefix).toEqual([cliPath]);
    expect(withDarioCommandArgs(resolution, ["proxy"])).toEqual([cliPath, "proxy"]);
  });

  it("fails clearly when a packaged app is missing the bundled Dario runtime", async () => {
    process.env.ELECTRON_RESOURCES_PATH = tmp;

    const { resolveDarioCommand } = await import("@/lib/ai/providers/dario/binary");

    expect(() => resolveDarioCommand()).toThrow(/Bundled Dario runtime is missing/);
  });

  it("lets SELENE_DARIO_BIN override packaged resolution", async () => {
    process.env.ELECTRON_RESOURCES_PATH = tmp;
    process.env.SELENE_DARIO_BIN = "/custom/dario";

    const { resolveDarioCommand } = await import("@/lib/ai/providers/dario/binary");
    const resolution = resolveDarioCommand();

    expect(resolution).toMatchObject({
      source: "override",
      command: "/custom/dario",
      argsPrefix: [],
    });
  });

  it("uses the installed npm dependency in development before falling back to PATH", async () => {
    const { resolveDarioCommand } = await import("@/lib/ai/providers/dario/binary");
    const resolution = resolveDarioCommand();

    expect(resolution.source).toBe("dependency");
    expect(resolution.command).toBe(process.execPath);
    expect(resolution.argsPrefix[0]).toMatch(/node_modules[/\\]@askalf[/\\]dario[/\\]dist[/\\]cli\.js$/);
  });
});

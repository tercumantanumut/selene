import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readdir: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readdir: mocks.readdir,
}));

vi.mock("@/lib/settings/settings-manager", () => ({
  loadSettings: () => ({ embeddingProvider: "local" }),
}));

import { createAggressiveIgnore, DEFAULT_IGNORE_PATTERNS } from "@/lib/vectordb/ignore-patterns";
import { discoverFiles } from "@/lib/vectordb/sync-helpers";

function directory(name: string) {
  return {
    name,
    isDirectory: () => true,
    isFile: () => false,
  };
}

function file(name: string) {
  return {
    name,
    isDirectory: () => false,
    isFile: () => true,
  };
}

describe("discoverFiles", () => {
  const basePath = "/workspace/demo";

  beforeEach(() => {
    mocks.readdir.mockReset();
  });

  it("does not enter ignored dependency, virtualenv, image, or font directories", async () => {
    mocks.readdir.mockImplementation(async (folderPath: string) => {
      switch (folderPath) {
        case basePath:
          return [directory("node_modules"), directory(".venv"), directory("public"), directory("src")];
        case `${basePath}/public`:
          return [directory("images"), directory("fonts")];
        case `${basePath}/src`:
          return [file("index.ts")];
        case `${basePath}/node_modules`:
        case `${basePath}/.venv`:
        case `${basePath}/public/images`:
        case `${basePath}/public/fonts`:
          throw new Error(`unexpected traversal into ${folderPath}`);
        default:
          return [];
      }
    });

    const shouldIgnore = createAggressiveIgnore(DEFAULT_IGNORE_PATTERNS, basePath, ["ts"]);
    const files = await discoverFiles(basePath, basePath, true, ["ts"], shouldIgnore);

    expect(files).toEqual([
      { filePath: `${basePath}/src/index.ts`, relativePath: "src/index.ts" },
    ]);
    expect(mocks.readdir).not.toHaveBeenCalledWith(`${basePath}/node_modules`, expect.anything());
    expect(mocks.readdir).not.toHaveBeenCalledWith(`${basePath}/.venv`, expect.anything());
    expect(mocks.readdir).not.toHaveBeenCalledWith(`${basePath}/public/images`, expect.anything());
    expect(mocks.readdir).not.toHaveBeenCalledWith(`${basePath}/public/fonts`, expect.anything());
  });

  it.each(["EMFILE", "ENFILE"])("propagates %s so sync cannot treat a partial scan as deletions", async (code) => {
    const error = Object.assign(new Error(`${code}: too many open files, scandir '${basePath}'`), { code });
    mocks.readdir.mockRejectedValue(error);

    await expect(
      discoverFiles(basePath, basePath, true, ["ts"], () => false)
    ).rejects.toMatchObject({ code });
  });
});

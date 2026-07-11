import { describe, expect, it } from "vitest";
import {
  DEFAULT_IGNORE_PATTERNS,
  createAggressiveIgnore,
  createIgnoreMatcher,
} from "@/lib/vectordb/ignore-patterns";

describe("vectordb ignore patterns", () => {
  const basePath = "/workspace/demo";

  it("ignores dependency, virtualenv, cache, and build trees during sync discovery", () => {
    const shouldIgnore = createIgnoreMatcher(DEFAULT_IGNORE_PATTERNS, basePath);

    expect(shouldIgnore("/workspace/demo/node_modules/react/index.js")).toBe(true);
    expect(shouldIgnore("/workspace/demo/.venv/lib/python3.12/site-packages/pip/__init__.py")).toBe(true);
    expect(shouldIgnore("/workspace/demo/src/__pycache__/module.cpython-312.pyc")).toBe(true);
    expect(shouldIgnore("/workspace/demo/env/bin/python")).toBe(true);
    expect(shouldIgnore("/workspace/demo/.cache/tool/result.json")).toBe(true);
    expect(shouldIgnore("/workspace/demo/.turbo/cache/entry")).toBe(true);
    expect(shouldIgnore("/workspace/demo/.parcel-cache/data.mdb")).toBe(true);
    expect(shouldIgnore("/workspace/demo/.svelte-kit/output/server.js")).toBe(true);
    expect(shouldIgnore("/workspace/demo/.nuxt/dist/server.js")).toBe(true);
    expect(shouldIgnore("/workspace/demo/target/debug/app")).toBe(true);
    expect(shouldIgnore("/workspace/demo/out/generated/index.js")).toBe(true);
    expect(shouldIgnore("/workspace/demo/storybook-static/assets/story.js")).toBe(true);
    expect(shouldIgnore("/workspace/demo/debug.log")).toBe(true);
    expect(shouldIgnore("/workspace/demo/package.egg-info")).toBe(true);
  });

  it("scopes default directory names to the selected sync root", () => {
    const nestedBasePath = "/workspace/build/demo";
    const shouldIgnore = createIgnoreMatcher(DEFAULT_IGNORE_PATTERNS, nestedBasePath);

    expect(shouldIgnore(`${nestedBasePath}/src/index.ts`)).toBe(false);
    expect(shouldIgnore(`${nestedBasePath}/src/.cache/result.json`)).toBe(true);
  });

  it("prunes common image and font directories before watcher traversal", () => {
    const shouldIgnore = createAggressiveIgnore(DEFAULT_IGNORE_PATTERNS, basePath, ["md", "ts"]);

    expect(shouldIgnore("/workspace/demo/public/images")).toBe(true);
    expect(shouldIgnore("/workspace/demo/assets/icons")).toBe(true);
    expect(shouldIgnore("/workspace/demo/public/fonts")).toBe(true);
    expect(shouldIgnore("/workspace/demo/public/images/hero.png")).toBe(true);
    expect(shouldIgnore("/workspace/demo/public/fonts/brand.woff2")).toBe(true);
    expect(shouldIgnore("/workspace/demo/src/icons/ButtonIcon.tsx")).toBe(false);
    expect(shouldIgnore("/workspace/demo/docs/readme.md")).toBe(false);
  });

  it("keeps explicitly included asset directories and extensions watchable", () => {
    const imageMatcher = createAggressiveIgnore(DEFAULT_IGNORE_PATTERNS, basePath, ["md", "png"]);
    const fontMatcher = createAggressiveIgnore(DEFAULT_IGNORE_PATTERNS, basePath, ["md", "woff2"]);

    expect(imageMatcher("/workspace/demo/assets/images")).toBe(false);
    expect(imageMatcher("/workspace/demo/assets/images/diagram.png")).toBe(false);
    expect(fontMatcher("/workspace/demo/public/fonts")).toBe(false);
    expect(fontMatcher("/workspace/demo/public/fonts/brand.woff2")).toBe(false);
  });
});

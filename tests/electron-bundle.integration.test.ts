import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

describe("Electron bundle (integration)", () => {
  const bundlePath = path.join(process.cwd(), "electron-dist", "main.js");
  const preloadPath = path.join(process.cwd(), "electron-dist", "preload.js");

  beforeAll(() => {
    // Build the bundle before running tests
    execSync("npm run electron:bundle", {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 120000,
    });
  }, 180000);

  it("produces a bundled main.js file", () => {
    expect(fs.existsSync(bundlePath)).toBe(true);
    const stats = fs.statSync(bundlePath);
    // Bundle size can vary significantly with minification/tree-shaking.
    expect(stats.size).toBeGreaterThan(50 * 1024);
  });

  it("keeps @huggingface/hub as a packaged lazy runtime dependency", () => {
    const content = fs.readFileSync(bundlePath, "utf8");
    expect(content).toContain('"standalone","node_modules","@huggingface","hub"');
    // Should NOT have dynamic require for the package
    expect(content).not.toMatch(/require\s*\(\s*["']@huggingface\/hub["']\s*\)/);
  });

  it("keeps electron as external", () => {
    const content = fs.readFileSync(bundlePath, "utf8");
    // electron should remain as external require
    expect(content).toMatch(/require\s*\(\s*["']electron["']\s*\)/);
  });

  it("keeps native modules as external", () => {
    const content = fs.readFileSync(bundlePath, "utf8");
    // better-sqlite3 should not be inlined into the bundle source.
    expect(content).not.toContain("BetterSqlite3");
    expect(content).not.toContain("node_modules/better-sqlite3");
  });

  it("produces a preload.js file", () => {
    expect(fs.existsSync(preloadPath)).toBe(true);
  });

  it("preload.js keeps electron as external", () => {
    const content = fs.readFileSync(preloadPath, "utf8");
    expect(content).toMatch(/require\s*\(\s*["']electron["']\s*\)/);
  });
});

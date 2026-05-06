import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/tool-registry/logging", () => ({
  logToolEvent: vi.fn(),
}));

vi.mock("@/lib/db/sqlite-client", () => ({
  db: {},
}));

vi.mock("@/lib/db/sqlite-character-schema", () => ({
  agentSyncFiles: {},
}));

vi.mock("../dependencies", () => ({
  installSandboxPackages: vi.fn(async () => ({
    attempted: false,
    success: true,
    packages: [],
    packageNames: [],
  })),
  validateWorkspaceDependencies: vi.fn(async () => ({
    manifestPackages: [],
    importedPackages: [],
    checkedPackages: [],
    missingManifestPackages: [],
    missingImportedPackages: [],
    missingPackages: [],
  })),
}));

const PROJECT_ROOT = process.cwd();
const projectNodeModules = join(PROJECT_ROOT, "node_modules");
const realProjectNodeModules = realpathSync(projectNodeModules);
const sandboxDir = join(PROJECT_ROOT, "selene-workspace");
const sandboxNodeModules = join(sandboxDir, "node_modules");

const { buildTailwindPreviewWithMetadata } = await import("../compiler");
import type { DesignImportLoader } from "../compiler";
const { buildContainmentConfig, isContained } = await import("../containment");
const { loadTsconfigPaths } = await import("../tsconfig-paths");

describe("design import pipeline round 3 hardening", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "selene-import-r3-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("rejects symlink escapes through realpath-backed containment", () => {
    const outside = mkdtempSync(join(tmpdir(), "selene-import-outside-"));
    try {
      const inside = join(workdir, "inside.txt");
      const target = join(outside, "secret.txt");
      writeFileSync(inside, "inside", "utf8");
      writeFileSync(target, "secret", "utf8");
      const symlinkPath = join(workdir, "linked-secret.txt");
      try {
        symlinkSync(target, symlinkPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }

      const containment = buildContainmentConfig([workdir]);
      expect(isContained(inside, containment)).toBe(true);
      expect(isContained(symlinkPath, containment)).toBe(false);
      expect(Object.isFrozen(containment)).toBe(true);
      expect(Object.isFrozen(containment.allowedRoots)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps unresolved imported-css urls anchored to the imported file directory", async () => {
    mkdirSync(join(workdir, "app", "theme"), { recursive: true });
    writeFileSync(join(workdir, "app", "page.css"), '@import "./theme/inner.css";\n.host { color: red; }', "utf8");
    writeFileSync(join(workdir, "app", "theme", "inner.css"), '.inner { background: url("./missing.png"); }', "utf8");
    writeFileSync(join(workdir, "app", "missing.png"), "wrong-parent-asset", "utf8");

    const componentSource = `
      import React from "react";
      import "./page.css";
      export default function Page() {
        return <div className="inner">css-import-url-marker</div>;
      }
    `;

    const { html, report } = await buildTailwindPreviewWithMetadata(componentSource, "Page", {
      autoInstallMissingDependencies: false,
      componentResolveDir: join(workdir, "app"),
      containment: buildContainmentConfig([
        workdir,
        projectNodeModules,
        realProjectNodeModules,
        sandboxDir,
        sandboxNodeModules,
      ]),
    });

    expect(report.errors).toEqual([]);
    expect(html).toContain("css-import-url-marker");
    expect(html).toContain('url("./missing.png")');
    expect(html).not.toContain("wrong-parent-asset");
  });

  it("keeps tsconfig aliases ahead of sandbox-first package resolution", async () => {
    mkdirSync(join(workdir, "packages", "ui"), { recursive: true });
    writeFileSync(
      join(workdir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@repo/ui": ["./packages/ui/index.ts"] } } }),
      "utf8",
    );
    writeFileSync(join(workdir, "packages", "ui", "index.ts"), 'export const marker = "alias-package-marker";', "utf8");

    const componentSource = `
      import React from "react";
      import { marker } from "@repo/ui";
      export default function Page() {
        return <div>{marker}</div>;
      }
    `;
    const tsconfigPaths = loadTsconfigPaths(workdir);
    expect(tsconfigPaths).not.toBeNull();

    const { html, report } = await buildTailwindPreviewWithMetadata(componentSource, "Page", {
      autoInstallMissingDependencies: false,
      tsconfigPaths: tsconfigPaths!,
      containment: buildContainmentConfig([
        workdir,
        projectNodeModules,
        realProjectNodeModules,
        sandboxDir,
        sandboxNodeModules,
      ]),
    });

    expect(report.errors).toEqual([]);
    expect(html).toContain("alias-package-marker");
  });

  it("keeps design: imports isolated from the file-namespace containment guard", async () => {
    const importedSource = `
      export default function ImportedBadge() {
        return <span>design-import-under-containment</span>;
      }
    `;
    const loader: DesignImportLoader = {
      async findByRef(input) {
        if (input.ref !== "badge") return null;
        return { id: "badge-row", sourceCode: importedSource };
      },
    };

    const componentSource = `
      import Badge from "design:badge";
      export default function Page() {
        return <Badge />;
      }
    `;

    const { html, report } = await buildTailwindPreviewWithMetadata(componentSource, "Page", {
      autoInstallMissingDependencies: false,
      userId: "user-r3",
      sessionId: "session-r3",
      designImportLoader: loader,
      containment: buildContainmentConfig([
        workdir,
        projectNodeModules,
        realProjectNodeModules,
        sandboxDir,
        sandboxNodeModules,
      ]),
    });

    expect(report.errors).toEqual([]);
    expect(html).toContain("design-import-under-containment");
  });

  it("exposes stable issue codes for containment and preprocessor failures", async () => {
    const containment = buildContainmentConfig([
      workdir,
      projectNodeModules,
      realProjectNodeModules,
      sandboxDir,
      sandboxNodeModules,
    ]);
    const outsideCss = resolve(workdir, "..", "outside.css");
    writeFileSync(outsideCss, ".outside { color: red; }", "utf8");
    let thrown: unknown;
    try {
      await buildTailwindPreviewWithMetadata('import "../outside.css"; export default function X(){return <div/>;}', "X", {
        autoInstallMissingDependencies: false,
        componentResolveDir: workdir,
        containment,
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { report?: { errors?: Array<{ code?: string }> } }).report?.errors?.[0]?.code).toBe("CONTAINMENT_VIOLATION");

    const sassFile = join(workdir, "style.scss");
    writeFileSync(sassFile, ".x { color: red; }", "utf8");
    thrown = undefined;
    try {
      await buildTailwindPreviewWithMetadata('import "./style.scss"; export default function X(){return <div/>;}', "X", {
        autoInstallMissingDependencies: false,
        componentResolveDir: workdir,
        containment,
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { report?: { errors?: Array<{ code?: string }> } }).report?.errors?.[0]?.code).toBe("PREPROCESSOR_NOT_SUPPORTED");
  });
});

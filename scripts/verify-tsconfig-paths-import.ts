/**
 * One-shot verification script for the Sprint 5 tsconfig-paths import fix.
 *
 * Reproduces the exact scenario from the user's failing import:
 *   - Source: components/ui/text-shimmer.tsx
 *   - Imports: framer-motion, @/lib/utils
 *
 * Before the fix this failed at compile with:
 *   `Could not resolve "@/lib/utils"`
 *
 * After the fix the alias resolves to <PROJECT_ROOT>/lib/utils.ts and the
 * compile produces a non-empty preview HTML with no errors. The script
 * intentionally lives outside vitest so we can also use it as a quick
 * smoke check after future changes to the tsconfig-paths or import paths
 * (e.g. ./scripts/verify-tsconfig-paths-import.ts).
 *
 * Run: npx tsx scripts/verify-tsconfig-paths-import.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import { buildTailwindPreviewWithMetadata } from "@/lib/design/workspace/compiler";
import { loadTsconfigPaths } from "@/lib/design/workspace/tsconfig-paths";
import { getProjectRoot } from "@/lib/utils/project-root";

async function main(): Promise<void> {
  const PROJECT_ROOT = getProjectRoot();
  const sourcePath = resolve(
    PROJECT_ROOT,
    "components",
    "ui",
    "text-shimmer.tsx",
  );
  const original = readFileSync(sourcePath, "utf8");
  // text-shimmer.tsx exports `TextShimmer` as a named export only, but
  // the workspace compiler entry imports the default export from the
  // virtual component module. Wrap the source in a thin default-export
  // shim so the compile reaches the import resolver — the goal here is
  // to prove the `@/lib/utils` alias resolves, not to relitigate the
  // separate "default export required" caveat the agent already
  // documented in its post-fix report.
  const source = `${original}\nexport default TextShimmer;\n`;

  const tsconfigPaths = loadTsconfigPaths(PROJECT_ROOT);
  if (!tsconfigPaths) {
    throw new Error(
      `loadTsconfigPaths returned null for ${PROJECT_ROOT} — expected paths config in tsconfig.json.`,
    );
  }
  console.log("[tsconfig-paths] baseUrl:", tsconfigPaths.baseUrl);
  console.log("[tsconfig-paths] paths:", tsconfigPaths.paths);

  const { html, report } = await buildTailwindPreviewWithMetadata(
    source,
    "TextShimmer",
    {
      tsconfigPaths,
      autoInstallMissingDependencies: false,
      source: "scripts.verify-tsconfig-paths-import",
    },
  );

  if (report.errors.length > 0) {
    console.error("[FAIL] compileReport.errors:", report.errors);
    process.exit(1);
  }

  console.log(`[OK] compile succeeded — html bytes: ${html.length}`);
  console.log(`[OK] dependencyCheck.missingPackages:`, report.dependencyCheck.missingPackages);
  console.log(`[OK] durationMs: ${report.durationMs}`);
}

main().catch((error) => {
  console.error("[FAIL] thrown:", error);
  if (error && typeof error === "object" && "report" in error) {
    console.error(
      "[FAIL] error.report:",
      JSON.stringify((error as { report?: unknown }).report, null, 2),
    );
  }
  process.exit(1);
});

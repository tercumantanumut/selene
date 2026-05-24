#!/usr/bin/env tsx
/**
 * Validate the environment-policy refactor wiring.
 *
 * Usage:
 *   npx tsx scripts/validation/validate-env-policy-refactor.ts [--dry-run]
 */

import { type Check, runChecks } from "./check-runner";

const checks: Check[] = [
  {
    id: "shared-policy-module-layout",
    description: "the shared environment policy module exports the expected builder API",
    filePath: "lib/process-env/policy.ts",
    requiredSnippets: [
      "export type EnvironmentTarget = \"execute-command\" | \"claude-sdk\";",
      "export function resolveBaseEnvironment(",
      "export function buildEnvironmentForTarget(",
      "export function initializeProcessEnvironment(",
    ],
  },
  {
    id: "windows-normalization-primitive",
    description: "windows-env exposes a reusable normalization primitive for higher-level policies",
    filePath: "lib/utils/windows-env.ts",
    requiredSnippets: [
      "export interface NormalizeWindowsEnvironmentOptions {",
      "export function normalizeWindowsEnvironment(",
      "filterGitBashPath?: boolean;",
      "pathKey?: \"PATH\" | \"Path\";",
    ],
  },
  {
    id: "executor-uses-shared-policy",
    description: "command execution delegates environment assembly to the shared policy layer and uses explicit bootstrap setup",
    filePath: "lib/command-execution/executor-runtime.ts",
    requiredSnippets: [
      "buildEnvironmentForTarget",
      "initializeProcessEnvironment",
      "export function initializeCommandExecutionProcessEnv(): NodeJS.ProcessEnv",
      "target: \"execute-command\"",
    ],
  },
  {
    id: "electron-bootstrap-uses-explicit-init",
    description: "Electron main initializes process env via an explicit bootstrap call instead of inline ad hoc mutation",
    filePath: "electron/main.ts",
    requiredSnippets: [
      "import { initializeProcessEnvironment } from \"../lib/process-env/policy\";",
      "function initializeElectronProcessEnvironment(): void {",
      "initializeProcessEnvironment({",
      "initializeElectronProcessEnvironment();",
    ],
  },
  {
    id: "tests-cover-policy-layer",
    description: "focused unit tests cover shared policy decisions and command bootstrap behavior",
    filePath: "tests/lib/process-env/policy.test.ts",
    requiredSnippets: [
      "describe(\"process-env policy\"",
      "uses shell env as the primary source and excludes unrelated process vars",
      "preserves Windows Git Bash compatibility while stripping MSYS markers",
      "normalizes the live Windows process env without filtering Git Bash paths by default",
    ],
  },
];

function main(): void {
  const dryRun = process.argv.includes("--dry-run");

  console.log("\n=== Environment Policy Refactor Validation ===");
  console.log(`Mode: ${dryRun ? "dry-run" : "validate"}`);
  console.log("This validation script is read-only and does not modify files.\n");

  const failed = runChecks(checks, /* tolerateMissing */ true);

  console.log("\n=== Validation Summary ===");
  if (failed > 0) {
    const summary = `Failed checks: ${failed}/${checks.length}`;
    if (dryRun) {
      console.warn(`${summary} (dry-run: non-fatal)`);
      return;
    }
    console.error(summary);
    process.exit(1);
  }

  console.log(`All checks passed: ${checks.length}/${checks.length}`);
}

main();

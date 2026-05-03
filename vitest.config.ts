import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"],
    // tests/integration/** is excluded by default (those run via the
    // dedicated integration vitest config), but the Sprint 7 W7.1.F Swift
    // engine end-to-end smoke lives there and self-gates on the
    // SELENE_E2E_SWIFT env var, so it must remain discoverable here.
    // We exclude the api/app subtree (existing integration suites) but
    // leave the top-level tests/integration/*.test.ts files visible.
    exclude: [
      "**/node_modules/**",
      "**/.next/**",
      "**/tests/integration/app/**",
      "**/tests/integration/api/**",
      "**/tmp-clawdbot/**",
      "**/.claude/worktrees/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["lib/**/*.ts"],
      exclude: ["lib/**/*.test.ts", "lib/**/*.spec.ts"],
    },
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});

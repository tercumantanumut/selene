import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { query as claudeAgentQuery } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeAgentSdkRuntimeModule {
  query: typeof claudeAgentQuery;
}

let cachedRuntime: Promise<ClaudeAgentSdkRuntimeModule> | null = null;

function resolvePackagedClaudeAgentSdkEntry(): string | null {
  const override = process.env.SELENE_CLAUDE_AGENT_SDK_RUNTIME_PATH;
  if (override && fs.existsSync(override)) return override;

  const resourcesPath = process.resourcesPath ?? process.env.ELECTRON_RESOURCES_PATH;
  if (!resourcesPath) return null;

  const candidate = path.join(
    resourcesPath,
    "standalone",
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "sdk.mjs"
  );

  return fs.existsSync(candidate) ? candidate : null;
}

export async function loadClaudeAgentSdkRuntime(): Promise<ClaudeAgentSdkRuntimeModule> {
  cachedRuntime ??= (async () => {
    const packagedEntry = resolvePackagedClaudeAgentSdkEntry();
    if (packagedEntry) {
      return import(pathToFileURL(packagedEntry).href) as Promise<ClaudeAgentSdkRuntimeModule>;
    }

    return import("@anthropic-ai/claude-agent-sdk");
  })();

  return cachedRuntime;
}

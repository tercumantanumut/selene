import { buildEnvironmentForTarget } from "@/lib/process-env/policy";
import { isElectronProduction } from "@/lib/utils/environment";
import type { DarioConfigFile } from "./config";

const DARIO_ENV_PREFIX = "DARIO_";
const BLOCKED_DARIO_INHERITED_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_LOG",
  "ANTHROPIC_UPSTREAM_API_KEY",
  "CLAUDECODE",
]);

/**
 * Build a Dario child-process environment.
 *
 * We preserve PATH/HOME/platform basics through Selene's existing Claude SDK
 * policy, but remove user-global DARIO_* and Anthropic overrides before
 * setting Selene-owned host/port/API-key values.
 */
export function buildDarioEnvironment(config: DarioConfigFile): NodeJS.ProcessEnv {
  const { env } = buildEnvironmentForTarget({
    target: "claude-sdk",
    isProduction: isElectronProduction(),
    processEnv: process.env,
  });

  const next: Record<string, string | undefined> = { ...env };
  for (const key of Object.keys(next)) {
    if (key.startsWith(DARIO_ENV_PREFIX) || BLOCKED_DARIO_INHERITED_KEYS.has(key)) {
      delete next[key];
    }
  }

  next.DARIO_API_KEY = config.apiKey;
  next.DARIO_HOST = config.host;
  next.DARIO_PORT = String(config.port);

  return next as NodeJS.ProcessEnv;
}

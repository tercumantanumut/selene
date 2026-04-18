/**
 * Ghost OS Preflight Tool
 *
 * Agent-callable diagnostic tool that runs the Ghost OS preflight probe
 * (binary lookup → sidecar spawn → MCP initialize → tools/list) and returns
 * a structured verdict the agent can use to answer setup / troubleshooting
 * questions without going through the renderer wizard.
 *
 * This tool runs in the Next.js server context — it does NOT have access to
 * Electron's `systemPreferences` API. The permission verdict will therefore
 * always be `not-probed`. Callers who need a real permission verdict must
 * use the desktop wizard (which injects a `permissionProbe` from the main
 * process).
 */

import { tool, jsonSchema } from "ai";
import { withToolLogging } from "@/lib/ai/tool-registry/logging";
import {
  runGhostOsPreflight,
  type PreflightProgressEvent,
  type PreflightResult,
} from "@/lib/ghost-os/preflight";

interface GhostOsPreflightToolOptions {
  sessionId?: string;
}

interface GhostOsPreflightArgs {
  timeoutMs?: number;
}

const ghostOsPreflightSchema = jsonSchema<GhostOsPreflightArgs>({
  type: "object",
  title: "GhostOsPreflightInput",
  description:
    "Input for running the Ghost OS preflight probe (diagnose binary / sidecar / MCP handshake).",
  properties: {
    timeoutMs: {
      type: "number",
      description:
        "Optional overall timeout in milliseconds. Defaults to 20000. The probe will be aborted and return with the stages it completed.",
      minimum: 1000,
      maximum: 60000,
    },
  },
  additionalProperties: false,
});

interface GhostOsPreflightToolResult {
  status: "success" | "error";
  overallOk: boolean;
  summary: string;
  durationMs: number;
  stages: PreflightProgressEvent[];
  binary: {
    found: boolean;
    path?: string;
    version?: string;
  };
  permission: PreflightResult["permission"];
  sidecarSpawn: PreflightResult["sidecarSpawn"];
  mcpHandshake: PreflightResult["mcpHandshake"];
  toolPing: PreflightResult["toolPing"];
  advice: string[];
  error?: string;
}

/**
 * Build a list of short human-readable remediation hints the agent can
 * surface to the user. Each line is actionable.
 */
function buildAdvice(result: PreflightResult): string[] {
  const advice: string[] = [];

  if (!result.binaryFound) {
    // Keep the brew tap formula in sync with `lib/ghost-os/setup.ts` —
    // both messages are user-facing and any drift produces a copy/paste
    // command that immediately 404s on `brew install`.
    advice.push(
      "Install Ghost OS: `brew install ghostwright/ghost-os/ghost-os` so the `ghost` binary is on PATH."
    );
    return advice;
  }

  if (!result.sidecarSpawn.ok) {
    advice.push(
      `Sidecar failed to spawn: ${result.sidecarSpawn.error ?? "unknown"}. Verify the binary is executable and not quarantined.`
    );
  }

  if (!result.mcpHandshake.ok) {
    advice.push(
      `MCP initialize failed: ${result.mcpHandshake.error ?? "unknown"}. If the error mentions screen recording, macOS Screen Recording permission is the likely cause.`
    );
  }

  if (!result.toolPing.ok) {
    advice.push(
      `tools/list failed: ${result.toolPing.error ?? "unknown"}. The sidecar connected but can't enumerate tools.`
    );
  }

  switch (result.permission.kind) {
    case "denied":
      advice.push(
        "macOS Screen Recording permission is not granted. Open System Settings → Privacy & Security → Screen Recording and enable Selene, then relaunch Selene."
      );
      break;
    case "tcc_stale":
      advice.push(
        "macOS reports Screen Recording as granted, but capture fails — this is a stale TCC entry. REMOVE Selene from System Settings → Privacy & Security → Screen Recording, then RE-ADD it, then relaunch Selene."
      );
      break;
    case "wrong-responsible-process":
      advice.push(
        `Permission appears bound to the wrong parent process (${result.permission.detectedParent}). Ensure Selene.app itself — not a dev-mode shell parent — is what was granted permission.`
      );
      break;
    case "unknown":
      advice.push(
        `Permission probe returned unknown: ${result.permission.error}. Review the event details and run the desktop wizard for a full diagnostic.`
      );
      break;
    case "not-probed":
      // Only note this if everything else actually succeeded — otherwise the
      // binary/handshake advice above is more relevant.
      if (
        result.binaryFound &&
        result.sidecarSpawn.ok &&
        result.mcpHandshake.ok &&
        result.toolPing.ok
      ) {
        advice.push(
          "Permission status was not probed in this context (server-side). Use the Ghost OS setup wizard in Settings for the full macOS TCC verdict."
        );
      }
      break;
    case "granted":
    case "non-darwin":
      // Nothing to add.
      break;
  }

  if (advice.length === 0) {
    advice.push(
      "Ghost OS preflight passed. No action needed — the sidecar is reachable and tools are discoverable."
    );
  }

  return advice;
}

async function executeGhostOsPreflight(
  _options: GhostOsPreflightToolOptions,
  args: GhostOsPreflightArgs
): Promise<GhostOsPreflightToolResult> {
  const timeoutMs = args.timeoutMs ?? 20000;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  const stages: PreflightProgressEvent[] = [];

  try {
    const result = await runGhostOsPreflight({
      // NOTE: never forward an agent-supplied binary path — the preflight
      // spawns whatever it's given with the server's env, which would be
      // an RCE primitive. Binary lookup is internal (resolveGhostBinary()).
      signal: controller.signal,
      onProgress: (event) => {
        stages.push(event);
      },
    });

    return {
      status: "success",
      overallOk: result.overallOk,
      summary: result.summary,
      durationMs: result.durationMs,
      stages,
      binary: {
        found: result.binaryFound,
        path: result.binaryPath,
        version: result.binaryVersion,
      },
      permission: result.permission,
      sidecarSpawn: result.sidecarSpawn,
      mcpHandshake: result.mcpHandshake,
      toolPing: result.toolPing,
      advice: buildAdvice(result),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      overallOk: false,
      summary: `preflight threw: ${msg}`,
      durationMs: 0,
      stages,
      binary: { found: false },
      permission: { kind: "not-probed" },
      sidecarSpawn: { ok: false, error: msg },
      mcpHandshake: { ok: false, error: msg },
      toolPing: { ok: false, error: msg },
      advice: [
        "The preflight probe threw an unexpected error. Run the Ghost OS setup wizard in Settings for a full diagnostic.",
      ],
      error: msg,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export function createGhostOsPreflightTool(
  options: GhostOsPreflightToolOptions = {}
) {
  const executeWithLogging = withToolLogging(
    "ghostOsPreflight",
    options.sessionId,
    (args: GhostOsPreflightArgs) => executeGhostOsPreflight(options, args)
  );

  return tool({
    description: `Diagnose the Ghost OS MCP sidecar end-to-end.

Runs these stages and returns a structured verdict:
  1. binary_located     — resolve the \`ghost\` binary from PATH / Homebrew
  2. permission_preflight — (server context: always "not-probed")
  3. sidecar_spawn      — \`ghost mcp\` child process starts and gets a PID
  4. mcp_handshake      — JSON-RPC 2.0 \`initialize\` succeeds
  5. first_tool_ping    — \`tools/list\` returns at least one tool
  6. complete           — overall OK verdict + remediation advice

Use when the user reports Ghost OS / screen-sharing / \`ghost mcp\` issues
and you need a concrete diagnosis before proposing a fix. The response
includes per-stage events, specific errors, and an \`advice\` array of
short remediation steps (install binary, grant Screen Recording, TCC-stale
remove-and-re-add, relaunch Selene).

The agent-callable variant cannot read macOS TCC state — if the verdict
requires a real Screen Recording check, direct the user to the Ghost OS
setup wizard in Settings.`,
    inputSchema: ghostOsPreflightSchema,
    execute: executeWithLogging,
  });
}

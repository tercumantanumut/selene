import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type DarioCommandSource = "override" | "packaged" | "dependency" | "external" | "path";

export interface DarioCommandResolution {
  command: string;
  argsPrefix: string[];
  source: DarioCommandSource;
  description: string;
}

function nodeExecutableName(): string {
  return process.platform === "win32" ? "node.exe" : "node";
}

function getElectronResourcesPath(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    || process.env.ELECTRON_RESOURCES_PATH
    || null;
  return resourcesPath && resourcesPath.trim().length > 0 ? resourcesPath : null;
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveWorkspaceDarioCli(): { cliPath: string; source: "dependency" | "external" } | null {
  const cwd = process.cwd();
  const candidates: Array<{ cliPath: string; source: "dependency" | "external" }> = [
    {
      cliPath: resolve(cwd, "node_modules", "@askalf", "dario", "dist", "cli.js"),
      source: "dependency",
    },
    {
      cliPath: resolve(cwd, ".external", "dario", "dist", "cli.js"),
      source: "external",
    },
    {
      cliPath: resolve(dirname(process.execPath), "..", "lib", "node_modules", "@askalf", "dario", "dist", "cli.js"),
      source: "dependency",
    },
  ];

  return candidates.find((candidate) => existsSync(candidate.cliPath)) ?? null;
}

/**
 * Resolve the Dario CLI without relying on the host PATH in packaged builds.
 *
 * Electron runs the Next.js server in a utility process with
 * ELECTRON_RESOURCES_PATH pointing at the app's Resources directory. The Dario
 * npm package is copied into standalone/node_modules during electron:prepare,
 * and the bundled Node binary lives beside it in standalone/node_modules/.bin.
 */
export function resolveDarioCommand(): DarioCommandResolution {
  const override = process.env.SELENE_DARIO_BIN?.trim();
  if (override) {
    return {
      command: override,
      argsPrefix: [],
      source: "override",
      description: override,
    };
  }

  const resourcesPath = getElectronResourcesPath();
  const isPackaged = !!resourcesPath && process.env.ELECTRON_IS_DEV !== "1";
  if (isPackaged) {
    const cliPath = join(resourcesPath, "standalone", "node_modules", "@askalf", "dario", "dist", "cli.js");
    const nodePath = join(resourcesPath, "standalone", "node_modules", ".bin", nodeExecutableName());
    const missing = [
      existsSync(cliPath) ? null : cliPath,
      existsSync(nodePath) ? null : nodePath,
    ].filter((path): path is string => Boolean(path));

    if (missing.length > 0) {
      throw new Error(
        "Bundled Dario runtime is missing from the packaged app: "
        + `${missing.join(", ")}. Rebuild the Electron package after installing @askalf/dario and running electron:prepare.`,
      );
    }

    return {
      command: nodePath,
      argsPrefix: [cliPath],
      source: "packaged",
      description: `${nodePath} ${cliPath}`,
    };
  }

  const workspaceCli = resolveWorkspaceDarioCli();
  if (workspaceCli) {
    return {
      command: process.execPath,
      argsPrefix: [workspaceCli.cliPath],
      source: workspaceCli.source,
      description: `${process.execPath} ${workspaceCli.cliPath}`,
    };
  }

  const pathBinary = firstExisting(
    (process.env.PATH ?? "")
      .split(process.platform === "win32" ? ";" : ":")
      .filter(Boolean)
      .map((entry) => join(entry, process.platform === "win32" ? "dario.cmd" : "dario")),
  );

  return {
    command: pathBinary ?? "dario",
    argsPrefix: [],
    source: "path",
    description: pathBinary ?? "dario on PATH",
  };
}

export function withDarioCommandArgs(resolution: DarioCommandResolution, args: string[]): string[] {
  return [...resolution.argsPrefix, ...args];
}

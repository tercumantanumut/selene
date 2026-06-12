/**
 * Reads the OAuth credentials CLIProxyAPI persists for Claude and Codex.
 *
 * After a successful `cliproxyapi -<provider>-login`, the sidecar drops a
 * `<provider>-<email>[-<plan>].json` file into its auth dir. Selene's auth
 * routes inspect that directory to surface "logged in as foo@bar" without
 * keeping a second copy of the token anywhere.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getCliproxyAuthDir } from "./config";

export interface SidecarCredential {
  /** Provider this credential is for. */
  provider: "claude" | "codex";
  /** Email parsed from the filename. */
  email: string;
  /**
   * Plan suffix (e.g. "prolite", "pro", "plus"), when present in the
   * filename. Used by Codex to disambiguate per-account-tier credentials.
   */
  plan?: string;
  /** Absolute path to the credential JSON file. */
  filePath: string;
  /** mtime of the credential file in ms since epoch. */
  updatedAt: number;
}

const FILENAME_PATTERNS: Record<SidecarCredential["provider"], RegExp> = {
  // Upstream's CredentialFileName:
  //   codex-<email>.json              (no plan)
  //   codex-<email>-<plan>.json       (most plans)
  //   codex-<hash>-<email>-team.json  (team — we don't emit this, but match defensively)
  claude: /^claude-(.+)\.json$/,
  codex: /^codex-(?:[a-f0-9]{8,}-)?(.+?)(?:-([a-z0-9]+))?\.json$/,
};

async function listCredentials(
  provider: SidecarCredential["provider"],
): Promise<SidecarCredential[]> {
  const dir = getCliproxyAuthDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }

  const pattern = FILENAME_PATTERNS[provider];
  const results: SidecarCredential[] = [];
  for (const name of entries) {
    const match = pattern.exec(name);
    if (!match) continue;
    const filePath = join(dir, name);
    let updatedAt = 0;
    try {
      const stat = await fs.stat(filePath);
      updatedAt = stat.mtimeMs;
    } catch {
      continue;
    }
    results.push({
      provider,
      email: match[1],
      plan: match[2],
      filePath,
      updatedAt,
    });
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results;
}

async function deleteCredentials(
  provider: SidecarCredential["provider"],
): Promise<void> {
  const creds = await listCredentials(provider);
  await Promise.all(
    creds.map((c) =>
      fs.unlink(c.filePath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      }),
    ),
  );
}

// ── Claude ──────────────────────────────────────────────────────────────────

export function listClaudeCredentials(): Promise<SidecarCredential[]> {
  return listCredentials("claude");
}

export async function hasClaudeCredential(): Promise<boolean> {
  return (await listClaudeCredentials()).length > 0;
}

export function deleteAllClaudeCredentials(): Promise<void> {
  return deleteCredentials("claude");
}

// ── Codex ───────────────────────────────────────────────────────────────────

export function listCodexCredentials(): Promise<SidecarCredential[]> {
  return listCredentials("codex");
}

export async function hasCodexCredential(): Promise<boolean> {
  return (await listCodexCredentials()).length > 0;
}

export function deleteAllCodexCredentials(): Promise<void> {
  return deleteCredentials("codex");
}

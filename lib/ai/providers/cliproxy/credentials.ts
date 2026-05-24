/**
 * Reads the OAuth credentials CLIProxyAPI persists for Claude.
 *
 * After a successful `cliproxyapi -claude-login` run, the sidecar drops a
 * `claude-<email>.json` file into its auth dir. Selene's auth status check
 * inspects that directory to surface "logged in as foo@bar" without keeping
 * a second copy of the token anywhere.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getCliproxyAuthDir } from "./config";

export interface ClaudeCredential {
  /** Email parsed from the filename (`claude-<email>.json` → `<email>`). */
  email: string;
  /** Absolute path to the credential JSON file. */
  filePath: string;
  /** mtime of the credential file in ms since epoch. */
  updatedAt: number;
}

const CLAUDE_FILE_PATTERN = /^claude-(.+)\.json$/;

/** Enumerate Claude OAuth credentials stored by the sidecar. */
export async function listClaudeCredentials(): Promise<ClaudeCredential[]> {
  const dir = getCliproxyAuthDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }

  const results: ClaudeCredential[] = [];
  for (const name of entries) {
    const match = CLAUDE_FILE_PATTERN.exec(name);
    if (!match) continue;
    const filePath = join(dir, name);
    let updatedAt = 0;
    try {
      const stat = await fs.stat(filePath);
      updatedAt = stat.mtimeMs;
    } catch {
      continue;
    }
    results.push({ email: match[1], filePath, updatedAt });
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results;
}

/** Returns true when at least one Claude credential is on disk. */
export async function hasClaudeCredential(): Promise<boolean> {
  const creds = await listClaudeCredentials();
  return creds.length > 0;
}

/** Delete every Claude credential the sidecar knows about. */
export async function deleteAllClaudeCredentials(): Promise<void> {
  const creds = await listClaudeCredentials();
  await Promise.all(
    creds.map((c) =>
      fs.unlink(c.filePath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      }),
    ),
  );
}

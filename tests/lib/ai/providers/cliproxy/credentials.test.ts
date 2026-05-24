import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteAllClaudeCredentials,
  hasClaudeCredential,
  listClaudeCredentials,
} from "@/lib/ai/providers/cliproxy/credentials";

describe("cliproxy/credentials", () => {
  let authDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "selene-cliproxy-creds-"));
    prev = process.env.SELENE_CLIPROXY_AUTH_DIR;
    process.env.SELENE_CLIPROXY_AUTH_DIR = authDir;
  });

  afterEach(() => {
    rmSync(authDir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SELENE_CLIPROXY_AUTH_DIR;
    else process.env.SELENE_CLIPROXY_AUTH_DIR = prev;
  });

  it("returns an empty list when no credentials exist", async () => {
    expect(await listClaudeCredentials()).toEqual([]);
    expect(await hasClaudeCredential()).toBe(false);
  });

  it("returns empty when the auth dir itself is missing", async () => {
    rmSync(authDir, { recursive: true, force: true });
    expect(await listClaudeCredentials()).toEqual([]);
    expect(await hasClaudeCredential()).toBe(false);
  });

  it("parses claude-<email>.json files and sorts newest first", async () => {
    writeFileSync(join(authDir, "claude-alice@example.com.json"), "{}");
    writeFileSync(join(authDir, "claude-bob@example.com.json"), "{}");
    writeFileSync(join(authDir, "ignored-non-claude.json"), "{}");

    // Force alice to be older than bob.
    utimesSync(join(authDir, "claude-alice@example.com.json"), 1700000000, 1700000000);
    utimesSync(join(authDir, "claude-bob@example.com.json"), 1800000000, 1800000000);

    const creds = await listClaudeCredentials();
    expect(creds.map((c) => c.email)).toEqual(["bob@example.com", "alice@example.com"]);
    expect(await hasClaudeCredential()).toBe(true);
  });

  it("deletes every claude-*.json on logout", async () => {
    writeFileSync(join(authDir, "claude-x@y.com.json"), "{}");
    writeFileSync(join(authDir, "claude-other@y.com.json"), "{}");
    writeFileSync(join(authDir, "codex-x@y.com.json"), "{}");

    await deleteAllClaudeCredentials();

    expect(await hasClaudeCredential()).toBe(false);
    // Non-claude credentials are untouched.
    const remaining = await listClaudeCredentials();
    expect(remaining).toEqual([]);
  });
});

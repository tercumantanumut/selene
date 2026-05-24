import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteAllClaudeCredentials,
  deleteAllCodexCredentials,
  hasClaudeCredential,
  hasCodexCredential,
  listClaudeCredentials,
  listCodexCredentials,
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
    // Codex credentials survive — different provider scope.
    expect(await hasCodexCredential()).toBe(true);
  });

  // ── Codex variant ────────────────────────────────────────────────────────

  it("returns an empty list when no codex credentials exist", async () => {
    expect(await listCodexCredentials()).toEqual([]);
    expect(await hasCodexCredential()).toBe(false);
  });

  it("parses codex-<email>.json (no plan) and codex-<email>-<plan>.json (with plan)", async () => {
    writeFileSync(join(authDir, "codex-noplan@example.com.json"), "{}");
    writeFileSync(join(authDir, "codex-pro@example.com-pro.json"), "{}");
    writeFileSync(join(authDir, "codex-prolite@example.com-prolite.json"), "{}");
    writeFileSync(join(authDir, "ignored-non-codex.json"), "{}");

    // Force ordering: prolite newest, noplan middle, pro oldest.
    utimesSync(join(authDir, "codex-pro@example.com-pro.json"), 1700000000, 1700000000);
    utimesSync(join(authDir, "codex-noplan@example.com.json"), 1750000000, 1750000000);
    utimesSync(join(authDir, "codex-prolite@example.com-prolite.json"), 1800000000, 1800000000);

    const creds = await listCodexCredentials();
    expect(creds).toHaveLength(3);
    expect(creds.map((c) => ({ email: c.email, plan: c.plan }))).toEqual([
      { email: "prolite@example.com", plan: "prolite" },
      { email: "noplan@example.com", plan: undefined },
      { email: "pro@example.com", plan: "pro" },
    ]);
    expect(await hasCodexCredential()).toBe(true);
  });

  it("ignores claude-*.json when listing codex (cross-provider isolation)", async () => {
    writeFileSync(join(authDir, "claude-x@y.com.json"), "{}");
    writeFileSync(join(authDir, "codex-x@y.com.json"), "{}");

    const codex = await listCodexCredentials();
    expect(codex.map((c) => c.provider)).toEqual(["codex"]);
    expect(codex.map((c) => c.email)).toEqual(["x@y.com"]);

    const claude = await listClaudeCredentials();
    expect(claude.map((c) => c.provider)).toEqual(["claude"]);
  });

  it("deletes every codex-*.json on logout, leaving claude credentials intact", async () => {
    writeFileSync(join(authDir, "codex-x@y.com.json"), "{}");
    writeFileSync(join(authDir, "codex-y@z.com-prolite.json"), "{}");
    writeFileSync(join(authDir, "claude-keep@me.com.json"), "{}");

    await deleteAllCodexCredentials();

    expect(await hasCodexCredential()).toBe(false);
    expect(await hasClaudeCredential()).toBe(true);
  });
});

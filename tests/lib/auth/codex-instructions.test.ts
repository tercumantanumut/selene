import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCodexInstructions } from "@/lib/auth/codex-instructions";

const RELEASE_TAG = "rust-v0.153.2";

function mockGitHub(promptByPath: Record<string, string>) {
  const requested: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requested.push(url);
    if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
      return new Response(JSON.stringify({ tag_name: RELEASE_TAG }), { status: 200 });
    }
    for (const [path, body] of Object.entries(promptByPath)) {
      if (url === `https://raw.githubusercontent.com/openai/codex/${RELEASE_TAG}/${path}`) {
        return new Response(body, { status: 200, headers: { etag: `"${path}"` } });
      }
    }
    return new Response("not found", { status: 404 });
  }));
  return requested;
}

describe("getCodexInstructions", () => {
  let cacheRoot: string;
  let previousLocalDataPath: string | undefined;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "codex-instructions-"));
    previousLocalDataPath = process.env.LOCAL_DATA_PATH;
    process.env.LOCAL_DATA_PATH = cacheRoot;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousLocalDataPath === undefined) {
      delete process.env.LOCAL_DATA_PATH;
    } else {
      process.env.LOCAL_DATA_PATH = previousLocalDataPath;
    }
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("uses the upstream models-manager base prompt for GPT-6 Astra", async () => {
    const requested = mockGitHub({
      "codex-rs/models-manager/prompt.md": "ASTRA BASE PROMPT",
      "codex-rs/core/gpt-5.2-codex_prompt.md": "GPT-5.2 CODEX PROMPT",
    });

    const instructions = await getCodexInstructions("gpt-6-astra");

    expect(instructions).toBe("ASTRA BASE PROMPT");
    expect(requested).toContain(
      `https://raw.githubusercontent.com/openai/codex/${RELEASE_TAG}/codex-rs/models-manager/prompt.md`,
    );
  });

  it("keeps GPT-5.2 Codex on its dedicated core prompt", async () => {
    mockGitHub({
      "codex-rs/models-manager/prompt.md": "ASTRA BASE PROMPT",
      "codex-rs/core/gpt-5.2-codex_prompt.md": "GPT-5.2 CODEX PROMPT",
    });

    await expect(getCodexInstructions("gpt-5.2-codex")).resolves.toBe("GPT-5.2 CODEX PROMPT");
  });
});

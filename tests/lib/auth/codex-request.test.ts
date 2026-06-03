import { describe, expect, it } from "vitest";

import { transformCodexRequest } from "@/lib/auth/codex-request";
import { getCodexModels, normalizeCodexModel } from "@/lib/auth/codex-models";

describe("transformCodexRequest", () => {
  it("strips leaked internal fallback text and reconstructs orphaned outputs structurally", async () => {
    const body = {
      model: "gpt-5-codex",
      input: [
        {
          type: "message",
          role: "assistant",
          content:
            '[Previous tool result; call_id=call_old]: {"status":"success","stdout":"..." }',
        },
        {
          type: "function_call_output",
          call_id: "call_orphan",
          name: "localGrep",
          output: { status: "success", matchCount: 3 },
        },
      ],
    } as Record<string, any>;

    const transformed = await transformCodexRequest(body, "");
    const input = transformed.input as Array<Record<string, unknown>>;

    expect(input).toHaveLength(2);
    expect(input[0]).toMatchObject({
      type: "function_call",
      call_id: "call_orphan",
      name: "localGrep",
    });
    expect(input[1]).toMatchObject({
      type: "function_call_output",
      call_id: "call_orphan",
      name: "localGrep",
    });
    expect(JSON.stringify(input)).not.toContain("[Previous tool result;");
  });

  it("reconstructs missing outputs without converting calls to assistant messages", async () => {
    const body = {
      model: "gpt-5-codex",
      input: [
        {
          type: "function_call",
          call_id: "call_only",
          name: "executeCommand",
          arguments: "{\"command\":\"pwd\"}",
        },
      ],
    } as Record<string, any>;

    const transformed = await transformCodexRequest(body, "");
    const input = transformed.input as Array<Record<string, unknown>>;

    expect(input).toHaveLength(2);
    expect(input[0]).toMatchObject({
      type: "function_call",
      call_id: "call_only",
    });
    expect(input[1]).toMatchObject({
      type: "function_call_output",
      call_id: "call_only",
      output: { reconstructed: true },
    });
  });

  it.each(["low", "high", "xhigh"] as const)(
    "maps GPT-5.5 %s variants to the CLIProxyAPI base model plus reasoning effort",
    async (effort) => {
      const transformed = await transformCodexRequest(
        { model: `gpt-5.5-${effort}`, input: [] } as Record<string, any>,
        "",
      );

      expect(transformed.model).toBe("gpt-5.5");
      expect(transformed.reasoning?.effort).toBe(effort);
    },
  );

  it("keeps the Codex model picker aligned with CLIProxyAPI Codex models and variants", () => {
    const ids = getCodexModels().map((model) => model.id);

    expect(ids).toEqual(expect.arrayContaining([
      "gpt-5.5-low",
      "gpt-5.5-high",
      "gpt-5.5-xhigh",
      "gpt-5.4-mini-xhigh",
      "gpt-5.3-codex-spark-high",
      "codex-auto-review-low",
    ]));
    expect(ids).not.toContain("gpt-5.5-none");
    expect(ids).not.toContain("gpt-5.4-none");
  });

  it("normalizes CLIProxyAPI suffix variants to supported base model IDs", () => {
    expect(normalizeCodexModel("gpt-5.5-xhigh")).toBe("gpt-5.5");
    expect(normalizeCodexModel("gpt-5.4-mini-high")).toBe("gpt-5.4-mini");
    expect(normalizeCodexModel("gpt-5.3-codex-spark-low")).toBe("gpt-5.3-codex-spark");
    expect(normalizeCodexModel("codex-auto-review-xhigh")).toBe("codex-auto-review");
  });
});

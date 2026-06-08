import { describe, expect, it } from "vitest";
import { convertSseToJson, ensureContentType } from "@/lib/auth/codex-response";

async function convertSseBody(body: string): Promise<Record<string, any>> {
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const converted = await convertSseToJson(response, ensureContentType(response.headers));
  return converted.json();
}

describe("convertSseToJson", () => {
  it("wraps scalar response.done payloads as Responses API text output", async () => {
    const json = await convertSseBody(
      'data: {"type":"response.done","response":"success"}\n\n'
    );

    expect(json.status).toBe("completed");
    expect(json.output).toHaveLength(1);
    expect(json.output[0].content[0]).toMatchObject({
      type: "output_text",
      text: "success",
    });
  });

  it("wraps accumulated text when response.done omits a response object", async () => {
    const json = await convertSseBody(
      'data: {"type":"response.output_text.delta","delta":"compact "}\n\n' +
      'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
      'data: {"type":"response.done"}\n\n'
    );

    expect(json.status).toBe("completed");
    expect(json.output[0].content[0]).toMatchObject({
      type: "output_text",
      text: "compact ok",
    });
  });

  it("parses Codex SSE data fields without a space after the colon", async () => {
    const json = await convertSseBody(
      'event: response.reasoning_summary_text.delta\r\n' +
      'data:{"type":"response.reasoning_summary_text.delta","delta":"ignore reasoning summary"}\r\n\r\n' +
      'event: response.output_text.delta\r\n' +
      'data:{"type":"response.output_text.delta","delta":"enhanced"}\r\n\r\n' +
      'event: response.output_text.delta\r\n' +
      'data:{"type":"response.output_text.delta","delta":" prompt"}\r\n\r\n' +
      'event: response.done\r\n' +
      'data:{"type":"response.done","response":{"id":"resp_no_space","object":"response","created_at":0,"model":"gpt-5.4","status":"completed","output":[],"usage":null}}\r\n\r\n'
    );

    expect(json.status).toBe("completed");
    expect(json.output[0].content[0]).toMatchObject({
      type: "output_text",
      text: "enhanced prompt",
    });
  });
});

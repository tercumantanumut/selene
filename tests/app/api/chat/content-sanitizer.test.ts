import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASE64_IMAGE_PLACEHOLDER,
  MAX_TEXT_CONTENT_LENGTH,
  sanitizeAssistantOutputText,
  sanitizeTextContent,
  normalizeReadFileInputArgs,
} from "@/app/api/chat/content-sanitizer";
import { storeFullContent } from "@/lib/ai/truncated-content-store";

vi.mock("@/lib/ai/truncated-content-store", () => ({
  storeFullContent: vi.fn(() => "trunc_test_123"),
}));

const leakedPlanningText =
  "I need continue with actual tools available names. Only commentary tools under functions.* not tool. Need sequential edits. Must read current files before edit. Need use editFile and run tests. Let's implement carefully. Need add setting to app/settings/settings-types FormState.";

const exactNamespaceLeakText =
  "Need use actual tool names weird transcript says functions.tool due maybe alias? Need continue. Read route.";

describe("sanitizeAssistantOutputText", () => {
  it("strips leaked internal planning prose when tool-call context is present", () => {
    expect(
      sanitizeAssistantOutputText(leakedPlanningText, { hasToolCallLikeParts: true })
    ).toBe("");
  });

  it("preserves the same text when there is no tool-call context", () => {
    expect(sanitizeAssistantOutputText(leakedPlanningText)).toBe(leakedPlanningText);
  });

  it("strips the exact namespace leak even before a tool-call part exists", () => {
    expect(sanitizeAssistantOutputText(exactNamespaceLeakText)).toBe("");
  });

  it("strips the leak fragment that ends mid-token at `functions.`", () => {
    // Regression for INTERNAL_TOOL_NAMESPACE_LEAK_BUG_REPORT.md.
    // When the AI SDK stream tokenizer splits the leak at the period
    // inside `functions.tool`, the first half no longer matches the
    // `functions.<word>` namespace pattern. The detector must still
    // catch it via the high-confidence + directive cues.
    const fragment =
      "Need use actual tool names weird transcript says functions.";
    expect(sanitizeAssistantOutputText(fragment)).toBe("");
    expect(
      sanitizeAssistantOutputText(fragment, { hasToolCallLikeParts: true }),
    ).toBe("");
  });

  it("preserves normal assistant text even when tool-call context is present", () => {
    const text = "I checked the files and updated the response formatting.";
    expect(sanitizeAssistantOutputText(text, { hasToolCallLikeParts: true })).toBe(text);
  });

  it("preserves a benign sentence that happens to mention the route", () => {
    const text = "I need to read the route handler before making changes.";
    expect(sanitizeAssistantOutputText(text)).toBe(text);
    expect(sanitizeAssistantOutputText(text, { hasToolCallLikeParts: true })).toBe(text);
  });
});

describe("content-sanitizer text length limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses a 75,000 character limit", () => {
    expect(MAX_TEXT_CONTENT_LENGTH).toBe(75_000);
  });

  it("does not truncate text at exactly the limit", () => {
    const chunk = "This is normal prose with spaces and punctuation.X";
    const input = chunk.repeat(Math.ceil(MAX_TEXT_CONTENT_LENGTH / chunk.length)).slice(0, MAX_TEXT_CONTENT_LENGTH);
    const output = sanitizeTextContent(input, "unit-test", "session-1");
    expect(output).toBe(input);
    expect(storeFullContent).not.toHaveBeenCalled();
  });

  it("truncates and stores full content when over limit with sessionId", () => {
    const chunk = "Long user prompt content with spaces, punctuation, and symbols !? ";
    const input = chunk
      .repeat(Math.ceil((MAX_TEXT_CONTENT_LENGTH + 500) / chunk.length))
      .slice(0, MAX_TEXT_CONTENT_LENGTH + 500);
    const output = sanitizeTextContent(input, "unit-test", "session-2");

    expect(storeFullContent).toHaveBeenCalledTimes(1);
    expect(storeFullContent).toHaveBeenCalledWith(
      "session-2",
      "unit-test",
      input,
      MAX_TEXT_CONTENT_LENGTH
    );
    expect(output.length).toBeGreaterThan(MAX_TEXT_CONTENT_LENGTH);
    expect(output).toContain("CONTENT TRUNCATED");
    expect(output).toContain("75,000");
    expect(output).toContain('contentId="trunc_test_123"');
  });

  it("truncates with fallback notice when sessionId is missing", () => {
    const chunk = "Another long content block with natural language and spaces. ";
    // Use +500 buffer to account for .trim() inside stripFakeToolCallJson
    const input = chunk
      .repeat(Math.ceil((MAX_TEXT_CONTENT_LENGTH + 500) / chunk.length))
      .slice(0, MAX_TEXT_CONTENT_LENGTH + 500);
    const output = sanitizeTextContent(input, "unit-test");

    expect(storeFullContent).not.toHaveBeenCalled();
    expect(output).toContain("[Content truncated at 75,000 chars - sessionId not available for full content retrieval]");
  });

  it("strips inline data-url image payloads without replacing the whole text", () => {
    const base64 = "A".repeat(1200);
    const input = `Plan:\n![diagram](data:image/png;base64,${base64})\nKeep the numbered steps below.`;

    const output = sanitizeTextContent(input, "unit-test");

    expect(output).toContain("Plan:");
    expect(output).toContain(BASE64_IMAGE_PLACEHOLDER);
    expect(output).toContain("Keep the numbered steps below.");
    expect(output).not.toBe(BASE64_IMAGE_PLACEHOLDER);
  });

  it("strips inline base64 data URL but does not collapse entire text", () => {
    const input = `data:image/png;base64,${"A".repeat(6000)}`;
    const output = sanitizeTextContent(input, "unit-test");
    // The inline regex strips the data URL, leaving just the placeholder
    expect(output).toContain(BASE64_IMAGE_PLACEHOLDER);
  });
});

describe("no false-positive base64 detection on text", () => {
  it("preserves long code blocks", () => {
    const code = `function processMessage(content: string): string {\n  const sanitized = content.replace(/[<>]/g, "");\n  if (sanitized.length > MAX_LENGTH) {\n    console.warn("Content too long:", sanitized.length);\n    return sanitized.slice(0, MAX_LENGTH);\n  }\n  return sanitized;\n}\n`;
    const input = code.repeat(Math.ceil(6000 / code.length));
    expect(input.length).toBeGreaterThan(5000);
    const output = sanitizeTextContent(input, "unit-test");
    expect(output).not.toBe(BASE64_IMAGE_PLACEHOLDER);
    expect(output).toContain("processMessage");
  });

  it("preserves long markdown documents", () => {
    const md = `## Plan\n\nExtract and fix the function:\n\n\`\`\`typescript\nexport function check(text: string): boolean {\n  return text.includes("data:image/");\n}\n\`\`\`\n\n- Update consumers\n- Remove duplicates\n`;
    const input = md.repeat(Math.ceil(6000 / md.length));
    expect(input.length).toBeGreaterThan(5000);
    const output = sanitizeTextContent(input, "unit-test");
    expect(output).not.toBe(BASE64_IMAGE_PLACEHOLDER);
    expect(output).toContain("## Plan");
  });

  it("preserves long JSON payloads", () => {
    const json = JSON.stringify({
      messages: Array.from({ length: 100 }, (_, i) => ({
        id: `msg_${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} with technical content about APIs and functions.`,
      })),
    });
    const output = sanitizeTextContent(json, "unit-test");
    expect(output).not.toBe(BASE64_IMAGE_PLACEHOLDER);
    expect(output).toContain("msg_0");
  });

  it("preserves raw alphanumeric strings (not base64)", () => {
    const input = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".repeat(100);
    expect(input.length).toBeGreaterThan(5000);
    const output = sanitizeTextContent(input, "unit-test");
    expect(output).toBe(input);
  });
});

describe("normalizeReadFileInputArgs", () => {
  it("drops head/tail when line range is present", () => {
    const { normalizedArgs, droppedSelectors } = normalizeReadFileInputArgs({
      filePath: "foo.ts",
      startLine: 10,
      endLine: 20,
      head: 5,
      tail: 5,
    });

    expect(normalizedArgs).toEqual({
      filePath: "foo.ts",
      startLine: 10,
      endLine: 20,
    });
    expect(droppedSelectors).toEqual(expect.arrayContaining(["head", "tail"]));
  });

  it("drops non-finite selector values", () => {
    const { normalizedArgs, droppedSelectors } = normalizeReadFileInputArgs({
      filePath: "foo.ts",
      head: Number.POSITIVE_INFINITY,
      tail: Number.NaN,
    });

    expect(normalizedArgs).toEqual({ filePath: "foo.ts" });
    expect(droppedSelectors).toEqual(expect.arrayContaining(["head", "tail"]));
  });
});

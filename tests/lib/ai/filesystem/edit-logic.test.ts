import { describe, expect, it } from "vitest";
import { applyFileEdits } from "@/lib/ai/filesystem/edit-logic";

describe("applyFileEdits", () => {
  it("handles exact match", () => {
    const content = `function hello() {
  console.log("world");
}`;
    const oldString = `console.log("world");`;
    const newString = `console.log("universe");`;

    const result = applyFileEdits(content, [{ oldString, newString }]);
    expect(result.success).toBe(true);
    expect(result.newContent).toContain(`console.log("universe");`);
  });

  it("handles indentation mismatch (fuzzy match)", () => {
    const content = `function hello() {
  console.log("world");
}`;
    const oldString = `    console.log("world");`; // 4 spaces
    const newString = `    console.log("universe");`;

    const result = applyFileEdits(content, [{ oldString, newString }]);
    expect(result.success).toBe(true);
    // Should preserve original 2 space indentation
    expect(result.newContent).toContain(`  console.log("universe");`);
  });

  it("handles multi-line indentation mismatch", () => {
    const content = `if (true) {
    doSomething();
    doSomethingElse();
}`;
    const oldString = `doSomething();
doSomethingElse();`; // No indentation
    const newString = `doNewThing();
doNewThingElse();`;

    const result = applyFileEdits(content, [{ oldString, newString }]);
    expect(result.success).toBe(true);
    // Should have 4 spaces indentation
    expect(result.newContent).toContain(`    doNewThing();`);
    expect(result.newContent).toContain(`    doNewThingElse();`);
  });

  it("counts only materially changed lines within a larger exact replacement block", () => {
    const content = `line1
line2
line3
line4
line5
line6
line7`;
    const oldString = `line1
line2
line3
line4
line5
line6`;
    const newString = `line1
line2
LINE3
line4
line5
line6`;

    const result = applyFileEdits(content, [{ oldString, newString }]);

    expect(result.success).toBe(true);
    expect(result.linesChanged).toBe(1);
  });

  it("counts only materially changed lines within a larger fuzzy replacement block", () => {
    const content = `if (true) {
  line1
  line2
  line3
  line4
}`;
    const oldString = `    line1
    line2
    line3
    line4`;
    const newString = `    line1
    line2
    LINE3
    line4`;

    const result = applyFileEdits(content, [{ oldString, newString }]);

    expect(result.success).toBe(true);
    expect(result.linesChanged).toBe(1);
  });

  it("fails if oldString not found", () => {
    const content = `console.log("hello");`;
    const oldString = `console.log("world");`;
    const newString = `foo`;

    const result = applyFileEdits(content, [{ oldString, newString }]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not find oldString");
  });

  it("fails if multiple matches found", () => {
    const content = `
console.log("hello");
console.log("hello");
`;
    const oldString = `console.log("hello");`;
    const newString = `foo`;

    const result = applyFileEdits(content, [{ oldString, newString }]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("matches multiple locations");
  });

  describe("CRLF line ending preservation", () => {
    it("preserves CRLF line endings after exact match edit", () => {
      const content = "function hello() {\r\n  console.log(\"world\");\r\n}\r\n";
      const oldString = `console.log("world");`;
      const newString = `console.log("universe");`;

      const result = applyFileEdits(content, [{ oldString, newString }]);
      expect(result.success).toBe(true);
      expect(result.newContent).toContain("\r\n");
      expect(result.newContent).not.toMatch(/(?<!\r)\n/); // no bare \n
      expect(result.newContent).toContain(`console.log("universe");`);
    });

    it("preserves CRLF line endings after fuzzy match edit", () => {
      const content = "function hello() {\r\n  console.log(\"world\");\r\n}\r\n";
      const oldString = `    console.log("world");`; // different indentation
      const newString = `    console.log("universe");`;

      const result = applyFileEdits(content, [{ oldString, newString }]);
      expect(result.success).toBe(true);
      expect(result.newContent).toContain("\r\n");
      expect(result.newContent).not.toMatch(/(?<!\r)\n/);
    });

    it("keeps LF-only endings for LF files", () => {
      const content = "function hello() {\n  console.log(\"world\");\n}\n";
      const oldString = `console.log("world");`;
      const newString = `console.log("universe");`;

      const result = applyFileEdits(content, [{ oldString, newString }]);
      expect(result.success).toBe(true);
      expect(result.newContent).not.toContain("\r\n");
    });

    it("matches CRLF content against LF oldString (cross-platform edit)", () => {
      const content = "import { foo } from \"bar\";\r\nimport { baz } from \"qux\";\r\n";
      const oldString = "import { foo } from \"bar\";"; // LF-only (typical LLM output)
      const newString = "import { foo, extra } from \"bar\";";

      const result = applyFileEdits(content, [{ oldString, newString }]);
      expect(result.success).toBe(true);
      expect(result.newContent).toContain("\r\n");
      expect(result.newContent).toContain("import { foo, extra } from \"bar\";");
    });

    it("handles multi-line replacement preserving CRLF", () => {
      const content = "line1\r\nline2\r\nline3\r\nline4\r\n";
      const oldString = "line2\nline3"; // LF in oldString
      const newString = "newLine2\nnewLine3\nnewLine3b"; // adds a line

      const result = applyFileEdits(content, [{ oldString, newString }]);
      expect(result.success).toBe(true);
      expect(result.newContent).toBe("line1\r\nnewLine2\r\nnewLine3\r\nnewLine3b\r\nline4\r\n");
    });
  });
});

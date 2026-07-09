import { describe, expect, it } from "vitest";
import { isMarkdownFile, stripReadFileLineNumbers } from "@/lib/markdown/file-preview";

describe("markdown file preview utilities", () => {
  describe("isMarkdownFile", () => {
    it("detects markdown file extensions", () => {
      expect(isMarkdownFile("notes.md")).toBe(true);
      expect(isMarkdownFile("README.MD")).toBe(true);
      expect(isMarkdownFile("docs/guide.markdown")).toBe(true);
    });

    it("detects markdown language labels", () => {
      expect(isMarkdownFile("untitled", "markdown")).toBe(true);
      expect(isMarkdownFile(undefined, "md")).toBe(true);
    });

    it("rejects non-markdown paths and languages", () => {
      expect(isMarkdownFile("notes.txt", "text")).toBe(false);
      expect(isMarkdownFile("component.tsx", "tsx")).toBe(false);
      expect(isMarkdownFile()).toBe(false);
    });
  });

  describe("stripReadFileLineNumbers", () => {
    it("removes readFile line-number prefixes without changing markdown content", () => {
      const lineNumbered = [
        "   1 | # Heading",
        "   2 | ",
        "   3 | - item",
        "1000 | ```ts",
        "1001 | const value = 1;",
        "1002 | ```",
      ].join("\n");

      expect(stripReadFileLineNumbers(lineNumbered)).toBe([
        "# Heading",
        "",
        "- item",
        "```ts",
        "const value = 1;",
        "```",
      ].join("\n"));
    });
  });
});

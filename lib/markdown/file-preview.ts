const MARKDOWN_FILE_EXTENSION_RE = /\.(?:md|markdown)$/i;
const MARKDOWN_LANGUAGE_RE = /^(?:md|markdown)$/i;

/**
 * Returns true for Markdown file paths or language labels used by file tools.
 */
export function isMarkdownFile(filePath?: string | null, language?: string | null): boolean {
  const normalizedPath = filePath?.trim() ?? "";
  const normalizedLanguage = language?.trim() ?? "";

  return (
    MARKDOWN_FILE_EXTENSION_RE.test(normalizedPath) ||
    MARKDOWN_LANGUAGE_RE.test(normalizedLanguage)
  );
}

/**
 * readFile returns text with fixed-width line numbers (`   1 | content`).
 * Markdown preview needs the document body without that UI-only prefix.
 */
export function stripReadFileLineNumbers(content: string): string {
  return content.replace(/^\s*\d+\s\|\s?/gm, "");
}

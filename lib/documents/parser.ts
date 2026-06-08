import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { extname, join, relative } from "path";
import { pathToFileURL } from "url";

import { isAudioMimeType, transcribeAudio } from "@/lib/audio/transcription";
import { loadPdfParseRuntime } from "./pdf-parse-runtime";

import { DocumentErrorCode, DocumentProcessingError } from "./errors";
import {
  runDocling,
  listFilesRecursive,
  cleanupTempPaths,
  createDoclingWorkDir,
} from "./docling-runner";

type SupportedDocumentFormat =
  | "pdf"
  | "markdown"
  | "html"
  | "text"
  | "docx"
  | "pptx"
  | "xlsx"
  | "csv"
  | "vtt"
  | "xml_jats"
  | "audio";

type DocumentExtractionMethod =
  | "plain-text"
  | "html"
  | "markdown"
  | "pdf-parse"
  | "docling"
  | "audio-stt";

type DocumentSourceType = "upload" | "synced-file" | "chat-attachment" | "delegated";

interface ParsedDocument {
  format: SupportedDocumentFormat;
  text: string;
  pageCount?: number;
  extractionMethod: DocumentExtractionMethod;
  markdown?: string;
  warnings?: string[];
  metadata?: Record<string, unknown>;
}

type DocumentFormatConfig = {
  format: SupportedDocumentFormat;
  extractor: "pdf" | "markdown" | "html" | "text" | "docling" | "audio";
  contentTypes: string[];
  extensions: string[];
  doclingInputFormat?: "xml_jats";
};

const DOCUMENT_FORMAT_CONFIGS: DocumentFormatConfig[] = [
  {
    format: "pdf",
    extractor: "pdf",
    contentTypes: ["application/pdf"],
    extensions: [".pdf"],
  },
  {
    format: "markdown",
    extractor: "markdown",
    contentTypes: ["text/markdown", "text/x-markdown"],
    extensions: [".md", ".markdown"],
  },
  {
    format: "html",
    extractor: "html",
    contentTypes: ["text/html", "application/xhtml+xml"],
    extensions: [".html", ".htm"],
  },
  {
    format: "docx",
    extractor: "docling",
    contentTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    extensions: [".docx"],
  },
  {
    format: "pptx",
    extractor: "docling",
    contentTypes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    extensions: [".pptx"],
  },
  {
    format: "xlsx",
    extractor: "docling",
    contentTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    extensions: [".xlsx"],
  },
  {
    format: "csv",
    extractor: "text",
    contentTypes: ["text/csv", "application/csv", "text/comma-separated-values"],
    extensions: [".csv"],
  },
  {
    format: "vtt",
    extractor: "docling",
    contentTypes: ["text/vtt"],
    extensions: [".vtt"],
  },
  {
    format: "xml_jats",
    extractor: "docling",
    contentTypes: ["application/xml+jats", "application/jats+xml"],
    extensions: [".jats.xml"],
    doclingInputFormat: "xml_jats",
  },
  {
    format: "text",
    extractor: "text",
    contentTypes: [
      "text/plain",
      "application/json",
      "text/javascript",
      "text/typescript",
      "text/x-python",
      "text/css",
      "application/x-sh",
      "text/xml",
      "application/xml",
      "application/x-yaml",
      "text/x-log",
    ],
    extensions: [
      ".txt",
      ".text",
      ".json",
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".py",
      ".css",
      ".sql",
      ".log",
      ".yaml",
      ".yml",
      ".sh",
      ".bat",
      ".xml",
      ".rst",
      ".tex",
    ],
  },
];

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".webm",
  ".ogg",
  ".oga",
  ".flac",
  ".aac",
]);

const UNSUPPORTED_EXTENSION_MESSAGES: Record<string, { message: string; suggestedAction?: string }> = {
  ".xls": {
    message: "Legacy Excel .xls is not supported yet.",
    suggestedAction: "Save the workbook as .xlsx and retry.",
  },
  ".doc": {
    message: "Legacy Word .doc is not supported yet.",
    suggestedAction: "Save the document as .docx and retry.",
  },
  ".ppt": {
    message: "Legacy PowerPoint .ppt is not supported yet.",
    suggestedAction: "Save the presentation as .pptx and retry.",
  },
};

function normalizeContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function looksLikeJatsXml(buffer: Buffer): boolean {
  const preview = buffer.subarray(0, 8192).toString("utf8").toLowerCase();
  return preview.includes("<article") && (preview.includes("jats") || preview.includes("<front") || preview.includes("<!doctype article"));
}

function getConfigByFormat(format: SupportedDocumentFormat): DocumentFormatConfig {
  const config = DOCUMENT_FORMAT_CONFIGS.find((entry) => entry.format === format);
  if (!config) {
    throw new Error(`Unsupported document format config: ${format}`);
  }
  return config;
}

function detectFormat(
  contentType: string,
  filename: string,
  sourceType: DocumentSourceType,
  buffer: Buffer,
): DocumentFormatConfig {
  const lowerType = normalizeContentType(contentType);
  const lowerFilename = filename.toLowerCase();
  const ext = extname(lowerFilename);

  if (isAudioMimeType(lowerType) || AUDIO_EXTENSIONS.has(ext)) {
    return {
      format: "audio",
      extractor: "audio",
      contentTypes: [lowerType],
      extensions: ext ? [ext] : [],
    };
  }

  const unsupported = UNSUPPORTED_EXTENSION_MESSAGES[ext];
  if (unsupported) {
    throw new DocumentProcessingError(
      DocumentErrorCode.UNSUPPORTED_DOCUMENT_FORMAT,
      unsupported.message,
      filename,
      unsupported.suggestedAction,
    );
  }

  if (
    lowerType.includes("jats") ||
    lowerFilename.endsWith(".jats.xml") ||
    (ext === ".xml" && looksLikeJatsXml(buffer))
  ) {
    return getConfigByFormat("xml_jats");
  }

  if (ext === ".xml" && sourceType !== "synced-file") {
    throw new DocumentProcessingError(
      DocumentErrorCode.UNSUPPORTED_DOCUMENT_FORMAT,
      "Generic XML uploads are not supported yet.",
      filename,
      "Use a supported XML family such as JATS XML, or convert the file to Markdown, HTML, or TXT.",
    );
  }

  const byType = DOCUMENT_FORMAT_CONFIGS.find((config) => config.contentTypes.includes(lowerType));
  if (byType) {
    return byType;
  }

  const byExt = DOCUMENT_FORMAT_CONFIGS.find((config) => config.extensions.includes(ext));
  if (byExt) {
    return byExt;
  }

  return getConfigByFormat("text");
}

function ensureNonEmptyExtraction(text: string, filename: string, suggestedAction?: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    throw new DocumentProcessingError(
      DocumentErrorCode.EMPTY_DOCUMENT_EXTRACTION,
      "The document was processed but no readable text was found.",
      filename,
      suggestedAction,
    );
  }
  return normalized;
}

function summarizeCommandOutput(value: string | undefined, maxLength = 500): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}

/**
 * Extract text from a document buffer, routing to the right extractor per file type.
 */
export async function extractTextFromDocument(
  buffer: Buffer,
  contentType: string,
  filename: string,
  sourceType: DocumentSourceType = "upload",
): Promise<ParsedDocument> {
  const config = detectFormat(contentType, filename, sourceType, buffer);

  switch (config.extractor) {
    case "pdf": {
      const { text, pageCount } = await extractFromPdf(buffer, filename);
      return {
        format: config.format,
        text: ensureNonEmptyExtraction(
          text,
          filename,
          "Try a different PDF export or verify the file is not encrypted.",
        ),
        pageCount,
        extractionMethod: "pdf-parse",
      };
    }
    case "markdown": {
      const text = ensureNonEmptyExtraction(normalizeMarkdown(buffer.toString("utf8")), filename);
      return { format: config.format, text, extractionMethod: "markdown" };
    }
    case "html": {
      const text = ensureNonEmptyExtraction(extractTextFromHtml(buffer.toString("utf8")), filename);
      return { format: config.format, text, extractionMethod: "html" };
    }
    case "audio": {
      const transcription = await transcribeAudio(buffer, contentType, filename);
      const text = ensureNonEmptyExtraction(
        transcription.text,
        filename,
        "Try re-recording the audio or check your configured speech-to-text provider.",
      );
      return {
        format: "audio",
        text,
        extractionMethod: "audio-stt",
        metadata: {
          provider: transcription.provider,
          durationSeconds: transcription.durationSeconds,
          language: transcription.language,
          sourceType,
        },
      };
    }
    case "docling": {
      return extractWithDocling({
        buffer,
        filename,
        format: config.format,
        doclingInputFormat: config.doclingInputFormat,
        sourceType,
      });
    }
    case "text":
    default: {
      const text = ensureNonEmptyExtraction(buffer.toString("utf8"), filename);
      return { format: config.format, text, extractionMethod: "plain-text" };
    }
  }
}

async function extractWithDocling(params: {
  buffer: Buffer;
  filename: string;
  format: SupportedDocumentFormat;
  doclingInputFormat?: "xml_jats";
  sourceType: DocumentSourceType;
}): Promise<ParsedDocument> {
  const { workDir, outputDir } = await createDoclingWorkDir();
  const inputPath = join(workDir, `input${extname(params.filename) || ".bin"}`);
  await writeFile(inputPath, params.buffer);

  try {
    const result = await runDocling({
      inputPath,
      outputDir,
      doclingInputFormat: params.doclingInputFormat,
    });

    if (result.error) {
      throw new DocumentProcessingError(
        DocumentErrorCode.DOCLING_NOT_AVAILABLE,
        `Docling is not available: ${result.error}`,
        params.filename,
        "Install uv and ensure `uv tool run --from docling docling --help` works on this machine.",
      );
    }

    const absoluteOutputFiles = await listFilesRecursive(outputDir).catch(() => []);
    const markdownFile = absoluteOutputFiles.find((filePath) => filePath.endsWith(".md"));

    if (result.exitCode !== 0 || !markdownFile) {
      const stderr = summarizeCommandOutput(result.stderr) || "Docling could not extract readable content from this document.";
      throw new DocumentProcessingError(
        DocumentErrorCode.DOCLING_EXTRACTION_FAILED,
        stderr,
        params.filename,
        "Verify the file is not corrupted, password protected, or exported in a legacy format.",
      );
    }

    const markdown = await readFile(markdownFile, "utf8");
    const text = ensureNonEmptyExtraction(
      normalizeMarkdown(markdown),
      params.filename,
      "The file converted successfully, but no usable text was found.",
    );

    const warnings: string[] = [];
    if (params.format === "pptx" && text.length < 80) {
      warnings.push("Presentation converted with limited text; slides may be mostly graphical.");
    }
    if (params.format === "xlsx" && text.length < 80) {
      warnings.push("Spreadsheet converted with limited text; sheets may be mostly empty or formatting-only.");
    }

    return {
      format: params.format,
      text,
      markdown,
      extractionMethod: "docling",
      warnings: warnings.length > 0 ? warnings : undefined,
      metadata: {
        sourceType: params.sourceType,
        outputFiles: absoluteOutputFiles.map((filePath) => relative(outputDir, filePath)),
        stderr: summarizeCommandOutput(result.stderr),
        stdout: summarizeCommandOutput(result.stdout),
      },
    };
  } finally {
    await cleanupTempPaths([workDir]);
  }
}

async function extractFromPdf(
  buffer: Buffer,
  filename: string,
): Promise<{ text: string; pageCount?: number }> {
  // Polyfill DOM APIs that pdfjs-dist expects but don't exist in Node.js.
  // These are only used for rendering; text extraction works without real
  // implementations, so stub classes are sufficient.
  if (typeof globalThis.DOMMatrix === "undefined") {
    (globalThis as any).DOMMatrix = class DOMMatrix {
      m11 = 1; m12 = 0; m13 = 0; m14 = 0;
      m21 = 0; m22 = 1; m23 = 0; m24 = 0;
      m31 = 0; m32 = 0; m33 = 1; m34 = 0;
      m41 = 0; m42 = 0; m43 = 0; m44 = 1;
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      is2D = true;
      isIdentity = true;
      inverse() { return new DOMMatrix(); }
      multiply() { return new DOMMatrix(); }
      scale() { return new DOMMatrix(); }
      translate() { return new DOMMatrix(); }
      transformPoint<T>(point: T) { return point; }
      toFloat32Array() { return new Float32Array(16); }
      toFloat64Array() { return new Float64Array(16); }
    };
  }

  if (typeof globalThis.Path2D === "undefined") {
    (globalThis as any).Path2D = class Path2D {
      addPath() {}
      closePath() {}
      moveTo() {}
      lineTo() {}
      bezierCurveTo() {}
      quadraticCurveTo() {}
      arc() {}
      arcTo() {}
      ellipse() {}
      rect() {}
    };
  }

  try {
    const pdfModule = await loadPdfParseRuntime();
    const PDFParse = (pdfModule as { PDFParse?: new (options: { data: Buffer }) => any }).PDFParse;

    if (typeof PDFParse === "function") {
      const PDFParseWithWorker = PDFParse as typeof PDFParse & {
        setWorker?: (workerPath: string) => void;
      };

      if (typeof PDFParseWithWorker.setWorker === "function") {
        const workerPath = join(
          process.cwd(),
          "node_modules",
          "pdfjs-dist",
          "legacy",
          "build",
          "pdf.worker.mjs",
        );
        if (existsSync(workerPath)) {
          PDFParseWithWorker.setWorker(pathToFileURL(workerPath).href);
        }
      }

      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        const rawText: string = result.text ?? "";
        const normalized = rawText.replace(/\r\n/g, "\n").trim();
        const pageCount = typeof result.total === "number" ? result.total : undefined;
        return { text: normalized, pageCount };
      } finally {
        if (typeof parser.destroy === "function") {
          await parser.destroy();
        }
      }
    }

    const pdfParse = (pdfModule as unknown as { default?: (data: Buffer) => Promise<any> }).default
      ?? (pdfModule as unknown as (data: Buffer) => Promise<any>);
    if (typeof pdfParse !== "function") {
      throw new Error("Unsupported pdf-parse export shape.");
    }

    const result = await pdfParse(buffer);
    const rawText: string = result.text ?? "";
    const normalized = rawText.replace(/\r\n/g, "\n").trim();
    const pageCount: number | undefined =
      typeof result.numpages === "number"
        ? result.numpages
        : typeof result.numPages === "number"
          ? result.numPages
          : undefined;

    return { text: normalized, pageCount };
  } catch (error) {
    console.error("PDF parsing error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    throw new DocumentProcessingError(
      DocumentErrorCode.PDF_PARSE_FAILED,
      `Failed to parse PDF document: ${errorMessage}. This may be due to a corrupted, encrypted, or incompatible PDF file.`,
      filename,
      "Try a different PDF export or verify the file is not encrypted.",
    );
  }
}

function normalizeMarkdown(markdown: string): string {
  let text = markdown.replace(/^---[\s\S]*?---\s*/u, "");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/```[\s\S]*?```/g, "");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function extractTextFromHtml(html: string): string {
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  text = text.replace(/\s+/g, " ");
  return text.trim();
}

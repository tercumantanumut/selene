const DOCUMENT_UPLOAD_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".csv",
  ".txt",
  ".vtt",
  ".xml",
] as const;

const DOCUMENT_UPLOAD_ACCEPT = DOCUMENT_UPLOAD_EXTENSIONS.join(",");

export const CHAT_ATTACHMENT_ACCEPT = [
  "image/*",
  DOCUMENT_UPLOAD_ACCEPT,
  "audio/*",
].join(",");

const DOCUMENT_SUPPORT_LABELS = [
  "PDF",
  "DOCX",
  "PPTX",
  "XLSX",
  "Markdown",
  "HTML",
  "CSV",
  "TXT",
  "VTT",
  "JATS XML",
] as const;

const CHAT_ATTACHMENT_SUPPORT_LABELS = [
  ...DOCUMENT_SUPPORT_LABELS,
  "audio attachments",
  "images",
] as const;

const UNSUPPORTED_ATTACHMENT_EXTENSION_HINTS: Record<string, string> = {
  ".xls": "Legacy Excel .xls is not supported yet. Save the workbook as .xlsx and try again.",
  ".doc": "Legacy Word .doc is not supported yet. Save the document as .docx and try again.",
  ".ppt": "Legacy PowerPoint .ppt is not supported yet. Save the presentation as .pptx and try again.",
};

const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".csv",
  ".txt",
  ".vtt",
  ".xml",
]);

const TYPE_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "text/markdown": "MD",
  "text/x-markdown": "MD",
  "text/html": "HTML",
  "application/xhtml+xml": "HTML",
  "text/csv": "CSV",
  "application/csv": "CSV",
  "text/plain": "TXT",
  "text/vtt": "VTT",
  "application/xml+jats": "JATS XML",
  "application/jats+xml": "JATS XML",
};

function normalizeContentType(contentType: string | undefined): string {
  return contentType?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function getFileExtension(filename: string | undefined): string {
  if (!filename) return "";
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
}

export function getDocumentTypeLabel(contentType: string | undefined, filename?: string): string {
  const normalizedType = normalizeContentType(contentType);
  if (normalizedType.startsWith("audio/")) return "AUDIO";
  if (TYPE_LABELS[normalizedType]) return TYPE_LABELS[normalizedType];

  const ext = getFileExtension(filename);
  if (ext === ".md" || ext === ".markdown") return "MD";
  if (ext === ".xml") return "XML";
  if (ext) return ext.slice(1).toUpperCase();

  const subtype = normalizedType.split("/")[1];
  return subtype ? subtype.toUpperCase() : "FILE";
}

export function getUnsupportedAttachmentHint(filename: string): string | null {
  return UNSUPPORTED_ATTACHMENT_EXTENSION_HINTS[getFileExtension(filename)] ?? null;
}

export function isImageAttachment(contentType: string | undefined): boolean {
  return normalizeContentType(contentType).startsWith("image/");
}

function isAudioAttachment(contentType: string | undefined): boolean {
  return normalizeContentType(contentType).startsWith("audio/");
}

export function isSupportedDocumentAttachment(contentType: string | undefined, filename: string): boolean {
  if (isImageAttachment(contentType) || isAudioAttachment(contentType)) {
    return true;
  }

  const normalizedType = normalizeContentType(contentType);
  if (TYPE_LABELS[normalizedType]) {
    return true;
  }

  return SUPPORTED_DOCUMENT_EXTENSIONS.has(getFileExtension(filename));
}

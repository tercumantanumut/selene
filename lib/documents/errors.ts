// lib/documents/errors.ts

export enum DocumentErrorCode {
  PDF_PARSE_FAILED = "PDF_PARSE_FAILED",
  DOCLING_NOT_AVAILABLE = "DOCLING_NOT_AVAILABLE",
  DOCLING_EXTRACTION_FAILED = "DOCLING_EXTRACTION_FAILED",
  UNSUPPORTED_DOCUMENT_FORMAT = "UNSUPPORTED_DOCUMENT_FORMAT",
  EMPTY_DOCUMENT_EXTRACTION = "EMPTY_DOCUMENT_EXTRACTION",
}

export class DocumentProcessingError extends Error {
  public readonly code: DocumentErrorCode;
  public readonly filePath?: string;
  public readonly suggestedAction?: string;

  constructor(
    code: DocumentErrorCode,
    message: string,
    filePath?: string,
    suggestedAction?: string,
  ) {
    super(message);
    this.name = "DocumentProcessingError";
    this.code = code;
    this.filePath = filePath;
    this.suggestedAction = suggestedAction;
  }
}

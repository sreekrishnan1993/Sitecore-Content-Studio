import type { ExtractionErrorBody, ExtractionResult, SourceFileType } from "../../types/extraction";

export interface ExtractionInput {
  bytes: Uint8Array;
  fileName: string;
  sourceUrl?: string;
}

/** A document parser. Implementations must run server-side and never execute document content. */
export interface DocumentExtractionProvider {
  id: string;
  fileType: SourceFileType;
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

export type ExtractionErrorCode = ExtractionErrorBody["error"]["code"];

export class ExtractionError extends Error {
  constructor(
    public readonly code: ExtractionErrorCode,
    message: string,
    public readonly status = 422,
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

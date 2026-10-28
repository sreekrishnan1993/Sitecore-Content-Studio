// Shared extraction model used by the server-side extraction pipeline and the Content Studio UI.

export type SourceFileType = "pdf" | "docx" | "html";

export type ContentType =
  | "headline"
  | "subheading"
  | "summary"
  | "body"
  | "list"
  | "quote"
  | "statistic"
  | "cta"
  | "caption"
  | "seo"
  | "link";

/**
 * Where a piece of content came from.
 * - extracted: verbatim text found in the source document.
 * - derived: deterministically produced from extracted text (e.g. a truncated SEO description).
 * - ai-suggestion: produced by an AI provider. Never presented as source text.
 * - manual: written by the author in the whiteboard.
 */
export type ContentOrigin = "extracted" | "derived" | "ai-suggestion" | "manual";

export interface SourceRef {
  /** 1-based page number (PDF only). */
  page?: number;
  /** Human readable location, e.g. "Paragraph 4" or "<h2> heading". */
  location?: string;
  /** The exact source text this block was taken from, when it differs from `text`. */
  sourceText?: string;
}

/** One item of a list block. Items are edited individually; `level` 0 is the top level. */
export interface ListItem {
  text: string;
  level: number;
}

export interface ExtractedBlock {
  id: string;
  type: ContentType;
  text: string;
  origin: ContentOrigin;
  source?: SourceRef;
  /** Optional sub-label, e.g. "Meta title" for SEO blocks. */
  label?: string;
  /** Id of the block whose text contains this one (e.g. a statistic inside a body paragraph). */
  containedIn?: string;
  /** Speaker attribution for quotes, only when it is present in the source text. */
  attribution?: string;
  /** Target URL for link and CTA blocks. */
  href?: string;
  /**
   * 0–1 confidence of the structural classification (heuristic, not a probability), or a score
   * reported by a provider. Low values mean the role is uncertain and should be checked.
   */
  confidence?: number;
  /** Why the block got its type, e.g. ["entirely bold", "first element of the document"]. */
  evidence?: string[];
  /** List blocks: the items, in order. `text` holds the same items, one per line. */
  items?: ListItem[];
  /** List blocks: true for numbered lists, when the source says so. */
  ordered?: boolean;
  /** Section the block belongs to (increments at each title or heading). */
  section?: number;
}

export interface ExtractedImage {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
  page?: number;
  /** Alt text found in the source (DOCX/HTML). Never invented. */
  sourceAltText?: string;
  /** Inline data URL (extracted images) or remote URL (publication images). */
  src: string;
  /** Extracted images come from the document; suggestions would be generated elsewhere. */
  origin: "extracted" | "referenced" | "ai-suggestion";
}

export interface DocumentMetadata {
  fileName: string;
  fileType: SourceFileType;
  fileSize: number;
  pageCount?: number;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  description?: string;
  createdAt?: string;
  modifiedAt?: string;
  sourceUrl?: string;
  wordCount: number;
}

export type WarningCode =
  | "scanned-document"
  | "no-text"
  | "images-truncated"
  | "image-skipped"
  | "parser-warning"
  | "metadata-unavailable"
  | "ai-unavailable";

export interface ExtractionWarning {
  code: WarningCode;
  message: string;
  page?: number;
}

export interface ExtractionResult {
  id: string;
  /** Identifier of the provider chain, e.g. "pdf:unpdf+heuristics". */
  provider: string;
  extractedAt: string;
  metadata: DocumentMetadata;
  blocks: ExtractedBlock[];
  images: ExtractedImage[];
  warnings: ExtractionWarning[];
  /** True only for bundled demo fixtures. Demo content must never be presented as uploaded content. */
  isSample: boolean;
}

export interface ExtractionErrorBody {
  error: {
    code:
      | "invalid-request"
      | "unsupported-type"
      | "file-too-large"
      | "empty-file"
      | "scanned-document"
      | "parse-failed"
      | "url-rejected"
      | "fetch-failed"
      | "unauthorized"
      | "auth-not-configured"
      | "forbidden-origin"
      | "rate-limited"
      | "busy"
      | "timeout"
      | "internal-error";
    message: string;
  };
}

export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  headline: "Headline",
  subheading: "Subheading",
  summary: "Summary",
  body: "Body text",
  list: "List",
  quote: "Executive quote",
  statistic: "Statistic",
  cta: "Call to action",
  caption: "Caption",
  seo: "SEO metadata",
  link: "Link",
};

export const CONTENT_TYPES = Object.keys(CONTENT_TYPE_LABELS) as ContentType[];

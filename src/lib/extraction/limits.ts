// Limits shared by the client (early validation) and the server (enforcement).
// The server reads overrides from environment variables; the client uses the defaults
// and the values reported by GET /api/extract.

export const DEFAULT_MAX_UPLOAD_MB = 15;
export const MAX_IMAGES_PER_DOCUMENT = 24;
export const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
export const MIN_IMAGE_DIMENSION = 48;
export const MAX_PDF_PAGES = 200;
export const MAX_IMAGE_SCAN_PAGES = 50;
/** pdf.js maxImageSize: images above this many pixels are not decoded (~25 megapixels). */
export const MAX_PDF_IMAGE_PIXELS = 25_000_000;
export const MAX_DOCX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
export const MAX_URL_RESPONSE_BYTES = 5 * 1024 * 1024;
export const URL_FETCH_TIMEOUT_MS = 10_000;

export const ACCEPTED_EXTENSIONS = [".pdf", ".docx"] as const;
export const ACCEPTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

/** Image formats browsers can display and that Sitecore Media Library accepts. */
export const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_MEDIA_IMAGE_BYTES = 10 * 1024 * 1024;

export function maxUploadBytes(): number {
  const raw = typeof process !== "undefined" ? process.env.CONTENT_STUDIO_MAX_UPLOAD_MB : undefined;
  const mb = raw ? Number(raw) : DEFAULT_MAX_UPLOAD_MB;
  return (Number.isFinite(mb) && mb > 0 ? Math.min(mb, 50) : DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024;
}

export function isUrlImportEnabled(): boolean {
  return process.env.CONTENT_STUDIO_ENABLE_URL_IMPORT !== "false";
}

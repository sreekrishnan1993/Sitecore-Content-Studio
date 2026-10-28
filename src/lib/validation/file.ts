import { ACCEPTED_EXTENSIONS, SUPPORTED_IMAGE_MIME_TYPES, MAX_MEDIA_IMAGE_BYTES } from "../extraction/limits";

export type DetectedFileType = "pdf" | "docx";

export type FileCheck = { ok: true; type: DetectedFileType } | { ok: false; code: "unsupported-type" | "file-too-large" | "empty-file"; message: string };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

/** Client-side pre-check based on name and size. The server re-validates using file signatures. */
export function checkFileBasics(name: string, size: number, maxBytes: number): FileCheck {
  const ext = extensionOf(name);
  if (ext === ".doc") {
    return { ok: false, code: "unsupported-type", message: "Legacy .doc files are not supported. Save the document as .docx and try again." };
  }
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, code: "unsupported-type", message: `"${name}" is not a supported file. Upload a PDF (.pdf) or Word (.docx) document.` };
  }
  if (size === 0) {
    return { ok: false, code: "empty-file", message: `"${name}" is empty.` };
  }
  if (size > maxBytes) {
    return { ok: false, code: "file-too-large", message: `"${name}" is ${formatBytes(size)}. The maximum size is ${formatBytes(maxBytes)}.` };
  }
  return { ok: true, type: ext === ".pdf" ? "pdf" : "docx" };
}

/** Detects the real file type from its leading bytes; extensions and MIME types are not trusted. */
export function sniffFileType(bytes: Uint8Array): DetectedFileType | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return "pdf"; // %PDF-
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return "docx"; // ZIP container; confirmed as DOCX by the DOCX provider.
  }
  return null;
}

export function checkMediaImage(mimeType: string, byteSize: number): string | null {
  if (!(SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return `${mimeType || "Unknown format"} is not supported for upload. Supported: PNG, JPEG, GIF, WebP.`;
  }
  if (byteSize > MAX_MEDIA_IMAGE_BYTES) {
    return `Image is ${formatBytes(byteSize)}; the upload limit is ${formatBytes(MAX_MEDIA_IMAGE_BYTES)}.`;
  }
  return null;
}

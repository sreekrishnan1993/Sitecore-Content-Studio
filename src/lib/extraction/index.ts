import "server-only";
import type { ExtractionResult } from "../types/extraction";
import { sniffFileType } from "../validation/file";
import { getContentEnhancer } from "./ai";
import { docxProvider } from "./providers/docx";
import { htmlProvider } from "./providers/html";
import { pdfProvider } from "./providers/pdf";
import { ExtractionError, type DocumentExtractionProvider } from "./providers/types";
import { downloadReferencedImages } from "./remote-images";
import { fetchPublication } from "./url-fetch";

export { ExtractionError } from "./providers/types";

const providers: Record<"pdf" | "docx" | "html", DocumentExtractionProvider> = {
  pdf: pdfProvider,
  docx: docxProvider,
  html: htmlProvider,
};

async function enhance(result: ExtractionResult): Promise<ExtractionResult> {
  const enhancer = getContentEnhancer();
  return enhancer ? enhancer.enhance(result) : result;
}

/** Extracts an uploaded file. The file type is taken from its signature, not its name or MIME type. */
export async function extractUploadedFile(bytes: Uint8Array, fileName: string): Promise<ExtractionResult> {
  if (bytes.byteLength === 0) throw new ExtractionError("empty-file", "The uploaded file is empty.", 400);
  const type = sniffFileType(bytes);
  if (!type) {
    throw new ExtractionError("unsupported-type", "The file content is not a PDF or Word (.docx) document.", 415);
  }
  const lower = fileName.toLowerCase();
  if ((type === "pdf" && !lower.endsWith(".pdf")) || (type === "docx" && !lower.endsWith(".docx"))) {
    throw new ExtractionError("unsupported-type", "The file extension does not match its content.", 415);
  }
  return enhance(await providers[type].extract({ bytes, fileName }));
}

export async function extractPublicationUrl(url: string): Promise<ExtractionResult> {
  const fetched = await fetchPublication(url);
  const sourceUrl = fetched.finalUrl.toString();
  const fileName = fetched.finalUrl.hostname + fetched.finalUrl.pathname;
  if (fetched.contentType === "application/pdf" || sniffFileType(fetched.bytes) === "pdf") {
    return enhance(await providers.pdf.extract({ bytes: fetched.bytes, fileName, sourceUrl }));
  }
  if (fetched.contentType === "text/html" || fetched.contentType === "application/xhtml+xml") {
    // Page images are downloaded so they can be uploaded to the Media Library like document images.
    return enhance(await downloadReferencedImages(await providers.html.extract({ bytes: fetched.bytes, fileName, sourceUrl })));
  }
  throw new ExtractionError("unsupported-type", `The URL returned "${fetched.contentType || "unknown content"}". Only HTML pages and PDFs can be imported.`, 415);
}

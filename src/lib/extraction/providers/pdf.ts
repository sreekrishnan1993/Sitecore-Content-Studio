import { createHash } from "node:crypto";
import { extractImages, extractLinks, extractTextItems, getDocumentProxy, getMeta, type StructuredTextItem } from "unpdf";
import type { ExtractedImage, ExtractionResult, ExtractionWarning } from "../../types/extraction";
import { createId } from "../../utils/id";
import { buildContentBlocks } from "../classify";
import type { SourceElement, SourceLink } from "../structure/model";
import { encodePng, toDataUrl } from "../images";
import { MAX_IMAGE_SCAN_PAGES, MAX_IMAGES_PER_DOCUMENT, MAX_PDF_IMAGE_PIXELS, MAX_PDF_PAGES, MAX_TOTAL_IMAGE_BYTES, MIN_IMAGE_DIMENSION } from "../limits";
import { countWords } from "../text";
import { ExtractionError, type DocumentExtractionProvider, type ExtractionInput } from "./types";

interface Line {
  text: string;
  y: number;
  left: number;
  right: number;
  fontSize: number;
}

function buildLines(items: StructuredTextItem[]): Line[] {
  const lines: Line[] = [];
  let current: Line | null = null;
  for (const item of items) {
    const str = item.str;
    if (current && str && Math.abs(item.y - current.y) > Math.max(2, current.fontSize * 0.5)) {
      lines.push(current);
      current = null;
    }
    if (str) {
      if (!current) current = { text: "", y: item.y, left: item.x, right: 0, fontSize: 0 };
      current.text += str;
      current.left = Math.min(current.left, item.x);
      current.right = Math.max(current.right, item.x + item.width);
      if (str.trim()) current.fontSize = Math.max(current.fontSize, Math.round(item.fontSize * 2) / 2);
    }
    if (item.hasEOL && current) {
      lines.push(current);
      current = null;
    }
  }
  if (current) lines.push(current);
  return lines.filter((l) => l.text.trim().length > 0);
}

const BULLET = /^([•◦▪▫●○■□‣⁃∙·–\-*])\s+(?=\S)/u;
const NUMBERED = /^((?:\d{1,3}|[a-zA-Z])[.)])\s+(?=\S)/;

/** A list marker at the start of a line, if any. */
export function listMarker(text: string): { marker: string; ordered: boolean; rest: string } | null {
  const bullet = BULLET.exec(text);
  if (bullet) return { marker: bullet[1], ordered: false, rest: text.slice(bullet[0].length) };
  const numbered = NUMBERED.exec(text);
  if (numbered) return { marker: numbered[1], ordered: true, rest: text.slice(numbered[0].length) };
  return null;
}

export interface PdfBlock {
  text: string;
  /** The block's text exactly as laid out, line by line (list marker included). */
  original: string;
  fontSize: number;
  left: number;
  marker?: string;
  ordered?: boolean;
}

/**
 * Layout-level assembly of lines into blocks: paragraphs by font size, vertical gaps and short
 * sentence-ending lines; list items by their leading bullet or number, with wrapped lines
 * (hanging indent, or no sentence end yet) kept inside their item.
 */
export function groupLines(lines: Line[]): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  const maxRight = Math.max(...lines.map((l) => l.right), 1);
  let prev: Line | null = null;
  for (const line of lines) {
    const text = line.text.trim();
    const last = blocks[blocks.length - 1];
    const marker = listMarker(text);
    let startNew = !prev || !last;
    if (prev && last) {
      const gap = prev.y - line.y;
      const sizeChanged = Math.abs(prev.fontSize - line.fontSize) > 0.6;
      const largeGap = gap < 0 || gap > Math.max(prev.fontSize, line.fontSize) * 1.75;
      if (marker) startNew = true;
      else if (last.marker) {
        // Inside a list item: a wrapped line is indented past the marker, or the item has not ended.
        const hanging = line.left > last.left + 2;
        startNew = sizeChanged || largeGap || !(hanging || !/[.!?]$/.test(prev.text.trim()));
      } else {
        const paragraphEnd = prev.right < maxRight * 0.75 && /[.!?:”"]$/.test(prev.text.trim());
        startNew = sizeChanged || largeGap || paragraphEnd;
      }
    }
    if (startNew || !last) {
      blocks.push({ text: marker ? marker.rest : text, original: text, fontSize: line.fontSize, left: line.left, marker: marker?.marker, ordered: marker?.ordered });
    } else {
      last.original += `\n${text}`;
      if (/[A-Za-z]-$/.test(last.text) && /^[a-z]/.test(text)) last.text = last.text.slice(0, -1) + text;
      else last.text = `${last.text} ${text}`;
    }
    prev = line;
  }
  return blocks;
}

/** Normalized elements for all pages. Bold is not reported: PDF text items carry no reliable weight. */
export function pdfElements(pageBlocks: PdfBlock[][]): SourceElement[] {
  const elements: SourceElement[] = [];
  let listCount = 0;
  let listId: string | null = null;
  let listLefts: number[] = [];
  pageBlocks.forEach((blocks, pageIndex) => {
    const page = pageIndex + 1;
    blocks.forEach((block, blockIndex) => {
      const base = {
        page,
        location: `Page ${page}, block ${blockIndex + 1}`,
        fontSize: block.fontSize,
        container: { type: "page" as const, id: `page-${page}` },
        ...(block.original !== block.text ? { sourceText: block.original } : {}),
      };
      if (!block.marker) {
        listId = null;
        elements.push({ ...base, text: block.text, kind: "paragraph" });
        return;
      }
      // Consecutive list items (also across a page break) form one list; indentation gives the level.
      if (!listId) {
        listId = `list-${++listCount}`;
        listLefts = [];
      }
      let level = listLefts.findIndex((l) => Math.abs(l - block.left) <= 3);
      if (level < 0) {
        listLefts = [...listLefts, block.left].sort((a, b) => a - b);
        level = listLefts.findIndex((l) => l === block.left);
      }
      elements.push({ ...base, text: block.text, kind: "list-item", list: { listId, level, ordered: block.ordered, marker: block.marker } });
    });
  });
  return elements;
}

function toIsoDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const pdfProvider: DocumentExtractionProvider = {
  id: "pdf:unpdf+heuristics",
  fileType: "pdf",
  async extract({ bytes, fileName, sourceUrl }: ExtractionInput): Promise<ExtractionResult> {
    const warnings: ExtractionWarning[] = [];
    let pdf;
    try {
      // pdf.js may transfer the buffer, so give it a copy. Scripts and XFA forms are never executed,
      // and decoded images are capped so a small file cannot expand into gigabytes of pixels.
      pdf = await getDocumentProxy(new Uint8Array(bytes), { enableXfa: false, maxImageSize: MAX_PDF_IMAGE_PIXELS, stopAtErrors: false });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "PasswordException") {
        throw new ExtractionError("parse-failed", "This PDF is password protected. Remove the password and upload it again.");
      }
      // Parser internals are logged server-side (no document content) and not returned to the client.
      console.warn(`Content Studio: PDF could not be opened (${name || "unknown error"})`);
      throw new ExtractionError("parse-failed", "The PDF could not be read. It may be damaged or use an unsupported format.");
    }

    try {
      if (pdf.numPages > MAX_PDF_PAGES) {
        throw new ExtractionError("parse-failed", `This PDF has ${pdf.numPages} pages. The maximum supported is ${MAX_PDF_PAGES}.`);
      }

      const { items } = await extractTextItems(pdf);
      const pageBlocks = items.map((pageItems) => groupLines(buildLines(pageItems)));
      const totalChars = pageBlocks.flat().reduce((sum, b) => sum + b.text.replace(/\s/g, "").length, 0);
      if (totalChars < 20) {
        throw new ExtractionError(
          "scanned-document",
          "No selectable text was found. This PDF appears to be scanned or image-only, and OCR is not configured for this installation.",
        );
      }

      pageBlocks.forEach((blocks, pageIndex) => {
        if (blocks.length === 0) {
          warnings.push({ code: "no-text", message: `Page ${pageIndex + 1} has no selectable text (it may be an image).`, page: pageIndex + 1 });
        }
      });
      // Layout signals only (font size, indentation, list markers); roles are decided downstream.
      const elements = pdfElements(pageBlocks);

      let info: Record<string, unknown> = {};
      try {
        info = (await getMeta(pdf, { parseDates: true })).info ?? {};
      } catch {
        warnings.push({ code: "metadata-unavailable", message: `Document properties could not be read.` });
      }

      const links: SourceLink[] = [];
      try {
        for (const href of (await extractLinks(pdf)).links) links.push({ href, location: "PDF link annotation" });
      } catch {
        warnings.push({ code: "parser-warning", message: `Link annotations could not be read.` });
      }

      const images = await extractPdfImages(pdf, warnings);
      const keywords = asText(info.Keywords);
      const blocks = buildContentBlocks({ elements, links }, { keywords });

      return {
        id: createId("ext"),
        provider: this.id,
        extractedAt: new Date().toISOString(),
        isSample: false,
        metadata: {
          fileName,
          fileType: "pdf",
          fileSize: bytes.byteLength,
          pageCount: pdf.numPages,
          title: asText(info.Title),
          author: asText(info.Author),
          subject: asText(info.Subject),
          keywords,
          createdAt: toIsoDate(info.CreationDate),
          modifiedAt: toIsoDate(info.ModDate),
          sourceUrl,
          wordCount: countWords(elements.map((e) => e.text).join(" ")),
        },
        blocks,
        images,
        warnings,
      };
    } finally {
      await pdf.loadingTask.destroy();
    }
  },
};

async function extractPdfImages(pdf: Awaited<ReturnType<typeof getDocumentProxy>>, warnings: ExtractionWarning[]): Promise<ExtractedImage[]> {
  const images: ExtractedImage[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let skippedSmall = 0;
  let truncated = false;
  const pageLimit = Math.min(pdf.numPages, MAX_IMAGE_SCAN_PAGES);

  for (let page = 1; page <= pageLimit && !truncated; page++) {
    let pageImages;
    try {
      pageImages = await extractImages(pdf, page);
    } catch {
      warnings.push({ code: "image-skipped", page, message: `Images on page ${page} could not be extracted.` });
      continue;
    }
    for (const img of pageImages) {
      if (img.width < MIN_IMAGE_DIMENSION || img.height < MIN_IMAGE_DIMENSION) {
        skippedSmall++;
        continue;
      }
      const hash = createHash("sha1").update(img.data).digest("hex");
      if (seen.has(hash)) continue;
      seen.add(hash);
      let png: Buffer;
      try {
        png = encodePng(img.data, img.width, img.height, img.channels);
      } catch {
        warnings.push({ code: "image-skipped", page, message: `An image on page ${page} could not be converted.` });
        continue;
      }
      if (images.length >= MAX_IMAGES_PER_DOCUMENT || totalBytes + png.byteLength > MAX_TOTAL_IMAGE_BYTES) {
        truncated = true;
        break;
      }
      totalBytes += png.byteLength;
      images.push({
        id: createId("img"),
        fileName: `page-${page}-image-${images.length + 1}.png`,
        mimeType: "image/png",
        byteSize: png.byteLength,
        width: img.width,
        height: img.height,
        page,
        src: toDataUrl("image/png", png),
        origin: "extracted",
      });
    }
  }
  if (truncated) {
    warnings.push({ code: "images-truncated", message: `Only the first ${images.length} images were extracted (limit: ${MAX_IMAGES_PER_DOCUMENT} images / ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024} MB).` });
  }
  if (pdf.numPages > MAX_IMAGE_SCAN_PAGES) {
    warnings.push({ code: "images-truncated", message: `Images were only scanned on the first ${MAX_IMAGE_SCAN_PAGES} pages.` });
  }
  if (skippedSmall > 0) {
    warnings.push({ code: "image-skipped", message: `${skippedSmall} very small image(s) (icons, rules or bullets under ${MIN_IMAGE_DIMENSION}px) were ignored.` });
  }
  return images;
}

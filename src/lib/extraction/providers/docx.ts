import JSZip from "jszip";
import mammoth from "mammoth";
import { parse } from "node-html-parser";
import type { DocumentMetadata, ExtractedImage, ExtractionResult, ExtractionWarning } from "../../types/extraction";
import { createId } from "../../utils/id";
import { buildContentBlocks } from "../classify";
import { htmlToStructure } from "../structure/html";
import { sniffImage, toDataUrl } from "../images";
import { MAX_DOCX_UNCOMPRESSED_BYTES, MAX_IMAGES_PER_DOCUMENT, MAX_TOTAL_IMAGE_BYTES, MIN_IMAGE_DIMENSION } from "../limits";
import { countWords, decodeXmlEntities } from "../text";
import { scanZip, verifyZipExpansion } from "../zip";
import { ExtractionError, type DocumentExtractionProvider, type ExtractionInput } from "./types";

// Paragraph styles the shared pipeline understands. Unmapped styles fall back to mammoth's defaults
// (Heading 1–6 => h1–h6, numbered/bulleted paragraphs => ol/ul with nesting).
const STYLE_MAP = [
  "p[style-name='Title'] => h1.cs-title:fresh",
  "p[style-name='Subtitle'] => p.cs-subtitle:fresh",
  "p[style-name='Caption'] => p.cs-caption:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
];

interface PendingImage {
  bytes: Buffer;
  contentType: string;
}

function readCoreProperty(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  const value = match ? decodeXmlEntities(match[1]).trim() : "";
  return value || undefined;
}

async function readDocxMetadata(bytes: Uint8Array, warnings: ExtractionWarning[]): Promise<Partial<DocumentMetadata>> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const core = await zip.file("docProps/core.xml")?.async("string");
    if (!core) return {};
    return {
      title: readCoreProperty(core, "dc:title"),
      author: readCoreProperty(core, "dc:creator"),
      subject: readCoreProperty(core, "dc:subject"),
      keywords: readCoreProperty(core, "cp:keywords"),
      description: readCoreProperty(core, "dc:description"),
      createdAt: readCoreProperty(core, "dcterms:created"),
      modifiedAt: readCoreProperty(core, "dcterms:modified"),
    };
  } catch {
    warnings.push({ code: "metadata-unavailable", message: `Document properties could not be read.` });
    return {};
  }
}

export const docxProvider: DocumentExtractionProvider = {
  id: "docx:mammoth+heuristics",
  fileType: "docx",
  async extract({ bytes, fileName, sourceUrl }: ExtractionInput): Promise<ExtractionResult> {
    const zipInfo = scanZip(bytes);
    if (!zipInfo || !zipInfo.names.includes("word/document.xml")) {
      throw new ExtractionError("unsupported-type", "This file is not a valid Word (.docx) document.", 415);
    }
    const tooLarge = `This document expands to more than ${MAX_DOCX_UNCOMPRESSED_BYTES / 1024 / 1024} MB when decompressed and cannot be processed.`;
    if (zipInfo.totalUncompressed > MAX_DOCX_UNCOMPRESSED_BYTES) throw new ExtractionError("file-too-large", tooLarge, 413);
    // Declared sizes can lie; measure the real expansion before any parser decompresses the file.
    const expansion = verifyZipExpansion(bytes, zipInfo, MAX_DOCX_UNCOMPRESSED_BYTES);
    if (!expansion.ok) {
      if (expansion.reason === "too-large") throw new ExtractionError("file-too-large", tooLarge, 413);
      throw new ExtractionError("parse-failed", "This Word document is damaged or uses an unsupported ZIP format.");
    }

    const warnings: ExtractionWarning[] = [];
    const pendingImages = new Map<string, PendingImage>();
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let html: string;
    try {
      const result = await mammoth.convertToHtml(
        { buffer },
        {
          styleMap: STYLE_MAP,
          externalFileAccess: false,
          convertImage: mammoth.images.imgElement(async (image) => {
            const id = createId("img");
            pendingImages.set(id, { bytes: await image.readAsBuffer(), contentType: image.contentType });
            return { src: `cs-image:${id}` };
          }),
        },
      );
      html = result.value;
      for (const message of result.messages.slice(0, 5)) {
        warnings.push({ code: "parser-warning", message: message.message });
      }
    } catch (error) {
      console.warn(`Content Studio: DOCX could not be converted (${error instanceof Error ? error.name : "unknown error"})`);
      throw new ExtractionError("parse-failed", "The Word document could not be read. It may be damaged or use an unsupported format.");
    }

    // Word structure (headings, Title/Subtitle/Caption styles, nested and numbered lists, tables,
    // bold runs) is read by the shared HTML structure reader; classification happens downstream.
    const tree = parse(html);
    const doc = htmlToStructure(tree, {
      location: (n, tag) => (tag === "tr" ? `Paragraph ${n} (table row)` : tag === "li" ? `Paragraph ${n} (list item)` : `Paragraph ${n}`),
      resolveHref: (href) => (href && !href.startsWith("#") ? href : undefined),
      classes: { title: "cs-title", subtitle: "cs-subtitle", caption: "cs-caption" },
    });
    // Images in document order (including paragraphs that contain only an image).
    const imageOrder = tree
      .querySelectorAll("img")
      .map((img) => ({ id: (img.getAttribute("src") ?? "").replace(/^cs-image:/, ""), alt: img.getAttribute("alt") || undefined }))
      .filter((r) => pendingImages.has(r.id));

    if (doc.elements.every((e) => !e.text.trim())) {
      throw new ExtractionError("parse-failed", "No text was found in this Word document.");
    }

    const images: ExtractedImage[] = [];
    let totalBytes = 0;
    let unsupported = 0;
    let small = 0;
    for (const ref of imageOrder) {
      const pending = pendingImages.get(ref.id);
      if (!pending) continue;
      const info = sniffImage(pending.bytes);
      if (!info) {
        unsupported++;
        continue;
      }
      if (info.width !== undefined && info.height !== undefined && (info.width < MIN_IMAGE_DIMENSION || info.height < MIN_IMAGE_DIMENSION)) {
        small++;
        continue;
      }
      if (images.length >= MAX_IMAGES_PER_DOCUMENT || totalBytes + pending.bytes.byteLength > MAX_TOTAL_IMAGE_BYTES) {
        warnings.push({ code: "images-truncated", message: `Only the first ${images.length} images were extracted (limit: ${MAX_IMAGES_PER_DOCUMENT} images / ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024} MB).` });
        break;
      }
      totalBytes += pending.bytes.byteLength;
      const ext = info.mimeType.split("/")[1].replace("jpeg", "jpg");
      images.push({
        id: ref.id,
        fileName: `image-${images.length + 1}.${ext}`,
        mimeType: info.mimeType,
        byteSize: pending.bytes.byteLength,
        width: info.width,
        height: info.height,
        sourceAltText: ref.alt,
        src: toDataUrl(info.mimeType, pending.bytes),
        origin: "extracted",
      });
    }
    if (unsupported > 0) {
      warnings.push({ code: "image-skipped", message: `${unsupported} embedded image(s) use a format browsers cannot display (for example EMF/WMF/TIFF) and were skipped.` });
    }
    if (small > 0) {
      warnings.push({ code: "image-skipped", message: `${small} very small image(s) under ${MIN_IMAGE_DIMENSION}px were ignored.` });
    }

    const meta = await readDocxMetadata(bytes, warnings);
    return {
      id: createId("ext"),
      provider: this.id,
      extractedAt: new Date().toISOString(),
      isSample: false,
      metadata: {
        fileName,
        fileType: "docx",
        fileSize: bytes.byteLength,
        sourceUrl,
        wordCount: countWords(doc.elements.map((e) => e.text).join(" ")),
        ...meta,
      },
      blocks: buildContentBlocks(doc, { keywords: meta.keywords }),
      images,
      warnings,
    };
  },
};

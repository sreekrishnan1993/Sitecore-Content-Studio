import { parse, type HTMLElement } from "node-html-parser";
import type { ExtractedImage, ExtractionResult, ExtractionWarning } from "../../types/extraction";
import { createId } from "../../utils/id";
import { buildContentBlocks } from "../classify";
import { htmlToStructure } from "../structure/html";
import { MAX_IMAGES_PER_DOCUMENT } from "../limits";
import { countWords, isSafeHref } from "../text";
import { ExtractionError, type DocumentExtractionProvider, type ExtractionInput } from "./types";

const STRIP = "script, style, noscript, template, iframe, svg, nav, aside, form, button";
const PAGE_CHROME = "header, footer";

function meta(root: HTMLElement, ...names: string[]): string | undefined {
  for (const name of names) {
    const el = root.querySelector(`meta[name="${name}"]`) ?? root.querySelector(`meta[property="${name}"]`);
    const content = el?.getAttribute("content")?.trim();
    if (content) return content;
  }
  return undefined;
}

function resolveUrl(href: string | undefined, base: URL): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

/** Publication pages: static HTML only. Scripts are removed and never executed. */
export const htmlProvider: DocumentExtractionProvider = {
  id: "html:node-html-parser+heuristics",
  fileType: "html",
  async extract({ bytes, fileName, sourceUrl }: ExtractionInput): Promise<ExtractionResult> {
    const base = new URL(sourceUrl ?? "https://invalid.local/");
    const root = parse(new TextDecoder().decode(bytes));
    const warnings: ExtractionWarning[] = [];

    const title = meta(root, "og:title", "twitter:title") ?? root.querySelector("title")?.text.trim();
    const metadata = {
      title: title || undefined,
      author: meta(root, "author", "article:author"),
      description: meta(root, "description", "og:description"),
      keywords: meta(root, "keywords", "news_keywords"),
      createdAt: meta(root, "article:published_time", "date", "pubdate"),
      modifiedAt: meta(root, "article:modified_time"),
    };

    root.querySelectorAll(STRIP).forEach((el) => el.remove());
    const article = root.querySelector("article") ?? root.querySelector("main");
    const container = article ?? root.querySelector("body") ?? root;
    // Site-wide header/footer is page chrome; an article's own <header> usually holds its headline.
    if (!article) container.querySelectorAll(PAGE_CHROME).forEach((el) => el.remove());

    const doc = htmlToStructure(container, {
      location: (n, tag) => `<${tag}> element ${n}`,
      resolveHref: (href) => {
        const url = resolveUrl(href, base);
        return url && isSafeHref(url) ? url : undefined;
      },
    });

    if (doc.elements.length === 0) {
      throw new ExtractionError(
        "parse-failed",
        "No article text was found at this URL. The page may require JavaScript or a login, which Content Studio does not run.",
      );
    }

    const images: ExtractedImage[] = [];
    for (const img of container.querySelectorAll("img")) {
      if (images.length >= MAX_IMAGES_PER_DOCUMENT) {
        warnings.push({ code: "images-truncated", message: `Only the first ${MAX_IMAGES_PER_DOCUMENT} images were collected.` });
        break;
      }
      const src = resolveUrl(img.getAttribute("src"), base);
      if (!src || !/^https?:/.test(src)) continue;
      const width = Number(img.getAttribute("width")) || undefined;
      const height = Number(img.getAttribute("height")) || undefined;
      if ((width && width < 48) || (height && height < 48)) continue;
      const name = decodeURIComponent(new URL(src).pathname.split("/").pop() || "image");
      images.push({
        id: createId("img"),
        fileName: name,
        mimeType: "",
        byteSize: 0,
        width,
        height,
        sourceAltText: img.getAttribute("alt")?.trim() || undefined,
        src,
        origin: "referenced",
      });
    }
    if (images.length > 0) {
      warnings.push({ code: "parser-warning", message: "Publication images are referenced by URL, not downloaded. Their size and format are verified only when they are uploaded." });
    }

    return {
      id: createId("ext"),
      provider: this.id,
      extractedAt: new Date().toISOString(),
      isSample: false,
      metadata: { fileName, fileType: "html", fileSize: bytes.byteLength, sourceUrl, wordCount: countWords(doc.elements.map((e) => e.text).join(" ")), ...metadata },
      blocks: buildContentBlocks(doc, { keywords: metadata.keywords }),
      images,
      warnings,
    };
  },
};

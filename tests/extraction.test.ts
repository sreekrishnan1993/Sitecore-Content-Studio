import { describe, expect, it } from "vitest";
import { buildSampleDocx, buildSamplePdf, buildScannedPdf, SAMPLE_TEXT } from "../scripts/fixtures.mjs";
import { buildContentBlocks, extractQuote, isCallToAction, isStatisticSentence } from "@/src/lib/extraction/classify";
import { sniffImage } from "@/src/lib/extraction/images";
import { docxProvider } from "@/src/lib/extraction/providers/docx";
import { htmlProvider } from "@/src/lib/extraction/providers/html";
import { pdfProvider } from "@/src/lib/extraction/providers/pdf";
import { ExtractionError } from "@/src/lib/extraction/providers/types";
import type { ExtractionResult } from "@/src/lib/types/extraction";
import { checkFileBasics, sniffFileType } from "@/src/lib/validation/file";

const byType = (r: ExtractionResult, type: string) => r.blocks.filter((b) => b.type === type);

function expectSharedPressReleaseShape(result: ExtractionResult) {
  expect(result.isSample).toBe(false);
  expect(byType(result, "headline")[0]?.text).toBe(SAMPLE_TEXT.headline);
  expect(byType(result, "subheading").map((b) => b.text)).toContain(SAMPLE_TEXT.subheading);
  expect(byType(result, "summary")[0]?.text).toBe(SAMPLE_TEXT.lead);

  const quote = byType(result, "quote")[0];
  expect(quote?.text).toContain("Atlas Insights gives every store manager");
  expect(quote?.attribution).toMatch(/^Maria Lopez/);
  expect(quote?.source?.sourceText).toContain("said Maria Lopez");

  const stats = byType(result, "statistic").map((b) => b.text);
  expect(stats.some((s) => s.includes("32%"))).toBe(true);

  const cta = byType(result, "cta")[0];
  expect(cta?.text).toBe(SAMPLE_TEXT.cta);
  expect(cta?.href).toBe("https://example.com/atlas");

  const links = byType(result, "link").map((b) => b.href);
  expect(links).toContain("https://example.com/atlas/pricing");

  const seo = byType(result, "seo");
  expect(seo.find((b) => b.label === "Meta title")?.origin).toBe("derived");
  expect(seo.find((b) => b.label === "Meta description")!.text.length).toBeLessThanOrEqual(155);
  expect(seo.find((b) => b.label === "Keywords")?.text).toBe("retail analytics, reporting");

  // Every extracted block's text must actually occur in the source document.
  for (const block of result.blocks.filter((b) => b.origin === "extracted" && b.type !== "link" && b.label !== "Keywords")) {
    const haystack = Object.values(SAMPLE_TEXT).join(" ") + " Read the full pricing guide for details.";
    for (const part of block.text.split(/\s+(?=[A-Z])/).slice(0, 1)) expect(haystack).toContain(part);
  }
  expect(result.metadata.title).toBe("Atlas Insights launch");
  expect(result.metadata.author).toBe("Northwind Press Office");
}

describe("PDF extraction", () => {
  it("extracts structured content, page numbers, metadata, links and images from a text PDF", async () => {
    const bytes = new Uint8Array(buildSamplePdf());
    expect(sniffFileType(bytes)).toBe("pdf");
    const result = await pdfProvider.extract({ bytes, fileName: "release.pdf" });

    expectSharedPressReleaseShape(result);
    expect(result.metadata.pageCount).toBe(2);
    expect(result.metadata.createdAt).toBe("2026-03-03T09:00:00.000Z");
    expect(byType(result, "headline")[0].source?.page).toBe(1);
    expect(byType(result, "subheading")[0].source?.page).toBe(2);

    expect(result.images).toHaveLength(1);
    const image = result.images[0];
    expect(image).toMatchObject({ page: 1, width: 96, height: 96, mimeType: "image/png", origin: "extracted" });
    expect(image.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(sniffImage(Buffer.from(image.src.split(",")[1], "base64"))).toEqual({ mimeType: "image/png", width: 96, height: 96 });
  });

  it("reports scanned PDFs instead of returning empty content", async () => {
    await expect(pdfProvider.extract({ bytes: new Uint8Array(buildScannedPdf()), fileName: "scan.pdf" })).rejects.toMatchObject({
      code: "scanned-document",
    });
  });

  it("fails cleanly on a corrupt PDF", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.4\nthis is not really a pdf");
    const error = await pdfProvider.extract({ bytes, fileName: "broken.pdf" }).catch((e) => e);
    expect(error).toBeInstanceOf(ExtractionError);
    expect(error.code).toBe("parse-failed");
  });
});

describe("DOCX extraction", () => {
  it("extracts paragraphs in order with metadata, hyperlinks and images", async () => {
    const bytes = new Uint8Array(await buildSampleDocx());
    expect(sniffFileType(bytes)).toBe("docx");
    const result = await docxProvider.extract({ bytes, fileName: "release.docx" });

    expectSharedPressReleaseShape(result);
    expect(result.metadata.createdAt).toBe("2026-03-03T09:00:00Z");
    const order = result.blocks.filter((b) => ["headline", "summary", "subheading", "body", "cta"].includes(b.type)).map((b) => b.type);
    // Consecutive paragraphs of one section form one body block; each paragraph is kept.
    expect(order).toEqual(["headline", "summary", "body", "subheading", "body", "cta"]);
    const sectionBody = result.blocks.filter((b) => b.type === "body")[1];
    expect(sectionBody.text.split("\n\n")).toEqual([SAMPLE_TEXT.body, "Read the full pricing guide for details."]);
    expect(byType(result, "link").find((l) => l.href === "https://example.com/atlas/pricing")?.text).toBe("full pricing guide");

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ mimeType: "image/png", width: 96, height: 96, sourceAltText: "Atlas Insights dashboard on a tablet" });
  });

  it("rejects ZIP files that are not Word documents", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
    await expect(docxProvider.extract({ bytes, fileName: "fake.docx" })).rejects.toMatchObject({ code: "unsupported-type" });
  });
});

describe("HTML publication extraction", () => {
  it("extracts article content and ignores scripts and site chrome", async () => {
    const html = `<html><head><title>Ignored</title><meta property="og:title" content="Atlas launch"><meta name="author" content="Press Office">
      <script>document.write("evil")</script></head><body><header><p>Site menu text that should be ignored entirely</p></header>
      <article><h1>${SAMPLE_TEXT.headline}</h1><p>${SAMPLE_TEXT.lead}</p><blockquote><p>We built this for store managers.</p></blockquote><p>— Maria Lopez, CEO</p>
      <p>${SAMPLE_TEXT.stat}</p><img src="/img/hero.jpg" alt="Hero" width="800" height="400"><p><a href="/pricing">Pricing</a> is available.</p></article></body></html>`;
    const result = await htmlProvider.extract({ bytes: new TextEncoder().encode(html), fileName: "example.com/news", sourceUrl: "https://example.com/news/atlas" });
    expect(result.metadata.title).toBe("Atlas launch");
    expect(result.metadata.author).toBe("Press Office");
    expect(byType(result, "headline")[0].text).toBe(SAMPLE_TEXT.headline);
    expect(byType(result, "quote")[0]).toMatchObject({ text: "We built this for store managers.", attribution: "Maria Lopez, CEO" });
    expect(result.blocks.some((b) => b.text.includes("evil") || b.text.includes("Site menu"))).toBe(false);
    expect(result.images[0]).toMatchObject({ src: "https://example.com/img/hero.jpg", origin: "referenced", sourceAltText: "Hero" });
    expect(byType(result, "link").map((l) => l.href)).toContain("https://example.com/pricing");
  });
});

describe("classification heuristics", () => {
  it("extracts quotes with attribution and never invents one", () => {
    expect(extractQuote('"This changes how our teams work every day," said Jane Smith, CTO at Example.')).toEqual({
      quoted: "This changes how our teams work every day,",
      attribution: "Jane Smith, CTO at Example",
    });
    expect(extractQuote("“A quotation without any speaker named at all.”")?.attribution).toBeUndefined();
    expect(extractQuote("No quotation here.")).toBeNull();
  });

  it("detects statistics but not plain years", () => {
    expect(isStatisticSentence("Revenue grew 45% year over year.")).toBe(true);
    expect(isStatisticSentence("The company raised $20 million.")).toBe(true);
    expect(isStatisticSentence("Founded in 2015, the company is based in Leeds.")).toBe(false);
  });

  it("detects calls to action conservatively", () => {
    expect(isCallToAction("Learn more at https://example.com.")).toBe(true);
    expect(isCallToAction("The CEO will visit Paris next week to meet customers.")).toBe(false);
  });

  it("uses an explicit summary section when present", () => {
    const blocks = buildContentBlocks(
      {
        elements: [
          { text: "Annual Report", kind: "heading", headingLevel: 1, titleStyle: true, location: "1" },
          { text: "Executive Summary", kind: "heading", headingLevel: 2, location: "2" },
          { text: "Short summary.", kind: "paragraph", location: "3" },
          { text: "Results", kind: "heading", headingLevel: 2, location: "4" },
          { text: "A long first results paragraph that has more than fifteen words so it could look like a lead paragraph.", kind: "paragraph", location: "5" },
        ],
        links: [],
      },
      {},
    );
    expect(blocks.filter((b) => b.type === "summary").map((b) => b.text)).toEqual(["Short summary."]);
    // The summary heading is source text too: it is kept, not dropped.
    expect(blocks.filter((b) => b.type === "subheading").map((b) => b.text)).toEqual(["Executive Summary", "Results"]);
    const body = blocks.find((b) => b.type === "body");
    expect(body?.source?.location).toBe("5");
    expect(body?.section).toBe(blocks.find((b) => b.text === "Results")?.section);
  });
});

describe("file validation", () => {
  it("rejects unsupported, empty and oversized files", () => {
    expect(checkFileBasics("notes.txt", 10, 1000)).toMatchObject({ ok: false, code: "unsupported-type" });
    expect(checkFileBasics("old.doc", 10, 1000)).toMatchObject({ ok: false, code: "unsupported-type" });
    expect(checkFileBasics("empty.pdf", 0, 1000)).toMatchObject({ ok: false, code: "empty-file" });
    expect(checkFileBasics("big.docx", 2000, 1000)).toMatchObject({ ok: false, code: "file-too-large" });
    expect(checkFileBasics("ok.PDF", 10, 1000)).toEqual({ ok: true, type: "pdf" });
  });

  it("identifies files by signature, not extension", () => {
    expect(sniffFileType(new TextEncoder().encode("plain text"))).toBeNull();
  });
});

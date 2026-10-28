import type { ExtractedBlock, ExtractedImage, ExtractionResult } from "@/src/lib/types/extraction";
import { createId } from "@/src/lib/utils/id";

// SAMPLE DATA — a fictional press release used by "Try the sample" (demo mode).
// It is marked isSample: true and shown with a "Sample" label everywhere in the UI.
// It is never presented as content extracted from an uploaded file.

function sampleImage(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,62%)"/><stop offset="1" stop-color="hsl(${hue + 40},50%,38%)"/></linearGradient></defs><rect width="960" height="540" fill="url(#g)"/><text x="480" y="260" font-family="Arial, sans-serif" font-size="40" fill="#fff" text-anchor="middle">${label}</text><text x="480" y="310" font-family="Arial, sans-serif" font-size="22" fill="#fff" opacity="0.85" text-anchor="middle">Sample image — demo data</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function createSampleExtraction(): ExtractionResult {
  const b = (block: Omit<ExtractedBlock, "id" | "origin"> & { origin?: ExtractedBlock["origin"] }): ExtractedBlock => ({ id: createId("blk"), origin: "extracted", ...block });
  const lead = b({
    type: "summary",
    label: "Lead paragraph",
    text: "LONDON, 3 March 2026 — Northwind Analytics today announced Atlas Insights, a reporting platform that helps retail teams turn store data into weekly decisions without writing code.",
    source: { page: 1, location: "Page 1, block 2" },
  });
  const statPara = b({
    type: "body",
    text: "In a six-month pilot with 40 stores, participating teams reduced stock-outs by 32% and saved an average of 14 hours of reporting work per week.",
    source: { page: 1, location: "Page 1, block 3" },
  });
  const quotePara = "“Atlas Insights gives every store manager the same view of performance that used to take our analysts days to build,” said Maria Lopez, Chief Executive Officer of Northwind Analytics.";

  const blocks: ExtractedBlock[] = [
    b({ type: "headline", text: "Northwind Analytics Launches Atlas Insights for Retail Teams", source: { page: 1, location: "Page 1, block 1" } }),
    lead,
    statPara,
    b({ type: "statistic", text: statPara.text, containedIn: statPara.id, source: { page: 1, location: "Page 1, block 3", sourceText: statPara.text } }),
    b({ type: "subheading", text: "Availability and pricing", source: { page: 2, location: "Page 2, block 1" } }),
    b({
      type: "quote",
      text: "Atlas Insights gives every store manager the same view of performance that used to take our analysts days to build,",
      attribution: "Maria Lopez, Chief Executive Officer of Northwind Analytics",
      source: { page: 2, location: "Page 2, block 2", sourceText: quotePara },
    }),
    b({ type: "body", text: "The platform connects to existing point-of-sale systems and will be available in English, French and German from April 2026.", source: { page: 2, location: "Page 2, block 3" } }),
    b({ type: "cta", text: "To request a demo, visit https://example.com/atlas.", href: "https://example.com/atlas", source: { page: 2, location: "Page 2, block 4" } }),
    b({ type: "link", text: "Pricing guide", href: "https://example.com/atlas/pricing", source: { page: 2, location: "PDF link annotation" } }),
    b({ type: "seo", label: "Meta title", origin: "derived", text: "Northwind Analytics Launches Atlas Insights for Retail Teams", source: { location: "Derived from headline" } }),
    b({ type: "seo", label: "Meta description", origin: "derived", text: "LONDON, 3 March 2026 — Northwind Analytics today announced Atlas Insights, a reporting platform that helps retail teams turn store data into…", source: { location: "Derived from summary" } }),
    b({ type: "seo", label: "Keywords", text: "retail analytics, reporting", source: { location: "Document properties" } }),
  ];

  const images: ExtractedImage[] = [
    { id: createId("img"), fileName: "sample-dashboard.svg", mimeType: "image/svg+xml", byteSize: 820, width: 960, height: 540, page: 1, src: sampleImage("Dashboard", 255), origin: "extracted" },
    { id: createId("img"), fileName: "sample-store-team.svg", mimeType: "image/svg+xml", byteSize: 830, width: 960, height: 540, page: 2, sourceAltText: "Store team reviewing a weekly report", src: sampleImage("Store team", 200), origin: "extracted" },
  ];

  return {
    id: createId("ext"),
    provider: "sample-fixture",
    extractedAt: new Date().toISOString(),
    isSample: true,
    metadata: {
      fileName: "Sample — Northwind press release (fictional).pdf",
      fileType: "pdf",
      fileSize: 48_213,
      pageCount: 2,
      title: "Atlas Insights launch",
      author: "Northwind Press Office",
      keywords: "retail analytics, reporting",
      createdAt: "2026-03-03T09:00:00.000Z",
      wordCount: 132,
    },
    blocks,
    images,
    warnings: [{ code: "parser-warning", message: "This is bundled sample data for demonstration. It was not extracted from a file you uploaded." }],
  };
}

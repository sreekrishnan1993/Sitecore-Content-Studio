// Builds small, deterministic PDF and DOCX test documents from scratch.
// Used by the unit tests and, via `npm run fixtures`, to write sample files to
// tests/fixtures/generated/ for manual testing in the UI.
//
// All content is fictional ("Northwind Analytics").

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

// ---------- PNG ----------
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** Raw RGB gradient pixels. */
export function gradientPixels(size) {
  const px = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      px[i] = 90 + Math.round((x / size) * 80);
      px[i + 1] = 60;
      px[i + 2] = 160 + Math.round((y / size) * 80);
    }
  return px;
}
export function buildPng(size = 96) {
  const px = gradientPixels(size);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

// ---------- PDF ----------
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Lays out paragraphs as text lines. Each item: { text, size, font, gapBefore, x, hang } (hang = indent of wrapped lines). */
function pageContent(items, image) {
  let y = 740;
  const ops = [];
  for (const item of items) {
    y -= item.gapBefore ?? 0;
    const maxChars = Math.floor(470 / (item.size * 0.5));
    const words = item.text.split(" ");
    let line = "";
    const lines = [];
    for (const w of words) {
      if ((line + " " + w).trim().length > maxChars) {
        lines.push(line.trim());
        line = w;
      } else line += " " + w;
    }
    if (line.trim()) lines.push(line.trim());
    lines.forEach((l, n) => {
      const x = (item.x ?? 72) + (n > 0 ? (item.hang ?? 0) : 0);
      ops.push(`BT /${item.font ?? "F1"} ${item.size} Tf ${x} ${y} Td (${esc(l)}) Tj ET`);
      y -= item.size * 1.3;
    });
  }
  if (image) ops.push(`q ${image.w} 0 0 ${image.h} 72 ${image.y} cm /Im1 Do Q`);
  return ops.join("\n");
}

function assemblePdf(objects) {
  // objects: array of strings or {dict, stream: Buffer}; object numbers are 1-based indices.
  const parts = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [];
  let length = parts[0].length;
  objects.forEach((obj, i) => {
    offsets.push(length);
    let buf;
    if (typeof obj === "string") buf = Buffer.from(`${i + 1} 0 obj\n${obj}\nendobj\n`, "binary");
    else {
      buf = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n${obj.dict.replace(/>>\s*$/, ` /Length ${obj.stream.length} >>`)}\nstream\n`, "binary"),
        obj.stream,
        Buffer.from("\nendstream\nendobj\n", "binary"),
      ]);
    }
    parts.push(buf);
    length += buf.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  const infoIndex = objects.findIndex((o) => typeof o === "string" && o.includes("/Producer"));
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${infoIndex >= 0 ? ` /Info ${infoIndex + 1} 0 R` : ""} >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref + trailer, "binary"));
  return Buffer.concat(parts);
}

export const SAMPLE_TEXT = {
  headline: "Northwind Analytics Launches Atlas Insights Platform",
  subheading: "Platform availability and pricing",
  lead:
    "LONDON, 3 March 2026 - Northwind Analytics today announced Atlas Insights, a reporting platform that helps retail teams turn store data into weekly decisions without writing code.",
  stat: "In a six-month pilot, participating stores reduced stock-outs by 32% and saved an average of 14 hours of reporting work per week.",
  quoteParagraph:
    '"Atlas Insights gives every store manager the same view of performance that used to take our analysts days to build," said Maria Lopez, Chief Executive Officer of Northwind Analytics.',
  body: "The platform connects to existing point-of-sale systems and is available in English, French and German from April.",
  cta: "To request a demo, visit https://example.com/atlas or contact press@example.com.",
};

export function buildSamplePdf() {
  const t = SAMPLE_TEXT;
  const page1 = pageContent(
    [
      { text: t.headline, size: 22, font: "F2" },
      { text: t.lead, size: 11, gapBefore: 18 },
      { text: t.stat, size: 11, gapBefore: 10 },
    ],
    { w: 128, h: 128, y: 300 },
  );
  const page2 = pageContent([
    { text: t.subheading, size: 15, font: "F2" },
    { text: t.quoteParagraph, size: 11, gapBefore: 12 },
    { text: t.body, size: 11, gapBefore: 10 },
    { text: t.cta, size: 11, gapBefore: 10 },
  ]);
  const imagePixels = deflateSync(gradientPixels(96));
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> /XObject << /Im1 9 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents 6 0 R /Annots [10 0 R] >>",
    { dict: "<< >>", stream: Buffer.from(page1, "binary") },
    { dict: "<< >>", stream: Buffer.from(page2, "binary") },
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    { dict: "<< /Type /XObject /Subtype /Image /Width 96 /Height 96 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode >>", stream: imagePixels },
    "<< /Type /Annot /Subtype /Link /Rect [72 500 300 520] /Border [0 0 0] /A << /S /URI /URI (https://example.com/atlas/pricing) >> >>",
    "<< /Title (Atlas Insights launch) /Author (Northwind Press Office) /Keywords (retail analytics, reporting) /Producer (Content Studio fixtures) /CreationDate (D:20260303090000Z) >>",
  ]);
}

/** A PDF with an image and no text layer, like a scanned page. */
export function buildScannedPdf() {
  const content = "q 400 0 0 400 100 200 cm /Im1 Do Q";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    { dict: "<< >>", stream: Buffer.from(content, "binary") },
    { dict: "<< /Type /XObject /Subtype /Image /Width 96 /Height 96 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode >>", stream: deflateSync(gradientPixels(96)) },
  ]);
}

// ---------- DOCX ----------
const xmlEsc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const para = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
const imagePara = (alt) => `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1" descr="${xmlEsc(alt)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="atlas.png" descr="${xmlEsc(alt)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg1"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

export async function buildSampleDocx() {
  const t = SAMPLE_TEXT;
  const body = [
    para(t.headline, "Title"),
    para(t.lead),
    para(t.stat),
    imagePara("Atlas Insights dashboard on a tablet"),
    para(t.subheading, "Heading2"),
    para(t.quoteParagraph),
    para(t.body),
    `<w:p><w:r><w:t xml:space="preserve">Read the </w:t></w:r><w:hyperlink r:id="rIdLink1"><w:r><w:t>full pricing guide</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> for details.</w:t></w:r></w:p>`,
    para(t.cta),
  ].join("");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>');
  zip.file("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rIdLink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/atlas/pricing" TargetMode="External"/></Relationships>');
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  zip.file("word/media/image1.png", buildPng(96));
  zip.file("docProps/core.xml", '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Atlas Insights launch</dc:title><dc:creator>Northwind Press Office</dc:creator><cp:keywords>retail analytics, reporting</cp:keywords><dcterms:created xsi:type="dcterms:W3CDTF">2026-03-03T09:00:00Z</dcterms:created></cp:coreProperties>');
  return zip.generateAsync({ type: "nodebuffer" });
}

// ---------- Structure fixtures: one document, three formats ----------
// The same logical structure expressed in Word, HTML and PDF, to check that every adapter feeds
// the shared pipeline equivalently. The title is bold text WITHOUT a title style (Word/HTML) or
// larger text (PDF). Fictional content.

export const STRUCTURE = {
  title: "Quarterly Product Update",
  intro: "This update summarises what changed across the reporting platform this quarter and what store teams should do next.",
  heading1: "New capabilities",
  para1: "Three capabilities reached general availability this quarter after an extended beta with retail customers.",
  bullets: [
    { text: "Faster report builder with saved filters, reusable templates and sharing for every member of a store team", level: 0 },
    { text: "Scheduled exports to cloud storage", level: 0 },
    { text: "Weekly and monthly schedules", level: 1 },
    { text: "CSV and XLSX formats", level: 1 },
    { text: "Role-based dashboards for store managers", level: 0 },
  ],
  closing: "Each capability is available on all paid plans at no extra cost.",
  heading2: "Next steps",
  numbered: ["Review the updated permission settings", "Share the release notes with your team", "Book a training session for administrators"],
  noteLabel: "Note:",
  noteText: " training sessions are limited to twenty seats and usually fill within a week.",
  table: [["Plan", "Seats"], ["Starter", "5"], ["Team", "25"]],
  caption: "Table 1: Seats included per plan",
};

const run = (text, bold) => `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
const listPara = (text, numId, ilvl) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${run(text)}</w:p>`;
const cell = (text) => `<w:tc><w:p>${run(text)}</w:p></w:tc>`;

export async function buildStructuredDocx() {
  const s = STRUCTURE;
  const body = [
    `<w:p>${run(s.title, true)}</w:p>`,
    para(s.intro),
    para(s.heading1, "Heading2"),
    para(s.para1),
    ...s.bullets.map((b) => listPara(b.text, 1, b.level)),
    para(s.closing),
    para(s.heading2, "Heading2"),
    ...s.numbered.map((t) => listPara(t, 2, 0)),
    `<w:p>${run(s.noteLabel, true)}${run(s.noteText)}</w:p>`,
    `<w:tbl>${s.table.map((row) => `<w:tr>${row.map(cell).join("")}</w:tr>`).join("")}</w:tbl>`,
    para(s.caption, "Caption"),
  ].join("");
  const lvl = (ilvl, fmt, text) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/></w:lvl>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0">${lvl(0, "bullet", "•")}${lvl(1, "bullet", "o")}</w:abstractNum><w:abstractNum w:abstractNumId="1">${lvl(0, "decimal", "%1.")}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>');
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style></w:styles>`);
  zip.file("word/numbering.xml", numbering);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

export function buildStructuredHtml() {
  const s = STRUCTURE;
  const esc = (t) => xmlEsc(t);
  const items = (list) => {
    let html = "";
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item.level > 0) continue;
      const children = [];
      for (let j = i + 1; j < list.length && list[j].level > 0; j++) children.push(list[j]);
      html += `<li>${esc(item.text)}${children.length ? `<ul>${children.map((c) => `<li>${esc(c.text)}</li>`).join("")}</ul>` : ""}</li>`;
    }
    return html;
  };
  return `<!doctype html><html><head><title>Product update</title></head><body><header><nav><a href="/">Home</a></nav></header><article>
<p><strong>${esc(s.title)}</strong></p>
<p>${esc(s.intro)}</p>
<h2>${esc(s.heading1)}</h2>
<p>${esc(s.para1)}</p>
<ul>${items(s.bullets)}</ul>
<p>${esc(s.closing)}</p>
<h2>${esc(s.heading2)}</h2>
<ol>${s.numbered.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
<p><strong>${esc(s.noteLabel)}</strong>${esc(s.noteText)}</p>
<figure><table>${s.table.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table><figcaption>${esc(s.caption)}</figcaption></figure>
</article><footer>© Example</footer></body></html>`;
}

/** Encodes text for WinAnsiEncoding fonts (bullet and en dash have their own code points). */
const winAnsi = (text) => Buffer.from(text.replace(/•/g, "\x95").replace(/–/g, "\x96"), "latin1");

/** PDF version: typography only (larger title and headings), bullets and numbers as text, no table. */
export function buildStructuredPdf() {
  const s = STRUCTURE;
  const bullet = (b) => ({ text: `${b.level ? "–" : "•"} ${b.text}`, size: 11, x: 72 + b.level * 18, hang: 10 });
  const page1 = pageContent([
    { text: s.title, size: 20, font: "F2" },
    { text: s.intro, size: 11, gapBefore: 14 },
    { text: s.heading1, size: 14, font: "F2", gapBefore: 18 },
    { text: s.para1, size: 11, gapBefore: 10 },
    ...s.bullets.map((b, i) => ({ ...bullet(b), gapBefore: i === 0 ? 8 : 2 })),
    { text: s.closing, size: 11, gapBefore: 12 },
  ]);
  const page2 = pageContent([
    { text: s.heading2, size: 14, font: "F2" },
    ...s.numbered.map((t, i) => ({ text: `${i + 1}. ${t}`, size: 11, hang: 12, gapBefore: i === 0 ? 8 : 2 })),
    { text: `${s.noteLabel}${s.noteText}`, size: 11, gapBefore: 12 },
  ]);
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents 6 0 R >>",
    { dict: "<< >>", stream: winAnsi(page1) },
    { dict: "<< >>", stream: winAnsi(page2) },
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ]);
}

// ---------- CLI ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "generated");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "northwind-press-release.pdf"), buildSamplePdf());
  writeFileSync(join(out, "scanned-page.pdf"), buildScannedPdf());
  writeFileSync(join(out, "northwind-press-release.docx"), await buildSampleDocx());
  writeFileSync(join(out, "not-a-document.pdf"), "This is plain text pretending to be a PDF.");
  writeFileSync(join(out, "structure.docx"), await buildStructuredDocx());
  writeFileSync(join(out, "structure.pdf"), buildStructuredPdf());
  writeFileSync(join(out, "structure.html"), buildStructuredHtml());
  console.log(`Fixtures written to ${out}`);
}

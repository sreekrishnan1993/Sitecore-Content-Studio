import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSampleDocx, buildSamplePdf, buildStructuredDocx, buildStructuredHtml, buildStructuredPdf, STRUCTURE } from "../scripts/fixtures.mjs";
import { createSampleExtraction } from "@/src/fixtures/sample-extraction";
import { buildFieldValue, displayLevels, listToHtml } from "@/src/lib/mapping";
import { docxProvider } from "@/src/lib/extraction/providers/docx";
import { htmlProvider } from "@/src/lib/extraction/providers/html";
import { groupLines, listMarker, pdfProvider } from "@/src/lib/extraction/providers/pdf";
import { classifyStructure, type ClassifiedElement } from "@/src/lib/extraction/structure/classify";
import { groupedTexts, groupElements, MAX_BODY_PARAGRAPHS } from "@/src/lib/extraction/structure/group";
import type { SourceElement } from "@/src/lib/extraction/structure/model";
import { countWords } from "@/src/lib/extraction/text";
import type { ExtractedBlock, ExtractionResult } from "@/src/lib/types/extraction";
import type { ContentCard, Workspace } from "@/src/lib/types/workspace";
import { createWorkspace, workspaceReducer, type WorkspaceAction } from "@/src/lib/workspace";

// Shared structure detection and grouping. Level A and B tests use synthetic normalized input,
// independent of any file format; level C runs real adapters on equivalent fixtures.

let n = 0;
const el = (text: string, extra: Partial<SourceElement> = {}): SourceElement => ({ text, kind: "paragraph", location: `#${++n}`, ...extra });
const long = (words: number, seed = "word") => Array.from({ length: words }, (_, i) => `${seed}${i}`).join(" ") + ".";
const roles = (items: ClassifiedElement[]) => items.map((c) => c.role);
const roleOf = (items: ClassifiedElement[], text: string) => items.find((c) => c.text === text);

describe("A. structural classification (format-agnostic)", () => {
  it("a bold opening line followed by longer prose is the title, with its evidence", () => {
    const items = classifyStructure([el("Quarterly Product Update", { bold: "all" }), el(long(20)), el(long(30))]);
    expect(items[0]).toMatchObject({ role: "title", level: 1 });
    expect(items[0].evidence).toEqual(expect.arrayContaining(["entirely bold", "first element of the document", "followed by longer content"]));
  });

  it("bold alone does not make a title: a bold line later in the document is at most a heading", () => {
    const items = classifyStructure([el(long(30, "intro")), el(long(25, "more")), el("Pricing and availability", { bold: "all" }), el(long(20))]);
    expect(items.some((c) => c.role === "title")).toBe(false);
    expect(roleOf(items, "Pricing and availability")?.role).toBe("heading");
  });

  it("a bold line followed by nothing is not a heading", () => {
    const items = classifyStructure([el(long(30)), el("Contact", { bold: "all" })]);
    expect(roleOf(items, "Contact")?.role).toBe("body");
  });

  it("explicit semantic headings give the title and section headings with levels", () => {
    const items = classifyStructure([el("Annual Report", { kind: "heading", headingLevel: 1 }), el(long(20)), el("Results", { kind: "heading", headingLevel: 2 }), el(long(20)), el("Outlook", { kind: "heading", headingLevel: 3 }), el(long(15))]);
    expect(roles(items)).toEqual(["title", "description", "heading", "body", "heading", "body"]);
    expect(roleOf(items, "Outlook")?.level).toBe(3);
  });

  it("a title style wins over position and typography", () => {
    const items = classifyStructure([el("Draft", { bold: "all" }), el("The Real Title", { kind: "heading", headingLevel: 1, titleStyle: true }), el(long(20))]);
    expect(roleOf(items, "The Real Title")?.role).toBe("title");
    expect(items.filter((c) => c.role === "title")).toHaveLength(1);
  });

  it("the description is the first substantial paragraph after the title, not every paragraph", () => {
    const items = classifyStructure([el("Title", { kind: "heading", headingLevel: 1 }), el(long(18, "intro")), el(long(25, "body")), el(long(25, "more"))]);
    expect(roles(items)).toEqual(["title", "description", "body", "body"]);
  });

  it("a subtitle style right after the title is a description even when short", () => {
    const items = classifyStructure([el("Title", { kind: "heading", headingLevel: 1, titleStyle: true }), el("A short subtitle", { styleName: "Subtitle" }), el(long(30))]);
    expect(roles(items).slice(0, 2)).toEqual(["title", "description"]);
  });

  it("a paragraph starting with an inline bold label stays body text", () => {
    const items = classifyStructure([el("Title", { kind: "heading", headingLevel: 1 }), el(long(20)), el("Note: seats are limited and fill quickly every quarter.", { bold: "partial" })]);
    expect(roleOf(items, "Note: seats are limited and fill quickly every quarter.")).toMatchObject({ role: "body", evidence: ["paragraph with inline bold (emphasis, not structure)"] });
  });

  it("a short paragraph between sections without heading formatting is body, not a heading", () => {
    const items = classifyStructure([el("Overview", { kind: "heading", headingLevel: 2 }), el(long(20)), el("Thanks to all teams"), el("Details", { kind: "heading", headingLevel: 2 }), el(long(20))]);
    expect(roleOf(items, "Thanks to all teams")).toMatchObject({ role: "body", evidence: ["short line without heading formatting"] });
  });

  it("larger text is a heading only when short and introducing content (layout sources)", () => {
    const items = classifyStructure([
      el("Big Title", { fontSize: 22 }),
      el(long(30), { fontSize: 11 }),
      el("Section", { fontSize: 14 }),
      el(long(30), { fontSize: 11 }),
      el(long(28, "large"), { fontSize: 14 }),
    ]);
    expect(roles(items)).toEqual(["title", "description", "heading", "body", "body"]);
    expect(roleOf(items, "Section")?.evidence[0]).toMatch(/font 1\.27× body size/);
  });

  it("list items keep their list, level and numbering", () => {
    const items = classifyStructure([
      el("One", { kind: "list-item", list: { listId: "a", level: 0, ordered: true, marker: "1." } }),
      el("One point one", { kind: "list-item", list: { listId: "a", level: 1, ordered: true } }),
    ]);
    expect(items.map((c) => [c.role, c.level])).toEqual([["list-item", 0], ["list-item", 1]]);
    expect(items[0].evidence[0]).toBe('list item (marker "1.")');
  });

  it("quotes take a following dash attribution; captions come from the source or a caption pattern", () => {
    const items = classifyStructure([
      el(long(20)),
      el("The platform changed how we work every single week.", { kind: "quote" }),
      el("— Maria Lopez, CEO"),
      el("Figure 2: Weekly active stores", {}),
      el("Store map", { kind: "caption" }),
    ]);
    expect(roles(items).slice(1)).toEqual(["quote", "attribution", "caption", "caption"]);
  });

  it("table rows stay table rows, whatever their text looks like", () => {
    const items = classifyStructure([el("Plan | Seats", { kind: "table-row", container: { type: "table", id: "t1" } })]);
    expect(items[0].role).toBe("table-row");
  });

  it("without any formatting (plain text), the opening line is only an uncertain title", () => {
    const items = classifyStructure([el("Release notes for spring"), el(long(30)), el(long(20))]);
    expect(items[0]).toMatchObject({ role: "title", confidence: 0.4 });
    expect(items[0].evidence).toContain("no formatting evidence: uncertain");
  });

  it("conflicting signals: bold or large but long and punctuated text is body", () => {
    const sentence = "This paragraph is entirely bold but it is a full sentence that ends with a period.";
    const items = classifyStructure([el(long(30)), el(sentence, { bold: "all" }), el(long(20))]);
    expect(roleOf(items, sentence)?.role).toBe("body");
  });

  it("two emphasized lines in a row are ambiguous and are not both made headings", () => {
    const items = classifyStructure([el(long(30)), el("Contact", { bold: "all" }), el("Press office", { bold: "all" }), el(long(20))]);
    expect(roleOf(items, "Contact")).toMatchObject({ role: "body", evidence: ["emphasized, but not followed by content"] });
  });

  it("page furniture is noise, kept out of content", () => {
    const items = classifyStructure([el("Title", { kind: "heading", headingLevel: 1 }), el(long(20)), el("###"), el("Page 2 of 3"), el("12")]);
    expect(roles(items).slice(2)).toEqual(["noise", "noise", "noise"]);
  });
});

describe("B. grouping", () => {
  const group = (els: SourceElement[]) => groupElements(classifyStructure(els));
  const list = (text: string, listId: string, level = 0, extra: Partial<SourceElement> = {}) => el(text, { kind: "list-item", list: { listId, level }, ...extra });

  it("consecutive items of one list form one list block; levels are kept and normalized", () => {
    const { groups } = group([el(long(30)), list("A", "l1", 1), list("A.1", "l1", 2), list("B", "l1", 1), list("Other list", "l2")]);
    const lists = groups.filter((g) => g.role === "list");
    expect(lists).toHaveLength(2);
    expect(lists[0].items?.map((i) => [i.text, i.level])).toEqual([["A", 0], ["A.1", 1], ["B", 0]]);
  });

  it("intro paragraph, list and closing paragraph stay three blocks of one section, in order", () => {
    const { groups } = group([el("Doc", { kind: "heading", headingLevel: 1 }), el(long(15, "lead")), el("Features", { kind: "heading", headingLevel: 2 }), el(long(15, "intro")), list("One", "l"), list("Two", "l"), el(long(12, "closing"))]);
    expect(groups.map((g) => g.role)).toEqual(["title", "description", "heading", "body", "list", "body"]);
    expect(new Set(groups.slice(3).map((g) => g.section)).size).toBe(1);
  });

  it("paragraphs of one section join; a new heading starts a new block", () => {
    const { groups } = group([el("Doc", { kind: "heading", headingLevel: 1, titleStyle: true }), el("A", { kind: "heading", headingLevel: 2 }), el(long(10, "a1")), el(long(10, "a2")), el("B", { kind: "heading", headingLevel: 2 }), el(long(10, "b1"))]);
    expect(groups.map((g) => [g.role, g.paragraphs.length])).toEqual([["title", 1], ["heading", 1], ["body", 2], ["heading", 1], ["body", 1]]);
  });

  it("similar lists in different sections are not combined", () => {
    const { groups } = group([el("A", { kind: "heading", headingLevel: 2 }), list("Item", "same"), el("B", { kind: "heading", headingLevel: 2 }), list("Item", "same")]);
    expect(groups.filter((g) => g.role === "list")).toHaveLength(2);
  });

  it("a document without headings is not swallowed by one block", () => {
    const { groups } = group(Array.from({ length: 6 }, (_, i) => el(long(20, `p${i}`))));
    const bodies = groups.filter((g) => g.role === "body" || g.role === "description");
    expect(bodies.length).toBeGreaterThan(1);
    expect(Math.max(...bodies.map((g) => g.paragraphs.length))).toBeLessThanOrEqual(MAX_BODY_PARAGRAPHS);
  });

  it("page boundaries are context: a broken paragraph is rejoined, a page break alone does not split", () => {
    const page = (p: number) => ({ container: { type: "page" as const, id: `page-${p}` }, page: p });
    const { groups } = group([
      el("Heading", { kind: "heading", headingLevel: 2, ...page(1) }),
      el("The rollout continued across", { ...page(1) }),
      el("all regions by the end of March.", { ...page(2) }),
      el(long(12, "next"), { ...page(2) }),
    ]);
    const body = groups.find((g) => g.role === "body")!;
    expect(body.paragraphs).toEqual(["The rollout continued across all regions by the end of March.", `${long(12, "next")}`]);
    expect(body.evidence).toContain("paragraph continued across a page break");
  });

  it("slides, tables, figures and columns are hard boundaries", () => {
    const slide = (id: string) => ({ container: { type: "slide" as const, id } });
    expect(group([el(long(10, "s1"), slide("1")), el(long(10, "s2"), slide("2"))]).groups.filter((g) => g.role !== "title")).toHaveLength(2);
    const table = { container: { type: "table" as const, id: "t" } };
    const { groups } = group([el(long(20, "before")), el("Plan | Seats", { kind: "table-row", ...table }), el("Team | 25", { kind: "table-row", ...table }), el(long(20, "after"))]);
    expect(groups.map((g) => g.role)).toEqual(["description", "table", "body"]);
    expect(groups[1].paragraphs).toEqual(["Plan | Seats", "Team | 25"]);
    const cols = group([el(long(12, "left"), { container: { type: "column", id: "c1" } }), el(long(12, "right"), { container: { type: "column", id: "c2" } })]);
    expect(cols.groups).toHaveLength(2);
  });

  it("an attribution line joins its quote", () => {
    const { groups } = group([el(long(20)), el("We moved faster than ever this year.", { kind: "quote" }), el("— Maria Lopez")]);
    expect(groups.find((g) => g.role === "quote")).toMatchObject({ attribution: "Maria Lopez" });
  });

  it("no text is lost or duplicated, and noise is reported separately", () => {
    const els = [
      el("Title", { bold: "all" }),
      el(long(20, "intro")),
      el("Section", { kind: "heading", headingLevel: 2 }),
      el(long(12, "a")),
      list("x", "l"),
      list("y", "l", 1),
      el("###"),
      el(long(12, "b")),
      el("Quote text that is long enough to count.", { kind: "quote" }),
      el("— Someone"),
      el("Plan | Seats", { kind: "table-row", container: { type: "table", id: "t" } }),
    ];
    const classified = classifyStructure(els);
    const result = groupElements(classified);
    expect(groupedTexts(result)).toEqual(classified.filter((c) => c.role !== "noise").map((c) => c.text));
    expect(result.skipped.map((c) => c.text)).toEqual(["###"]);
  });

  it("PDF layout: markers start list items and wrapped lines stay inside their item", () => {
    const line = (text: string, y: number, left: number) => ({ text, y, left, right: left + text.length * 5, fontSize: 11 });
    const blocks = groupLines([
      line("Intro sentence before the list.", 700, 72),
      line("• First item that is long enough", 686, 72),
      line("to wrap onto a second line", 672, 82),
      line("• Second item", 658, 72),
      line("– Nested item", 644, 90),
      line("1. Numbered item", 630, 72),
    ]);
    expect(blocks.map((b) => [b.marker ?? null, b.text])).toEqual([
      [null, "Intro sentence before the list."],
      ["•", "First item that is long enough to wrap onto a second line"],
      ["•", "Second item"],
      ["–", "Nested item"],
      ["1.", "Numbered item"],
    ]);
    expect(blocks[1].original).toBe("• First item that is long enough\nto wrap onto a second line");
    expect(listMarker("2026 was a record year.")).toBeNull();
    expect(listMarker("A. Smith said")).toMatchObject({ ordered: true }); // limitation: single-letter numbering is ambiguous
  });
});

// ---------- C. adapters ----------

async function extractAll() {
  return {
    docx: await docxProvider.extract({ bytes: new Uint8Array(await buildStructuredDocx()), fileName: "structure.docx" }),
    html: await htmlProvider.extract({ bytes: new TextEncoder().encode(buildStructuredHtml()), fileName: "structure.html", sourceUrl: "https://example.com/update" }),
    pdf: await pdfProvider.extract({ bytes: new Uint8Array(buildStructuredPdf()), fileName: "structure.pdf" }),
  };
}

/** Blocks that carry source content (not derived, not contained duplicates, not links/SEO). */
const primary = (r: ExtractionResult) => r.blocks.filter((b) => b.origin === "extracted" && !b.containedIn && b.type !== "link" && b.type !== "seo");
const signature = (b: ExtractedBlock) => ({ type: b.type, text: b.text, items: b.items, ordered: b.ordered });
/** Words in primary blocks; a quote written as a paragraph is counted from its full source text. */
const blockWords = (r: ExtractionResult) =>
  primary(r).reduce((sum, b) => sum + countWords(b.type === "quote" && b.source?.sourceText ? b.source.sourceText : b.text), 0);

describe("C. source adapters feed the same pipeline", () => {
  it("equivalent Word, HTML and PDF documents produce the same content blocks", async () => {
    const r = await extractAll();
    const common = (x: ExtractionResult) => primary(x).filter((b) => !(b.type === "body" && b.label === "Table") && b.type !== "caption").map(signature);
    expect(common(r.html)).toEqual(common(r.docx));
    expect(common(r.pdf)).toEqual(common(r.docx));

    const s = STRUCTURE;
    expect(common(r.docx)).toEqual([
      { type: "headline", text: s.title },
      { type: "summary", text: s.intro },
      { type: "subheading", text: s.heading1 },
      { type: "body", text: s.para1 },
      { type: "list", text: s.bullets.map((b) => b.text).join("\n"), items: s.bullets, ordered: false },
      { type: "body", text: s.closing },
      { type: "subheading", text: s.heading2 },
      { type: "list", text: s.numbered.join("\n"), items: s.numbered.map((text) => ({ text, level: 0 })), ordered: true },
      { type: "body", text: `${s.noteLabel}${s.noteText}` },
    ]);
  });

  it("tables and captions are kept as their own blocks where the format has them", async () => {
    const r = await extractAll();
    for (const x of [r.docx, r.html]) {
      expect(primary(x).find((b) => b.label === "Table")?.text).toBe(STRUCTURE.table.map((row) => row.join(" | ")).join("\n"));
      expect(primary(x).find((b) => b.type === "caption")?.text).toBe(STRUCTURE.caption);
    }
  });

  it("the title comes from bold (Word, HTML) or font size (PDF); PDF reports no bold", async () => {
    const r = await extractAll();
    expect(r.docx.blocks[0].evidence).toContain("entirely bold");
    expect(r.html.blocks[0].evidence).toContain("entirely bold");
    expect(r.pdf.blocks[0].evidence?.[0]).toMatch(/font .*× body size/);
  });

  it("keeps PDF provenance: a wrapped bullet is one item, with the verbatim layout text", async () => {
    const r = await extractAll();
    const list = primary(r.pdf).find((b) => b.type === "list")!;
    expect(list.items?.[0].text).toBe(STRUCTURE.bullets[0].text);
    expect(list.source?.sourceText).toContain("• Faster report builder");
  });

  it("no source text is lost or duplicated, in any format", async () => {
    const r = await extractAll();
    for (const x of [r.docx, r.html, r.pdf]) expect(blockWords(x)).toBe(x.metadata.wordCount);
    const pressDocx = await docxProvider.extract({ bytes: new Uint8Array(await buildSampleDocx()), fileName: "release.docx" });
    const pressPdf = await pdfProvider.extract({ bytes: new Uint8Array(buildSamplePdf()), fileName: "release.pdf" });
    for (const x of [pressDocx, pressPdf]) expect(blockWords(x)).toBe(x.metadata.wordCount);
  });

  // Real documents: put any .docx, .pdf or .html files in tests/fixtures/samples/ and they are
  // checked here with format-independent invariants (no file-specific expectations).
  const samplesDir = join(__dirname, "fixtures", "samples");
  const samples = existsSync(samplesDir) ? readdirSync(samplesDir).filter((f) => /\.(docx|pdf|html?)$/i.test(f)) : [];
  it.skipIf(samples.length === 0).each(samples)("sample %s: one title at most, grouped lists, no lost text", async (file) => {
    const bytes = new Uint8Array(readFileSync(join(samplesDir, file)));
    const result = /\.pdf$/i.test(file)
      ? await pdfProvider.extract({ bytes, fileName: file })
      : /\.docx$/i.test(file)
        ? await docxProvider.extract({ bytes, fileName: file })
        : await htmlProvider.extract({ bytes, fileName: file, sourceUrl: "https://example.com/sample" });
    const blocks = primary(result);
    expect(blocks.filter((b) => b.type === "headline").length).toBeLessThanOrEqual(1);
    // Adjacent list blocks are only allowed when the source says they are different lists.
    expect(blocks.length).toBeLessThan(Math.max(4, result.metadata.wordCount / 8));
    // Small tolerance for page furniture (page numbers, end markers) that is deliberately dropped.
    expect(Math.abs(blockWords(result) - result.metadata.wordCount)).toBeLessThanOrEqual(Math.max(3, result.metadata.wordCount * 0.02));
  });
});

describe("whiteboard and mapping with grouped content", () => {
  const apply = (ws: Workspace, ...actions: WorkspaceAction[]) => actions.reduce(workspaceReducer, ws);
  async function structureWorkspace() {
    return createWorkspace((await extractAll()).docx);
  }
  const firstOf = (ws: Workspace, type: ContentCard["type"]) => ws.cards.find((c) => c.type === type)!;

  it("list cards keep individually editable items; editing one item updates the card text", async () => {
    let ws = await structureWorkspace();
    const list = firstOf(ws, "list");
    expect(list.items).toHaveLength(5);
    const items = list.items!.map((i, n) => (n === 1 ? { ...i, text: "Scheduled exports to any cloud storage" } : i));
    ws = apply(ws, { type: "update-card", id: list.id, patch: { items } });
    const updated = ws.cards.find((c) => c.id === list.id)!;
    expect(updated.text.split("\n")[1]).toBe("Scheduled exports to any cloud storage");
    expect(updated.items?.[2]).toEqual({ text: "Weekly and monthly schedules", level: 1 });
    expect(updated.edited).toBe(true);
  });

  it("authors can correct the type: list <-> body keeps every item or paragraph", async () => {
    let ws = await structureWorkspace();
    const list = firstOf(ws, "list");
    ws = apply(ws, { type: "update-card", id: list.id, patch: { type: "body" } });
    const asBody = ws.cards.find((c) => c.id === list.id)!;
    expect(asBody.items).toBeUndefined();
    expect(asBody.text.split("\n\n")).toEqual(STRUCTURE.bullets.map((b) => b.text));
    expect(asBody.edited).toBe(false);
    ws = apply(ws, { type: "update-card", id: list.id, patch: { type: "list" } });
    expect(ws.cards.find((c) => c.id === list.id)!.items?.map((i) => i.text)).toEqual(STRUCTURE.bullets.map((b) => b.text));
  });

  it("split and merge regroup content without losing or rewriting text", async () => {
    let ws = await structureWorkspace();
    const list = firstOf(ws, "list");
    ws = apply(ws, { type: "split-card", id: list.id, at: 2, newId: "second" });
    const second = ws.cards.find((c) => c.id === "second")!;
    expect(second.items?.map((i) => i.text)).toEqual(["Weekly and monthly schedules", "CSV and XLSX formats", "Role-based dashboards for store managers"]);
    // Stored levels are kept; displays start the new list at level 0.
    expect(displayLevels(second.items!)).toEqual([0, 0, 0]);
    ws = apply(ws, { type: "merge-cards", id: list.id });
    // Split followed by merge restores the original items and nesting exactly.
    expect(ws.cards.find((c) => c.id === list.id)!.items).toEqual(STRUCTURE.bullets);
    expect(ws.cards.find((c) => c.id === list.id)!.origin).toBe("extracted");
    // Different types are never merged.
    const heading = firstOf(ws, "subheading");
    expect(apply(ws, { type: "merge-cards", id: heading.id })).toBe(ws);
  });

  it("rich text output keeps paragraphs and nested lists", async () => {
    const ws = await structureWorkspace();
    const field = { name: "Body", type: "Rich Text" as const, required: false };
    const value = buildFieldValue(field, { kind: "article" }, ws, "live").value!;
    expect(value).toContain("<ul><li>Faster report builder");
    expect(value).toContain("<li>Scheduled exports to cloud storage<ul><li>Weekly and monthly schedules</li><li>CSV and XLSX formats</li></ul></li>");
    expect(value).toContain("<ol><li>Review the updated permission settings</li>");
    expect(listToHtml([{ text: "a", level: 0 }, { text: "b", level: 3 }, { text: "c", level: 0 }])).toBe("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
  });

  it("the bundled demo sample still builds a workspace and article", () => {
    const ws = createWorkspace(createSampleExtraction());
    const value = buildFieldValue({ name: "Body", type: "Rich Text", required: false }, { kind: "article" }, ws, "demo").value!;
    expect(value).toContain("<h2>Availability and pricing</h2>");
  });
});

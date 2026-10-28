import type { DocumentMetadata, ExtractedBlock, SourceRef } from "../types/extraction";
import { createId } from "../utils/id";
import { extractQuote, isStatisticSentence } from "./detectors";
import { classifyStructure } from "./structure/classify";
import { groupElements, type ContentGroup } from "./structure/group";
import type { SourceLink, StructuredDocument } from "./structure/model";
import { collapseLines, findUrls, isSafeHref, splitSentences, truncateAtWord } from "./text";

export { extractQuote, isCallToAction, isStatisticSentence } from "./detectors";

/**
 * Builds whiteboard blocks from a normalized document, for every source format:
 *   adapter → StructuredDocument → classifyStructure → groupElements → blocks (here)
 * Everything produced is either verbatim source text ("extracted") or a mechanical
 * transformation of it ("derived"). Body blocks hold their paragraphs separated by a blank line;
 * list blocks hold their items in `items` (and one per line in `text`).
 */

const MAX_STATISTICS = 12;
const MAX_LINKS = 30;

function sourceOf(group: ContentGroup): SourceRef {
  const first = group.members[0].element;
  const last = group.members[group.members.length - 1].element;
  const location = first.location === last.location || group.members.length === 1 ? first.location : `${first.location} – ${last.location}`;
  // Original text with the source's own line breaks, when it differs from the presented text.
  const original = group.members.map((m) => (m.element.sourceText ?? m.element.text).trim()).join("\n\n");
  const presented = group.paragraphs.length ? group.paragraphs.join("\n\n") : group.members.map((m) => m.text).join("\n");
  return { page: first.page, location, ...(original !== presented ? { sourceText: original } : {}) };
}

export function buildContentBlocks(doc: StructuredDocument, metadata: Pick<DocumentMetadata, "keywords">): ExtractedBlock[] {
  const { groups } = groupElements(classifyStructure(doc.elements));
  const blocks: ExtractedBlock[] = [];
  let statCount = 0;
  const push = (block: Omit<ExtractedBlock, "id">): ExtractedBlock => {
    const full = { id: createId("blk"), ...block };
    blocks.push(full);
    return full;
  };
  const meta = (g: ContentGroup) => ({ confidence: Math.round(g.confidence * 100) / 100, evidence: g.evidence, section: g.section });

  /** Statistics inside a block's sentences, as derived blocks pointing at their container. */
  const addStatistics = (container: ExtractedBlock, texts: string[]) => {
    for (const text of texts) {
      for (const sentence of splitSentences(text)) {
        if (statCount >= MAX_STATISTICS) return;
        if (isStatisticSentence(sentence)) {
          statCount++;
          push({ type: "statistic", text: sentence, origin: "extracted", containedIn: container.id, source: { ...container.source, sourceText: text } });
        }
      }
    }
  };

  for (const g of groups) {
    const source = sourceOf(g);
    switch (g.role) {
      case "title":
        push({ type: "headline", text: g.paragraphs[0], origin: "extracted", source, ...meta(g) });
        break;
      case "heading":
        push({ type: "subheading", text: g.paragraphs[0], origin: "extracted", source, ...meta(g) });
        break;
      case "caption":
        push({ type: "caption", text: g.paragraphs[0], origin: "extracted", source, ...meta(g) });
        break;
      case "cta": {
        const href = findUrls(g.paragraphs[0]).find(isSafeHref);
        push({ type: "cta", text: g.paragraphs[0], origin: "extracted", href, source, ...meta(g) });
        break;
      }
      case "quote": {
        const raw = g.paragraphs[0];
        const inner = extractQuote(raw);
        const fromBlockquote = g.members[0].element.kind === "quote";
        push({
          type: "quote",
          text: fromBlockquote ? raw.replace(/^[“"]|[”"]$/g, "").trim() : (inner?.quoted ?? raw),
          attribution: g.attribution ?? inner?.attribution,
          origin: "extracted",
          source: { ...source, sourceText: g.members.map((m) => m.element.text.trim()).join("\n") },
          ...meta(g),
        });
        break;
      }
      case "list": {
        const items = (g.items ?? []).map((i) => ({ text: i.text, level: i.level }));
        const block = push({ type: "list", text: items.map((i) => i.text).join("\n"), items, ordered: g.ordered, origin: "extracted", source, ...meta(g) });
        addStatistics(block, items.map((i) => i.text));
        break;
      }
      case "table":
        push({ type: "body", label: "Table", text: g.paragraphs.join("\n"), origin: "extracted", source, ...meta(g) });
        break;
      case "description":
      case "body": {
        const text = g.paragraphs.join("\n\n");
        const block = push({
          type: g.role === "description" ? "summary" : "body",
          ...(g.role === "description" ? { label: g.evidence.some((e) => e.startsWith("paragraph under")) ? "Summary section" : "Description" } : {}),
          text,
          origin: "extracted",
          source,
          ...meta(g),
        });
        for (const paragraph of g.paragraphs) {
          const quote = extractQuote(paragraph);
          if (quote) {
            push({ type: "quote", text: quote.quoted, attribution: quote.attribution, origin: "extracted", containedIn: block.id, source: { ...source, sourceText: paragraph } });
          }
        }
        addStatistics(block, g.paragraphs);
        break;
      }
    }
  }

  // Links: explicit hyperlinks first, then URLs written in the text.
  const seen = new Set<string>();
  const linkCandidates: SourceLink[] = [...doc.links];
  for (const el of doc.elements) {
    for (const url of findUrls(el.text)) linkCandidates.push({ href: url, page: el.page, location: el.location });
  }
  for (const link of linkCandidates) {
    if (seen.size >= MAX_LINKS) break;
    if (!isSafeHref(link.href)) continue;
    const key = link.href.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const label = link.text && collapseLines(link.text) !== link.href ? collapseLines(link.text) : undefined;
    push({ type: "link", text: label ?? link.href, href: link.href, origin: "extracted", source: { page: link.page, location: link.location } });
  }

  // SEO metadata: derived from extracted text, never presented as source text.
  const headline = blocks.find((b) => b.type === "headline");
  if (headline) {
    push({ type: "seo", label: "Meta title", text: truncateAtWord(headline.text, 60), origin: "derived", source: { location: "Derived from headline" } });
  }
  const summary = blocks.find((b) => b.type === "summary");
  const descriptionBase = summary ?? blocks.find((b) => b.type === "body" && !b.label);
  if (descriptionBase) {
    const firstParagraph = descriptionBase.text.split("\n\n")[0];
    push({
      type: "seo",
      label: "Meta description",
      text: truncateAtWord(collapseLines(firstParagraph), 155),
      origin: "derived",
      source: { location: `Derived from ${descriptionBase.type === "summary" ? "description" : "first paragraph"}` },
    });
  }
  if (metadata.keywords) {
    push({ type: "seo", label: "Keywords", text: metadata.keywords, origin: "extracted", source: { location: "Document properties" } });
  }
  return blocks;
}

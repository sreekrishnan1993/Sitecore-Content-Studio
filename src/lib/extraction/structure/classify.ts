import { collapseLines, countWords } from "../text";
import { END_MARKER, extractQuote, isCallToAction, SUMMARY_HEADING } from "../detectors";
import type { SourceElement } from "./model";

// Shared structural classification. Assigns a role to every normalized element from combined
// evidence: semantic kind, typography relative to the document, position and the neighbouring
// elements. No single signal decides on its own (bold alone never makes a title or heading).
// Every decision carries a confidence and the evidence behind it, so it can be explained and
// corrected on the whiteboard.

export type StructuralRole =
  | "title"
  | "heading"
  | "description"
  | "body"
  | "list-item"
  | "quote"
  | "attribution"
  | "caption"
  | "cta"
  | "table-row"
  /** Page furniture such as "###" or bare page numbers. Kept with evidence, not turned into content. */
  | "noise";

export interface ClassifiedElement {
  element: SourceElement;
  /** Index in the normalized element list (reading order). */
  index: number;
  /** Text with line breaks collapsed, for presentation. element.text keeps the original. */
  text: string;
  role: StructuralRole;
  /** Heading level; 1 is the highest. */
  level?: number;
  /** 0–1. Heuristic, not a probability: high = explicit semantics, low = position only. */
  confidence: number;
  evidence: string[];
}

const DESCRIPTION_MIN_WORDS = 12;
const TITLE_SEARCH_WINDOW = 4;
const CAPTION_PATTERN = /^(figure|fig\.|table|image|photo|chart|exhibit|graph|diagram)\s*\d+[a-z]?\s*[:.—–-]/i;

/** Font size carrying the most text: the document's body size. undefined when no element reports a size. */
export function bodyFontSize(elements: SourceElement[]): number | undefined {
  const weights = new Map<number, number>();
  for (const el of elements) {
    if (el.fontSize === undefined) continue;
    const size = Math.round(el.fontSize * 2) / 2;
    weights.set(size, (weights.get(size) ?? 0) + el.text.length);
  }
  let best: number | undefined;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

/** A short, unpunctuated line: the shape of a title or heading (not sufficient on its own). */
function isHeadingShaped(text: string): boolean {
  const words = countWords(text);
  return words >= 1 && words <= 20 && text.length <= 160 && !/[.,;:!?]$/.test(text);
}

interface Emphasis {
  explicitHeading: boolean;
  relativeSize?: number;
  bold: boolean;
  signals: string[];
}

function emphasisOf(el: SourceElement, body: number | undefined): Emphasis {
  const signals: string[] = [];
  const explicitHeading = el.kind === "heading";
  if (explicitHeading) signals.push(el.headingLevel ? `explicit heading level ${el.headingLevel}` : "explicit heading");
  const relativeSize = el.fontSize !== undefined && body ? el.fontSize / body : undefined;
  if (relativeSize !== undefined && relativeSize >= 1.15) signals.push(`font ${relativeSize.toFixed(2)}× body size`);
  const bold = el.bold === "all";
  if (bold) signals.push("entirely bold");
  return { explicitHeading, relativeSize, bold, signals };
}

/** True when the element stands out typographically or semantically. */
const emphasized = (e: Emphasis) => e.explicitHeading || (e.relativeSize ?? 1) >= 1.15 || e.bold;

export function classifyStructure(elements: SourceElement[]): ClassifiedElement[] {
  const body = bodyFontSize(elements);
  const items: ClassifiedElement[] = [];
  elements.forEach((element, index) => {
    const text = collapseLines(element.text);
    if (!text) return;
    items.push({ element, index, text, role: "body", confidence: 0.5, evidence: [] });
  });
  const content = (i: number) => items.slice(i + 1).find((c) => c.role !== "noise");
  const emphasis = items.map((c) => emphasisOf(c.element, body));

  // 1. Roles the source states explicitly, and page furniture.
  for (const [i, c] of items.entries()) {
    const el = c.element;
    if (el.kind !== "list-item" && el.kind !== "table-row" && END_MARKER.test(c.text)) {
      Object.assign(c, { role: "noise", confidence: 0.9, evidence: ["end marker or page number"] });
    } else if (el.kind === "table-row") {
      Object.assign(c, { role: "table-row", confidence: 0.95, evidence: ["table row in the source"] });
    } else if (el.kind === "list-item") {
      Object.assign(c, { role: "list-item", level: el.list?.level ?? 0, confidence: 0.95, evidence: [el.list?.marker ? `list item (marker "${el.list.marker}")` : "list item in the source"] });
    } else if (el.kind === "caption" || /^caption$/i.test(el.styleName ?? "")) {
      Object.assign(c, { role: "caption", confidence: 0.95, evidence: ["caption in the source"] });
    } else if (el.kind === "quote") {
      Object.assign(c, { role: "quote", confidence: 0.95, evidence: ["block quote in the source"] });
    } else if (el.titleStyle) {
      Object.assign(c, { role: "title", level: 1, confidence: 0.98, evidence: ["title style in the source"] });
    } else if (el.kind === "heading") {
      Object.assign(c, { role: "heading", level: el.headingLevel ?? 2, confidence: 0.95, evidence: [...emphasis[i].signals] });
    }
  }

  // 2. Document title: the strongest emphasized, heading-shaped element at the start of the
  //    document, followed by content. Position alone gives a low-confidence title.
  if (!items.some((c) => c.role === "title")) {
    const firstProse = items.findIndex((c) => c.role === "body" && countWords(c.text) >= 25);
    const window = items.slice(0, Math.min(TITLE_SEARCH_WINDOW, firstProse < 0 ? TITLE_SEARCH_WINDOW : Math.max(firstProse, 1)));
    let best: { c: ClassifiedElement; score: number; evidence: string[] } | undefined;
    for (const c of window) {
      if ((c.role !== "body" && c.role !== "heading") || !isHeadingShaped(c.text)) continue;
      const e = emphasis[items.indexOf(c)];
      const next = content(items.indexOf(c));
      const evidence = [...e.signals];
      let score = 0;
      if (e.explicitHeading) score += c.element.headingLevel === 1 ? 3 : 2;
      if ((e.relativeSize ?? 1) >= 1.5) score += 3;
      else if ((e.relativeSize ?? 1) >= 1.15) score += 2;
      if (e.bold) score += 1;
      if (c === items.find((x) => x.role !== "noise")) {
        score += 1;
        evidence.push("first element of the document");
      }
      if (next && (next.role === "body" || next.role === "list-item") && countWords(next.text) > countWords(c.text)) {
        score += 1;
        evidence.push("followed by longer content");
      }
      if (!best || score > best.score) best = { c, score, evidence };
    }
    if (best) {
      const strong = emphasized(emphasis[items.indexOf(best.c)]);
      if (strong && best.score >= 3) {
        Object.assign(best.c, { role: "title", level: 1, confidence: Math.min(0.95, 0.45 + best.score * 0.1), evidence: best.evidence });
      } else if (!strong && best.score >= 2 && best.c === items.find((x) => x.role !== "noise")) {
        // Plain text (e.g. pasted): position is the only evidence. Keep it, but say so.
        Object.assign(best.c, { role: "title", level: 1, confidence: 0.4, evidence: [...best.evidence, "no formatting evidence: uncertain"] });
      }
    }
  }

  // 3. Implicit section headings: heading-shaped AND emphasized AND introducing content.
  //    A short paragraph without emphasis is body text, wherever it appears.
  for (const [i, c] of items.entries()) {
    if (c.role !== "body" || !isHeadingShaped(c.text)) continue;
    const e = emphasis[i];
    if (!emphasized(e)) continue;
    const next = content(i);
    if (!next || next.role === "noise") continue;
    const nextEmphasized = isHeadingShaped(next.text) && emphasized(emphasis[items.indexOf(next)]) && next.role === "body";
    if (nextEmphasized && countWords(next.text) <= countWords(c.text) + 3) {
      // Two emphasized lines in a row with nothing between: likely a wrapped heading or a label pair.
      c.evidence = ["emphasized, but not followed by content"];
      continue;
    }
    const large = (e.relativeSize ?? 1) >= 1.15;
    Object.assign(c, {
      role: "heading",
      level: (e.relativeSize ?? 1) >= 1.5 ? 2 : 3,
      confidence: large && e.bold ? 0.85 : large ? 0.75 : 0.65,
      evidence: [...e.signals, "short line introducing the following content"],
    });
  }

  // 4. Quotes and calls to action written as paragraphs; attribution lines after block quotes.
  for (const [i, c] of items.entries()) {
    if (c.role === "quote") {
      const next = items[i + 1];
      if (next && next.role === "body" && /^[—–-]\s*\S/.test(next.text) && next.text.length < 140) {
        Object.assign(next, { role: "attribution", confidence: 0.85, evidence: ["dash-prefixed line after a quote"] });
      }
      continue;
    }
    if (c.role !== "body") continue;
    if (isCallToAction(c.text)) {
      Object.assign(c, { role: "cta", confidence: 0.7, evidence: ["call-to-action wording"] });
      continue;
    }
    const quote = extractQuote(c.text);
    if (quote && quote.quoted.length >= c.text.length * 0.5) {
      Object.assign(c, { role: "quote", confidence: 0.75, evidence: ["mostly quoted speech"] });
      continue;
    }
    if (CAPTION_PATTERN.test(c.text) && c.text.length <= 200) {
      Object.assign(c, { role: "caption", confidence: 0.7, evidence: ["starts like a figure or table caption"] });
    }
  }

  // 5. Description: an explicit summary section, otherwise the first substantial paragraph after
  //    the title and before the first section heading (a subtitle counts even when short).
  const summaryHeadings = items.filter((c) => c.role === "heading" && SUMMARY_HEADING.test(c.text));
  if (summaryHeadings.length) {
    for (const h of summaryHeadings) {
      for (let i = items.indexOf(h) + 1; i < items.length && items[i].role !== "heading" && items[i].role !== "title"; i++) {
        if (items[i].role === "body") Object.assign(items[i], { role: "description", confidence: 0.9, evidence: [`paragraph under "${h.text}"`] });
      }
    }
  } else {
    const titleIndex = items.findIndex((c) => c.role === "title");
    for (let i = titleIndex + 1; i < items.length; i++) {
      const c = items[i];
      if (c.role === "heading") break;
      if (c.role !== "body") continue;
      const subtitle = /^subtitle$/i.test(c.element.styleName ?? "");
      if (subtitle || countWords(c.text) >= DESCRIPTION_MIN_WORDS) {
        const adjacent = i === titleIndex + 1;
        Object.assign(c, {
          role: "description",
          confidence: subtitle ? 0.9 : adjacent && titleIndex >= 0 ? 0.75 : 0.55,
          evidence: [subtitle ? "subtitle style" : titleIndex >= 0 ? "first paragraph after the title" : "first substantial paragraph", ...(c.element.bold === "partial" ? ["inline bold is emphasis, not structure"] : [])],
        });
      }
      break;
    }
  }

  // 6. Everything else is body text; explain the common near-misses.
  for (const [i, c] of items.entries()) {
    if (c.role !== "body" || c.evidence.length) continue;
    if (c.element.bold === "partial") c.evidence = ["paragraph with inline bold (emphasis, not structure)"];
    else if (isHeadingShaped(c.text) && !emphasized(emphasis[i])) c.evidence = ["short line without heading formatting"];
    else c.evidence = ["paragraph"];
    c.confidence = c.element.kind === "paragraph" ? 0.7 : 0.5;
  }
  return items;
}

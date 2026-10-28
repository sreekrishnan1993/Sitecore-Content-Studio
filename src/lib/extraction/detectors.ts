import { findUrls } from "./text";

// Text-level detectors shared by structural classification and block building. They look at the
// wording of a single element only; structure and context are handled in structure/.

export const SUMMARY_HEADING = /^(executive summary|summary|overview|abstract|key takeaways|highlights|at a glance)[:.]?$/i;
export const END_MARKER = /^(#{3}|-?\s*ends?\s*-?|\*{3}|page \d+( of \d+)?|\d{1,3})$/i;
const CTA_VERB = /\b(visit|learn more|find out more|register|sign up|download|contact us|get started|book a demo|request a demo|read more|join us|subscribe|apply now|shop now|try it)\b/i;
const CTA_LEAD = /^(please\s+)?(visit|learn|find out|register|sign up|download|contact|get started|book|request|read|join|subscribe|apply|shop|try)\b/i;
const STAT_PATTERNS = [
  /\d[\d,.]*\s?(%|percent\b|per cent\b)/i,
  /[$€£¥]\s?\d/,
  /\b\d[\d,.]*\s?(million|billion|trillion|thousand|bn)\b/i,
  /\b\d+(\.\d+)?x\b/i,
  /\b\d{1,3}(,\d{3})+\b/,
  /\b\d+\s+(customers|users|employees|countries|markets|locations|partners|clients|members|stores|people|jobs|cities|offices)\b/i,
  /\b(doubled|tripled|quadrupled|halved)\b/i,
];

const ATTRIBUTION_AFTER =
  /(?:said|says|added|explained|noted|commented|stated|according to)\s+((?:[A-Z][\p{L}'’.-]*\s?){1,4}(?:,\s*[^.“”"]{2,90})?)/u;
const ATTRIBUTION_BEFORE =
  /((?:[A-Z][\p{L}'’.-]*\s){0,3}[A-Z][\p{L}'’.-]*(?:,\s*[^,“”"]{2,90},)?)\s+(?:said|says|added|explained|noted|commented|stated)\b/u;

export interface QuoteMatch {
  quoted: string;
  attribution?: string;
}

export function extractQuote(text: string): QuoteMatch | null {
  const segments: string[] = [];
  const pattern = /[“"]([^”"]{20,})[”"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) segments.push(match[1].trim());
  if (segments.length === 0) return null;

  const outside = text.replace(/[“"][^”"]*[”"]/g, " ¶ ");
  const after = ATTRIBUTION_AFTER.exec(outside);
  const before = ATTRIBUTION_BEFORE.exec(outside);
  const raw = after?.[1] ?? before?.[1];
  const attribution = raw?.replace(/[\s,.¶]+$/, "").replace(/\s*¶.*$/, "").trim();
  return { quoted: segments.join(" "), attribution: attribution || undefined };
}

export function isStatisticSentence(sentence: string): boolean {
  return STAT_PATTERNS.some((p) => p.test(sentence));
}

export function isCallToAction(text: string): boolean {
  if (text.length > 300 || !CTA_VERB.test(text)) return false;
  return findUrls(text).length > 0 || CTA_LEAD.test(text) || /for more information/i.test(text);
}

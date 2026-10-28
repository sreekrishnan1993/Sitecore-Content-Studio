export function normalizeWhitespace(text: string): string {
  return text.replace(/ /g, " ").replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

export function collapseLines(text: string): string {
  return normalizeWhitespace(text).replace(/\n/g, " ");
}

export function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return matches ? matches.length : 0;
}

/** Splits text into sentences without breaking on common abbreviations or decimals. */
export function splitSentences(text: string): string[] {
  const protectedText = text.replace(/\b(Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|Co|Corp|St|vs|e\.g|i\.e|U\.S|No)\./g, "$1\u0000");
  return protectedText
    .split(/(?<=[.!?][”"’)]?)\s+(?=[“"‘(A-Z0-9])/)
    .map((s) => s.replace(/\u0000/g, ".").trim())
    .filter(Boolean);
}

/** Truncates at a word boundary and appends an ellipsis when shortened. */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'”)\]]+[^\s<>"'”)\].,;:!?]/gi;

export function findUrls(text: string): string[] {
  const found = text.match(URL_PATTERN) ?? [];
  return found.map((u) => (u.toLowerCase().startsWith("www.") ? `https://${u}` : u));
}

export function isSafeHref(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

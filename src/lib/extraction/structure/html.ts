import { NodeType, parse, type HTMLElement, type Node } from "node-html-parser";
import type { Coverage, SourceContainer, SourceElement, SourceLink, StructuredDocument } from "./model";

// Reads semantic structure from an HTML tree into the normalized representation. Used by every
// adapter whose parser produces HTML (Word via mammoth, web pages). It reports only what the
// markup states: element kinds, heading levels, list nesting and numbering, bold coverage,
// tables, figures and sections. It does not decide what anything *is*.

export interface HtmlStructureOptions {
  /** Location label for the n-th element (1-based). */
  location: (n: number, tag: string) => string;
  /** Resolves and validates an href; undefined to drop the link. */
  resolveHref: (href: string | undefined) => string | undefined;
  /** Optional hook for each emitted element's node (e.g. to collect images in order). */
  onElement?: (node: HTMLElement, location: string) => void;
  /** Class names that mark paragraph styles (e.g. mammoth style mappings). */
  classes?: { title?: string; subtitle?: string; caption?: string };
}

const BLOCK = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "blockquote", "table", "thead", "tbody", "tfoot", "tr",
  "figure", "figcaption", "section", "article", "main", "div", "header", "footer", "aside", "nav", "pre", "dl", "dt", "dd", "hr",
]);

const isElement = (n: Node): n is HTMLElement => n.nodeType === NodeType.ELEMENT_NODE;
const tagOf = (n: HTMLElement) => n.tagName?.toLowerCase() ?? "";
const visible = (s: string) => s.replace(/\s+/g, "");

/** How much of an element's visible text is inside the given inline tags. */
export function coverage(el: HTMLElement, selector: string): Coverage {
  const total = visible(el.text).length;
  if (total === 0) return "none";
  const inner = el.querySelectorAll(selector).filter((x) => !x.parentNode || !(x.parentNode as HTMLElement).closest?.(selector));
  const covered = inner.reduce((sum, x) => sum + visible(x.text).length, 0);
  if (covered === 0) return "none";
  return covered >= total * 0.95 ? "all" : "partial";
}

export function htmlToStructure(container: HTMLElement, options: HtmlStructureOptions): StructuredDocument {
  const elements: SourceElement[] = [];
  const links: SourceLink[] = [];
  let count = 0;
  let listCount = 0;
  let tableCount = 0;
  let regionCount = 0;
  const cls = options.classes ?? {};

  const emit = (node: HTMLElement, text: string, fields: Omit<SourceElement, "text" | "location">, tag = tagOf(node)) => {
    if (!text.trim()) return;
    count++;
    const location = options.location(count, tag);
    elements.push({ text: text.trim(), location, bold: coverage(node, "strong, b"), italic: coverage(node, "em, i"), ...fields });
    for (const a of node.querySelectorAll("a")) {
      const href = options.resolveHref(a.getAttribute("href"));
      if (href) links.push({ href, text: a.text, location });
    }
    options.onElement?.(node, location);
  };

  /** Text of a list item without its nested lists. */
  const ownText = (li: HTMLElement) =>
    li.childNodes
      .filter((c) => !(isElement(c) && (tagOf(c) === "ul" || tagOf(c) === "ol")))
      .map((c) => c.text)
      .join("");

  const walkList = (list: HTMLElement, level: number, listId: string, container?: SourceContainer) => {
    const ordered = tagOf(list) === "ol";
    for (const li of list.childNodes.filter(isElement)) {
      if (tagOf(li) !== "li") continue;
      emit(li, ownText(li), { kind: "list-item", list: { listId, level, ordered }, container });
      for (const nested of li.childNodes.filter(isElement)) {
        if (tagOf(nested) === "ul" || tagOf(nested) === "ol") walkList(nested, level + 1, listId, container);
      }
    }
  };

  const walk = (node: HTMLElement, container?: SourceContainer) => {
    let inline: Node[] = [];
    const flushInline = () => {
      const text = inline.map((n) => n.text).join("");
      if (text.trim()) {
        // Loose text between blocks: wrap it so formatting can still be measured.
        const holder = parse("<p></p>").firstChild as HTMLElement;
        inline.forEach((n) => holder.appendChild(n.clone()));
        emit(holder, text, { kind: "paragraph", container }, "text");
      }
      inline = [];
    };

    for (const child of node.childNodes) {
      if (!isElement(child)) {
        if (child.nodeType === NodeType.TEXT_NODE) inline.push(child);
        continue;
      }
      const tag = tagOf(child);
      if (!BLOCK.has(tag)) {
        inline.push(child);
        continue;
      }
      flushInline();
      const classes = (child.getAttribute("class") ?? "").split(/\s+/);
      if (/^h[1-6]$/.test(tag)) {
        emit(child, child.text, { kind: "heading", headingLevel: Number(tag[1]), titleStyle: cls.title ? classes.includes(cls.title) : undefined, container });
      } else if (tag === "p" || tag === "pre" || tag === "dt" || tag === "dd") {
        if (cls.caption && classes.includes(cls.caption)) emit(child, child.text, { kind: "caption", styleName: "Caption", container });
        else emit(child, child.text, { kind: "paragraph", styleName: cls.subtitle && classes.includes(cls.subtitle) ? "Subtitle" : undefined, container });
      } else if (tag === "ul" || tag === "ol") {
        walkList(child, 0, `list-${++listCount}`, container);
      } else if (tag === "li") {
        // A list item outside a list element: still a list item, its own list.
        emit(child, ownText(child), { kind: "list-item", list: { listId: `list-${++listCount}`, level: 0 }, container });
      } else if (tag === "blockquote") {
        const paragraphs = child.querySelectorAll("p");
        if (paragraphs.length) paragraphs.forEach((p) => emit(p, p.text, { kind: "quote", container }));
        else emit(child, child.text, { kind: "quote", container });
      } else if (tag === "table") {
        const table: SourceContainer = { type: "table", id: `table-${++tableCount}` };
        for (const tr of child.querySelectorAll("tr")) {
          const cells = tr.querySelectorAll("td, th").map((c) => c.text.trim()).filter(Boolean);
          if (cells.length) emit(tr, cells.join(" | "), { kind: "table-row", cells, container: table }, "tr");
        }
      } else if (tag === "figcaption") {
        emit(child, child.text, { kind: "caption", container });
      } else if (tag === "figure" || tag === "section" || tag === "aside") {
        walk(child, { type: tag === "figure" ? "figure" : "section", id: `${tag}-${++regionCount}` });
      } else if (tag === "hr") {
        continue;
      } else {
        // div, article, main, header, footer, nav, dl, thead/tbody/tr outside a table: structural wrappers.
        walk(child, container);
      }
    }
    flushInline();
  };

  walk(container);
  return { elements, links };
}

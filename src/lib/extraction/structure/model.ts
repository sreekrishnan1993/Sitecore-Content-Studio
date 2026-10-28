// Format-agnostic intermediate representation.
//
// Source adapters (Word, PDF, HTML, future formats) report what the source *says* about each
// element: its semantic kind, explicit heading level, list membership, formatting and container.
// They do not decide what the content *is*; that is done once, for every format, by the shared
// classification (classify.ts) and grouping (group.ts) stages.
//
// Every optional property means "the source did not provide this". Adapters must leave a
// property undefined rather than guess it (e.g. PDF text has no reliable bold information).

/** What the source explicitly declares an element to be. "paragraph" when it declares nothing. */
export type SourceKind = "heading" | "paragraph" | "list-item" | "quote" | "caption" | "table-row";

/** How much of an element's text carries a formatting property. */
export type Coverage = "all" | "partial" | "none";

export interface SourceList {
  /** Elements with the same listId belong to one list in the source. */
  listId: string;
  /** 0 = top level. */
  level: number;
  /** true for numbered lists; undefined when the source does not say. */
  ordered?: boolean;
  /** The bullet or number as written in the source (e.g. "•", "1."), when known. */
  marker?: string;
}

export interface SourceContainer {
  /**
   * page/slide: physical boundaries (a page break is context, a slide is a unit of its own).
   * table/figure/column/section: regions whose content must not be merged with neighbours.
   */
  type: "page" | "slide" | "section" | "table" | "figure" | "column";
  id: string;
}

export interface SourceElement {
  /** Text as extracted, with the source's line breaks. Never rewritten by later stages. */
  text: string;
  /**
   * Verbatim source text when the adapter had to normalize `text` (e.g. a list marker moved to
   * `list.marker`, or a word hyphenated across lines joined). Omitted when identical.
   */
  sourceText?: string;
  kind: SourceKind;
  /** Explicit heading level (1–6) from the source's semantics (h1–h6, Word "Heading N"). */
  headingLevel?: number;
  /** The source explicitly marks this as the document title (e.g. Word "Title" style). */
  titleStyle?: boolean;
  /** Named paragraph style, when the source has one (e.g. "Subtitle", "Caption"). */
  styleName?: string;
  list?: SourceList;
  bold?: Coverage;
  italic?: Coverage;
  /** Font size in points (layout sources such as PDF). */
  fontSize?: number;
  /** Innermost container, if any. */
  container?: SourceContainer;
  /** For "table-row": the cell texts. */
  cells?: string[];
  /** 1-based page or slide number, when the source has pages. */
  page?: number;
  /** Human-readable location, e.g. "Paragraph 4" or "Page 2, block 3". */
  location: string;
}

export interface SourceLink {
  href: string;
  text?: string;
  page?: number;
  location?: string;
}

/** What every adapter hands to the shared pipeline. */
export interface StructuredDocument {
  elements: SourceElement[];
  links: SourceLink[];
}

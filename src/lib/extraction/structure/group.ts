import type { ClassifiedElement } from "./classify";
import type { SourceElement } from "./model";

// Shared grouping. Combines classified elements into logical, editable content blocks:
// - a title or heading starts a new section and is its own block;
// - consecutive list items of one list form one list block, keeping each item and its level;
// - consecutive body paragraphs of a section form one body block (bounded, so a document
//   without headings is not swallowed by a single block);
// - quotes, captions and calls to action stay separate; an attribution line joins its quote;
// - table rows of one table form one table block and are never merged with prose;
// - page boundaries are context: a paragraph broken across pages is rejoined, and a page break
//   alone does not split a section. Slides, columns, figures and sections are hard boundaries.
// Grouping never rewrites text: every member keeps its original element.

export type GroupRole = "title" | "heading" | "description" | "body" | "list" | "quote" | "caption" | "cta" | "table";

export interface GroupedListItem {
  text: string;
  /** 0 = top level, relative to the list's shallowest item. */
  level: number;
  members: ClassifiedElement[];
}

export interface ContentGroup {
  role: GroupRole;
  /** Elements in reading order. Every non-noise element belongs to exactly one group. */
  members: ClassifiedElement[];
  /** Increments at every title or heading. */
  section: number;
  level?: number;
  /** Body, description and table groups: one entry per paragraph or row. */
  paragraphs: string[];
  /** List groups only. */
  items?: GroupedListItem[];
  ordered?: boolean;
  attribution?: string;
  confidence: number;
  evidence: string[];
}

export interface GroupingResult {
  groups: ContentGroup[];
  /** Noise elements (end markers, page numbers): kept here, not turned into content. */
  skipped: ClassifiedElement[];
}

export const MAX_BODY_PARAGRAPHS = 4;
export const MAX_BODY_CHARS = 1500;

/** Containers that separate content. Pages are deliberately not one of them. */
function region(el: SourceElement): string {
  const c = el.container;
  return c && c.type !== "page" ? `${c.type}:${c.id}` : "flow";
}

/** A paragraph broken by a page boundary: no sentence end before, lower-case start after. */
function continuesAcrossPage(prev: ClassifiedElement, next: ClassifiedElement): boolean {
  const pageChanged = prev.element.container?.type === "page" && next.element.container?.type === "page" && prev.element.container.id !== next.element.container.id;
  return pageChanged && !/[.!?:;"”’)\]]$/.test(prev.text) && /^[a-z]/.test(next.text);
}

export function groupElements(classified: ClassifiedElement[]): GroupingResult {
  const groups: ContentGroup[] = [];
  const skipped: ClassifiedElement[] = [];
  let section = 0;
  let current: ContentGroup | null = null;

  const open = (c: ClassifiedElement, role: GroupRole, extra: Partial<ContentGroup> = {}): ContentGroup => {
    const group: ContentGroup = { role, members: [c], section, level: c.level, paragraphs: [], confidence: c.confidence, evidence: [...c.evidence], ...extra };
    groups.push(group);
    return group;
  };
  const absorb = (g: ContentGroup, c: ClassifiedElement) => {
    g.members.push(c);
    g.confidence = Math.min(g.confidence, c.confidence);
  };

  for (const c of classified) {
    const last = current;
    const lastMember = last?.members[last.members.length - 1];
    switch (c.role) {
      case "noise":
        skipped.push(c); // does not interrupt the surrounding group
        continue;

      case "title":
      case "heading":
        section++;
        open(c, c.role, { paragraphs: [c.text] });
        current = null; // nothing joins a heading
        continue;

      case "attribution":
        if (last?.role === "quote" && !last.attribution) {
          absorb(last, c);
          last.attribution = c.text.replace(/^[—–-]\s*/, "");
          current = null;
          continue;
        }
        break; // otherwise treated as body below

      case "quote":
      case "caption":
      case "cta":
        open(c, c.role, { paragraphs: [c.text] });
        current = c.role === "quote" ? groups[groups.length - 1] : null;
        continue;

      case "list-item": {
        const list = c.element.list;
        const sameList =
          last?.role === "list" &&
          region(lastMember!.element) === region(c.element) &&
          (list?.listId !== undefined ? lastMember!.element.list?.listId === list.listId : lastMember!.element.list?.listId === undefined);
        if (sameList) {
          absorb(last!, c);
          last!.items!.push({ text: c.text, level: list?.level ?? 0, members: [c] });
        } else {
          current = open(c, "list", { ordered: list?.ordered, items: [{ text: c.text, level: list?.level ?? 0, members: [c] }], evidence: [...c.evidence] });
        }
        continue;
      }

      case "table-row": {
        const container = c.element.container;
        if (last?.role === "table" && container && lastMember!.element.container?.id === container.id) {
          absorb(last, c);
          last.paragraphs.push(c.text);
        } else {
          current = open(c, "table", { paragraphs: [c.text], evidence: ["table rows"] });
        }
        continue;
      }
    }

    // body, description (and a stray attribution line, as body)
    const role: GroupRole = c.role === "description" ? "description" : "body";
    if (last && lastMember && (last.role === "body" || last.role === "description") && continuesAcrossPage(lastMember, c)) {
      // A paragraph broken by a page boundary stays one paragraph.
      absorb(last, c);
      last.paragraphs[last.paragraphs.length - 1] += ` ${c.text}`;
      if (!last.evidence.includes("paragraph continued across a page break")) last.evidence.push("paragraph continued across a page break");
      continue;
    }
    const joinable =
      last?.role === role &&
      last.section === section &&
      region(lastMember!.element) === region(c.element) &&
      last.paragraphs.length < MAX_BODY_PARAGRAPHS &&
      last.paragraphs.join("").length + c.text.length <= MAX_BODY_CHARS;
    if (joinable) {
      absorb(last!, c);
      last!.paragraphs.push(c.text);
    } else {
      current = open(c, role, { paragraphs: [c.text] });
    }
  }

  // Normalize list levels so every list starts at level 0.
  for (const g of groups) {
    if (!g.items?.length) continue;
    const min = Math.min(...g.items.map((i) => i.level));
    for (const item of g.items) item.level -= min;
    if (g.items.length > 1) g.evidence = [`${g.items.length} consecutive items of one list`, ...(g.items.some((i) => i.level > 0) ? ["nested items keep their level"] : [])];
  }
  return { groups, skipped };
}

/** All member texts of all groups, in order. Used to prove grouping neither loses nor duplicates text. */
export function groupedTexts(result: GroupingResult): string[] {
  return result.groups.flatMap((g) => g.members.map((m) => m.text));
}

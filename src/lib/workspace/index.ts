import type { ContentType, ExtractionResult } from "../types/extraction";
import type { ContentCard, ImageAsset, MappingSource, MappingState, Workspace } from "../types/workspace";
import { sameSitecoreId } from "../sitecore/graphql";
import { createId } from "../utils/id";

/**
 * Applies a mapping change and invalidates what depended on the old value:
 * - a different template drops the old template's field snapshot and field mappings;
 * - a different destination path or site drops the destination verification.
 */
export function applyMappingPatch(prev: MappingState, patch: Partial<Omit<MappingState, "fields">>): MappingState {
  const next: MappingState = { ...prev, ...patch };
  if ("templateId" in patch && !sameSitecoreId(patch.templateId, prev.templateId)) {
    if (!("template" in patch)) next.template = undefined;
    next.fields = {};
  }
  if (next.template && !sameSitecoreId(next.template.id, next.templateId)) next.template = undefined;
  if (!("destinationVerified" in patch)) {
    const pathChanged = "destinationPath" in patch && patch.destinationPath?.trim() !== prev.destinationVerified?.path;
    const siteChanged = "siteId" in patch && patch.siteId !== prev.siteId;
    if (pathChanged || siteChanged) next.destinationVerified = undefined;
  }
  return next;
}

/** `mapping`: selections made before extraction (the site chosen on the Upload page). */
export function createWorkspace(extraction: ExtractionResult, mapping: Omit<MappingState, "fields"> = {}): Workspace {
  const now = new Date().toISOString();
  const cards: ContentCard[] = extraction.blocks.map((b) => ({
    id: b.id,
    type: b.type,
    text: b.text,
    origin: b.origin,
    // Statistics and quotes found inside a paragraph start deselected so the article does not repeat them.
    selected: !b.containedIn,
    source: b.source,
    label: b.label,
    attribution: b.attribution,
    href: b.href,
    items: b.items,
    ordered: b.ordered,
    confidence: b.confidence,
    evidence: b.evidence,
    section: b.section,
    edited: false,
  }));
  const images: ImageAsset[] = extraction.images.map((img) => ({ id: img.id, selected: true, altText: img.sourceAltText ?? "", caption: "" }));
  return { id: createId("ws"), createdAt: now, updatedAt: now, extraction, cards, images, mapping: { ...mapping, fields: {} } };
}

export type CardPatch = Partial<Pick<ContentCard, "text" | "attribution" | "href" | "type" | "label" | "items" | "ordered">>;

/** Paragraphs of a body-like card (separated by a blank line). */
export function cardParagraphs(card: Pick<ContentCard, "text">): string[] {
  return card.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/** Card types that can be merged with a neighbour of the same type, or split. */
export const REGROUPABLE_TYPES = new Set<ContentType>(["body", "summary", "list"]);

/**
 * Keeps a card's representation consistent after a change: list cards always have items and a
 * matching text; changing a list into another type turns its items into paragraphs, and turning
 * paragraphs into a list makes each paragraph (or line) an item.
 */
export function normalizeCard(card: ContentCard): ContentCard {
  if (card.type === "list") {
    const items = card.items ?? card.text.split(/\n+/).map((t) => t.trim()).filter(Boolean).map((text) => ({ text, level: 0 }));
    return { ...card, items, text: items.map((i) => i.text).join("\n") };
  }
  if (card.items) {
    const { items, ...rest } = card;
    return { ...rest, ordered: undefined, text: items.map((i) => i.text).join("\n\n") };
  }
  return card;
}

function mergeSources(a: ContentCard["source"], b: ContentCard["source"]): ContentCard["source"] {
  if (!a || !b) return a ?? b;
  const location = [a.location, b.location].filter(Boolean).join(" + ") || undefined;
  return { page: a.page ?? b.page, location };
}

export type WorkspaceAction =
  | { type: "toggle-card"; id: string }
  | { type: "select-cards"; ids: string[]; selected: boolean }
  | { type: "update-card"; id: string; patch: CardPatch }
  | { type: "add-card"; cardType: ContentType; afterId?: string; id?: string }
  | { type: "duplicate-card"; id: string; newId?: string }
  | { type: "delete-card"; id: string }
  | { type: "restore-card"; card: ContentCard; index: number }
  | { type: "move-card"; id: string; toIndex: number }
  /** Merges a body, summary or list card with the next card of the same type on the board. */
  | { type: "merge-cards"; id: string }
  /** Splits a body/summary card before paragraph `at`, or a list card before item `at`. */
  | { type: "split-card"; id: string; at: number; newId?: string }
  | { type: "update-image"; id: string; patch: Partial<Omit<ImageAsset, "id">> }
  | { type: "set-mapping"; patch: Partial<Omit<MappingState, "fields">> }
  | { type: "set-field-mapping"; field: string; source: MappingSource }
  | { type: "replace-field-mappings"; fields: Record<string, MappingSource> }
  | { type: "mark-draft-saved"; at: string }
  | { type: "mark-created"; itemId: string; path: string; at: string; warnings?: string[] }
  | { type: "set-creation"; creation: Workspace["creation"] };

export function workspaceReducer(ws: Workspace, action: WorkspaceAction): Workspace {
  const next = applyAction(ws, action);
  return next === ws ? ws : { ...next, updatedAt: new Date().toISOString() };
}

function applyAction(ws: Workspace, action: WorkspaceAction): Workspace {
  switch (action.type) {
    case "toggle-card":
      return { ...ws, cards: ws.cards.map((c) => (c.id === action.id ? { ...c, selected: !c.selected } : c)) };
    case "select-cards": {
      const ids = new Set(action.ids);
      return { ...ws, cards: ws.cards.map((c) => (ids.has(c.id) ? { ...c, selected: action.selected } : c)) };
    }
    case "update-card":
      return {
        ...ws,
        cards: ws.cards.map((c) => {
          if (c.id !== action.id) return c;
          const patched = { ...c, ...action.patch };
          // A new type changes the representation (e.g. list items <-> paragraphs); edited text clears stale items.
          if (action.patch.text !== undefined && action.patch.items === undefined && patched.type === "list") delete patched.items;
          const next = normalizeCard(patched);
          const textChanged = next.text !== c.text && !(action.patch.type && action.patch.text === undefined && action.patch.items === undefined);
          const attributionChanged = action.patch.attribution !== undefined && action.patch.attribution !== c.attribution;
          return { ...next, edited: c.edited || textChanged || attributionChanged };
        }),
      };
    case "add-card": {
      const card: ContentCard = { id: action.id ?? createId("card"), type: action.cardType, text: "", origin: "manual", selected: true, edited: false };
      const index = action.afterId ? ws.cards.findIndex((c) => c.id === action.afterId) + 1 : ws.cards.length;
      const cards = [...ws.cards];
      cards.splice(index <= 0 ? cards.length : index, 0, card);
      return { ...ws, cards };
    }
    case "duplicate-card": {
      const index = ws.cards.findIndex((c) => c.id === action.id);
      if (index < 0) return ws;
      const original = ws.cards[index];
      // A copy is the author's own content; it keeps the source reference for traceability.
      const copy: ContentCard = { ...original, id: action.newId ?? createId("card"), origin: "manual", edited: false };
      const cards = [...ws.cards];
      cards.splice(index + 1, 0, copy);
      return { ...ws, cards };
    }
    case "delete-card":
      return { ...ws, cards: ws.cards.filter((c) => c.id !== action.id) };
    case "restore-card": {
      if (ws.cards.some((c) => c.id === action.card.id)) return ws;
      const cards = [...ws.cards];
      cards.splice(Math.min(Math.max(action.index, 0), cards.length), 0, action.card);
      return { ...ws, cards };
    }
    case "move-card": {
      const from = ws.cards.findIndex((c) => c.id === action.id);
      if (from < 0) return ws;
      const to = Math.max(0, Math.min(action.toIndex, ws.cards.length - 1));
      if (from === to) return ws;
      const cards = [...ws.cards];
      const [card] = cards.splice(from, 1);
      cards.splice(to, 0, card);
      return { ...ws, cards };
    }
    case "merge-cards": {
      const index = ws.cards.findIndex((c) => c.id === action.id);
      const a = ws.cards[index];
      const b = ws.cards[index + 1];
      if (!a || !b || a.type !== b.type || !REGROUPABLE_TYPES.has(a.type)) return ws;
      const merged: ContentCard = normalizeCard({
        ...a,
        text: a.type === "list" ? "" : [a.text, b.text].filter((t) => t.trim()).join("\n\n"),
        items: a.type === "list" ? [...(a.items ?? []), ...(b.items ?? [])] : undefined,
        // Joining keeps both texts verbatim, so extracted content stays extracted.
        origin: a.origin === b.origin ? a.origin : "manual",
        edited: a.edited || b.edited,
        selected: a.selected || b.selected,
        source: mergeSources(a.source, b.source),
        confidence: Math.min(a.confidence ?? 1, b.confidence ?? 1),
        evidence: ["merged on the whiteboard"],
      });
      const cards = [...ws.cards];
      cards.splice(index, 2, merged);
      return { ...ws, cards };
    }
    case "split-card": {
      const index = ws.cards.findIndex((c) => c.id === action.id);
      const card = ws.cards[index];
      if (!card || !REGROUPABLE_TYPES.has(card.type)) return ws;
      let first: ContentCard;
      let second: ContentCard;
      if (card.type === "list") {
        const items = card.items ?? [];
        if (action.at <= 0 || action.at >= items.length) return ws;
        // Stored levels are kept as they are, so a later merge restores the original nesting exactly;
        // displays clamp them (see displayLevels).
        first = normalizeCard({ ...card, items: items.slice(0, action.at) });
        second = normalizeCard({ ...card, id: action.newId ?? createId("card"), items: items.slice(action.at) });
      } else {
        const paragraphs = cardParagraphs(card);
        if (action.at <= 0 || action.at >= paragraphs.length) return ws;
        first = { ...card, text: paragraphs.slice(0, action.at).join("\n\n") };
        second = { ...card, id: action.newId ?? createId("card"), text: paragraphs.slice(action.at).join("\n\n") };
      }
      second.evidence = ["split on the whiteboard"];
      first.evidence = ["split on the whiteboard"];
      const cards = [...ws.cards];
      cards.splice(index, 1, first, second);
      return { ...ws, cards };
    }
    case "update-image":
      return { ...ws, images: ws.images.map((i) => (i.id === action.id ? { ...i, ...action.patch } : i)) };
    case "set-mapping":
      return { ...ws, mapping: applyMappingPatch(ws.mapping, action.patch) };
    case "set-field-mapping":
      return { ...ws, mapping: { ...ws.mapping, fields: { ...ws.mapping.fields, [action.field]: action.source } } };
    case "replace-field-mappings":
      return { ...ws, mapping: { ...ws.mapping, fields: action.fields } };
    case "mark-draft-saved":
      return { ...ws, draftSavedAt: action.at };
    case "mark-created":
      return { ...ws, creation: undefined, createdItem: { itemId: action.itemId, path: action.path, createdAt: action.at, warnings: action.warnings } };
    case "set-creation":
      return { ...ws, creation: action.creation };
  }
}

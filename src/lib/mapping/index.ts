import { sameSitecoreId, toImageFieldValue, toSitecoreId } from "../sitecore/graphql";
import type { ExtractedImage, ListItem } from "../types/extraction";
import { cardParagraphs } from "../workspace";
import type { IntegrationMode, SitecoreLanguage, SitecoreSite, SitecoreTemplate, SitecoreTemplateField } from "../types/sitecore";
import type { ContentCard, ImageAsset, MappingSource, MappingState, Workspace } from "../types/workspace";

/**
 * The template the mapping actually refers to: the loaded field snapshot, but only if it belongs
 * to the selected template ID. Mapping, validation, preview and creation all use this.
 */
export function selectedTemplate(mapping: Pick<MappingState, "templateId" | "template">): SitecoreTemplate | undefined {
  return mapping.template && sameSitecoreId(mapping.template.id, mapping.templateId) ? mapping.template : undefined;
}

/** True for example text such as "/sitecore/content/<collection>/<site>/Home". Sitecore item names cannot contain < or >. */
export function isPlaceholderPath(path: string): boolean {
  return /[<>]|…|\.\.\./.test(path);
}

/** Why the destination cannot be used yet, or null. In live mode the path must have been verified in Sitecore. */
export function destinationIssue(mapping: Pick<MappingState, "destinationPath" | "destinationVerified">, mode: IntegrationMode): string | null {
  const path = mapping.destinationPath?.trim();
  if (!path) return "Select a destination (parent item).";
  if (isPlaceholderPath(path)) return "The destination path contains placeholder text such as <collection> or <site>. Enter the real path of an existing parent item.";
  if (!path.toLowerCase().startsWith("/sitecore/content/")) return "The destination must be under /sitecore/content/.";
  if (mode === "live" && mapping.destinationVerified?.path !== path) return "Select the parent item in the content tree before continuing.";
  return null;
}

/**
 * The mapping change for choosing a site (in Template mapping or before a media upload). The parent
 * item and media folder belong to the site's tree, so a different site starts from its own default
 * destination (or none) and its own media folder; a language the site does not use is cleared.
 */
export function siteSelectionPatch(mapping: MappingState, siteId: string, sites: SitecoreSite[] | undefined): Partial<MappingState> {
  const next = sites?.find((s) => s.id === siteId);
  const patch: Partial<MappingState> = { siteId: siteId || undefined, siteName: next?.displayName, siteKey: next?.name };
  if (siteId !== mapping.siteId) Object.assign(patch, { destinationPath: next?.defaultDestination, mediaFolder: undefined });
  if (next && mapping.language && next.languages.length && !next.languages.includes(mapping.language)) patch.language = undefined;
  return patch;
}

/** The languages offered for a site: those it uses, or all when it lists none (or no site is chosen). */
export function siteLanguages(languages: SitecoreLanguage[] | undefined, site: SitecoreSite | undefined): SitecoreLanguage[] {
  return (languages ?? []).filter((l) => !site || site.languages.length === 0 || site.languages.includes(l.code));
}

/**
 * Checks restored selections against what the adapter actually returned. Selections that no
 * longer exist are cleared (never guessed); matching IDs are rewritten in the adapter's format.
 */
export function reconcileMapping(
  mapping: MappingState,
  lists: { sites?: SitecoreSite[]; languages?: SitecoreLanguage[]; templates?: SitecoreTemplate[] },
): { patch: Partial<Omit<MappingState, "fields">>; notices: string[] } | null {
  const patch: Partial<Omit<MappingState, "fields">> = {};
  const notices: string[] = [];
  if (lists.sites && mapping.siteId && !lists.sites.some((s) => s.id === mapping.siteId)) {
    Object.assign(patch, { siteId: undefined, siteName: undefined, siteKey: undefined });
    notices.push(`The previously selected site${mapping.siteName ? ` "${mapping.siteName}"` : ""} is not available here. Select a site.`);
  }
  if (lists.languages && mapping.language && !lists.languages.some((l) => l.code === mapping.language)) {
    patch.language = undefined;
    notices.push(`The previously selected language "${mapping.language}" is not available here. Select a language.`);
  }
  if (lists.templates && mapping.templateId) {
    const match = lists.templates.find((t) => sameSitecoreId(t.id, mapping.templateId));
    if (!match) {
      patch.templateId = undefined;
      notices.push(`The previously selected template${mapping.template?.name ? ` "${mapping.template.name}"` : ""} is not available here. Select a template.`);
    } else if (match.id !== mapping.templateId) {
      patch.templateId = match.id;
    }
  }
  return Object.keys(patch).length ? { patch, notices } : null;
}

export const ARTICLE_TYPES = new Set(["subheading", "body", "list", "quote"]);

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Cards that will be used, in board order. */
export function selectedCards(ws: Pick<Workspace, "cards">): ContentCard[] {
  return ws.cards.filter((c) => c.selected && c.text.trim());
}

/** The ordered article: selected subheadings, paragraphs and quotes (not the headline/summary). */
export function articleCards(ws: Pick<Workspace, "cards">): ContentCard[] {
  return selectedCards(ws).filter((c) => ARTICLE_TYPES.has(c.type));
}

export interface ResolvedSource {
  cards: ContentCard[];
  image?: { asset: ImageAsset; image: ExtractedImage };
  text?: string;
  /** Which card part a single-card source reads. */
  part?: "text" | "attribution" | "href";
}

export function resolveSource(source: MappingSource | undefined, ws: Workspace): ResolvedSource {
  if (!source || source.kind === "none") return { cards: [] };
  switch (source.kind) {
    case "content": {
      const cards = selectedCards(ws).filter((c) => c.type === source.contentType);
      return { cards: source.mode === "first" ? cards.slice(0, 1) : cards };
    }
    case "article":
      return { cards: articleCards(ws) };
    case "card": {
      const card = ws.cards.find((c) => c.id === source.cardId && c.selected);
      return { cards: card ? [card] : [], part: source.part ?? "text" };
    }
    case "image": {
      const asset = ws.images.find((i) => i.id === source.imageId && i.selected);
      const image = ws.extraction.images.find((i) => i.id === source.imageId);
      return { cards: [], image: asset && image ? { asset, image } : undefined };
    }
    case "metadata":
      return { cards: [], text: ws.extraction.metadata[source.key] ?? undefined };
    case "static":
      return { cards: [], text: source.value };
  }
}

function cardPart(card: ContentCard, part: ResolvedSource["part"]): string {
  if (part === "attribution") return card.attribution ?? "";
  if (part === "href") return card.href ?? "";
  return card.text;
}

/**
 * Levels as they can be displayed: re-based so the first item is at level 0, never negative, and
 * at most one level deeper than the item before. Siblings stay siblings. Stored levels are
 * never changed (so splitting and merging a list restores its nesting).
 */
export function displayLevels(items: ListItem[]): number[] {
  const base = items[0]?.level ?? 0;
  const levels: number[] = [];
  for (const item of items) levels.push(Math.max(0, Math.min(item.level - base, (levels[levels.length - 1] ?? -1) + 1)));
  return levels;
}

/** Nested <ul>/<ol> markup for list items with levels. */
export function listToHtml(items: ListItem[], ordered?: boolean): string {
  const tag = ordered ? "ol" : "ul";
  let html = "";
  let depth = -1;
  const levels = displayLevels(items);
  for (const [i, item] of items.entries()) {
    const level = levels[i];
    if (level > depth) html += `<${tag}>`.repeat(level - depth);
    else {
      html += "</li>";
      if (level < depth) html += `</${tag}></li>`.repeat(depth - level);
    }
    html += `<li>${escapeHtml(item.text.trim())}`;
    depth = level;
  }
  if (depth >= 0) html += "</li>" + `</${tag}></li>`.repeat(depth) + `</${tag}>`;
  return html;
}

function toRichText(cards: ContentCard[]): string {
  return cards
    .map((c) => {
      const text = escapeHtml(c.text.trim());
      if (c.type === "list") return listToHtml(c.items ?? [], c.ordered);
      if (c.type === "subheading") return `<h2>${text}</h2>`;
      if (c.type === "quote") {
        const cite = c.attribution ? `<cite>${escapeHtml(c.attribution)}</cite>` : "";
        return `<blockquote><p>${text}</p>${cite}</blockquote>`;
      }
      if ((c.type === "link" || c.type === "cta") && c.href) return `<p><a href="${escapeHtml(c.href)}">${text}</a></p>`;
      // Body cards can hold several paragraphs (separated by a blank line).
      return cardParagraphs(c)
        .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
        .join("\n");
    })
    .join("\n");
}

/** Sitecore date fields use the ISO "yyyyMMddTHHmmssZ" format. */
export function toSitecoreDate(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export interface FieldValue {
  field: SitecoreTemplateField;
  /** Value sent to Sitecore, or null when nothing will be written. */
  value: string | null;
  /** Human readable preview. */
  display: string;
  image?: { asset: ImageAsset; image: ExtractedImage };
  notes: string[];
  /** Set when the mapping cannot produce a valid value for this field type; validation reports it as an error. */
  blocking?: string;
}

/** Field types whose values are IDs, flags or numbers: document text must never be written to them. */
const NON_TEXT_TYPES = new Set(["Reference", "Checkbox", "Number"]);

export function buildFieldValue(field: SitecoreTemplateField, source: MappingSource | undefined, ws: Workspace, mode: IntegrationMode): FieldValue {
  const resolved = resolveSource(source, ws);
  const notes: string[] = [];
  const texts = resolved.cards.map((c) => cardPart(c, resolved.part).trim()).filter(Boolean);
  if (resolved.text?.trim()) texts.push(resolved.text.trim());

  if (source?.kind === "image" && field.type !== "Image") {
    return { field, value: null, display: "", notes, blocking: `"${field.name}" is a ${field.rawType ?? field.type} field. Images can only be mapped to Image fields.` };
  }

  if (NON_TEXT_TYPES.has(field.type) || field.type === "Other") {
    const mapped = source && source.kind !== "none";
    if (!mapped) return { field, value: null, display: "", notes };
    if (source.kind !== "static" || NON_TEXT_TYPES.has(field.type)) {
      return {
        field,
        value: null,
        display: "",
        notes,
        blocking: `"${field.name}" is a ${field.rawType ?? field.type} field. Content Studio cannot fill it from document content; leave it unmapped and set it in Sitecore.`,
      };
    }
    notes.push(`"${field.name}" has the unsupported type ${field.rawType ?? "Other"}; your custom text is written as-is. Check it in Sitecore.`);
    return { field, value: source.value || null, display: source.value, notes };
  }

  switch (field.type) {
    case "Image": {
      if (!resolved.image) return { field, value: null, display: "", notes };
      const { image, asset } = resolved.image;
      if (mode === "demo") {
        notes.push("Demo: simulated asset, shown in the preview only. It does not exist in Sitecore.");
        return { field, value: null, display: image.fileName, image: resolved.image, notes };
      }
      // Live: only a media item Sitecore confirmed can be referenced.
      const upload = asset.mediaUpload;
      const value = upload?.state === "uploaded" && upload.mediaItemId ? toImageFieldValue(upload.mediaItemId) : null;
      if (value) return { field, value, display: `${image.fileName} → ${upload?.mediaPath ?? upload?.mediaItemId}`, image: resolved.image, notes };
      const why =
        upload?.state === "uncertain"
          ? "its upload outcome is unknown; check the Media Library and resolve it in Images & media"
          : upload?.state === "failed"
            ? `its upload failed (${upload.message ?? "no details"})`
            : "it has not been uploaded to the Media Library (Images & media; enable media upload in Settings if the panel is missing)";
      return {
        field,
        value: null,
        display: image.fileName,
        image: resolved.image,
        notes,
        blocking: `"${field.name}" is mapped to ${image.fileName}, but ${why}. Upload it, or set the field to "Not mapped".`,
      };
    }
    case "Rich Text": {
      if (resolved.cards.length) {
        const html = toRichText(resolved.part && resolved.part !== "text" ? [] : resolved.cards);
        const value = html || texts.map((t) => `<p>${escapeHtml(t)}</p>`).join("\n");
        return { field, value, display: texts.join("\n\n"), notes };
      }
      const value = texts.length ? texts.map((t) => `<p>${escapeHtml(t)}</p>`).join("\n") : null;
      return { field, value, display: texts.join("\n\n"), notes };
    }
    case "General Link": {
      const card = resolved.cards.find((c) => c.href);
      const href = card?.href ?? (resolved.text && /^https?:\/\//.test(resolved.text) ? resolved.text : undefined);
      if (!href) {
        if (texts.length) notes.push("The mapped content has no URL, so the link cannot be created.");
        return { field, value: null, display: "", notes };
      }
      const text = card ? card.text : href;
      return {
        field,
        value: `<link linktype="external" url="${escapeHtml(href)}" text="${escapeHtml(text.slice(0, 200))}" target="" />`,
        display: `${text} → ${href}`,
        notes,
      };
    }
    case "Date":
    case "Datetime": {
      const raw = texts[0];
      if (!raw) return { field, value: null, display: "", notes };
      const value = toSitecoreDate(raw);
      if (!value) notes.push(`"${raw}" is not a recognisable date.`);
      return { field, value, display: value ? new Date(raw).toLocaleDateString() : raw, notes };
    }
    case "Single-Line Text": {
      if (texts.length > 1) notes.push(`${texts.length} items are combined into one line.`);
      const value = texts.join(" ").replace(/\s+/g, " ").trim();
      return { field, value: value || null, display: value, notes };
    }
    default: {
      const value = texts.join("\n\n");
      return { field, value: value || null, display: value, notes };
    }
  }
}

// ---------- source encoding for <select> controls ----------

export function encodeSource(source: MappingSource | undefined): string {
  if (!source) return "none";
  switch (source.kind) {
    case "none":
    case "article":
      return source.kind;
    case "content":
      return `content:${source.contentType}:${source.mode}`;
    case "card":
      return `card:${source.cardId}:${source.part ?? "text"}`;
    case "image":
      return `image:${source.imageId}`;
    case "metadata":
      return `metadata:${source.key}`;
    case "static":
      return "static";
  }
}

export function decodeSource(value: string, previous?: MappingSource): MappingSource {
  const [kind, a, b] = value.split(":");
  switch (kind) {
    case "article":
      return { kind: "article" };
    case "content":
      return { kind: "content", contentType: a as ContentCard["type"], mode: b === "all" ? "all" : "first" };
    case "card":
      return { kind: "card", cardId: a, part: b === "attribution" || b === "href" ? b : "text" };
    case "image":
      return { kind: "image", imageId: a };
    case "metadata":
      return { kind: "metadata", key: a as "author" | "createdAt" | "sourceUrl" | "fileName" };
    case "static":
      return { kind: "static", value: previous?.kind === "static" ? previous.value : "" };
    default:
      return { kind: "none" };
  }
}

// ---------- automatic mapping ----------

const RULES: Array<{ pattern: RegExp; source: (ws: Workspace, field: SitecoreTemplateField) => MappingSource | null }> = [
  { pattern: /^(meta ?title|seo ?title|browser ?title|page ?title)$/i, source: (ws) => seoCard(ws, "Meta title") },
  { pattern: /^(meta ?description|seo ?description)$/i, source: (ws) => seoCard(ws, "Meta description") },
  { pattern: /keywords?/i, source: (ws) => seoCard(ws, "Keywords") },
  { pattern: /quote ?(author|attribution|by|name)|attribution/i, source: (ws) => cardOf(ws, "quote", "attribution") },
  { pattern: /^(title|headline|heading|name)$/i, source: () => ({ kind: "content", contentType: "headline", mode: "first" }) },
  { pattern: /sub ?(title|heading|head)|strapline/i, source: () => ({ kind: "content", contentType: "subheading", mode: "first" }) },
  { pattern: /summary|intro|abstract|teaser|lead|excerpt|standfirst/i, source: () => ({ kind: "content", contentType: "summary", mode: "first" }) },
  { pattern: /^(body|content|text|article|main ?content|copy)$/i, source: (_ws, f) => (f.type === "Rich Text" ? { kind: "article" } : { kind: "content", contentType: "body", mode: "all" }) },
  { pattern: /quote|testimonial/i, source: (ws) => cardOf(ws, "quote", "text") },
  { pattern: /stat|figure|metric/i, source: () => ({ kind: "content", contentType: "statistic", mode: "first" }) },
  { pattern: /cta|call ?to ?action|link|url/i, source: (ws) => cardOf(ws, "cta", "text") ?? cardOf(ws, "link", "text") },
  { pattern: /author|byline/i, source: (ws) => (ws.extraction.metadata.author ? { kind: "metadata", key: "author" } : null) },
  { pattern: /date|published/i, source: (ws) => (ws.extraction.metadata.createdAt ? { kind: "metadata", key: "createdAt" } : null) },
];

function seoCard(ws: Workspace, label: string): MappingSource | null {
  const card = ws.cards.find((c) => c.type === "seo" && c.label === label && c.selected);
  return card ? { kind: "card", cardId: card.id } : null;
}

function cardOf(ws: Workspace, type: ContentCard["type"], part: "text" | "attribution"): MappingSource | null {
  const card = ws.cards.find((c) => c.type === type && c.selected && (part !== "attribution" || c.attribution));
  return card ? { kind: "card", cardId: card.id, part } : null;
}

/** In live mode only an image with a confirmed Media Library upload can fill an Image field. */
function firstImage(ws: Workspace, mode: IntegrationMode): MappingSource | null {
  const image = ws.images.find((i) => i.selected && (mode === "demo" || (i.mediaUpload?.state === "uploaded" && i.mediaUpload.mediaItemId)));
  return image ? { kind: "image", imageId: image.id } : null;
}

/**
 * Suggests a source for every field. At most one Image field is filled automatically, so the same
 * image is never copied into several image fields; the author chooses the others explicitly.
 */
export function autoMap(template: SitecoreTemplate, ws: Workspace, mode: IntegrationMode = "demo"): Record<string, MappingSource> {
  const fields: Record<string, MappingSource> = {};
  let imageUsed = false;
  for (const field of template.fields) {
    if (field.type === "Image") {
      const source = imageUsed || !/image|thumbnail|hero|picture|photo|visual/i.test(field.name) ? null : firstImage(ws, mode);
      if (source) imageUsed = true;
      fields[field.name] = source ?? { kind: "none" };
      continue;
    }
    if (NON_TEXT_TYPES.has(field.type) || field.type === "Other") {
      fields[field.name] = { kind: "none" };
      continue;
    }
    const rule = RULES.find((r) => r.pattern.test(field.name.trim()));
    let source = rule?.source(ws, field) ?? null;
    if (source?.kind === "content") {
      const contentType = source.contentType;
      if (!selectedCards(ws).some((c) => c.type === contentType)) source = null;
    }
    if (source?.kind === "image") source = null;
    fields[field.name] = source ?? { kind: "none" };
  }
  return fields;
}

// ---------- validation ----------

export interface ValidationIssue {
  level: "error" | "warning";
  field?: string;
  message: string;
}

const ITEM_NAME_PATTERN = /^[\w*$][\w\s\-$]*(\(\d{1,}\))?$/;

export function suggestItemName(headline: string | undefined): string {
  const cleaned = (headline ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || "Content Studio item";
}

export function validateItemName(name: string): string | null {
  if (!name.trim()) return "Enter an item name.";
  if (name.length > 100) return "Item names must be 100 characters or fewer.";
  if (!ITEM_NAME_PATTERN.test(name)) return "Item names can contain letters, numbers, spaces, hyphens and underscores, and must not start with a space or hyphen.";
  return null;
}

export function validateMapping(loaded: SitecoreTemplate | undefined, mapping: MappingState, ws: Workspace, mode: IntegrationMode): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // Only a field snapshot that belongs to the selected template ID counts as a selection.
  const template = loaded && sameSitecoreId(loaded.id, mapping.templateId) ? loaded : undefined;
  if (!mapping.siteId) issues.push({ level: "error", message: "Select a site." });
  if (!mapping.templateId) issues.push({ level: "error", message: "Select a content template." });
  else if (mode === "live" && !toSitecoreId(mapping.templateId)) issues.push({ level: "error", message: "The selected template does not have a valid Sitecore ID. Select it again from the list." });
  else if (!template) issues.push({ level: "error", message: "The fields of the selected template are not loaded. Wait for them to load, or select the template again." });
  if (!mapping.language) issues.push({ level: "error", message: "Select a language." });
  const destination = destinationIssue(mapping, mode);
  if (destination) issues.push({ level: "error", message: destination });
  const nameError = validateItemName(mapping.itemName ?? "");
  if (nameError) issues.push({ level: "error", message: nameError });
  if (!template) return issues;

  if (template.fields.length === 0) issues.push({ level: "error", message: "The selected template has no fields that can be mapped." });
  if (template.requiredInfo === "unavailable") {
    issues.push({ level: "warning", message: "Required-field rules could not be read from Sitecore, so required fields may not be marked. Check the template in Sitecore." });
  }
  for (const note of template.notes ?? []) issues.push({ level: "warning", message: note });

  const usedCardIds = new Set<string>();
  let anyValue = false;
  for (const field of template.fields) {
    const source = mapping.fields[field.name];
    const value = buildFieldValue(field, source, ws, mode);
    const resolved = resolveSource(source, ws);
    resolved.cards.forEach((c) => usedCardIds.add(c.id));
    const mapped = source && source.kind !== "none";
    const hasValue = value.value !== null || (mode === "demo" && !!value.image);
    if (hasValue) anyValue = true;

    if (!mapped) {
      const hint = field.type === "Image" && mode === "live" && ws.images.some((i) => i.selected) ? " To fill it, upload an image in Images & media, then choose it here." : "";
      issues.push(
        field.required
          ? { level: "error", field: field.name, message: `Required field "${field.name}" is not mapped.${hint}` }
          : { level: "warning", field: field.name, message: `"${field.name}" is not mapped and will be left empty.${hint}` },
      );
      continue;
    }
    if (!hasValue && !value.blocking) {
      issues.push({
        level: field.required ? "error" : "warning",
        field: field.name,
        message:
          source.kind === "card" || source.kind === "image"
            ? `"${field.name}" is mapped to content that was removed or deselected.`
            : `"${field.name}" is mapped, but there is no selected content to fill it.`,
      });
    }
    if (value.blocking) issues.push({ level: "error", field: field.name, message: value.blocking });
    for (const note of value.notes) issues.push({ level: "warning", field: field.name, message: `${field.name}: ${note}` });
  }

  if (!anyValue) issues.push({ level: "error", message: "No field has a value. Map at least one field." });

  const unusedCount = selectedCards(ws).filter((c) => !usedCardIds.has(c.id) && c.type !== "link" && c.type !== "seo").length;
  if (unusedCount > 0) issues.push({ level: "warning", message: `${unusedCount} selected content card(s) are not used by any field.` });

  return issues;
}

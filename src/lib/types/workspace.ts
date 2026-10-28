import type { ContentOrigin, ContentType, ExtractionResult, ListItem, SourceRef } from "./extraction";
import type { MediaUploadDiagnostics, SitecoreTemplate } from "./sitecore";

export interface ContentCard {
  id: string;
  type: ContentType;
  /**
   * The card's text. Body cards may hold several paragraphs separated by a blank line.
   * List cards keep this equal to their items, one per line (see `items`).
   */
  text: string;
  /** List cards: individually editable items. */
  items?: ListItem[];
  /** List cards: numbered list. */
  ordered?: boolean;
  /** Classification confidence (0–1) and evidence from extraction, shown so authors can correct it. */
  confidence?: number;
  evidence?: string[];
  section?: number;
  origin: ContentOrigin;
  selected: boolean;
  source?: SourceRef;
  label?: string;
  attribution?: string;
  href?: string;
  /** True once the author has edited extracted text; the card is then no longer verbatim source text. */
  edited: boolean;
}

export interface ImageAsset {
  id: string;
  selected: boolean;
  altText: string;
  caption: string;
  /** Result of an upload to the Sitecore Media Library. "uploaded" is only set when Sitecore confirmed it. */
  mediaUpload?: {
    state: "uploaded" | "uncertain" | "failed";
    /** Braced GUID returned by Sitecore. Only present when state is "uploaded". */
    mediaItemId?: string;
    /** Path of the media item, read back from Sitecore by ID. */
    mediaPath?: string;
    embedUrl?: string;
    message?: string;
    at: string;
    diagnostics?: MediaUploadDiagnostics;
  };
}

export type MappingSource =
  | { kind: "none" }
  | { kind: "content"; contentType: ContentType; mode: "first" | "all" }
  | { kind: "article" }
  | { kind: "card"; cardId: string; part?: "text" | "attribution" | "href" }
  | { kind: "image"; imageId: string }
  | { kind: "metadata"; key: "author" | "createdAt" | "sourceUrl" | "fileName" }
  | { kind: "static"; value: string };

export interface MappingState {
  siteId?: string;
  /** Site name, kept for the confirmation summary and media upload. */
  siteName?: string;
  /** Technical site name (Sites API "name"), required by the media upload API. */
  siteKey?: string;
  templateId?: string;
  /** Snapshot of the selected template's field definitions. */
  template?: SitecoreTemplate;
  language?: string;
  destinationPath?: string;
  /**
   * Set only after Sitecore confirmed the parent item exists (Verify in live mode). Cleared when
   * the path or site changes, so it always refers to the current destinationPath.
   */
  destinationVerified?: { path: string; itemId: string };
  /** Media Library folder for image uploads, chosen in the media tree. */
  mediaFolder?: string;
  itemName?: string;
  fields: Record<string, MappingSource>;
}

export interface Workspace {
  id: string;
  createdAt: string;
  updatedAt: string;
  extraction: ExtractionResult;
  cards: ContentCard[];
  images: ImageAsset[];
  mapping: MappingState;
  /** Set when a local draft snapshot was saved (demo or live). */
  draftSavedAt?: string;
  /**
   * An item creation that has started but has no confirmed outcome. "pending" survives a reload
   * and is then treated as uncertain; creation stays blocked until the author checks Sitecore.
   */
  creation?: { state: "pending" | "uncertain"; startedAt: string; itemName: string; parentPath: string; message?: string };
  /** Present only after Sitecore confirmed the item was created. */
  createdItem?: { itemId: string; path: string; createdAt: string; warnings?: string[] };
}

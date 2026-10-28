export type IntegrationMode = "demo" | "live";

export type SitecoreFieldType =
  | "Single-Line Text"
  | "Multi-Line Text"
  | "Rich Text"
  | "Image"
  | "General Link"
  | "Date"
  | "Datetime"
  | "Checkbox"
  | "Number"
  /** Droplink, Droptree, Multilist, Treelist, Checklist... values are item IDs, never free text. */
  | "Reference"
  | "Other";

export interface SitecoreSite {
  id: string;
  name: string;
  displayName: string;
  languages: string[];
  /** Suggested parent path for new content, when known. */
  defaultDestination?: string;
  /** Live: IDs of the site's home page(s) (Sites API hosts), used to find the site root when `id` is not an item ID. */
  homePageIds?: string[];
}

/** One item in a content or media tree. */
export interface SitecoreTreeItem {
  id: string;
  name: string;
  displayName?: string;
  path: string;
  /** Unknown (undefined) when the API cannot say; the tree then offers to expand it. */
  hasChildren?: boolean;
  templateName?: string;
}

/** Where the content and media trees start for a site. */
export interface SitecoreTreeRoots {
  /** The site's root item, or /sitecore/content when it cannot be determined. */
  content: SitecoreTreeItem;
  media: SitecoreTreeItem;
  /** The site's own media folder, when one exists (opened and suggested in the media tree). */
  mediaFolder?: SitecoreTreeItem;
  notes: string[];
}

export interface SitecoreTemplateField {
  name: string;
  /** ID of the field definition item (live mode). */
  id?: string;
  type: SitecoreFieldType;
  /** Raw type string as reported by Sitecore. */
  rawType?: string;
  required: boolean;
  /**
   * Where `required` came from. Sitecore templates have no "required" flag; a field is
   * required only when a "Required" validation rule is assigned to its definition item.
   */
  requiredSource?: "validation-rule" | "demo";
  section?: string;
  /** Name of the template that defines the field (differs from the selected template for inherited fields). */
  definedIn?: string;
}

export interface SitecoreTemplate {
  id: string;
  name: string;
  path?: string;
  description?: string;
  fields: SitecoreTemplateField[];
  /** Whether required-field information could be read. "unavailable" means: unknown, not "none required". */
  requiredInfo?: "available" | "unavailable";
  /** Notes about how the definition was loaded, e.g. base templates that could not be read. */
  notes?: string[];
}

export interface SitecoreLanguage {
  code: string;
  name: string;
}

export interface CreateItemRequest {
  name: string;
  templateId: string;
  parentPath: string;
  language: string;
  /** Values are sent by field name. type and fieldId are for diagnostics and verification only. */
  fields: Array<{ name: string; value: string; type?: SitecoreFieldType; fieldId?: string }>;
}

/**
 * What went wrong:
 * - validation: Sitecore ran the request and refused it (e.g. invalid name or field)
 * - permission: not authorized or not allowed
 * - schema: the request does not match the Authoring API schema
 * - server: Sitecore returned a server error
 * - network: no answer (timeout, lost connection)
 * - unexpected-response: an answer the app cannot interpret
 * - precondition: stopped by the app before sending (destination, duplicate, invalid ID)
 */
export type SitecoreFailureKind = "validation" | "permission" | "schema" | "server" | "network" | "unexpected-response" | "precondition";

export interface GraphQLErrorInfo {
  message: string;
  path?: string;
  code?: string;
}

/** Sanitized record of a creation attempt. Contains no field values and no tokens. */
export interface CreateDiagnostics {
  operation: "ContentStudioCreateItem";
  stage: "preflight" | "duplicate-check" | "mutation" | "verification";
  kind?: SitecoreFailureKind;
  /** "no": rejected before execution. "possibly": Sitecore may have run it. "yes": it ran. */
  executed: "no" | "possibly" | "yes";
  httpStatus?: number;
  errors: GraphQLErrorInfo[];
  transportError?: string;
  input: {
    name: string;
    templateId: string;
    parent: string | null;
    parentPath: string;
    language: string;
    /** Value lengths only; for Image fields also the value, which is a media reference, not content. */
    fields: Array<{ name: string; length: number; type?: SitecoreFieldType; fieldId?: string; value?: string }>;
  };
  /** Image fields read back from Sitecore after creation. */
  fieldCheck?: Array<{ name: string; sent: string; saved: string | null; match: boolean }>;
  at: string;
}

export type CreateItemResult =
  /** Confirmed by the Sitecore API: the item exists. */
  | { ok: true; itemId: string; path: string; warnings?: string[]; diagnostics?: CreateDiagnostics }
  | { ok: false; reason: "demo-mode"; message: string; preview: GraphQLRequestPreview }
  /** Sitecore answered and the item was not created. Safe to fix and retry. */
  | { ok: false; reason: "error"; message: string; kind?: SitecoreFailureKind; diagnostics?: CreateDiagnostics }
  /** No reliable answer (timeout, lost connection). The item may or may not exist. */
  | { ok: false; reason: "uncertain"; message: string; kind?: SitecoreFailureKind; diagnostics?: CreateDiagnostics };

/** Result of comparing the request this app sends with the tenant's createItem schema (read-only). */
export interface CreateItemSchemaCheck {
  status: "match" | "mismatch" | "unavailable";
  detail: string;
}

export type ItemLookup ={ found: true; itemId: string; path: string } | { found: false };

export interface MediaUploadRequest {
  file: Blob;
  /** Media item name without extension. */
  name: string;
  /** File extension without the dot, e.g. "png". */
  extension: string;
  mimeType: string;
  /** Workspace image ID, for diagnostics. */
  imageId?: string;
  /** Media Library folder path, e.g. /sitecore/media library/Project/Site/News. */
  folderPath: string;
  language: string;
  siteName: string;
}

/** Sanitized record of a media upload. Contains no image data and no tokens. */
export interface MediaUploadDiagnostics {
  operation: "xmc.agent.assetsUploadAsset";
  imageId?: string;
  fileName: string;
  mimeType: string;
  size: number;
  folderPath: string;
  /** itemPath sent to the Agent API: relative to the Media Library root. */
  itemPath?: string;
  httpStatus?: number;
  /** The "success" flag Sitecore returned, if any. */
  success?: boolean | null;
  returnedId?: string | null;
  /** Whether the returned media item was found by ID afterwards. */
  verified: "yes" | "no" | "not-checked";
  mediaPath?: string;
  error?: string;
  at: string;
}

export type MediaUploadResult =
  | { ok: true; mediaItemId: string; mediaPath?: string; embedUrl?: string; warnings?: string[]; diagnostics: MediaUploadDiagnostics }
  | { ok: false; reason: "error" | "uncertain"; message: string; diagnostics?: MediaUploadDiagnostics };

export interface GraphQLRequestPreview {
  query: string;
  variables: Record<string, unknown>;
}

export interface IntegrationStatus {
  mode: IntegrationMode;
  /** Why the app is in its current mode. */
  detail: string;
  canListSites: boolean;
  canDiscoverTemplates: boolean;
  canCreateItems: boolean;
  canUploadMedia: boolean;
}

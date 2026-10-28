import type {
  CreateItemRequest,
  CreateItemResult,
  IntegrationStatus,
  ItemLookup,
  MediaUploadRequest,
  MediaUploadResult,
  SitecoreLanguage,
  SitecoreSite,
  SitecoreTemplate,
  SitecoreTreeItem,
  SitecoreTreeRoots,
} from "../types/sitecore";

export type DestinationCheck = { ok: true; itemId: string; path: string } | { ok: false; message: string };

/** Everything the UI needs from Sitecore. Implemented by the demo adapter and the live adapter. */
export interface SitecoreAdapter {
  readonly status: IntegrationStatus;
  listSites(): Promise<SitecoreSite[]>;
  listLanguages(): Promise<SitecoreLanguage[]>;
  listTemplates(): Promise<SitecoreTemplate[]>;
  /** Loads field definitions for a template, including inherited fields. */
  getTemplate(templateId: string): Promise<SitecoreTemplate>;
  checkDestination(path: string): Promise<DestinationCheck>;
  /** Read-only: where the content tree (site root) and media tree start for a site. */
  getTreeRoots(site: SitecoreSite | undefined): Promise<SitecoreTreeRoots>;
  /** Read-only: the children of an item, in Sitecore sort order. */
  getChildren(path: string): Promise<SitecoreTreeItem[]>;
  /** Looks up an item by its full path. Used to detect duplicates and to resolve uncertain creations. */
  findItem(path: string): Promise<ItemLookup>;
  /** Creates an unpublished item. Never publishes. */
  createItem(request: CreateItemRequest): Promise<CreateItemResult>;
  /** Uploads one image to the Media Library. Only available when status.canUploadMedia is true. */
  uploadMedia(request: MediaUploadRequest): Promise<MediaUploadResult>;
}

export interface AdapterSettings {
  templateRootPath: string;
  experimentalMediaUpload: boolean;
}

export const DEFAULT_ADAPTER_SETTINGS: AdapterSettings = {
  templateRootPath: "/sitecore/templates/Project",
  experimentalMediaUpload: false,
};

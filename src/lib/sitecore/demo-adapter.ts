import type { CreateItemRequest, CreateItemResult, IntegrationStatus, ItemLookup, MediaUploadResult, SitecoreLanguage, SitecoreSite, SitecoreTemplate, SitecoreTreeItem, SitecoreTreeRoots } from "../types/sitecore";
import type { DestinationCheck, SitecoreAdapter } from "./adapter";
import { buildCreateItemMutation, CONTENT_ROOT, MEDIA_ROOT, siteMediaFolderPath } from "./graphql";

// DEMO DATA. These sites, templates and languages are mock values used when Content Studio
// is not running inside Sitecore. They are labelled "(demo)" everywhere they appear.

const DEMO_SITES: SitecoreSite[] = [
  { id: "demo-site-corporate", name: "corporate", displayName: "Corporate site (demo)", languages: ["en", "de", "fr"], defaultDestination: "/sitecore/content/Demo/Corporate/Home/News" },
  { id: "demo-site-newsroom", name: "newsroom", displayName: "Newsroom (demo)", languages: ["en"], defaultDestination: "/sitecore/content/Demo/Newsroom/Home/Press Releases" },
];

const DEMO_LANGUAGES: SitecoreLanguage[] = [
  { code: "en", name: "English" },
  { code: "de", name: "German" },
  { code: "fr", name: "French" },
];

const DEMO_TEMPLATES: SitecoreTemplate[] = [
  {
    id: "demo-tpl-press-release",
    name: "Press Release (demo)",
    path: "/sitecore/templates/Project/Demo/Press Release",
    description: "Headline, summary, rich-text body, executive quote, hero image and SEO fields.",
    fields: [
      { name: "Title", type: "Single-Line Text", required: true, requiredSource: "demo", section: "Content" },
      { name: "Subtitle", type: "Single-Line Text", required: false, section: "Content" },
      { name: "Summary", type: "Multi-Line Text", required: true, requiredSource: "demo", section: "Content" },
      { name: "Body", type: "Rich Text", required: true, requiredSource: "demo", section: "Content" },
      { name: "Quote", type: "Multi-Line Text", required: false, section: "Content" },
      { name: "Quote Author", type: "Single-Line Text", required: false, section: "Content" },
      { name: "Key Statistic", type: "Single-Line Text", required: false, section: "Content" },
      { name: "Hero Image", type: "Image", required: false, section: "Media" },
      { name: "Call To Action", type: "General Link", required: false, section: "Content" },
      { name: "Publish Date", type: "Date", required: false, section: "Metadata" },
      { name: "Author", type: "Single-Line Text", required: false, section: "Metadata" },
      { name: "Meta Title", type: "Single-Line Text", required: false, section: "SEO" },
      { name: "Meta Description", type: "Multi-Line Text", required: false, section: "SEO" },
      { name: "Meta Keywords", type: "Single-Line Text", required: false, section: "SEO" },
    ],
  },
  {
    id: "demo-tpl-article",
    name: "News Article (demo)",
    path: "/sitecore/templates/Project/Demo/News Article",
    description: "A simpler article with title, teaser, content and image.",
    fields: [
      { name: "Heading", type: "Single-Line Text", required: true, requiredSource: "demo", section: "Content" },
      { name: "Teaser", type: "Multi-Line Text", required: false, section: "Content" },
      { name: "Content", type: "Rich Text", required: true, requiredSource: "demo", section: "Content" },
      { name: "Image", type: "Image", required: false, section: "Content" },
      { name: "Date", type: "Date", required: false, section: "Content" },
    ],
  },
];

/** Demo content and media trees (every item path; parents are implied). */
const DEMO_TREE_PATHS = [
  "/sitecore/content/Demo/Corporate/Home/News/2026",
  "/sitecore/content/Demo/Corporate/Home/About",
  "/sitecore/content/Demo/Corporate/Data",
  "/sitecore/content/Demo/Newsroom/Home/Press Releases",
  "/sitecore/media library/Project/Demo/Corporate/News",
  "/sitecore/media library/Project/Demo/Newsroom",
];

function demoTree(): Map<string, SitecoreTreeItem> {
  const items = new Map<string, SitecoreTreeItem>();
  for (const full of DEMO_TREE_PATHS) {
    const segments = full.split("/").filter(Boolean);
    for (let n = 1; n <= segments.length; n++) {
      const path = `/${segments.slice(0, n).join("/")}`;
      if (!items.has(path.toLowerCase())) items.set(path.toLowerCase(), { id: `demo-item:${path}`, name: segments[n - 1], path, hasChildren: false, templateName: path.toLowerCase().startsWith(MEDIA_ROOT) ? "Media folder" : "Demo item" });
      if (n > 1) items.get(`/${segments.slice(0, n - 1).join("/")}`.toLowerCase())!.hasChildren = true;
    }
  }
  return items;
}

const DEMO_ITEMS = demoTree();

export class DemoSitecoreAdapter implements SitecoreAdapter {
  constructor(public readonly status: IntegrationStatus) {}

  async listSites() {
    return DEMO_SITES;
  }

  async listLanguages() {
    return DEMO_LANGUAGES;
  }

  async listTemplates() {
    return DEMO_TEMPLATES;
  }

  async getTemplate(templateId: string) {
    const template = DEMO_TEMPLATES.find((t) => t.id === templateId);
    if (!template) throw new Error(`Demo template ${templateId} does not exist.`);
    return { ...template, requiredInfo: "available" as const };
  }

  async checkDestination(path: string): Promise<DestinationCheck> {
    if (!path.startsWith("/sitecore/content/")) {
      return { ok: false, message: "Destination must be a content path under /sitecore/content/." };
    }
    // Demo mode cannot verify that the path exists.
    return { ok: true, itemId: "demo-parent", path };
  }

  async getTreeRoots(site: SitecoreSite | undefined): Promise<SitecoreTreeRoots> {
    // A demo site's root is the parent of its Home item.
    const siteRoot = site?.defaultDestination?.replace(/\/Home(\/.*)?$/i, "");
    const content = (siteRoot && DEMO_ITEMS.get(siteRoot.toLowerCase())) || DEMO_ITEMS.get(CONTENT_ROOT)!;
    const mediaPath = siteMediaFolderPath(content.path);
    const mediaFolder = mediaPath ? DEMO_ITEMS.get(mediaPath.toLowerCase()) : undefined;
    return { content, media: DEMO_ITEMS.get(MEDIA_ROOT)!, mediaFolder, notes: [] };
  }

  async getChildren(path: string): Promise<SitecoreTreeItem[]> {
    const key = path.toLowerCase().replace(/\/+$/, "");
    if (!DEMO_ITEMS.has(key)) throw new Error(`Demo item "${path}" does not exist.`);
    return [...DEMO_ITEMS.values()].filter((item) => item.path.toLowerCase().replace(/\/[^/]+$/, "") === key);
  }

  async findItem(): Promise<ItemLookup> {
    // Demo mode has no content tree, so nothing can be found (and nothing was ever created).
    return { found: false };
  }

  async uploadMedia(): Promise<MediaUploadResult> {
    return { ok: false, reason: "error", message: "Demo mode: nothing is uploaded to Sitecore." };
  }

  async createItem(request: CreateItemRequest): Promise<CreateItemResult> {
    return {
      ok: false,
      reason: "demo-mode",
      message: "Demo mode: nothing was sent to Sitecore. Install Content Studio in SitecoreAI / XM Cloud to create items.",
      preview: buildCreateItemMutation({ ...request, parentId: `<ID of ${request.parentPath}>` }),
    };
  }
}

export function demoStatus(detail: string): IntegrationStatus {
  return { mode: "demo", detail, canListSites: true, canDiscoverTemplates: true, canCreateItems: false, canUploadMedia: false };
}

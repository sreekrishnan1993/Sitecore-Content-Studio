import type { ClientSDK } from "@sitecore-marketplace-sdk/client";
import { describe, expect, it } from "vitest";
import { DemoSitecoreAdapter, demoStatus } from "@/src/lib/sitecore/demo-adapter";
import { isPathWithin, siteMediaFolderPath } from "@/src/lib/sitecore/graphql";
import { LiveSitecoreAdapter } from "@/src/lib/sitecore/live-adapter";
import { applyMappingPatch } from "@/src/lib/workspace";
import { destinationIssue, siteLanguages, siteSelectionPatch } from "@/src/lib/mapping";

// A small content tree answered by item path or ID, like the Authoring API's item(where: …).
const ITEMS = [
  { itemId: "10000000000000000000000000000001", name: "content", path: "/sitecore/content", hasChildren: true },
  { itemId: "10000000000000000000000000000002", name: "Brands", path: "/sitecore/content/Brands", hasChildren: true },
  { itemId: "10000000000000000000000000000003", name: "BrandX", displayName: "Brand X", path: "/sitecore/content/Brands/BrandX", hasChildren: true },
  { itemId: "10000000000000000000000000000004", name: "Home", path: "/sitecore/content/Brands/BrandX/Home", hasChildren: true },
  { itemId: "10000000000000000000000000000005", name: "News", path: "/sitecore/content/Brands/BrandX/Home/News", hasChildren: false },
  { itemId: "20000000000000000000000000000001", name: "media library", path: "/sitecore/media library", hasChildren: true },
  { itemId: "20000000000000000000000000000002", name: "Project", path: "/sitecore/media library/Project", hasChildren: true },
  { itemId: "20000000000000000000000000000003", name: "Brands", path: "/sitecore/media library/Project/Brands", hasChildren: true },
  { itemId: "20000000000000000000000000000004", name: "BrandX", path: "/sitecore/media library/Project/Brands/BrandX", hasChildren: false },
  { itemId: "20000000000000000000000000000005", name: "BrandY", path: "/sitecore/media library/Project/Brands/BrandY", hasChildren: false },
].map((i) => ({ ...i, template: { name: "Folder" } }));

const norm = (id: unknown) => String(id).replace(/[{}-]/g, "").toLowerCase();
const byKey = (key: unknown) => ITEMS.find((i) => i.path.toLowerCase() === String(key).toLowerCase() || norm(i.itemId) === norm(key)) ?? null;

function live(opts: { rejectOptionalFields?: boolean; siteId?: string; homePageId?: string } = {}) {
  const queries: string[] = [];
  const client = {
    async query(key: string) {
      if (key === "xmc.sites.listSites") return { data: { data: [{ id: opts.siteId ?? "x", name: "brandx", displayName: "Brand X", languages: ["en"], hosts: [{ homePageId: opts.homePageId }] }] } };
      throw new Error(key);
    },
    async mutate(_key: string, options: { params: { body: { query: string; variables: { key: string } } } }) {
      const { query, variables } = options.params.body;
      queries.push(query);
      if (opts.rejectOptionalFields && query.includes("hasChildren")) return { data: { errors: [{ message: 'The field `hasChildren` does not exist on the type `Item`.' }] } };
      const strip = (i: (typeof ITEMS)[number] | null) => (i && opts.rejectOptionalFields ? { itemId: i.itemId, name: i.name, path: i.path, template: i.template } : i);
      if (query.includes("ContentStudioTreeChildren")) {
        const parent = byKey(variables.key);
        const kids = ITEMS.filter((i) => parent && i.path.toLowerCase().replace(/\/[^/]+$/, "") === parent.path.toLowerCase());
        return { data: { data: { item: parent ? { children: { nodes: kids.map(strip) } } : null } } };
      }
      return { data: { data: { item: strip(byKey(variables.key)) } } };
    },
  };
  const adapter = new LiveSitecoreAdapter(client as unknown as ClientSDK, "ctx", { templateRootPath: "/sitecore/templates/Project", experimentalMediaUpload: true }, "Sandbox");
  return { adapter, queries };
}

describe("item tree: live adapter", () => {
  it("roots the content tree at the site item and opens the site's media folder", async () => {
    const { adapter } = live({ siteId: "10000000-0000-0000-0000-000000000003" });
    const [site] = await adapter.listSites();
    const roots = await adapter.getTreeRoots(site);
    expect(roots.content).toMatchObject({ path: "/sitecore/content/Brands/BrandX", displayName: "Brand X", hasChildren: true });
    expect(roots.media.path).toBe("/sitecore/media library");
    // Exactly the site's own folder: never the collection folder or a sibling site's.
    expect(roots.mediaFolder?.path).toBe("/sitecore/media library/Project/Brands/BrandX");
    expect(roots.notes).toEqual([]);
  });

  it("falls back to the parent of the site's home page when the site ID is not an item", async () => {
    const { adapter } = live({ siteId: "not-an-item", homePageId: "10000000000000000000000000000004" });
    const [site] = await adapter.listSites();
    expect(site.homePageIds).toEqual(["10000000000000000000000000000004"]);
    expect((await adapter.getTreeRoots(site)).content.path).toBe("/sitecore/content/Brands/BrandX");
  });

  it("starts at /sitecore/content, with a note, when the site root cannot be found", async () => {
    const { adapter } = live({ siteId: "not-an-item" });
    const roots = await adapter.getTreeRoots((await adapter.listSites())[0]);
    expect(roots.content.path).toBe("/sitecore/content");
    expect(roots.mediaFolder).toBeUndefined();
    expect(roots.notes[0]).toMatch(/could not be found/);
  });

  it("lists children in Sitecore order, with canonical IDs", async () => {
    const { adapter, queries } = live();
    const children = await adapter.getChildren("/sitecore/content/Brands/BrandX/Home");
    expect(children).toEqual([{ id: "{10000000-0000-0000-0000-000000000005}", name: "News", path: "/sitecore/content/Brands/BrandX/Home/News", hasChildren: false, templateName: "Folder", displayName: undefined }]);
    expect(queries.every((q) => /^query /.test(q) && !/mutation/.test(q))).toBe(true);
  });

  it("retries with the basic field set when the schema lacks hasChildren, and remembers it", async () => {
    const { adapter, queries } = live({ rejectOptionalFields: true });
    const children = await adapter.getChildren("/sitecore/content/Brands");
    expect(children.map((c) => [c.name, c.hasChildren])).toEqual([["BrandX", undefined]]);
    await adapter.getChildren("/sitecore/content/Brands/BrandX");
    expect(queries.filter((q) => q.includes("hasChildren"))).toHaveLength(1);
  });

  it("reports a missing parent as an error", async () => {
    const { adapter } = live();
    await expect(adapter.getChildren("/sitecore/content/Nope")).rejects.toThrow(/not found/);
  });
});

describe("item tree: demo adapter and helpers", () => {
  const demo = new DemoSitecoreAdapter(demoStatus("test"));

  it("roots each demo site at its own item and finds its media folder", async () => {
    const [corporate] = await demo.listSites();
    const roots = await demo.getTreeRoots(corporate);
    expect(roots.content.path).toBe("/sitecore/content/Demo/Corporate");
    expect(roots.mediaFolder?.path).toBe("/sitecore/media library/Project/Demo/Corporate");
    expect((await demo.getChildren("/sitecore/content/Demo/Corporate/Home")).map((c) => c.name)).toEqual(["News", "About"]);
    expect((await demo.getTreeRoots(undefined)).content.path).toBe("/sitecore/content");
  });

  it("derives exactly one media folder from the site path", () => {
    expect(siteMediaFolderPath("/sitecore/content/Hztl/BrandX")).toBe("/sitecore/media library/Project/Hztl/BrandX");
    expect(siteMediaFolderPath("/sitecore/content")).toBeNull();
    expect(siteMediaFolderPath("/sitecore/templates/x")).toBeNull();
    expect(isPathWithin("/Sitecore/Content/A/b", "/sitecore/content/a")).toBe(true);
    expect(isPathWithin("/sitecore/contentx", "/sitecore/content")).toBe(false);
  });

  it("selecting a tree item in live mode satisfies the destination check; editing the path clears it", () => {
    let mapping = applyMappingPatch({ fields: {} }, { destinationPath: "/sitecore/content/Brands/BrandX/Home/News", destinationVerified: { path: "/sitecore/content/Brands/BrandX/Home/News", itemId: "{10000000-0000-0000-0000-000000000005}" } });
    expect(destinationIssue(mapping, "live")).toBeNull();
    mapping = applyMappingPatch(mapping, { destinationPath: "/sitecore/content/Brands/BrandX/Home" });
    expect(destinationIssue(mapping, "live")).toMatch(/Select the parent item/);
  });
});

describe("site selection shared by the upload panel and Template mapping", () => {
  const sites = [
    { id: "a", name: "brand-a", displayName: "Brand A", languages: ["en", "de"], defaultDestination: "/sitecore/content/A/Home" },
    { id: "b", name: "brand-b", displayName: "Brand B", languages: ["en"] },
  ];

  it("chosen before upload, the site and language carry into mapping; a new site resets its tree selections", () => {
    let mapping = applyMappingPatch({ fields: {} }, siteSelectionPatch({ fields: {} }, "a", sites));
    expect(mapping).toMatchObject({ siteId: "a", siteKey: "brand-a", siteName: "Brand A", destinationPath: "/sitecore/content/A/Home" });
    mapping = applyMappingPatch(mapping, { language: "de", mediaFolder: "/sitecore/media library/Project/A" });
    // Choosing the same site again keeps everything.
    expect(applyMappingPatch(mapping, siteSelectionPatch(mapping, "a", sites))).toMatchObject({ language: "de", mediaFolder: "/sitecore/media library/Project/A" });
    const switched = applyMappingPatch(mapping, siteSelectionPatch(mapping, "b", sites));
    expect(switched).toMatchObject({ siteId: "b", siteKey: "brand-b", destinationPath: undefined, mediaFolder: undefined, language: undefined });
  });

  it("offers only the site's languages", () => {
    const languages = [{ code: "en", name: "English" }, { code: "de", name: "German" }, { code: "fr", name: "French" }];
    expect(siteLanguages(languages, sites[0]).map((l) => l.code)).toEqual(["en", "de"]);
    expect(siteLanguages(languages, undefined)).toHaveLength(3);
  });
});

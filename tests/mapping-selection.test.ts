import type { ClientSDK } from "@sitecore-marketplace-sdk/client";
import { describe, expect, it } from "vitest";
import { createSampleExtraction } from "@/src/fixtures/sample-extraction";
import { autoMap, buildFieldValue, destinationIssue, reconcileMapping, selectedTemplate, validateMapping } from "@/src/lib/mapping";
import { buildCreateItemMutation, REQUIRED_VALIDATOR_ID, sameSitecoreId, STANDARD_TEMPLATE_ID } from "@/src/lib/sitecore/graphql";
import { LiveSitecoreAdapter } from "@/src/lib/sitecore/live-adapter";
import type { SitecoreTemplate } from "@/src/lib/types/sitecore";
import type { Workspace } from "@/src/lib/types/workspace";
import { createWorkspace, workspaceReducer, type WorkspaceAction } from "@/src/lib/workspace";

// Regression tests for the Template Mapping bug: the Authoring API returned template IDs in a
// different format from getTemplate(), so the selected template never matched its field snapshot.
// Validation then reported "Select a content template." and the field table rendered nothing.

const ARTICLE_RAW = "aaaaaaaabbbbccccddddeeeeeeeeeeee"; // as the Authoring API returns itemId: no braces, lowercase
const ARTICLE = "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}";
const NEWS_RAW = "cccccccc0000111122223333444455556".slice(0, 32);
const BASE = "{BBBBBBBB-0000-1111-2222-333344445555}";
const PARENT = { itemId: "99999999888877776666555544443333", path: "/sitecore/content/Corp/Site/Home/News" };

const field = (name: string, type: string, rules = "") => ({ name, template: { name: "Template field" }, type: { value: type }, validatorBar: { value: rules } });

function authoringApi(options: { failTree?: boolean; failFields?: boolean } = {}) {
  const sent: string[] = [];
  const handler = (query: string, vars: Record<string, unknown>): unknown => {
    sent.push(query);
    const id = typeof vars.id === "string" ? vars.id.toUpperCase() : "";
    if (query.includes("ContentStudioTemplateTree")) {
      if (options.failTree) return { errors: [{ message: "Access denied for /sitecore/templates/Project" }] };
      return {
        data: {
          item: {
            itemId: "root", name: "Project", path: "/sitecore/templates/Project", template: { name: "Template Folder" },
            children: { nodes: [
              { itemId: ARTICLE_RAW, name: "Article Detail Page", path: "/sitecore/templates/Project/Article Detail Page", template: { name: "Template" } },
              { itemId: NEWS_RAW, name: "News Page", path: "/sitecore/templates/Project/News Page", template: { name: "Template" } },
              { itemId: "not-a-guid", name: "Broken", template: { name: "Template" } },
            ] },
          },
        },
      };
    }
    if (query.includes("ContentStudioTemplateFields")) {
      if (options.failFields) return { errors: [{ message: "Template could not be read" }] };
      if (id === ARTICLE) {
        return { data: { item: { itemId: ARTICLE_RAW, name: "Article Detail Page", path: "/sitecore/templates/Project/Article Detail Page", baseTemplates: { value: `${BASE}|${STANDARD_TEMPLATE_ID}` },
          children: { nodes: [{ name: "Content", template: { name: "Template section" }, children: { nodes: [field("Title", "Single-Line Text"), field("Body", "Rich Text")] } }] } } } };
      }
      if (id === BASE) {
        return { data: { item: { itemId: BASE, name: "_Seo", baseTemplates: { value: "" }, children: { nodes: [{ name: "SEO", template: { name: "Template section" }, children: { nodes: [field("Meta Title", "Single-Line Text")] } }] } } } };
      }
      if (id === `{${NEWS_RAW.toUpperCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")}}`) {
        return { data: { item: { itemId: NEWS_RAW, name: "News Page", baseTemplates: { value: "" }, children: { nodes: [{ name: "Data", template: { name: "Template section" }, children: { nodes: [field("Heading", "Single-Line Text"), field("Summary", "Multi-Line Text")] } }] } } } };
      }
      return { data: { item: null } };
    }
    if (query.includes("ContentStudioTemplateValidation")) {
      const required = id === ARTICLE ? REQUIRED_VALIDATOR_ID : "";
      return { data: { item: { children: { nodes: [{ template: { name: "Template section" }, children: { nodes: [{ name: "Title", validatorBar: { value: required } }] } }] } } } };
    }
    if (query.includes("ContentStudioItemByPath")) {
      return { data: { item: vars.path === PARENT.path ? { itemId: PARENT.itemId, name: "News", path: PARENT.path } : null } };
    }
    if (query.includes("ContentStudioCreateItem")) return { data: { createItem: { item: { itemId: "12121212343456567878909012121212", name: "x", path: `${PARENT.path}/x` } } } };
    throw new Error("unexpected query");
  };
  const client = {
    async query(key: string) {
      if (key === "xmc.sites.listSites") return { data: { data: [{ id: "site-1", name: "brand", displayName: "Brand", languages: ["en"] }] } };
      return { data: { data: [{ name: "en", englishName: "English" }] } };
    },
    async mutate(_key: string, opts: { params: { body: { query: string; variables?: Record<string, unknown> } } }) {
      return { data: handler(opts.params.body.query, opts.params.body.variables ?? {}) };
    },
  };
  const adapter = new LiveSitecoreAdapter(client as unknown as ClientSDK, "ctx", { templateRootPath: "/sitecore/templates/Project", experimentalMediaUpload: false }, "Sandbox");
  return { adapter, sent };
}

const apply = (ws: Workspace, ...actions: WorkspaceAction[]) => actions.reduce(workspaceReducer, ws);

/** What MappingStep does when a template is chosen in the dropdown and its fields load. */
async function chooseTemplate(ws: Workspace, adapter: LiveSitecoreAdapter, listId: string): Promise<Workspace> {
  ws = apply(ws, { type: "set-mapping", patch: { templateId: listId } });
  const template = await adapter.getTemplate(ws.mapping.templateId as string);
  ws = apply(ws, { type: "set-mapping", patch: { templateId: template.id, template } });
  return apply(ws, { type: "replace-field-mappings", fields: autoMap(template, ws) });
}

async function verified(ws: Workspace, adapter: LiveSitecoreAdapter, path: string): Promise<Workspace> {
  ws = apply(ws, { type: "set-mapping", patch: { destinationPath: path } });
  const check = await adapter.checkDestination(path);
  return check.ok ? apply(ws, { type: "set-mapping", patch: { destinationVerified: { path, itemId: check.itemId } } }) : ws;
}

const messages = (ws: Workspace) => validateMapping(selectedTemplate(ws.mapping), ws.mapping, ws, "live").filter((i) => i.level === "error").map((i) => i.message);
const base = () => apply(createWorkspace(createSampleExtraction()), { type: "set-mapping", patch: { siteId: "site-1", siteName: "Brand", siteKey: "brand", language: "en", itemName: "Test item" } });

describe("template selection (regression)", () => {
  it("1. selecting a template by its real ID clears the template error, and IDs agree end to end", async () => {
    const { adapter } = authoringApi();
    const templates = await adapter.listTemplates();
    const article = templates.find((t) => t.name === "Article Detail Page")!;
    // Root cause: list IDs and getTemplate IDs must be the same canonical value.
    expect(article.id).toBe(ARTICLE);
    expect(templates.map((t) => t.name)).not.toContain("Broken");

    let ws = base();
    expect(messages(ws)).toContain("Select a content template.");
    ws = await chooseTemplate(ws, adapter, article.id);
    expect(ws.mapping.templateId).toBe(ARTICLE);
    expect(selectedTemplate(ws.mapping)?.id).toBe(ARTICLE);
    expect(messages(ws).some((m) => /template/i.test(m))).toBe(false);
  });

  it("1b. a session saved before the fix (raw list ID, braced snapshot) still resolves", async () => {
    const { adapter } = authoringApi();
    const template = await adapter.getTemplate(ARTICLE_RAW);
    const ws = apply(base(), { type: "set-mapping", patch: { templateId: ARTICLE_RAW, template } });
    expect(sameSitecoreId(ARTICLE_RAW, ARTICLE)).toBe(true);
    expect(selectedTemplate(ws.mapping)?.name).toBe("Article Detail Page");
  });

  it("2. a template label without a valid ID, or a snapshot for another template, does not pass", async () => {
    const { adapter } = authoringApi();
    const article = await adapter.getTemplate(ARTICLE);
    const byLabel = apply(base(), { type: "set-mapping", patch: { templateId: "Article Detail Page" } });
    expect(messages(byLabel)).toContain("The selected template does not have a valid Sitecore ID. Select it again from the list.");
    await expect(adapter.getTemplate("Article Detail Page")).rejects.toThrow(/valid Sitecore ID/);

    const snapshotOnly = { ...base(), mapping: { ...base().mapping, templateId: undefined, template: article } };
    expect(messages(snapshotOnly)).toContain("Select a content template.");
    expect(validateMapping(article, snapshotOnly.mapping, snapshotOnly, "live").some((i) => i.message === "Select a content template.")).toBe(true);

    const mismatched = { ...base(), mapping: { ...base().mapping, templateId: `{${NEWS_RAW}}`, template: article } };
    expect(selectedTemplate(mismatched.mapping)).toBeUndefined();
    expect(messages(mismatched).some((m) => m.startsWith("The fields of the selected template are not loaded"))).toBe(true);
  });
});

describe("destination path (regression)", () => {
  const PLACEHOLDER = "/sitecore/content/<collection>/<site>/Home/News";

  it("3. a placeholder path never passes, in live or demo mode", () => {
    for (const mode of ["live", "demo"] as const) {
      expect(destinationIssue({ destinationPath: PLACEHOLDER }, mode)).toMatch(/placeholder text/);
      // Even a stale verification record cannot make a placeholder valid.
      expect(destinationIssue({ destinationPath: PLACEHOLDER, destinationVerified: { path: PLACEHOLDER, itemId: "x" } }, mode)).toMatch(/placeholder text/);
    }
    expect(destinationIssue({ destinationPath: "  " }, "live")).toBe("Select a destination (parent item).");
  });

  it("4. only a path Sitecore confirmed passes in live mode; edits invalidate it", async () => {
    const { adapter } = authoringApi();
    let ws = apply(base(), { type: "set-mapping", patch: { destinationPath: PARENT.path } });
    expect(destinationIssue(ws.mapping, "live")).toMatch(/Select the parent item in the content tree/);

    ws = await verified(ws, adapter, PARENT.path);
    expect(ws.mapping.destinationVerified).toEqual({ path: PARENT.path, itemId: PARENT.itemId });
    expect(destinationIssue(ws.mapping, "live")).toBeNull();

    ws = apply(ws, { type: "set-mapping", patch: { destinationPath: `${PARENT.path}/Other` } });
    expect(ws.mapping.destinationVerified).toBeUndefined();
    expect(ws.mapping.destinationPath).toBe(`${PARENT.path}/Other`);

    const missing = await adapter.checkDestination("/sitecore/content/Corp/Site/Home/Missing");
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) expect(missing.message).toMatch(/No item exists .* or you do not have access/);
  });
});

describe("field mapping (regression)", () => {
  it("5. the mapping is built from the fields Sitecore returned, including inherited ones", async () => {
    const { adapter } = authoringApi();
    const ws = await chooseTemplate(base(), adapter, ARTICLE);
    const template = selectedTemplate(ws.mapping)!;
    expect(template.fields.map((f) => f.name)).toEqual(["Title", "Body", "Meta Title"]);
    expect(template.fields.find((f) => f.name === "Meta Title")?.definedIn).toBe("_Seo");
    expect(template.fields.find((f) => f.name === "Title")).toMatchObject({ required: true, requiredSource: "validation-rule" });
    expect(Object.keys(ws.mapping.fields).sort()).toEqual(["Body", "Meta Title", "Title"]);
    expect(ws.mapping.fields.Title).toEqual({ kind: "content", contentType: "headline", mode: "first" });
  });

  it("6. changing the template drops the old fields and maps the new template's fields", async () => {
    const { adapter } = authoringApi();
    let ws = await chooseTemplate(base(), adapter, ARTICLE);
    ws = apply(ws, { type: "set-mapping", patch: { templateId: NEWS_RAW } });
    expect(ws.mapping.template).toBeUndefined();
    expect(ws.mapping.fields).toEqual({});

    ws = await chooseTemplate(ws, adapter, NEWS_RAW);
    expect(selectedTemplate(ws.mapping)?.name).toBe("News Page");
    expect(Object.keys(ws.mapping.fields).sort()).toEqual(["Heading", "Summary"]);
  });

  it("7. changing the site invalidates the destination verification and missing selections", async () => {
    const { adapter } = authoringApi();
    let ws = await verified(base(), adapter, PARENT.path);
    expect(ws.mapping.destinationVerified).toBeDefined();
    ws = apply(ws, { type: "set-mapping", patch: { siteId: "site-2", siteName: "Other" } });
    expect(ws.mapping.destinationVerified).toBeUndefined();
    expect(ws.mapping.destinationPath).toBe(PARENT.path);
    expect(destinationIssue(ws.mapping, "live")).toMatch(/Select the parent item/);

    const sites = await adapter.listSites();
    const result = reconcileMapping(ws.mapping, { sites });
    expect(result?.patch).toMatchObject({ siteId: undefined });
  });

  it("8. restored state keeps valid selections and clears unknown ones without inventing IDs", async () => {
    const { adapter } = authoringApi();
    let ws = await chooseTemplate(base(), adapter, ARTICLE);
    ws = await verified(ws, adapter, PARENT.path);
    const restored: Workspace = JSON.parse(JSON.stringify(ws));
    const lists = { sites: await adapter.listSites(), languages: await adapter.listLanguages(), templates: await adapter.listTemplates() };
    expect(reconcileMapping(restored.mapping, lists)).toBeNull();
    expect(messages(restored).filter((m) => /template|destination/i.test(m))).toEqual([]);

    // A workspace mapped in demo mode, opened in live mode: the demo template is not carried over.
    const demo = { ...restored.mapping, templateId: "demo-tpl-press-release", siteId: "demo-site-corporate" };
    const result = reconcileMapping(demo, lists)!;
    expect(result.patch).toMatchObject({ templateId: undefined, siteId: undefined });
    expect(result.notices.length).toBe(2);
    const cleared = apply(restored, { type: "set-mapping", patch: { ...demo, ...result.patch } });
    expect(cleared.mapping.templateId).toBeUndefined();
    expect(cleared.mapping.template).toBeUndefined();
    expect(cleared.mapping.fields).toEqual({});
  });

  it("9. API failures surface actionable errors and never fall back to demo data", async () => {
    const tree = authoringApi({ failTree: true }).adapter;
    await expect(tree.listTemplates()).rejects.toThrow(/Access denied|permission/i);
    expect(tree.status.mode).toBe("live");

    const fields = authoringApi({ failFields: true }).adapter;
    await expect(fields.getTemplate(ARTICLE)).rejects.toThrow(/Template could not be read/);
    expect(fields.status.mode).toBe("live");
  });

  it("10. preview and creation use the same validated template ID, destination and fields", async () => {
    const { adapter, sent } = authoringApi();
    let ws = await chooseTemplate(base(), adapter, ARTICLE);
    ws = await verified(ws, adapter, PARENT.path);
    expect(messages(ws)).toEqual([]);

    // Exactly what PreviewStep sends.
    const template = selectedTemplate(ws.mapping) as SitecoreTemplate;
    const fields = template.fields.map((f) => buildFieldValue(f, ws.mapping.fields[f.name], ws, "live")).filter((v) => v.value !== null).map((v) => ({ name: v.field.name, value: v.value as string }));
    const result = await adapter.createItem({ name: "Test item", templateId: template.id, parentPath: ws.mapping.destinationPath as string, language: ws.mapping.language as string, fields });
    expect(result.ok).toBe(true);

    const mutation = sent.find((q) => q.includes("ContentStudioCreateItem")) as string;
    expect(mutation).toContain(`templateId: "${ARTICLE}"`);
    expect(mutation).toContain(`parent: "{99999999-8888-7777-6666-555544443333}"`);
    for (const f of fields) expect(mutation).toContain(`name: ${JSON.stringify(f.name)}`);
    // The request reviewed in the confirmation is exactly the one sent.
    const reviewed = buildCreateItemMutation({ name: "Test item", templateId: template.id, parentPath: ws.mapping.destinationPath as string, parentId: ws.mapping.destinationVerified?.itemId as string, language: "en", fields }).query;
    expect(mutation).toBe(reviewed);
    expect(fields.map((f) => f.name)).toContain("Title");
  });
});

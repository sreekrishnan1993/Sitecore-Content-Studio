import { describe, expect, it } from "vitest";
import { createSampleExtraction } from "@/src/fixtures/sample-extraction";
import { autoMap, buildFieldValue, decodeSource, encodeSource, suggestItemName, toSitecoreDate, validateItemName, validateMapping } from "@/src/lib/mapping";
import { DemoSitecoreAdapter, demoStatus } from "@/src/lib/sitecore/demo-adapter";
import { buildCreateItemMutation, collectTemplates, normalizeFieldType } from "@/src/lib/sitecore/graphql";
import { isPublicAddress, parsePublicationUrl } from "@/src/lib/extraction/url-fetch";
import type { SitecoreTemplate } from "@/src/lib/types/sitecore";
import type { Workspace } from "@/src/lib/types/workspace";
import { createWorkspace, workspaceReducer, type WorkspaceAction } from "@/src/lib/workspace";

const apply = (ws: Workspace, ...actions: WorkspaceAction[]) => actions.reduce(workspaceReducer, ws);

describe("workspace / whiteboard state", () => {
  it("starts with contained statistics/quotes deselected and everything else selected", () => {
    const ws = createWorkspace(createSampleExtraction());
    const stat = ws.cards.find((c) => c.type === "statistic")!;
    expect(stat.selected).toBe(false);
    expect(ws.cards.filter((c) => c.type !== "statistic").every((c) => c.selected)).toBe(true);
    expect(ws.images.every((i) => i.selected)).toBe(true);
  });

  it("selects, edits, adds, duplicates, reorders, deletes and restores cards", () => {
    let ws = createWorkspace(createSampleExtraction());
    const [first, second] = ws.cards;

    ws = apply(ws, { type: "toggle-card", id: first.id });
    expect(ws.cards[0].selected).toBe(false);

    ws = apply(ws, { type: "update-card", id: second.id, patch: { text: "Edited lead" } });
    expect(ws.cards[1]).toMatchObject({ text: "Edited lead", edited: true, origin: "extracted" });

    ws = apply(ws, { type: "add-card", cardType: "cta", id: "new-card", afterId: first.id });
    expect(ws.cards[1]).toMatchObject({ id: "new-card", type: "cta", origin: "manual", selected: true, text: "" });

    ws = apply(ws, { type: "duplicate-card", id: second.id, newId: "copy" });
    const copyIndex = ws.cards.findIndex((c) => c.id === "copy");
    expect(ws.cards[copyIndex - 1].id).toBe(second.id);
    expect(ws.cards[copyIndex].origin).toBe("manual");

    const count = ws.cards.length;
    ws = apply(ws, { type: "move-card", id: first.id, toIndex: count - 1 });
    expect(ws.cards[count - 1].id).toBe(first.id);

    const removed = ws.cards[2];
    ws = apply(ws, { type: "delete-card", id: removed.id });
    expect(ws.cards.find((c) => c.id === removed.id)).toBeUndefined();
    ws = apply(ws, { type: "restore-card", card: removed, index: 2 });
    expect(ws.cards[2]).toEqual(removed);
  });

  it("does not change the workspace for no-op moves", () => {
    const ws = createWorkspace(createSampleExtraction());
    expect(workspaceReducer(ws, { type: "move-card", id: ws.cards[0].id, toIndex: 0 })).toBe(ws);
  });
});

async function demoTemplate(): Promise<SitecoreTemplate> {
  return new DemoSitecoreAdapter(demoStatus("test")).getTemplate("demo-tpl-press-release");
}

function mappedWorkspace(template: SitecoreTemplate): Workspace {
  let ws = createWorkspace(createSampleExtraction());
  ws = apply(
    ws,
    { type: "set-mapping", patch: { siteId: "demo-site-corporate", templateId: template.id, template, language: "en", destinationPath: "/sitecore/content/Demo/Corporate/Home/News", itemName: "Atlas launch" } },
  );
  return apply(ws, { type: "replace-field-mappings", fields: autoMap(template, ws) });
}

describe("template mapping", () => {
  it("auto-maps fields by name and type", async () => {
    const template = await demoTemplate();
    const ws = mappedWorkspace(template);
    const f = ws.mapping.fields;
    expect(f.Title).toEqual({ kind: "content", contentType: "headline", mode: "first" });
    expect(f.Summary).toEqual({ kind: "content", contentType: "summary", mode: "first" });
    expect(f.Body).toEqual({ kind: "article" });
    expect(f["Quote Author"]).toMatchObject({ kind: "card", part: "attribution" });
    expect(f["Hero Image"]).toMatchObject({ kind: "image" });
    expect(f["Publish Date"]).toEqual({ kind: "metadata", key: "createdAt" });
    expect(f["Meta Title"]).toMatchObject({ kind: "card" });
    // The only statistic is inside a paragraph and starts deselected, so it must not be auto-mapped.
    expect(f["Key Statistic"]).toEqual({ kind: "none" });
  });

  it("builds escaped Sitecore field values", async () => {
    const template = await demoTemplate();
    let ws = mappedWorkspace(template);
    const bodyCard = ws.cards.find((c) => c.type === "body")!;
    ws = apply(ws, { type: "update-card", id: bodyCard.id, patch: { text: "Uses <script>alert(1)</script> & more" } });
    const body = buildFieldValue(template.fields.find((x) => x.name === "Body")!, ws.mapping.fields.Body, ws, "live");
    expect(body.value).toContain("<h2>Availability and pricing</h2>");
    expect(body.value).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
    expect(body.value).toContain("<blockquote><p>Atlas Insights gives every store manager");
    expect(body.value).not.toContain("<script>");

    const cta = buildFieldValue(template.fields.find((x) => x.name === "Call To Action")!, { kind: "content", contentType: "cta", mode: "first" }, ws, "live");
    expect(cta.value).toMatch(/^<link linktype="external" url="https:\/\/example.com\/atlas"/);

    const date = buildFieldValue(template.fields.find((x) => x.name === "Publish Date")!, ws.mapping.fields["Publish Date"], ws, "live");
    expect(date.value).toBe("20260303T090000Z");

    const image = buildFieldValue(template.fields.find((x) => x.name === "Hero Image")!, ws.mapping.fields["Hero Image"], ws, "live");
    expect(image.value).toBeNull();
    // Live mode: an image that is not in the Media Library blocks creation instead of being silently dropped.
    expect(image.blocking).toMatch(/has not been uploaded to the Media Library/);
  });

  it("reports required-field, unmapped and destination errors", async () => {
    const template = await demoTemplate();
    let ws = mappedWorkspace(template);
    expect(validateMapping(template, ws.mapping, ws, "demo").filter((i) => i.level === "error")).toEqual([]);

    ws = apply(ws, { type: "set-field-mapping", field: "Title", source: { kind: "none" } }, { type: "set-mapping", patch: { destinationPath: "/content/wrong", itemName: " bad name" } });
    const issues = validateMapping(template, ws.mapping, ws, "demo");
    const messages = issues.filter((i) => i.level === "error").map((i) => i.message);
    expect(messages).toContain('Required field "Title" is not mapped.');
    expect(messages).toContain("The destination must be under /sitecore/content/.");
    expect(messages.some((m) => m.startsWith("Item names can contain"))).toBe(true);

    // A required field mapped to deselected content is an error, not a silent empty value.
    ws = mappedWorkspace(template);
    const headline = ws.cards.find((c) => c.type === "headline")!;
    ws = apply(ws, { type: "toggle-card", id: headline.id });
    expect(validateMapping(template, ws.mapping, ws, "demo").some((i) => i.level === "error" && i.field === "Title")).toBe(true);

    expect(validateMapping(undefined, { fields: {} }, ws, "demo").map((i) => i.message)).toEqual(
      expect.arrayContaining(["Select a site.", "Select a content template.", "Select a language.", "Select a destination (parent item)."]),
    );
  });

  it("round-trips mapping sources through select values", () => {
    for (const source of [
      { kind: "none" },
      { kind: "article" },
      { kind: "content", contentType: "quote", mode: "all" },
      { kind: "card", cardId: "blk_1", part: "attribution" },
      { kind: "image", imageId: "img_1" },
      { kind: "metadata", key: "author" },
    ] as const) {
      expect(decodeSource(encodeSource(source))).toEqual(source);
    }
  });

  it("suggests valid Sitecore item names", () => {
    const name = suggestItemName("Northwind’s Atlas: 32% fewer stock-outs!");
    expect(validateItemName(name)).toBeNull();
    expect(validateItemName("-leading hyphen")).not.toBeNull();
    expect(toSitecoreDate("not a date")).toBeNull();
  });
});

describe("Sitecore adapters", () => {
  it("demo mode never reports a successful item creation", async () => {
    const adapter = new DemoSitecoreAdapter(demoStatus("test"));
    expect(adapter.status.canCreateItems).toBe(false);
    const result = await adapter.createItem({ name: "Item", templateId: "demo-tpl-article", parentPath: "/sitecore/content/Demo", language: "en", fields: [{ name: "Heading", value: "Hi" }] });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "demo-mode") {
      expect(result.message).toMatch(/nothing was sent to Sitecore/);
      expect(result.preview.query).toContain("createItem");
    } else {
      throw new Error("Expected a demo-mode result");
    }
  });

  it("builds a createItem mutation with safely quoted values", () => {
    const { query } = buildCreateItemMutation({
      name: "Atlas",
      templateId: "{ABC}",
      parentId: "1234",
      parentPath: "/sitecore/content/x",
      language: "en",
      fields: [{ name: "Body", value: '<p>He said "hi"\nand left \\ }</p>' }],
    });
    expect(query).toContain('value: "<p>He said \\"hi\\"\\nand left \\\\ }</p>"');
    expect(query).toContain('parent: "1234"');
    expect(query).not.toContain("publish");
  });

  it("finds templates in an item tree and normalises field types", () => {
    const templates = collectTemplates({
      itemId: "root",
      name: "Project",
      template: { name: "Template Folder" },
      children: { nodes: [{ itemId: "t1", name: "Press Release", path: "/p/Press Release", template: { name: "Template" } }, { itemId: "f", name: "Folder", template: { name: "Template Folder" }, children: { nodes: [{ itemId: "t2", name: "Article", template: { name: "Template" } }] } }] },
    });
    expect(templates.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(normalizeFieldType("Rich Text")).toBe("Rich Text");
    expect(normalizeFieldType("Droplink")).toBe("Reference");
    expect(normalizeFieldType("Some Custom Type")).toBe("Other");
  });
});

describe("publication URL guard", () => {
  it("blocks private, loopback and link-local addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  it("rejects non-web URLs, credentials and unusual ports", () => {
    expect(() => parsePublicationUrl("file:///etc/passwd")).toThrow(/Only http and https/);
    expect(() => parsePublicationUrl("https://user:pw@example.com")).toThrow(/credentials/);
    expect(() => parsePublicationUrl("http://example.com:8080/")).toThrow(/ports/);
    expect(() => parsePublicationUrl("not a url")).toThrow(/full URL/);
    expect(parsePublicationUrl("https://example.com/news").hostname).toBe("example.com");
  });
});

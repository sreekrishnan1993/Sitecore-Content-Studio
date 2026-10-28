import type { ClientSDK } from "@sitecore-marketplace-sdk/client";
import { describe, expect, it } from "vitest";
import { createSampleExtraction } from "@/src/fixtures/sample-extraction";
import { autoMap, buildFieldValue, selectedTemplate, validateMapping } from "@/src/lib/mapping";
import type { SitecoreAdapter } from "@/src/lib/sitecore/adapter";
import { DemoSitecoreAdapter, demoStatus } from "@/src/lib/sitecore/demo-adapter";
import { mediaIdFromImageValue, normalizeFieldType, toImageFieldValue } from "@/src/lib/sitecore/graphql";
import { LiveSitecoreAdapter, mediaLibraryRelativePath } from "@/src/lib/sitecore/live-adapter";
import type { MediaUploadResult, SitecoreTemplate } from "@/src/lib/types/sitecore";
import type { Workspace } from "@/src/lib/types/workspace";
import { createWorkspace, workspaceReducer, type WorkspaceAction } from "@/src/lib/workspace";

// The selected image must reach the created item's Image field as a reference to a media item that
// Sitecore confirmed. These tests follow the image from selection to the createItem payload.

const MEDIA_RAW = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const MEDIA = "{A1B2C3D4-E5F6-0718-293A-4B5C6D7E8F90}";
const FOLDER = "/sitecore/media library/Project/Brand";
const MEDIA_PATH = `${FOLDER}/hero`;
const PARENT = { itemId: "11111111222233334444555555555555", path: "/sitecore/content/Brand/Home/News" };
const CREATED = "99999999888877776666555544443333";
const TEMPLATE: SitecoreTemplate = {
  id: "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}",
  name: "Article Detail Page",
  requiredInfo: "available",
  fields: [
    { name: "Title", type: "Single-Line Text", required: true },
    { name: "Hero Image", id: "{F1F1F1F1-0000-0000-0000-000000000001}", type: "Image", rawType: "Image", required: false },
    { name: "Thumbnail Image", id: "{F1F1F1F1-0000-0000-0000-000000000002}", type: "Image", rawType: "Image", required: false },
    { name: "Link", type: "General Link", rawType: "General Link", required: false },
    { name: "Category", type: "Reference", rawType: "Droplink", required: false },
  ],
};

interface Options {
  upload?: () => unknown;
  createFails?: boolean;
  savedImage?: (sent: string) => string;
}

function sandbox(options: Options = {}) {
  const sent: Array<{ key: string; query?: string; body?: Record<string, unknown> }> = [];
  let createdValue = "";
  const graphql = (query: string, vars: Record<string, unknown>) => {
    if (query.includes("ContentStudioItemByPath")) {
      if (vars.path === FOLDER) return { data: { item: { itemId: "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0", path: FOLDER } } };
      return { data: { item: vars.path === PARENT.path ? { itemId: PARENT.itemId, path: PARENT.path } : null } };
    }
    if (query.includes("ContentStudioItemById")) {
      return { data: { item: vars.id === MEDIA ? { itemId: MEDIA_RAW, name: "hero", path: MEDIA_PATH } : null } };
    }
    if (query.includes("ContentStudioCreateItem")) {
      createdValue = /name: "Hero Image", value: "((?:[^"\\]|\\.)*)"/.exec(query)?.[1]?.replace(/\\"/g, '"') ?? "";
      return { data: { createItem: { item: { itemId: CREATED, name: "x", path: `${PARENT.path}/x` } } } };
    }
    if (query.includes("ContentStudioReadFields")) {
      return { data: { item: { f0: { value: options.savedImage ? options.savedImage(createdValue) : createdValue } } } };
    }
    throw new Error(`unexpected ${query.slice(0, 40)}`);
  };
  const client = {
    async mutate(key: string, opts: { params: { body: Record<string, unknown> & { query?: string; variables?: Record<string, unknown> } } }) {
      sent.push({ key, query: opts.params.body.query, body: opts.params.body });
      if (key === "xmc.agent.assetsUploadAsset") {
        return options.upload ? options.upload() : { data: { success: true, mediaItem: { id: MEDIA_RAW, embedUrl: "https://edge/hero.png" } }, response: { status: 200 } };
      }
      const query = opts.params.body.query ?? "";
      if (options.createFails && query.includes("ContentStudioCreateItem")) {
        return { data: undefined, error: { errors: [{ message: "Field 'Hero Image' could not be set", path: ["createItem"] }] }, response: { status: 400 } };
      }
      return { data: graphql(query, opts.params.body.variables ?? {}), response: { status: 200 } };
    },
  };
  const live = new LiveSitecoreAdapter(client as unknown as ClientSDK, "ctx", { templateRootPath: "/sitecore/templates/Project", experimentalMediaUpload: true }, "Sandbox");
  return { live, sent };
}

const apply = (ws: Workspace, ...actions: WorkspaceAction[]) => actions.reduce(workspaceReducer, ws);

function workspace(): Workspace {
  return apply(createWorkspace(createSampleExtraction()), {
    type: "set-mapping",
    patch: { siteId: "s1", siteKey: "brand", language: "en", templateId: TEMPLATE.id, template: TEMPLATE, destinationPath: PARENT.path, destinationVerified: { path: PARENT.path, itemId: PARENT.itemId }, itemName: "ContentStudio-Test-20261027-1500" },
  });
}

/** What MediaUploadPanel does with an upload result. */
async function uploadFirstImage(ws: Workspace, live: LiveSitecoreAdapter): Promise<{ ws: Workspace; result: MediaUploadResult }> {
  const img = ws.extraction.images[0];
  const result = await live.uploadMedia({ file: new Blob([new Uint8Array(8)], { type: "image/png" }), name: "hero", extension: "png", mimeType: "image/png", imageId: img.id, folderPath: "/sitecore/media library/Project/Brand", language: "en", siteName: "brand" });
  const at = "now";
  ws = apply(ws, {
    type: "update-image",
    id: img.id,
    patch: {
      mediaUpload: result.ok
        ? { state: "uploaded", mediaItemId: result.mediaItemId, mediaPath: result.mediaPath, at, diagnostics: result.diagnostics }
        : { state: result.reason === "uncertain" ? "uncertain" : "failed", message: result.message, at, diagnostics: result.diagnostics },
    },
  });
  return { ws, result };
}

/** What PreviewStep sends. */
function payload(ws: Workspace) {
  const template = selectedTemplate(ws.mapping) as SitecoreTemplate;
  return template.fields
    .map((f) => buildFieldValue(f, ws.mapping.fields[f.name], ws, "live"))
    .filter((v) => v.value !== null)
    .map((v) => ({ name: v.field.name, value: v.value as string, type: v.field.type, fieldId: v.field.id }));
}

const imageId = (ws: Workspace) => ws.extraction.images[0].id;
const errorsFor = (ws: Workspace, field: string) => validateMapping(TEMPLATE, ws.mapping, ws, "live").filter((i) => i.level === "error" && i.field === field);

describe("image field mapping", () => {
  it("1. the selected image and its mapping persist across updates and a session round trip", () => {
    let ws = workspace();
    ws = apply(ws, { type: "set-field-mapping", field: "Hero Image", source: { kind: "image", imageId: imageId(ws) } });
    ws = apply(ws, { type: "set-mapping", patch: { itemName: "Renamed" } }, { type: "update-image", id: imageId(ws), patch: { altText: "Dashboard" } });
    const restored: Workspace = JSON.parse(JSON.stringify(ws));
    expect(restored.mapping.fields["Hero Image"]).toEqual({ kind: "image", imageId: imageId(ws) });
    expect(restored.images[0]).toMatchObject({ selected: true, altText: "Dashboard" });
  });

  it("2. a confirmed upload stores the braced media ID and path, and the field gets the image value", async () => {
    const { live } = sandbox();
    const { ws, result } = await uploadFirstImage(workspace(), live);
    expect(result).toMatchObject({ ok: true, mediaItemId: MEDIA, mediaPath: MEDIA_PATH, diagnostics: { verified: "yes", success: true, returnedId: MEDIA_RAW, httpStatus: 200 } });
    expect(ws.images[0].mediaUpload).toMatchObject({ state: "uploaded", mediaItemId: MEDIA, mediaPath: MEDIA_PATH });
    const mapped = apply(ws, { type: "set-field-mapping", field: "Hero Image", source: { kind: "image", imageId: imageId(ws) } });
    expect(buildFieldValue(TEMPLATE.fields[1], mapped.mapping.fields["Hero Image"], mapped, "live").value).toBe(`<image mediaid="${MEDIA}" />`);
    expect(errorsFor(mapped, "Hero Image")).toEqual([]);
  });

  it("3. a failed or unconfirmed upload never becomes an image reference and blocks creation", async () => {
    for (const [upload, reason] of [
      [() => ({ data: { success: false }, response: { status: 200 } }), "error"],
      [() => ({ data: { success: true, mediaItem: { id: "not-a-guid" } }, response: { status: 200 } }), "error"],
      [() => ({ data: undefined, error: { detail: "Forbidden" }, response: { status: 403 } }), "error"],
      [() => { throw new Error("timeout"); }, "uncertain"],
      [() => ({ data: { success: true, mediaItem: { id: "deadbeefdeadbeefdeadbeefdeadbeef" } }, response: { status: 200 } }), "uncertain"], // ID not found afterwards
    ] as const) {
      const { live } = sandbox({ upload });
      const { ws, result } = await uploadFirstImage(workspace(), live);
      expect(result).toMatchObject({ ok: false, reason });
      expect(ws.images[0].mediaUpload?.state).not.toBe("uploaded");
      const mapped = apply(ws, { type: "set-field-mapping", field: "Hero Image", source: { kind: "image", imageId: imageId(ws) } });
      expect(buildFieldValue(TEMPLATE.fields[1], mapped.mapping.fields["Hero Image"], mapped, "live").value).toBeNull();
      expect(errorsFor(mapped, "Hero Image")).toHaveLength(1);
    }
  });

  it("3b. a never-uploaded image mapped in live mode is an error, not a silently empty field", () => {
    const base = workspace();
    const ws = apply(base, { type: "set-field-mapping", field: "Hero Image", source: { kind: "image", imageId: imageId(base) } });
    expect(errorsFor(ws, "Hero Image")[0].message).toMatch(/has not been uploaded to the Media Library/);
  });

  it("4. field types come from Sitecore's type names and are not interchangeable", () => {
    expect(normalizeFieldType("Image")).toBe("Image");
    expect(normalizeFieldType("General Link")).toBe("General Link");
    expect(normalizeFieldType("Droplink")).toBe("Reference");
    expect(normalizeFieldType("Droptree")).toBe("Reference");
    expect(normalizeFieldType("Multilist")).toBe("Reference");
    expect(normalizeFieldType("File")).toBe("Other");
  });

  it("5. Image values are <image mediaid=\"{ID}\" /> with a braced ID; GUIDs, paths and URLs alone are rejected", () => {
    expect(toImageFieldValue(MEDIA_RAW)).toBe(`<image mediaid="${MEDIA}" />`);
    expect(toImageFieldValue(MEDIA.toLowerCase())).toBe(`<image mediaid="${MEDIA}" />`);
    expect(toImageFieldValue(MEDIA_PATH)).toBeNull();
    expect(toImageFieldValue("https://edge/hero.png")).toBeNull();
    expect(mediaIdFromImageValue(`<image mediaid="${MEDIA.toLowerCase()}" alt="x" />`)).toBe(MEDIA);
  });

  it("7. images are never mapped to incompatible fields, and auto-mapping fills at most one Image field", () => {
    let ws = workspace();
    for (const field of ["Title", "Link", "Category"]) {
      ws = apply(ws, { type: "set-field-mapping", field, source: { kind: "image", imageId: imageId(ws) } });
      expect(buildFieldValue(TEMPLATE.fields.find((f) => f.name === field)!, ws.mapping.fields[field], ws, "live")).toMatchObject({ value: null, blocking: expect.stringMatching(/Images can only be mapped to Image fields/) });
    }
    const demo = autoMap(TEMPLATE, workspace(), "demo");
    expect(demo["Hero Image"]).toMatchObject({ kind: "image" });
    expect(demo["Thumbnail Image"]).toEqual({ kind: "none" });
    for (const name of ["Title", "Link", "Category"]) expect(demo[name]?.kind).not.toBe("image");
    // Live: nothing uploaded yet, so no image is suggested.
    expect(autoMap(TEMPLATE, workspace(), "live")["Hero Image"]).toEqual({ kind: "none" });
  });

  it("8. demo mode never claims a live upload or a Sitecore media reference", async () => {
    const demo: SitecoreAdapter = new DemoSitecoreAdapter(demoStatus("demo"));
    expect(demo.status.canUploadMedia).toBe(false);
    expect(await demo.uploadMedia({ file: new Blob(), name: "hero", extension: "png", mimeType: "image/png", folderPath: "/sitecore/media library/x", language: "en", siteName: "s" })).toMatchObject({ ok: false });
    const base = workspace();
    const ws = apply(base, { type: "set-field-mapping", field: "Hero Image", source: { kind: "image", imageId: imageId(base) } });
    const value = buildFieldValue(TEMPLATE.fields[1], ws.mapping.fields["Hero Image"], ws, "demo");
    expect(value.value).toBeNull();
    expect(value.notes.join(" ")).toMatch(/simulated asset.*does not exist in Sitecore/);
  });
});

describe("creation with an image field", () => {
  it("6 + 10. the image reference is in the createItem payload and Sitecore saved it", async () => {
    const { live, sent } = sandbox();
    let { ws } = await uploadFirstImage(workspace(), live);
    ws = apply(ws, { type: "set-field-mapping", field: "Title", source: { kind: "static", value: "Hello" } }, { type: "set-field-mapping", field: "Hero Image", source: { kind: "image", imageId: imageId(ws) } });
    const fields = payload(ws);
    expect(fields).toContainEqual({ name: "Hero Image", value: `<image mediaid="${MEDIA}" />`, type: "Image", fieldId: "{F1F1F1F1-0000-0000-0000-000000000001}" });

    const result = await live.createItem({ name: "ContentStudio-Test-20261027-1500", templateId: TEMPLATE.id, parentPath: PARENT.path, language: "en", fields });
    expect(result).toMatchObject({ ok: true, itemId: CREATED });
    const mutation = sent.find((c) => c.query?.includes("ContentStudioCreateItem"))!.query!;
    expect(mutation).toContain(`{ name: "Hero Image", value: "<image mediaid=\\"${MEDIA}\\" />" }`);
    if (!result.ok) throw new Error("expected success");
    expect(result.warnings).toBeUndefined();
    expect(result.diagnostics?.fieldCheck).toEqual([{ name: "Hero Image", sent: `<image mediaid="${MEDIA}" />`, saved: `<image mediaid="${MEDIA}" />`, match: true }]);
    expect(result.diagnostics?.input.fields.find((f) => f.name === "Hero Image")).toMatchObject({ type: "Image", fieldId: "{F1F1F1F1-0000-0000-0000-000000000001}", value: `<image mediaid="${MEDIA}" />` });
    // Only one upload and one creation were sent.
    expect(sent.filter((c) => c.key === "xmc.agent.assetsUploadAsset")).toHaveLength(1);
    expect(sent.filter((c) => c.query?.includes("ContentStudioCreateItem"))).toHaveLength(1);
  });

  it("10b. an image field Sitecore did not save as sent is reported, not hidden", async () => {
    const { live } = sandbox({ savedImage: () => "" });
    let { ws } = await uploadFirstImage(workspace(), live);
    ws = apply(ws, { type: "set-field-mapping", field: "Hero Image", source: { kind: "image", imageId: imageId(ws) } });
    const result = await live.createItem({ name: "ContentStudio-Test-20261027-1501", templateId: TEMPLATE.id, parentPath: PARENT.path, language: "en", fields: payload(ws) });
    expect(result).toMatchObject({ ok: true, warnings: [expect.stringMatching(/Image field "Hero Image" was not saved as sent \(Sitecore has: empty\)/)] });
  });

  it("9. upload succeeded but creation failed: no success is reported and the upload is kept for a retry", async () => {
    const { live, sent } = sandbox({ createFails: true });
    let { ws } = await uploadFirstImage(workspace(), live);
    ws = apply(ws, { type: "set-field-mapping", field: "Hero Image", source: { kind: "image", imageId: imageId(ws) } });
    const result = await live.createItem({ name: "ContentStudio-Test-20261027-1502", templateId: TEMPLATE.id, parentPath: PARENT.path, language: "en", fields: payload(ws) });
    expect(result).toMatchObject({ ok: false, reason: "error", kind: "schema" });
    expect(ws.createdItem).toBeUndefined();
    expect(ws.images[0].mediaUpload).toMatchObject({ state: "uploaded", mediaItemId: MEDIA });
    // A retry reuses the existing media item; nothing is uploaded again.
    expect(payload(ws).find((f) => f.name === "Hero Image")?.value).toBe(`<image mediaid="${MEDIA}" />`);
    expect(sent.filter((c) => c.key === "xmc.agent.assetsUploadAsset")).toHaveLength(1);
  });
});

describe("Agent API folder path (tenant error: '/sitecore/Media Library//sitecore/media library/… not found')", () => {
  it("sends itemPath relative to the Media Library root", async () => {
    const { live, sent } = sandbox();
    const { result } = await uploadFirstImage(workspace(), live);
    expect(result.ok).toBe(true);
    const request = JSON.parse(sent.find((c) => c.key === "xmc.agent.assetsUploadAsset")!.body!.upload_request as string);
    expect(request.itemPath).toBe("Project/Brand");
    expect(request.itemPath).not.toMatch(/^\/|sitecore/i);
    expect(result.diagnostics).toMatchObject({ folderPath: FOLDER, itemPath: "Project/Brand" });
  });

  it("converts any casing and rejects paths outside the Media Library", () => {
    expect(mediaLibraryRelativePath("/sitecore/media library/Project/HztlFoundation/BrandX")).toBe("Project/HztlFoundation/BrandX");
    expect(mediaLibraryRelativePath("/sitecore/Media Library/Project/Site/")).toBe("Project/Site");
    expect(mediaLibraryRelativePath("/sitecore/media library")).toBeNull();
    expect(mediaLibraryRelativePath("/sitecore/content/Home")).toBeNull();
    expect(mediaLibraryRelativePath("/sitecore/media library/../content")).toBeNull();
    expect(mediaLibraryRelativePath("/sitecore/media library/<site>")).toBeNull();
  });

  it("a missing folder is reported before anything is uploaded", async () => {
    const { live, sent } = sandbox();
    const img = workspace().extraction.images[0];
    const result = await live.uploadMedia({ file: new Blob([new Uint8Array(8)], { type: "image/png" }), name: "hero", extension: "png", mimeType: "image/png", imageId: img.id, folderPath: "/sitecore/media library/Project/Missing", language: "en", siteName: "brand" });
    expect(result).toMatchObject({ ok: false, reason: "error", message: expect.stringMatching(/does not exist, or you cannot access it/) });
    expect(sent.some((c) => c.key === "xmc.agent.assetsUploadAsset")).toBe(false);
  });

  it("a 404 from the Agent API is a definite failure with its message, never uploaded or uncertain", async () => {
    const { live } = sandbox({ upload: () => ({ data: undefined, error: { detail: "Content item with Path /sitecore/Media Library/X not found" }, response: { status: 404 } }) });
    const { ws, result } = await uploadFirstImage(workspace(), live);
    expect(result).toMatchObject({ ok: false, reason: "error", diagnostics: { httpStatus: 404 } });
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toMatch(/not found/);
    expect(ws.images[0].mediaUpload?.state).toBe("failed");
  });
});

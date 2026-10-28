import type { ClientSDK } from "@sitecore-marketplace-sdk/client";
import { describe, expect, it } from "vitest";
import { createSampleExtraction } from "@/src/fixtures/sample-extraction";
import { autoMap, buildFieldValue, validateMapping } from "@/src/lib/mapping";
import { REQUIRED_VALIDATOR_ID, STANDARD_TEMPLATE_ID, buildCreateItemMutation, hasRequiredRule, parseBaseTemplateIds, toSitecoreId } from "@/src/lib/sitecore/graphql";
import { friendlySitecoreError, LiveSitecoreAdapter } from "@/src/lib/sitecore/live-adapter";
import type { SitecoreTemplate } from "@/src/lib/types/sitecore";
import { createWorkspace, workspaceReducer } from "@/src/lib/workspace";

// A scripted stand-in for the Marketplace ClientSDK. It records every call so tests can assert the
// exact SDK operations and parameters, and answers GraphQL by matching the operation name.

type GraphQLHandler = (query: string, variables: Record<string, unknown>) => unknown;

interface Call {
  kind: "query" | "mutate";
  key: string;
  options: { params?: { query?: { sitecoreContextId?: string }; body?: { query?: string; variables?: Record<string, unknown> } & Record<string, unknown> }; timeoutMs?: number };
}

function mockClient(graphql: GraphQLHandler, extra: { sites?: unknown; upload?: () => unknown } = {}) {
  const calls: Call[] = [];
  const client = {
    async query(key: string, options: Call["options"]) {
      calls.push({ kind: "query", key, options });
      if (key === "xmc.sites.listSites") return extra.sites ?? { data: { data: [{ id: "s1", name: "corporate", displayName: "Corporate", languages: ["en"] }] } };
      if (key === "xmc.sites.listLanguages") return { data: { data: [{ name: "en", iso: "en", englishName: "English" }] } };
      throw new Error(`unexpected query ${key}`);
    },
    async mutate(key: string, options: Call["options"]) {
      calls.push({ kind: "mutate", key, options });
      if (key === "xmc.authoring.graphql") return { data: graphql(options.params?.body?.query ?? "", options.params?.body?.variables ?? {}) };
      if (key === "xmc.agent.assetsUploadAsset") return extra.upload ? extra.upload() : { data: { success: true, mediaItem: { id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", embedUrl: "https://edge/img.png" } } };
      throw new Error(`unexpected mutation ${key}`);
    },
  };
  return { client: client as unknown as ClientSDK, calls };
}

const PARENT = { itemId: "11111111222233334444555555555555", path: "/sitecore/content/Corp/Home/News" };
const TEMPLATE_ID = "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}";
const BASE_ID = "{BBBBBBBB-BBBB-CCCC-DDDD-EEEEEEEEEEEE}";

function adapter(graphql: GraphQLHandler, extra?: Parameters<typeof mockClient>[1], media = false) {
  const { client, calls } = mockClient(graphql, extra);
  return { live: new LiveSitecoreAdapter(client, "ctx-live-123", { templateRootPath: "/sitecore/templates/Project", experimentalMediaUpload: media }, "Sandbox"), calls };
}

const templateGraph: GraphQLHandler = (query, vars) => {
  if (query.includes("ContentStudioTemplateFields")) {
    if (vars.id === TEMPLATE_ID) {
      return {
        data: {
          item: {
            itemId: TEMPLATE_ID, name: "Press Release", path: "/sitecore/templates/Project/Press Release",
            baseTemplates: { value: `${BASE_ID}|${STANDARD_TEMPLATE_ID}` },
            children: { nodes: [
              { name: "Content", template: { name: "Template section" }, children: { nodes: [
                { name: "Title", template: { name: "Template field" }, type: { value: "Single-Line Text" } },
                { name: "Body", template: { name: "Template field" }, type: { value: "Rich Text" } },
                { name: "Category", template: { name: "Template field" }, type: { value: "Droplink" } },
              ] } },
              { name: "__Standard Values", template: { name: "Press Release" } },
            ] },
          },
        },
      };
    }
    if (vars.id === BASE_ID) {
      return { data: { item: { itemId: BASE_ID, name: "_Seo", baseTemplates: { value: "" }, children: { nodes: [
        { name: "SEO", template: { name: "Template section" }, children: { nodes: [
          { name: "Meta Title", template: { name: "Template field" }, type: { value: "Single-Line Text" } },
          { name: "Title", template: { name: "Template field" }, type: { value: "Single-Line Text" } },
        ] } },
      ] } } } };
    }
    return { data: { item: null } };
  }
  if (query.includes("ContentStudioTemplateValidation")) {
    if (vars.id === TEMPLATE_ID) {
      return { data: { item: { children: { nodes: [{ template: { name: "Template section" }, children: { nodes: [
        { name: "Title", template: { name: "Template field" }, validatorBar: { value: `{11111111-1111-1111-1111-111111111111}|${REQUIRED_VALIDATOR_ID}` } },
        { name: "Body", template: { name: "Template field" }, quickAction: { value: "" } },
      ] } }] } } } };
    }
    return { errors: [{ message: 'Cannot query field "__Validator Bar Validation Rules"' }] };
  }
  throw new Error(`unexpected GraphQL: ${query.slice(0, 60)}`);
};

describe("live adapter: SDK call shapes", () => {
  it("uses the documented SDK keys, context ID and a timeout", async () => {
    const { live, calls } = adapter(templateGraph);
    await live.listSites();
    await live.listLanguages();
    await live.getTemplate(TEMPLATE_ID);
    expect(calls.map((c) => c.key)).toEqual(expect.arrayContaining(["xmc.sites.listSites", "xmc.sites.listLanguages", "xmc.authoring.graphql"]));
    for (const call of calls) expect(call.options.params?.query?.sitecoreContextId).toBe("ctx-live-123");
    for (const call of calls.filter((c) => c.kind === "mutate")) expect(call.options.timeoutMs).toBeGreaterThan(0);
  });

  it("maps site and language responses", async () => {
    const { live } = adapter(templateGraph);
    expect(await live.listSites()).toEqual([{ id: "s1", name: "corporate", displayName: "Corporate", languages: ["en"], homePageIds: [] }]);
    expect(await live.listLanguages()).toEqual([{ code: "en", name: "English" }]);
  });

  it("surfaces API errors and access problems clearly", async () => {
    const { live } = adapter(templateGraph, { sites: { data: { error: { status: 403, title: "Forbidden" } } } });
    await expect(live.listSites()).rejects.toThrow(/permission/);
    expect(friendlySitecoreError(new Error("Request failed with status 401 Unauthorized"))).toMatch(/not authorized/);
    expect(friendlySitecoreError(new Error("503 Service Unavailable"))).toMatch(/unavailable/);
  });

  it("rejects malformed responses instead of guessing", async () => {
    const { live } = adapter(templateGraph, { sites: { data: { data: { not: "an array" } } } });
    await expect(live.listSites()).rejects.toThrow(/unexpected response/);
  });
});

describe("live adapter: template metadata", () => {
  it("includes inherited fields, skips the Standard template, and reads Required validation rules", async () => {
    const { live, calls } = adapter(templateGraph);
    const template = await live.getTemplate(TEMPLATE_ID);
    expect(template.fields.map((f) => f.name)).toEqual(["Title", "Body", "Category", "Meta Title"]);
    expect(template.fields.find((f) => f.name === "Title")).toMatchObject({ required: true, requiredSource: "validation-rule" });
    expect(template.fields.find((f) => f.name === "Body")?.required).toBe(false);
    expect(template.fields.find((f) => f.name === "Category")?.type).toBe("Reference");
    expect(template.fields.find((f) => f.name === "Meta Title")?.definedIn).toBe("_Seo");
    // The base template's validation rules could not be read: reported as unknown, not as "none required".
    expect(template.requiredInfo).toBe("unavailable");
    const ids = calls.filter((c) => c.options.params?.body?.query?.includes("ContentStudioTemplateFields")).map((c) => c.options.params?.body?.variables?.id);
    expect(ids).not.toContain(STANDARD_TEMPLATE_ID);
  });

  it("parses base-template and validation-rule values", () => {
    expect(parseBaseTemplateIds(`${BASE_ID}|${STANDARD_TEMPLATE_ID}|not-an-id`)).toEqual([BASE_ID]);
    expect(hasRequiredRule([null, `${REQUIRED_VALIDATOR_ID.toLowerCase()}`])).toBe(true);
    expect(hasRequiredRule(["{11111111-1111-1111-1111-111111111111}", undefined])).toBe(false);
    expect(toSitecoreId("aaaaaaaabbbbccccddddeeeeeeeeeeee")).toBe(TEMPLATE_ID);
    expect(toSitecoreId("../../etc")).toBeNull();
  });
});

describe("live adapter: item creation", () => {
  const request = { name: "Atlas launch", templateId: TEMPLATE_ID, parentPath: PARENT.path, language: "en", fields: [{ name: "Title", value: 'Say "hi"' }] };

  it("sends one createItem mutation with braced IDs and reports the confirmed item", async () => {
    let created = false;
    const { live, calls } = adapter((q, v) => {
      if (q.includes("ContentStudioItemByPath")) return { data: { item: v.path === PARENT.path ? PARENT : null } };
      if (q.includes("createItem")) {
        created = true;
        return { data: { createItem: { item: { itemId: "99999999888877776666555555555555", path: `${PARENT.path}/Atlas launch` } } } };
      }
      throw new Error("unexpected");
    });
    const result = await live.createItem(request);
    expect(result).toEqual({ ok: true, itemId: "99999999888877776666555555555555", path: `${PARENT.path}/Atlas launch` });
    expect(created).toBe(true);
    const mutation = calls.find((c) => c.options.params?.body?.query?.includes("createItem"))!.options.params!.body!.query!;
    expect(mutation).toContain(`parent: "{11111111-2222-3333-4444-555555555555}"`);
    expect(mutation).toContain(`templateId: "${TEMPLATE_ID}"`);
    expect(mutation).toContain(`value: "Say \\"hi\\""`);
    expect(mutation.toLowerCase()).not.toContain("publish");
    expect(calls.filter((c) => c.options.params?.body?.query?.includes("createItem"))).toHaveLength(1);
  });

  it("refuses to create a duplicate and sends no mutation", async () => {
    const { live, calls } = adapter((q, v) => {
      if (q.includes("ContentStudioItemByPath")) return { data: { item: v.path === PARENT.path ? PARENT : { itemId: "77777777888877776666555555555555", path: v.path } } };
      throw new Error("createItem must not be called");
    });
    expect(await live.createItem(request)).toMatchObject({ ok: false, reason: "error", message: expect.stringMatching(/already exists/) });
    expect(calls.some((c) => c.options.params?.body?.query?.includes("createItem"))).toBe(false);
  });

  it("fails definitely when the parent does not exist", async () => {
    const { live } = adapter((q) => (q.includes("ContentStudioItemByPath") ? { data: { item: null } } : { errors: [{ message: "unexpected" }] }));
    expect(await live.createItem(request)).toMatchObject({ ok: false, reason: "error", message: expect.stringMatching(/No item exists/) });
  });

  it("reports GraphQL errors as a failure only after confirming the item does not exist", async () => {
    const { live } = adapter((q, v) => {
      if (q.includes("ContentStudioItemByPath")) return { data: { item: v.path === PARENT.path ? PARENT : null } };
      return { errors: [{ message: "Field 'Nope' not found" }] };
    });
    expect(await live.createItem(request)).toMatchObject({ ok: false, reason: "error", message: expect.stringMatching(/Nope/) });
  });

  it("reports success with warnings when Sitecore errored but the item exists", async () => {
    let afterMutation = false;
    const { live } = adapter((q, v) => {
      if (q.includes("ContentStudioItemByPath")) {
        if (v.path === PARENT.path) return { data: { item: PARENT } };
        return { data: { item: afterMutation ? { itemId: "99999999888877776666555555555555", path: v.path } : null } };
      }
      afterMutation = true;
      return { errors: [{ message: "Could not set field 'Body'" }] };
    });
    const result = await live.createItem(request);
    expect(result).toMatchObject({ ok: true, warnings: [expect.stringMatching(/Body/)] });
  });

  it("treats a timeout during the mutation as uncertain, never as success or failure", async () => {
    const { client } = mockClient(() => ({}));
    let mutationSent = false;
    (client as unknown as { mutate: unknown }).mutate = async (_key: string, options: Call["options"]) => {
      const q = options.params?.body?.query ?? "";
      if (q.includes("ContentStudioItemByPath")) return { data: { data: { item: options.params?.body?.variables?.path === PARENT.path ? PARENT : null } } };
      mutationSent = true;
      throw new Error("Request timed out after 30000ms");
    };
    const live = new LiveSitecoreAdapter(client, "ctx", { templateRootPath: "/x", experimentalMediaUpload: false }, "t");
    expect(await live.createItem(request)).toMatchObject({ ok: false, reason: "uncertain" });
    expect(mutationSent).toBe(true);
  });

  it("rejects an invalid template ID before contacting Sitecore", async () => {
    const { live, calls } = adapter(() => {
      throw new Error("must not be called");
    });
    expect(await live.createItem({ ...request, templateId: "demo-tpl" })).toMatchObject({ ok: false, reason: "error" });
    expect(calls).toHaveLength(0);
  });

  it("buildCreateItemMutation output is stable for review in demo mode", () => {
    expect(buildCreateItemMutation({ ...request, parentId: PARENT.itemId }).query).toContain('name: "Atlas launch"');
  });
});

describe("live adapter: experimental media upload", () => {
  const upload = { file: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), name: "hero", extension: "png", mimeType: "image/png", folderPath: "/sitecore/media library/Project", language: "en", siteName: "corporate" };
  const mediaGraph: Parameters<typeof adapter>[0] = (q, v) =>
    q.includes("ContentStudioItemById") && v.id === "{A1B2C3D4-E5F6-0718-293A-4B5C6D7E8F90}"
      ? { data: { item: { itemId: "a1b2c3d4e5f60718293a4b5c6d7e8f90", name: "hero", path: "/sitecore/media library/Project/hero" } } }
      : q.includes("ContentStudioItemByPath")
        ? { data: { item: v.path === "/sitecore/media library/Project" ? { itemId: "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0", path: "/sitecore/media library/Project" } : null } }
        : templateGraph(q, v);

  it("is refused unless explicitly enabled", async () => {
    const { live, calls } = adapter(templateGraph);
    expect(await live.uploadMedia(upload)).toMatchObject({ ok: false, reason: "error" });
    expect(calls).toHaveLength(0);
  });

  it("sends the documented upload request and only reports confirmed media items", async () => {
    const { live, calls } = adapter(mediaGraph, undefined, true);
    expect(await live.uploadMedia(upload)).toMatchObject({
      ok: true,
      mediaItemId: "{A1B2C3D4-E5F6-0718-293A-4B5C6D7E8F90}",
      mediaPath: "/sitecore/media library/Project/hero",
      embedUrl: "https://edge/img.png",
      diagnostics: { success: true, verified: "yes", fileName: "hero.png" },
    });
    const uploadCall = calls.find((c) => c.key === "xmc.agent.assetsUploadAsset")!;
    const body = uploadCall.options.params!.body!;
    // A named File with its type, so the multipart part is not sent as "blob".
    expect(body.file).toBeInstanceOf(File);
    expect((body.file as File).name).toBe("hero.png");
    expect((body.file as File).type).toBe("image/png");
    expect(JSON.parse(body.upload_request as string)).toEqual({ name: "hero.png", itemPath: "Project", language: "en", extension: "png", siteName: "corporate" });
  });

  it("does not treat an unconfirmed response as success", async () => {
    const { live } = adapter(mediaGraph, { upload: () => ({ data: { success: false } }) }, true);
    expect(await live.uploadMedia(upload)).toMatchObject({ ok: false, reason: "error" });
    const { live: thrower } = adapter(mediaGraph, {
      upload: () => {
        throw new Error("timeout");
      },
    }, true);
    expect(await thrower.uploadMedia(upload)).toMatchObject({ ok: false, reason: "uncertain" });
  });
});

describe("mapping safety for live templates", () => {
  const template: SitecoreTemplate = {
    id: TEMPLATE_ID,
    name: "Press Release",
    requiredInfo: "available",
    fields: [
      { name: "Title", type: "Single-Line Text", required: true, requiredSource: "validation-rule" },
      { name: "Category", type: "Reference", rawType: "Droplink", required: false },
      { name: "Hero Image", type: "Image", required: false },
    ],
  };

  it("never auto-maps document text into reference fields, and blocks manual attempts", () => {
    let ws = workspaceReducer(createWorkspace(createSampleExtraction()), { type: "set-mapping", patch: { templateId: TEMPLATE_ID, template } });
    expect(autoMap(template, ws).Category).toEqual({ kind: "none" });
    ws = workspaceReducer(ws, { type: "set-field-mapping", field: "Category", source: { kind: "content", contentType: "headline", mode: "first" } });
    const value = buildFieldValue(template.fields[1], ws.mapping.fields.Category, ws, "live");
    expect(value.value).toBeNull();
    expect(validateMapping(template, ws.mapping, ws, "live").some((i) => i.level === "error" && i.field === "Category")).toBe(true);
  });

  it("writes an image field only after a confirmed upload", () => {
    let ws = createWorkspace(createSampleExtraction());
    const image = ws.images[0];
    const source = { kind: "image", imageId: image.id } as const;
    expect(buildFieldValue(template.fields[2], source, ws, "live").value).toBeNull();
    ws = workspaceReducer(ws, { type: "update-image", id: image.id, patch: { mediaUpload: { state: "uncertain", at: "now" } } });
    expect(buildFieldValue(template.fields[2], source, ws, "live").value).toBeNull();
    ws = workspaceReducer(ws, { type: "update-image", id: image.id, patch: { mediaUpload: { state: "uploaded", mediaItemId: "a1b2c3d4e5f60718293a4b5c6d7e8f90", at: "now" } } });
    expect(buildFieldValue(template.fields[2], source, ws, "live").value).toBe('<image mediaid="{A1B2C3D4-E5F6-0718-293A-4B5C6D7E8F90}" />');
  });

  it("tracks uncertain creations and clears them only on confirmation", () => {
    let ws = createWorkspace(createSampleExtraction());
    ws = workspaceReducer(ws, { type: "set-creation", creation: { state: "pending", startedAt: "t", itemName: "A", parentPath: "/sitecore/content/x" } });
    expect(ws.creation?.state).toBe("pending");
    ws = workspaceReducer(ws, { type: "mark-created", itemId: "1", path: "/p", at: "t" });
    expect(ws.creation).toBeUndefined();
    expect(ws.createdItem?.itemId).toBe("1");
  });
});

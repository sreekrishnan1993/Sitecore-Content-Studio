import type { ClientSDK } from "@sitecore-marketplace-sdk/client";
import { describe, expect, it } from "vitest";
import { readDeployment } from "@/src/lib/security/deployment";
import { describeTarget, sandboxWriteGuard } from "@/src/lib/sitecore/environment";
import { LiveSitecoreAdapter } from "@/src/lib/sitecore/live-adapter";
import type { ServerCapabilities } from "@/src/lib/types/capabilities";

// Live item creation: reproduces the failures behind "creation does not work" and checks
// that every Sitecore answer is classified correctly and verified before success is reported.

const PARENT = { itemId: "11111111222233334444555555555555", path: "/sitecore/content/Brand/Site/Home/News" };
const TEMPLATE_ID = "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}";
const SECRET_TEXT = "CONFIDENTIAL-BODY-TEXT-7f3a";
const REQUEST = {
  name: "ContentStudio-Test-20261027-1200",
  templateId: TEMPLATE_ID,
  parentPath: PARENT.path,
  language: "en",
  fields: [
    { name: "Title", value: "Test title" },
    { name: "Body", value: `<p>${SECRET_TEXT}</p>` },
  ],
};
const TARGET = `${PARENT.path}/${REQUEST.name}`;

/** Simulates the SDK result for the createItem call; reads answer normally. */
function sdk(createResult: () => unknown, options: { existsAfter?: boolean } = {}) {
  let mutationSent = false;
  const sent: string[] = [];
  const client = {
    async query() {
      throw new Error("not used");
    },
    async mutate(_key: string, opts: { params: { body: { query: string; variables?: Record<string, unknown> } } }) {
      const { query, variables = {} } = opts.params.body;
      sent.push(query);
      if (query.includes("ContentStudioItemByPath")) {
        if (variables.path === PARENT.path) return { data: { data: { item: { itemId: PARENT.itemId, name: "News", path: PARENT.path } } } };
        const exists = mutationSent && options.existsAfter;
        return { data: { data: { item: exists ? { itemId: "99999999888877776666555544443333", name: REQUEST.name, path: TARGET } : null } } };
      }
      if (query.includes("ContentStudioCreateItem")) {
        mutationSent = true;
        return createResult();
      }
      throw new Error(`unexpected operation: ${query.slice(0, 40)}`);
    },
  };
  const live = new LiveSitecoreAdapter(client as unknown as ClientSDK, "ctx-live", { templateRootPath: "/sitecore/templates/Project", experimentalMediaUpload: false }, "Sandbox");
  return { live, sent, mutationCount: () => sent.filter((q) => q.includes("ContentStudioCreateItem")).length };
}

/** Shape of a hey-api RequestResult for a non-2xx answer, as the SDK returns it. */
const httpError = (status: number, body: unknown) => ({ data: undefined, error: body, response: { status } });

describe("root cause 1: sandbox deployment without a tenant blocks creation", () => {
  const appContext = { id: "app", url: "http://localhost:3000", resourceAccess: [{ resourceId: "res-1", tenantId: "tenant-123", tenantName: "brandx-sandbox", tenantDisplayName: "BrandX Sandbox", context: { live: "ctx", preview: "ctx" } }] };

  it("reproduces the .env configuration: deployment=sandbox with an empty tenant", () => {
    const caps = { ...readDeployment({ CONTENT_STUDIO_DEPLOYMENT: "sandbox", CONTENT_STUDIO_SANDBOX_TENANT: "" }) } as ServerCapabilities;
    expect(caps).toMatchObject({ deployment: "sandbox", sandboxTenant: null });
    const guard = sandboxWriteGuard(describeTarget(appContext), caps);
    expect(guard.allowed).toBe(false);
    // The message must tell the author exactly what to set.
    expect(guard.message).toContain("CONTENT_STUDIO_SANDBOX_TENANT");
    expect(guard.message).toContain("brandx-sandbox");
    expect(guard.message).toMatch(/restart/i);
  });

  it("allows creation once the tenant is set to the connected sandbox", () => {
    const caps = { ...readDeployment({ CONTENT_STUDIO_DEPLOYMENT: "sandbox", CONTENT_STUDIO_SANDBOX_TENANT: "brandx-sandbox" }) } as ServerCapabilities;
    expect(sandboxWriteGuard(describeTarget(appContext), caps)).toMatchObject({ allowed: true, sandbox: true });
  });
});

describe("root cause 2: Sitecore's error answers were reported as 'uncertain'", () => {
  it("HTTP 400 schema rejection is a definite failure with the real GraphQL errors", async () => {
    const { live, mutationCount } = sdk(() =>
      httpError(400, { errors: [{ message: 'The field `title` does not exist on the type `FieldValueInput`.', path: ["createItem"], extensions: { code: "HC0016" } }] }),
    );
    const result = await live.createItem(REQUEST);
    expect(result).toMatchObject({ ok: false, reason: "error", kind: "schema" });
    if (result.ok || result.reason === "demo-mode") throw new Error("expected failure");
    expect(result.message).toMatch(/does not exist on the type/);
    expect(result.diagnostics).toMatchObject({ operation: "ContentStudioCreateItem", stage: "mutation", httpStatus: 400, executed: "no" });
    expect(result.diagnostics?.errors[0]).toMatchObject({ path: "createItem", code: "HC0016" });
    expect(mutationCount()).toBe(1);
  });

  it("HTTP 403 is a permission failure", async () => {
    const { live } = sdk(() => httpError(403, { title: "Forbidden", detail: "Access denied" }));
    expect(await live.createItem(REQUEST)).toMatchObject({ ok: false, reason: "error", kind: "permission" });
  });

  it("HTTP 500 with errors is verified by lookup: not found means it failed", async () => {
    const { live } = sdk(() => httpError(500, { errors: [{ message: "Template not found" }] }));
    expect(await live.createItem(REQUEST)).toMatchObject({ ok: false, reason: "error", kind: "server", diagnostics: { executed: "possibly", stage: "verification" } });
  });

  it("HTTP 500 but the item exists: success with a warning, confirmed by lookup", async () => {
    const { live } = sdk(() => httpError(500, { errors: [{ message: "Could not set field Body" }] }), { existsAfter: true });
    expect(await live.createItem(REQUEST)).toMatchObject({ ok: true, itemId: "99999999888877776666555544443333", warnings: [expect.stringMatching(/Body/)] });
  });

  it("an execution error in a 200 response (e.g. invalid field) fails after confirming nothing was created", async () => {
    const { live } = sdk(() => ({ data: { data: { createItem: null }, errors: [{ message: "Field 'Nope' was not found on template", path: ["createItem"] }] }, response: { status: 200 } }));
    const result = await live.createItem(REQUEST);
    expect(result).toMatchObject({ ok: false, reason: "error", kind: "validation" });
  });
});

describe("successful creation and uncertain outcomes", () => {
  it("reports success only with the item returned by Sitecore", async () => {
    const { live, mutationCount } = sdk(() => ({ data: { data: { createItem: { item: { itemId: "99999999888877776666555544443333", name: REQUEST.name, path: TARGET } } } }, response: { status: 200 } }));
    expect(await live.createItem(REQUEST)).toEqual({ ok: true, itemId: "99999999888877776666555544443333", path: TARGET });
    expect(mutationCount()).toBe(1);
  });

  it("a timeout is followed by a lookup; if the item exists it is confirmed, never re-sent", async () => {
    const { live, mutationCount } = sdk(() => {
      throw new Error("Request timed out after 30000ms");
    }, { existsAfter: true });
    const result = await live.createItem(REQUEST);
    expect(result).toMatchObject({ ok: true, path: TARGET, warnings: [expect.stringMatching(/confirmed by looking it up/)] });
    expect(mutationCount()).toBe(1);
  });

  it("a timeout with no item yet stays uncertain (the request may still be running)", async () => {
    const { live, mutationCount } = sdk(() => {
      throw new Error("Request timed out after 30000ms");
    });
    const result = await live.createItem(REQUEST);
    expect(result).toMatchObject({ ok: false, reason: "uncertain", kind: "network" });
    if (result.ok || result.reason === "demo-mode") throw new Error("expected failure");
    expect(result.message).toMatch(/Check in Sitecore/);
    expect(mutationCount()).toBe(1);
  });

  it("diagnostics never contain field values", async () => {
    const { live } = sdk(() => httpError(400, { errors: [{ message: "Syntax Error: Unexpected Name" }] }));
    const result = await live.createItem(REQUEST);
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET_TEXT);
    if (result.ok || result.reason === "demo-mode") throw new Error("expected failure");
    expect(result.diagnostics?.input.fields).toEqual([
      { name: "Title", length: 10 },
      { name: "Body", length: SECRET_TEXT.length + 7 },
    ]);
  });
});

describe("non-mutating createItem schema check (introspection)", () => {
  const nn = (name: string, kind = "INPUT_OBJECT") => ({ kind: "NON_NULL", name: null, ofType: { kind, name, ofType: null } });
  const list = (name: string) => ({ kind: "LIST", name: null, ofType: { kind: "INPUT_OBJECT", name, ofType: null } });
  function schemaClient(types: Record<string, Array<{ name: string; type: unknown; defaultValue?: string | null }>>, args = [{ name: "input", type: nn("CreateItemInput") }]) {
    const sent: string[] = [];
    const client = {
      async mutate(_k: string, o: { params: { body: { query: string; variables?: { name?: string } } } }) {
        const q = o.params.body.query;
        sent.push(q);
        if (q.includes("ContentStudioCreateItemSchema")) return { data: { data: { __schema: { mutationType: { fields: [{ name: "deleteItem", args: [] }, { name: "createItem", args }] } } } } };
        if (q.includes("ContentStudioInputType")) {
          const fields = types[o.params.body.variables?.name ?? ""];
          return { data: { data: { __type: fields ? { name: o.params.body.variables?.name, inputFields: fields } : null } } };
        }
        throw new Error("unexpected");
      },
    };
    return { live: new LiveSitecoreAdapter(client as unknown as ClientSDK, "ctx", { templateRootPath: "/x", experimentalMediaUpload: false }, "t"), sent };
  }
  const documented = {
    CreateItemInput: [
      { name: "name", type: nn("String", "SCALAR") },
      { name: "templateId", type: nn("ID", "SCALAR") },
      { name: "parent", type: nn("ID", "SCALAR") },
      { name: "language", type: nn("String", "SCALAR") },
      { name: "fields", type: list("FieldValueInput") },
      { name: "database", type: { kind: "SCALAR", name: "String", ofType: null }, defaultValue: '"master"' },
    ],
    FieldValueInput: [
      { name: "name", type: nn("String", "SCALAR") },
      { name: "value", type: nn("String", "SCALAR") },
    ],
  };

  it("matches the documented input shape, using only read-only queries", async () => {
    const { live, sent } = schemaClient(documented);
    expect(await live.inspectCreateItemSchema()).toMatchObject({ status: "match" });
    expect(sent.every((q) => q.trim().startsWith("query "))).toBe(true);
  });

  it("reports a different parent field or a required field the app does not send", async () => {
    const { live } = schemaClient({
      ...documented,
      CreateItemInput: documented.CreateItemInput.map((f) => (f.name === "parent" ? { ...f, name: "parentId" } : f)),
      FieldValueInput: [...documented.FieldValueInput, { name: "fieldId", type: nn("ID", "SCALAR") }],
    });
    const result = await live.inspectCreateItemSchema();
    expect(result.status).toBe("mismatch");
    expect(result.detail).toMatch(/CreateItemInput has no field\(s\) parent/);
    expect(result.detail).toMatch(/FieldValueInput requires fieldId/);
  });

  it("is 'unavailable', not a failure, when introspection is disabled", async () => {
    const client = { async mutate() { return { data: undefined, error: { errors: [{ message: "Introspection is not allowed" }] }, response: { status: 400 } }; } };
    const live = new LiveSitecoreAdapter(client as unknown as ClientSDK, "ctx", { templateRootPath: "/x", experimentalMediaUpload: false }, "t");
    expect(await live.inspectCreateItemSchema()).toMatchObject({ status: "unavailable" });
  });
});

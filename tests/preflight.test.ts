import type { ApplicationContext, ClientSDK } from "@sitecore-marketplace-sdk/client";
import { describe, expect, it } from "vitest";
import { checkEnvironment, checkServer, resolveAuthMode } from "../scripts/preflight.mjs";
import { readAuthConfig } from "@/src/lib/security/auth";
import { readDeployment } from "@/src/lib/security/deployment";
import { DemoSitecoreAdapter, demoStatus } from "@/src/lib/sitecore/demo-adapter";
import { describeTarget, sandboxWriteGuard } from "@/src/lib/sitecore/environment";
import { LiveSitecoreAdapter } from "@/src/lib/sitecore/live-adapter";
import { runPreflight } from "@/src/lib/sitecore/preflight";
import type { ServerCapabilities } from "@/src/lib/types/capabilities";

type Result = { status: string; label: string; detail: string };
const byLabel = (results: Result[], label: string) => results.find((r) => r.label === label);

const SANDBOX_CAPS: ServerCapabilities = {
  maxUploadBytes: 1,
  urlImportEnabled: false,
  aiProvider: null,
  ocrProvider: null,
  authMode: "none",
  deployment: "sandbox",
  sandboxTenant: "acme-sandbox",
};

function appContext(resources: Array<Record<string, unknown>>, extensionRoutes: string[] = ["/content-studio"]): ApplicationContext {
  return {
    id: "app",
    url: "http://localhost:3000",
    resourceAccess: resources as unknown as ApplicationContext["resourceAccess"],
    extensionPoints: extensionRoutes.map((route, i) => ({ extensionPointId: `ep${i}`, route })),
  };
}
const SANDBOX_RESOURCE = { resourceId: "res-1", tenantId: "t-1", tenantName: "acme-sandbox", tenantDisplayName: "ACME Sandbox", context: { live: "ctx-live", preview: "ctx-preview" } };

describe("CLI preflight mirrors the server's auth rules", () => {
  const matrix: Array<Record<string, string | undefined>> = [
    {},
    { CONTENT_STUDIO_AUTH_MODE: "none" },
    { CONTENT_STUDIO_AUTH_MODE: "none", CONTENT_STUDIO_ALLOW_UNAUTHENTICATED: "true" },
    { CONTENT_STUDIO_AUTH_MODE: "none", CONTENT_STUDIO_ALLOW_UNAUTHENTICATED: "TRUE" },
    { CONTENT_STUDIO_AUTH_MODE: "auth0" },
    { CONTENT_STUDIO_AUTH_MODE: "auth0", CONTENT_STUDIO_AUTH0_DOMAIN: "x.auth0.com", CONTENT_STUDIO_AUTH0_AUDIENCE: "api" },
    { CONTENT_STUDIO_AUTH_MODE: " AUTH0 ", CONTENT_STUDIO_AUTH0_DOMAIN: "x.auth0.com" },
    { CONTENT_STUDIO_AUTH_MODE: "basic" },
  ];
  for (const NODE_ENV of ["production", "development"]) {
    for (const vars of matrix) {
      it(`${NODE_ENV} ${JSON.stringify(vars)}`, () => {
        const env = { ...vars, NODE_ENV };
        expect(resolveAuthMode(env).mode).toBe(readAuthConfig(env).mode);
      });
    }
  }

  it("production defaults stay fail-closed and nothing enables a bypass implicitly", () => {
    expect(readAuthConfig({ NODE_ENV: "production" }).mode).toBe("misconfigured");
    expect(readAuthConfig({ NODE_ENV: "production", CONTENT_STUDIO_DEPLOYMENT: "sandbox", CONTENT_STUDIO_SANDBOX_TENANT: "x" }).mode).toBe("misconfigured");
    expect(readAuthConfig({ NODE_ENV: "production", CONTENT_STUDIO_AUTH_MODE: "none" }).mode).toBe("misconfigured");
  });
});

describe("CLI preflight: configuration", () => {
  const sandboxEnv = {
    NODE_ENV: "production",
    CONTENT_STUDIO_DEPLOYMENT: "sandbox",
    CONTENT_STUDIO_SANDBOX_TENANT: "acme-sandbox",
    CONTENT_STUDIO_AUTH_MODE: "none",
    CONTENT_STUDIO_ALLOW_UNAUTHENTICATED: "true",
    CONTENT_STUDIO_ENABLE_URL_IMPORT: "false",
  };

  it("accepts the documented sandbox configuration with warnings only", () => {
    const results: Result[] = checkEnvironment(sandboxEnv);
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
    expect(byLabel(results, "Authentication")?.status).toBe("warn");
  });

  it("fails unauthenticated mode on a deployment not marked as sandbox", () => {
    const results: Result[] = checkEnvironment({ ...sandboxEnv, CONTENT_STUDIO_DEPLOYMENT: "" });
    expect(byLabel(results, "Authentication")?.status).toBe("fail");
    expect(byLabel(results, "Deployment")?.status).toBe("fail");
  });

  it("accepts a production deployment for any tenant; only missing sign-in fails", () => {
    const results: Result[] = checkEnvironment({ NODE_ENV: "production", CONTENT_STUDIO_DEPLOYMENT: "production" });
    expect(byLabel(results, "Deployment")).toMatchObject({ status: "pass", detail: expect.stringMatching(/whichever tenant/) });
    expect(byLabel(results, "Sandbox tenant")).toBeUndefined();
    expect(results.filter((r) => r.status === "fail").map((r) => r.label)).toEqual(["Authentication"]);
  });

  it("passes a production deployment with Sitecore sign-in, and catches a client ID mismatch", () => {
    const prod = {
      NODE_ENV: "production",
      CONTENT_STUDIO_DEPLOYMENT: "production",
      CONTENT_STUDIO_AUTH_MODE: "auth0",
      CONTENT_STUDIO_AUTH0_DOMAIN: "auth.sitecorecloud.io",
      CONTENT_STUDIO_AUTH0_AUDIENCE: "https://api-webapp.sitecorecloud.io",
      CONTENT_STUDIO_AUTH0_CLIENT_IDS: "client-123",
      NEXT_PUBLIC_CONTENT_STUDIO_AUTH0_CLIENT_ID: "client-123",
    };
    const ok: Result[] = checkEnvironment(prod);
    expect(ok.filter((r) => r.status === "fail")).toEqual([]);
    expect(byLabel(ok, "Auth0 client sign-in")?.status).toBe("pass");
    const mismatch: Result[] = checkEnvironment({ ...prod, CONTENT_STUDIO_AUTH0_CLIENT_IDS: "other" });
    expect(byLabel(mismatch, "Auth0 client restriction")?.status).toBe("fail");
    const noClient: Result[] = checkEnvironment({ ...prod, NEXT_PUBLIC_CONTENT_STUDIO_AUTH0_CLIENT_ID: "" });
    expect(byLabel(noClient, "Auth0 client sign-in")?.status).toBe("fail");
  });

  it("still fails unauthenticated mode on a production deployment", () => {
    const results: Result[] = checkEnvironment({ ...sandboxEnv, CONTENT_STUDIO_DEPLOYMENT: "production" });
    expect(byLabel(results, "Authentication")?.status).toBe("fail");
    expect(byLabel(results, "Sandbox tenant")?.status).toBe("info");
  });

  it("fails an unconfigured server, an unmarked deployment and secret-looking public variables", () => {
    const results: Result[] = checkEnvironment({ NODE_ENV: "production", NEXT_PUBLIC_AUTH0_SECRET: "x" });
    expect(byLabel(results, "Authentication")?.status).toBe("fail");
    expect(byLabel(results, "Deployment")?.status).toBe("fail");
    expect(byLabel(results, "Public variables")?.status).toBe("fail");
  });

  it("reads the deployment marker without affecting authentication", () => {
    expect(readDeployment({ CONTENT_STUDIO_DEPLOYMENT: " Sandbox ", CONTENT_STUDIO_SANDBOX_TENANT: " acme " })).toEqual({ deployment: "sandbox", sandboxTenant: "acme" });
    expect(readDeployment({ CONTENT_STUDIO_DEPLOYMENT: "staging" })).toEqual({ deployment: "unmarked", sandboxTenant: null });
  });
});

describe("CLI preflight: server probe", () => {
  function fakeFetch(caps: Partial<ServerCapabilities>, postStatus: number) {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const impl = async (url: URL, init: { method: string; body?: unknown }) => {
      requests.push({ url: url.pathname, method: init.method, body: init.body });
      if (url.pathname === "/api/extract" && init.method === "GET") return new Response(JSON.stringify(caps), { status: 200 });
      if (url.pathname === "/content-studio") return new Response("", { status: 200, headers: { "content-security-policy": "frame-ancestors 'self'; object-src 'none'" } });
      return new Response("", { status: postStatus });
    };
    return { impl: impl as unknown as typeof fetch, requests };
  }
  const env = { NODE_ENV: "production", CONTENT_STUDIO_DEPLOYMENT: "sandbox", CONTENT_STUDIO_AUTH_MODE: "none", CONTENT_STUDIO_ALLOW_UNAUTHENTICATED: "true" };

  it("never sends a document and flags unauthenticated mode on a non-loopback host", async () => {
    const { impl, requests } = fakeFetch({ authMode: "none", deployment: "sandbox" }, 415);
    const results: Result[] = await checkServer("https://cs-test.example.com", env, impl);
    expect(byLabel(results, "Exposure")?.status).toBe("fail");
    expect(requests.filter((r) => r.method === "POST").every((r) => r.body === undefined)).toBe(true);
  });

  it("passes on loopback and reports the open endpoint as a warning", async () => {
    const { impl } = fakeFetch({ authMode: "none", deployment: "sandbox" }, 415);
    const results: Result[] = await checkServer("http://localhost:3000", env, impl);
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
    expect(byLabel(results, "Unauthenticated POST")?.status).toBe("warn");
  });

  it("detects a server started with a different configuration", async () => {
    const { impl } = fakeFetch({ authMode: "misconfigured", deployment: "unmarked" }, 503);
    const results: Result[] = await checkServer("http://localhost:3000", env, impl);
    expect(byLabel(results, "Running auth mode")?.status).toBe("fail");
    expect(byLabel(results, "Running deployment")?.status).toBe("fail");
  });
});

describe("sandbox write guard", () => {
  const target = describeTarget(appContext([SANDBOX_RESOURCE]));

  it("allows writes only to the configured sandbox tenant", () => {
    expect(sandboxWriteGuard(target, SANDBOX_CAPS)).toMatchObject({ allowed: true, sandbox: true });
    expect(sandboxWriteGuard(target, { ...SANDBOX_CAPS, sandboxTenant: "t-1" }).allowed).toBe(true);
    expect(sandboxWriteGuard(target, { ...SANDBOX_CAPS, sandboxTenant: "acme-production" })).toMatchObject({ allowed: false });
    expect(sandboxWriteGuard(target, { ...SANDBOX_CAPS, sandboxTenant: null })).toMatchObject({ allowed: false });
  });

  it("blocks when more than one environment is granted or the server config is unknown", () => {
    const two = describeTarget(appContext([SANDBOX_RESOURCE, { ...SANDBOX_RESOURCE, tenantName: "other" }]));
    expect(sandboxWriteGuard(two, SANDBOX_CAPS)).toMatchObject({ allowed: false });
    expect(sandboxWriteGuard(target, null)).toMatchObject({ allowed: false });
  });

  it("does not restrict deployments that are not marked as sandbox, but labels them", () => {
    expect(sandboxWriteGuard(target, { ...SANDBOX_CAPS, deployment: "production" })).toMatchObject({ allowed: true, sandbox: false });
  });
});

describe("in-app preflight is read-only", () => {
  function recordingClient() {
    const calls: Array<{ kind: string; key: string; body?: { query?: string } }> = [];
    const client = {
      async query(key: string) {
        calls.push({ kind: "query", key });
        if (key === "xmc.sites.listSites") return { data: { data: [{ id: "s1", name: "corporate" }] } };
        return { data: { data: [{ name: "en" }] } };
      },
      async mutate(key: string, options: { params?: { body?: { query?: string; variables?: { name?: string } } } }) {
        calls.push({ kind: "mutate", key, body: options.params?.body });
        const query = options.params?.body?.query ?? "";
        const scalar = { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "String" } };
        if (query.includes("ContentStudioCreateItemSchema")) {
          return { data: { data: { __schema: { mutationType: { fields: [{ name: "createItem", args: [{ name: "input", type: { kind: "NON_NULL", name: null, ofType: { kind: "INPUT_OBJECT", name: "CreateItemInput" } } }] }] } } } } };
        }
        if (query.includes("ContentStudioInputType")) {
          const names = options.params?.body?.variables?.name === "CreateItemInput" ? ["name", "templateId", "parent", "language"] : ["name", "value"];
          const inputFields = names.map((name) => ({ name, type: scalar }));
          if (options.params?.body?.variables?.name === "CreateItemInput") inputFields.push({ name: "fields", type: { kind: "LIST", name: null, ofType: { kind: "INPUT_OBJECT", name: "FieldValueInput" } } as never });
          return { data: { data: { __type: { inputFields } } } };
        }
        return { data: { data: { item: { itemId: "{11111111-2222-3333-4444-555555555555}", name: "Project", path: "/sitecore/templates/Project" } } } };
      },
    };
    return { client: client as unknown as ClientSDK, calls };
  }

  it("passes for a correctly configured sandbox and sends only queries", async () => {
    const { client, calls } = recordingClient();
    const adapter = new LiveSitecoreAdapter(client, "ctx-live", { templateRootPath: "/sitecore/templates/Project", experimentalMediaUpload: false }, "ACME Sandbox");
    const checks = await runPreflight({ adapter, appContext: appContext([SANDBOX_RESOURCE]), capabilities: SANDBOX_CAPS, templateRootPath: "/sitecore/templates/Project", experimentalMediaUpload: false, route: "/content-studio" });

    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(checks.find((c) => c.id === "extension")?.status).toBe("pass");
    expect(checks.find((c) => c.id === "authoring-api")?.status).toBe("pass");
    // Only the authoring GraphQL proxy may be a "mutate" call, and only with a query operation.
    for (const call of calls.filter((c) => c.kind === "mutate")) {
      expect(call.key).toBe("xmc.authoring.graphql");
      expect(call.body?.query?.trim().startsWith("query ")).toBe(true);
    }
    expect(calls.some((c) => c.key.startsWith("xmc.agent."))).toBe(false);
  });

  it("fails on the wrong tenant, unmarked deployment and API errors", async () => {
    const { client } = recordingClient();
    const failing = { ...client, query: async () => ({ error: { status: 403, title: "Forbidden" } }) } as unknown as ClientSDK;
    const adapter = new LiveSitecoreAdapter(failing, "ctx-live", { templateRootPath: "/x", experimentalMediaUpload: true }, "Prod");
    const checks = await runPreflight({
      adapter,
      appContext: appContext([{ ...SANDBOX_RESOURCE, tenantName: "acme-prod", tenantDisplayName: "ACME Prod", tenantId: "t-9", resourceId: "r-9" }], ["/other"]),
      capabilities: { ...SANDBOX_CAPS, deployment: "unmarked" },
      templateRootPath: "/x",
      experimentalMediaUpload: true,
      route: "/content-studio",
    });
    const status = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({ auth: "fail", deployment: "fail", target: "fail", extension: "warn", media: "warn", "sites-api": "fail" });
  });

  it("passes deployment and target for production in any tenant; missing sign-in still fails", async () => {
    const { client } = recordingClient();
    const adapter = new LiveSitecoreAdapter(client, "ctx-live", { templateRootPath: "/sitecore/templates/Project", experimentalMediaUpload: false }, "QA");
    const checks = await runPreflight({
      adapter,
      // A tenant other than any configured sandbox tenant.
      appContext: appContext([{ ...SANDBOX_RESOURCE, tenantName: "other-qa", tenantDisplayName: "Other / qa", tenantId: "t-qa", resourceId: "r-qa" }]),
      capabilities: { ...SANDBOX_CAPS, deployment: "production", sandboxTenant: null, authMode: "misconfigured", urlImportEnabled: true },
      templateRootPath: "/sitecore/templates/Project",
      experimentalMediaUpload: false,
      route: "/content-studio",
    });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.deployment).toMatchObject({ status: "pass", detail: expect.stringMatching(/whichever tenant/) });
    expect(byId.target).toMatchObject({ status: "pass", detail: expect.stringMatching(/Other \/ qa.*go to this environment/) });
    expect(byId["url-import"].status).toBe("pass");
    expect(checks.filter((c) => c.status === "fail").map((c) => c.id)).toEqual(["auth"]);
  });

  it("skips Sitecore probes in demo mode", async () => {
    const checks = await runPreflight({ adapter: new DemoSitecoreAdapter(demoStatus("demo")), capabilities: SANDBOX_CAPS, templateRootPath: "/x", experimentalMediaUpload: false, route: "/content-studio" });
    expect(checks.find((c) => c.id === "sites-api")?.status).toBe("skip");
    expect(checks.find((c) => c.id === "connection")?.status).toBe("warn");
  });
});

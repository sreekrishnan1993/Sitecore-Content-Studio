import type { ApplicationContext } from "@sitecore-marketplace-sdk/client";
import type { ServerCapabilities } from "../types/capabilities";
import type { CreateItemSchemaCheck } from "../types/sitecore";
import type { SitecoreAdapter } from "./adapter";
import { describeTarget, sandboxWriteGuard } from "./environment";

// Sandbox preflight, run from Settings inside Sitecore. Read-only by construction: it uses only
// listSites, listLanguages, findItem and createItem schema introspection (Authoring GraphQL
// *queries*). It never calls createItem or uploadMedia, and never sends a GraphQL mutation.

export type PreflightStatus = "pass" | "warn" | "fail" | "skip";

export interface PreflightCheck {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
}

export interface PreflightInput {
  adapter: Pick<SitecoreAdapter, "status" | "listSites" | "listLanguages" | "findItem"> & { inspectCreateItemSchema?: () => Promise<CreateItemSchemaCheck> };
  appContext?: ApplicationContext;
  capabilities: ServerCapabilities | null;
  capabilitiesError?: string | null;
  templateRootPath: string;
  experimentalMediaUpload: boolean;
  /** The route this page is registered under. */
  route: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function extensionPointRoutes(appContext: ApplicationContext): string[] {
  const points = appContext.extensionPoints ?? appContext.touchpoints ?? [];
  return points.flatMap((p) => [p.route, ...(p.meta ?? []).map((m: { route?: string }) => m.route)]).filter((r): r is string => typeof r === "string");
}

export async function runPreflight(input: PreflightInput): Promise<PreflightCheck[]> {
  const { adapter, appContext, capabilities: caps } = input;
  const live = adapter.status.mode === "live";
  const checks: PreflightCheck[] = [];
  const add = (id: string, label: string, status: PreflightStatus, detail: string) => checks.push({ id, label, status, detail });

  add("connection", "Sitecore connection", live ? "pass" : "warn", live ? adapter.status.detail : `Demo mode: ${adapter.status.detail}`);

  // Server configuration
  if (!caps) {
    add("server", "Extraction service", "fail", `Server configuration could not be read${input.capabilitiesError ? ` (${input.capabilitiesError})` : ""}.`);
  } else {
    if (caps.authMode === "auth0") add("auth", "API authentication", "pass", "auth0: access tokens are verified.");
    else if (caps.authMode === "misconfigured") add("auth", "API authentication", "fail", "Not configured: the server refuses all document uploads and URL imports until sign-in is configured (CONTENT_STUDIO_AUTH_MODE=auth0).");
    else if (caps.deployment === "sandbox") add("auth", "API authentication", "warn", "none: unauthenticated. Acceptable only for a private, time-boxed sandbox with synthetic documents.");
    else add("auth", "API authentication", "fail", "none: unauthenticated on a deployment that is not marked CONTENT_STUDIO_DEPLOYMENT=sandbox.");

    add(
      "deployment",
      "Deployment",
      caps.deployment === "unmarked" ? "fail" : "pass",
      caps.deployment === "sandbox"
        ? `sandbox: item creation and media upload are limited to the tenant "${caps.sandboxTenant ?? "(not set)"}".`
        : caps.deployment === "production"
          ? "production: the app works in whichever tenant opens it, with the signed-in user's Sitecore permissions."
          : 'CONTENT_STUDIO_DEPLOYMENT is not set. Set it to "production" (any tenant) or "sandbox" (one test tenant).',
    );
    // URL import is only questioned for a sandbox test, where it is not needed.
    const urlWarn = caps.urlImportEnabled && caps.deployment === "sandbox";
    add("url-import", "Publication URL import", urlWarn ? "warn" : "pass", caps.urlImportEnabled ? (urlWarn ? "Enabled. Not needed for the Sitecore test; consider CONTENT_STUDIO_ENABLE_URL_IMPORT=false." : "Enabled.") : "Disabled.");
  }

  // Target environment and Marketplace configuration
  const target = describeTarget(appContext);
  if (!live || !appContext) {
    add("target", "Target environment", "skip", "Not connected to Sitecore.");
    add("extension", "Extension point", "skip", "Not connected to Sitecore.");
  } else {
    const guard = sandboxWriteGuard(target, caps);
    const where = `${target?.label ?? "unknown"} (tenant ${target?.tenantName ?? target?.tenantId ?? "?"}, ${target?.resourceCount ?? 0} environment(s) granted)`;
    if (caps?.deployment === "production") {
      // Not restricted to a tenant: the detected environment is where this session reads and writes.
      add("target", "Target environment", target ? "pass" : "fail", target ? `${where}. Item creation and media upload go to this environment.` : "The host reported no Sitecore environment.");
    } else {
      add("target", "Target environment", guard.allowed && guard.sandbox ? "pass" : "fail", `${where}${guard.message ? `. ${guard.message}` : ""}`);
    }
    const routes = extensionPointRoutes(appContext);
    const registered = routes.some((r) => r.split("?")[0].replace(/\/+$/, "").endsWith(input.route));
    add(
      "extension",
      "Extension point",
      routes.length === 0 ? "warn" : registered ? "pass" : "warn",
      routes.length === 0 ? "The host did not report extension points; confirm in the Cloud Portal." : registered ? `Registered for ${input.route}.` : `No extension point reports ${input.route} (reported: ${routes.join(", ")}).`,
    );
  }

  add(
    "media",
    "Media upload",
    input.experimentalMediaUpload ? "warn" : "pass",
    input.experimentalMediaUpload ? "Experimental upload is ON. Turn it off unless you are running the media test." : "Off (default).",
  );

  // Read-only API probes
  if (!live) {
    add("sites-api", "Sites API", "skip", "Demo mode.");
    add("languages", "Languages", "skip", "Demo mode.");
    add("authoring-api", "Authoring GraphQL API", "skip", "Demo mode.");
    return checks;
  }
  try {
    const sites = await adapter.listSites();
    add("sites-api", "Sites API", sites.length > 0 ? "pass" : "warn", sites.length > 0 ? `${sites.length} site(s): ${sites.slice(0, 5).map((s) => s.name).join(", ")}` : "No sites returned.");
  } catch (error) {
    add("sites-api", "Sites API", "fail", message(error));
  }
  try {
    const languages = await adapter.listLanguages();
    add("languages", "Languages", languages.length > 0 ? "pass" : "warn", languages.map((l) => l.code).join(", ") || "No languages returned.");
  } catch (error) {
    add("languages", "Languages", "fail", message(error));
  }
  try {
    const root = await adapter.findItem(input.templateRootPath);
    add(
      "authoring-api",
      "Authoring GraphQL API",
      root.found ? "pass" : "warn",
      root.found ? `Read ${root.path} (${root.itemId}).` : `The API answered, but "${input.templateRootPath}" was not found. Change the template root.`,
    );
  } catch (error) {
    add("authoring-api", "Authoring GraphQL API", "fail", message(error));
  }
  if (adapter.inspectCreateItemSchema) {
    try {
      const schema = await adapter.inspectCreateItemSchema();
      add("create-schema", "createItem schema", schema.status === "match" ? "pass" : schema.status === "mismatch" ? "fail" : "warn", schema.detail);
    } catch (error) {
      add("create-schema", "createItem schema", "warn", message(error));
    }
  }
  return checks;
}

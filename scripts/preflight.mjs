#!/usr/bin/env node
// Content Studio sandbox preflight (server side).
//
//   npm run preflight                                  # check configuration (.env files + process env)
//   npm run preflight -- --url http://localhost:3000   # also probe a running server
//
// Read-only: it reads environment variables and .next/routes-manifest.json, and (with --url) sends
// GET requests plus one empty POST to /api/extract that carries no document. It never contacts
// Sitecore, creates content or uploads media. Sitecore-side checks (resource access, extension
// point, Sites and Authoring APIs, media upload setting) run in the app: Settings → Sandbox preflight.
//
// The auth rules below mirror src/lib/security/auth.ts; tests/preflight.test.ts keeps them in sync.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_FRAME_ANCESTORS = "'self' https://*.sitecorecloud.io";

/** Loads .env files with Next.js precedence for `next start`; process.env wins. */
export function loadEnv(dir, processEnv = process.env, production = true) {
  const files = production ? [".env.production.local", ".env.local", ".env.production", ".env"] : [".env.development.local", ".env.local", ".env.development", ".env"];
  const merged = {};
  for (const file of files.reverse()) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      merged[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return { ...merged, ...processEnv, NODE_ENV: production ? "production" : "development" };
}

/** Same decision as readAuthConfig(): "auth0" | "none" | "misconfigured". */
export function resolveAuthMode(env) {
  const mode = (env.CONTENT_STUDIO_AUTH_MODE ?? "").trim().toLowerCase();
  const production = env.NODE_ENV === "production";
  if (mode === "auth0") {
    const domain = env.CONTENT_STUDIO_AUTH0_DOMAIN?.trim();
    const audience = env.CONTENT_STUDIO_AUTH0_AUDIENCE?.trim();
    return domain && audience ? { mode: "auth0" } : { mode: "misconfigured", reason: "CONTENT_STUDIO_AUTH0_DOMAIN and CONTENT_STUDIO_AUTH0_AUDIENCE are required for auth0." };
  }
  if (mode === "none") {
    if (production && env.CONTENT_STUDIO_ALLOW_UNAUTHENTICATED !== "true") return { mode: "misconfigured", reason: "none in production also requires CONTENT_STUDIO_ALLOW_UNAUTHENTICATED=true." };
    return { mode: "none" };
  }
  if (mode) return { mode: "misconfigured", reason: `Unknown CONTENT_STUDIO_AUTH_MODE "${mode}".` };
  if (production) return { mode: "misconfigured", reason: "CONTENT_STUDIO_AUTH_MODE is not set (production fails closed)." };
  return { mode: "none" };
}

function deploymentOf(env) {
  const v = (env.CONTENT_STUDIO_DEPLOYMENT ?? "").trim().toLowerCase();
  return v === "sandbox" || v === "production" ? v : "unmarked";
}

function positiveInt(value) {
  if (value === undefined || value === "") return true;
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

/** Checks configuration only. Returns [{ status: "pass"|"warn"|"fail"|"info", label, detail }]. */
export function checkEnvironment(env, { projectDir } = {}) {
  const out = [];
  const add = (status, label, detail) => out.push({ status, label, detail });
  const auth = resolveAuthMode(env);
  const deployment = deploymentOf(env);

  add(
    deployment === "unmarked" ? "fail" : "pass",
    "Deployment",
    deployment === "sandbox"
      ? "CONTENT_STUDIO_DEPLOYMENT=sandbox: writes limited to one test tenant."
      : deployment === "production"
        ? "CONTENT_STUDIO_DEPLOYMENT=production: works in whichever tenant opens the app."
        : 'CONTENT_STUDIO_DEPLOYMENT is not set; set it to "production" (any tenant) or "sandbox" (one test tenant).',
  );
  if (deployment === "sandbox") {
    add(
      env.CONTENT_STUDIO_SANDBOX_TENANT?.trim() ? "pass" : "fail",
      "Sandbox tenant",
      env.CONTENT_STUDIO_SANDBOX_TENANT?.trim() ? `Writes limited to "${env.CONTENT_STUDIO_SANDBOX_TENANT.trim()}"` : "CONTENT_STUDIO_SANDBOX_TENANT is not set; live writes will be disabled in the app.",
    );
  } else if (env.CONTENT_STUDIO_SANDBOX_TENANT?.trim()) {
    add("info", "Sandbox tenant", "CONTENT_STUDIO_SANDBOX_TENANT is set but only used when CONTENT_STUDIO_DEPLOYMENT=sandbox.");
  }

  if (auth.mode === "misconfigured") add("fail", "Authentication", `Misconfigured: ${auth.reason} The server will refuse all extraction.`);
  else if (auth.mode === "auth0") {
    add("pass", "Authentication", "auth0: bearer tokens are verified.");
    add("warn", "Auth0 client sign-in", "Not implemented in the browser yet: uploads will get 401 until setApiTokenProvider() is wired.");
    if (!env.CONTENT_STUDIO_AUTH0_CLIENT_IDS?.trim()) add("warn", "Auth0 client restriction", "CONTENT_STUDIO_AUTH0_CLIENT_IDS is not set; any client of the audience is accepted.");
  } else if (deployment !== "sandbox") add("fail", "Authentication", "none (unauthenticated) on a deployment not marked as sandbox.");
  else add("warn", "Authentication", "none (unauthenticated): run only on a loopback/private address, time-boxed, with synthetic documents.");

  const urlImport = env.CONTENT_STUDIO_ENABLE_URL_IMPORT?.trim().toLowerCase() !== "false";
  add(urlImport && auth.mode === "none" ? "warn" : "pass", "Publication URL import", urlImport ? "Enabled" + (auth.mode === "none" ? "; not needed for the Sitecore test — set CONTENT_STUDIO_ENABLE_URL_IMPORT=false." : ".") : "Disabled.");

  const numbers = ["CONTENT_STUDIO_RATE_LIMIT_PER_MINUTE", "CONTENT_STUDIO_MAX_CONCURRENT_EXTRACTIONS", "CONTENT_STUDIO_MAX_UPLOAD_MB"].filter((k) => !positiveInt(env[k]));
  add(numbers.length ? "warn" : "pass", "Numeric limits", numbers.length ? `Invalid values (defaults will be used): ${numbers.join(", ")}` : "Valid or defaulted.");
  add("info", "Platform rate limiting", "Required in front of any shared deployment; the in-process limits cover one instance only.");

  const leaked = Object.keys(env).filter((k) => /^NEXT_PUBLIC_.*(SECRET|TOKEN|PASSWORD|KEY)/i.test(k));
  if (leaked.length) add("fail", "Public variables", `These are bundled into browser code: ${leaked.join(", ")}`);

  const expectedAncestors = env.CONTENT_STUDIO_FRAME_ANCESTORS?.trim() || DEFAULT_FRAME_ANCESTORS;
  const manifestPath = projectDir ? join(projectDir, ".next", "routes-manifest.json") : null;
  if (!manifestPath || !existsSync(manifestPath)) {
    add("warn", "Build", "No production build found; run `npm run build` with this environment.");
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const csp = (manifest.headers ?? []).find((h) => h.source === "/content-studio")?.headers?.find((h) => h.key === "Content-Security-Policy")?.value;
    if (!csp) add("fail", "Build headers", "The build has no Content-Security-Policy for /content-studio.");
    else if (!csp.includes(`frame-ancestors ${expectedAncestors};`)) add("fail", "Build headers", `Built with a different frame-ancestors (${csp.split(";")[0]}). Rebuild after setting CONTENT_STUDIO_FRAME_ANCESTORS.`);
    else add("pass", "Build headers", `frame-ancestors ${expectedAncestors}`);
  }
  add("info", "Media upload", "Browser setting, off by default. Checked by Settings → Sandbox preflight in the app.");
  return out;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Probes a running server. Sends GETs and one empty POST (no document). */
export async function checkServer(baseUrl, env, fetchImpl = fetch) {
  const out = [];
  const add = (status, label, detail) => out.push({ status, label, detail });
  const base = new URL(baseUrl);
  const expected = resolveAuthMode(env).mode;
  const deployment = deploymentOf(env);

  let caps = null;
  try {
    const res = await fetchImpl(new URL("/api/extract", base), { method: "GET" });
    caps = res.ok ? await res.json() : null;
    if (!caps) add("fail", "Capabilities", `GET /api/extract returned HTTP ${res.status}.`);
  } catch (error) {
    add("fail", "Server reachable", `${base.origin} could not be reached (${error?.message ?? error}).`);
    return out;
  }
  if (caps) {
    add(caps.authMode === expected ? "pass" : "fail", "Running auth mode", caps.authMode === expected ? caps.authMode : `Server reports "${caps.authMode}" but this environment resolves to "${expected}". Was it started with different variables?`);
    add(caps.deployment === deployment && deployment !== "unmarked" ? "pass" : "fail", "Running deployment", `Server reports "${caps.deployment}"${caps.sandboxTenant ? `, tenant "${caps.sandboxTenant}"` : ""}${caps.deployment === deployment ? "" : `; this environment says "${deployment}"`}.`);
    if (caps.authMode === "none" && !LOOPBACK.has(base.hostname)) {
      add("fail", "Exposure", `Unauthenticated mode is being served at ${base.hostname}. Bind to 127.0.0.1 (npm run start:sandbox) or put an authenticating proxy in front.`);
    }
  }

  const page = await fetchImpl(new URL("/content-studio", base), { method: "GET" });
  const csp = page.headers.get("content-security-policy") ?? "";
  add(page.ok && csp.includes("frame-ancestors") ? "pass" : "fail", "Page headers", page.ok ? csp.split(";")[0] || "no CSP header" : `GET /content-studio returned HTTP ${page.status}.`);

  // Empty POST: no content type and no body, so no document is processed in any mode.
  const probe = await fetchImpl(new URL("/api/extract", base), { method: "POST" });
  const expectedStatus = { auth0: 401, misconfigured: 503, none: 415 }[caps?.authMode ?? expected];
  add(
    probe.status === expectedStatus ? (caps?.authMode === "none" ? "warn" : "pass") : "fail",
    "Unauthenticated POST",
    probe.status === 415 ? "Accepted without credentials (HTTP 415 for the empty body): the endpoint is open." : `HTTP ${probe.status} (expected ${expectedStatus}).`,
  );
  return out;
}

const ICON = { pass: "PASS", warn: "WARN", fail: "FAIL", info: "INFO" };

async function main() {
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf("--url");
  const url = urlIndex >= 0 ? args[urlIndex + 1] : undefined;
  const projectDir = process.cwd();
  const env = loadEnv(projectDir, process.env, !args.includes("--dev"));

  const results = checkEnvironment(env, { projectDir });
  if (url) results.push(...(await checkServer(url, env)));

  for (const r of results) console.log(`${ICON[r.status].padEnd(5)} ${r.label}: ${r.detail}`);
  const failed = results.filter((r) => r.status === "fail").length;
  console.log(failed ? `\n${failed} check(s) failed. Fix them before the sandbox test.` : "\nNo failures. Next: Settings → Sandbox preflight inside Sitecore.");
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

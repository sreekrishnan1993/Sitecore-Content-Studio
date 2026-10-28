import "server-only";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Authentication for Content Studio's own API routes.
 *
 * The Marketplace client SDK with built-in authorization gives the browser no token that
 * this server could verify: `host.user` is unsigned, self-reported data and must not be
 * trusted. Sitecore's documented way for a Marketplace app's server to obtain and trust a
 * Sitecore user token is *custom authorization* (Auth0). This module therefore supports:
 *
 * - "auth0": verify an `Authorization: Bearer <JWT>` access token against the Auth0
 *   tenant's JWKS (signature, issuer, audience, expiry, optional client and organization).
 * - "none": no authentication. Allowed in development. In production it must be enabled
 *   explicitly with CONTENT_STUDIO_ALLOW_UNAUTHENTICATED=true (for a controlled sandbox).
 *
 * If nothing is configured in production, requests are rejected (fail closed).
 */

export type AuthConfig =
  | { mode: "auth0"; issuer: string; audience: string; clientIds: string[]; orgClaim: string; allowedOrgs: string[] }
  | { mode: "none"; explicit: boolean }
  | { mode: "misconfigured"; reason: string };

export type AuthResult =
  | { ok: true; subject: string; mode: "auth0" | "none"; client?: string; organization?: string }
  | { ok: false; status: 401 | 503; code: "unauthorized" | "auth-not-configured"; message: string; reason: string };

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

export function readAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const mode = (env.CONTENT_STUDIO_AUTH_MODE ?? "").trim().toLowerCase();
  const production = env.NODE_ENV === "production";

  if (mode === "auth0") {
    const domain = env.CONTENT_STUDIO_AUTH0_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const audience = env.CONTENT_STUDIO_AUTH0_AUDIENCE?.trim();
    if (!domain || !audience) {
      return { mode: "misconfigured", reason: "CONTENT_STUDIO_AUTH0_DOMAIN and CONTENT_STUDIO_AUTH0_AUDIENCE are required when CONTENT_STUDIO_AUTH_MODE=auth0." };
    }
    return {
      mode: "auth0",
      issuer: `https://${domain}/`,
      audience,
      clientIds: list(env.CONTENT_STUDIO_AUTH0_CLIENT_IDS),
      orgClaim: env.CONTENT_STUDIO_AUTH0_ORG_CLAIM?.trim() || "org_id",
      allowedOrgs: list(env.CONTENT_STUDIO_ALLOWED_ORG_IDS),
    };
  }
  if (mode === "none") {
    if (production && env.CONTENT_STUDIO_ALLOW_UNAUTHENTICATED !== "true") {
      return { mode: "misconfigured", reason: "CONTENT_STUDIO_AUTH_MODE=none in production also requires CONTENT_STUDIO_ALLOW_UNAUTHENTICATED=true." };
    }
    return { mode: "none", explicit: true };
  }
  if (mode) return { mode: "misconfigured", reason: `Unknown CONTENT_STUDIO_AUTH_MODE "${mode}". Use "auth0" or "none".` };
  if (production) {
    return { mode: "misconfigured", reason: "No authentication is configured. Set CONTENT_STUDIO_AUTH_MODE (see README)." };
  }
  return { mode: "none", explicit: false };
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

function remoteKeySet(issuer: string): JWTVerifyGetKey {
  let keySet = jwksCache.get(issuer);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(".well-known/jwks.json", issuer), { timeoutDuration: 5000, cooldownDuration: 30_000 });
    jwksCache.set(issuer, keySet);
  }
  return keySet;
}

/** A 401 result. `reason` is for the audit log only (never the token); the message is the same for every cause. */
const unauthorized = (reason: string) =>
  ({ ok: false, status: 401, code: "unauthorized", message: "Sign-in is required, or your session has expired. Reopen Content Studio from Sitecore.", reason }) as const;

const claim = (value: unknown) => (typeof value === "string" && value ? value.slice(0, 200) : undefined);

/** Authenticates a request. `keySet` can be injected for tests; production uses the issuer's JWKS. */
export async function authenticateRequest(request: Request, config: AuthConfig = readAuthConfig(), keySet?: JWTVerifyGetKey): Promise<AuthResult> {
  if (config.mode === "misconfigured") {
    return { ok: false, status: 503, code: "auth-not-configured", message: "Document processing is not available because server authentication is not configured.", reason: config.reason };
  }
  if (config.mode === "none") return { ok: true, subject: "anonymous", mode: "none" };

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/.exec(header.trim());
  if (!match) return unauthorized(header ? "malformed-authorization-header" : "missing-token");

  try {
    const { payload } = await jwtVerify(match[1], keySet ?? remoteKeySet(config.issuer), {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
      clockTolerance: 30,
      requiredClaims: ["sub", "exp"],
    });
    const client = claim(payload.azp ?? payload.client_id);
    const organization = claim(payload[config.orgClaim]);
    if (config.clientIds.length > 0 && (!client || !config.clientIds.includes(client))) return unauthorized("client-not-allowed");
    if (config.allowedOrgs.length > 0 && (!organization || !config.allowedOrgs.includes(organization))) return unauthorized("organization-not-allowed");
    return { ok: true, subject: payload.sub as string, mode: "auth0", client, organization };
  } catch (error) {
    // The category only; never the token.
    return unauthorized(error instanceof joseErrors.JOSEError ? error.code : error instanceof Error ? error.name : "unknown");
  }
}

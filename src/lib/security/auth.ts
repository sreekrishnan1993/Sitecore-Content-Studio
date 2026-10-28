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
  | { ok: true; subject: string; mode: "auth0" | "none" }
  | { ok: false; status: 401 | 503; code: "unauthorized" | "auth-not-configured"; message: string };

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

const UNAUTHORIZED = { ok: false, status: 401, code: "unauthorized", message: "Sign-in is required, or your session has expired. Reopen Content Studio from Sitecore." } as const;

/** Authenticates a request. `keySet` can be injected for tests; production uses the issuer's JWKS. */
export async function authenticateRequest(request: Request, config: AuthConfig = readAuthConfig(), keySet?: JWTVerifyGetKey): Promise<AuthResult> {
  if (config.mode === "misconfigured") {
    console.error(`Content Studio: API authentication is not configured: ${config.reason}`);
    return { ok: false, status: 503, code: "auth-not-configured", message: "Document processing is not available because server authentication is not configured." };
  }
  if (config.mode === "none") return { ok: true, subject: "anonymous", mode: "none" };

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/.exec(header.trim());
  if (!match) return UNAUTHORIZED;

  try {
    const { payload } = await jwtVerify(match[1], keySet ?? remoteKeySet(config.issuer), {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
      clockTolerance: 30,
      requiredClaims: ["sub", "exp"],
    });
    if (config.clientIds.length > 0) {
      const client = (payload.azp ?? payload.client_id) as unknown;
      if (typeof client !== "string" || !config.clientIds.includes(client)) {
        console.warn("Content Studio: token rejected (client not allowed)");
        return UNAUTHORIZED;
      }
    }
    if (config.allowedOrgs.length > 0) {
      const org = payload[config.orgClaim];
      if (typeof org !== "string" || !config.allowedOrgs.includes(org)) {
        console.warn("Content Studio: token rejected (organization not allowed)");
        return UNAUTHORIZED;
      }
    }
    return { ok: true, subject: payload.sub as string, mode: "auth0" };
  } catch (error) {
    // Log the category only; never log the token.
    const reason = error instanceof joseErrors.JOSEError ? error.code : error instanceof Error ? error.name : "unknown";
    console.warn(`Content Studio: token rejected (${reason})`);
    return UNAUTHORIZED;
  }
}

"use client";

import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { setApiTokenProvider } from "@/src/lib/security/client-auth";
import { useIntegration } from "./IntegrationProvider";

// Sign-in for Content Studio's own API (document upload and URL import), using the app's
// Marketplace custom-authorization client credentials (Single Page App: no client secret).
// The access token is sent as a bearer token and verified by the server (src/lib/security/auth.ts).
// Sitecore content is still read and written through the Marketplace SDK, not with this token.

/** Public Auth0 settings. The client ID is not a secret; Sitecore's domain and audience are the defaults. */
export const API_AUTH = {
  clientId: process.env.NEXT_PUBLIC_CONTENT_STUDIO_AUTH0_CLIENT_ID?.trim() || "",
  domain: (process.env.NEXT_PUBLIC_CONTENT_STUDIO_AUTH0_DOMAIN?.trim() || "auth.sitecorecloud.io").replace(/^https?:\/\//, "").replace(/\/+$/, ""),
  audience: process.env.NEXT_PUBLIC_CONTENT_STUDIO_AUTH0_AUDIENCE?.trim() || "https://api-webapp.sitecorecloud.io",
};

export interface ApiAuthState {
  /** A client ID is configured and the app runs inside Sitecore, so sign-in is available. */
  available: boolean;
  isLoading: boolean;
  isAuthenticated: boolean;
  userName?: string;
  error?: string;
  signIn: () => Promise<void>;
  signOut: () => void;
}

const UNAVAILABLE: ApiAuthState = { available: false, isLoading: false, isAuthenticated: false, signIn: async () => {}, signOut: () => {} };
const ApiAuthContext = createContext<ApiAuthState>(UNAVAILABLE);

export function useApiAuth(): ApiAuthState {
  return useContext(ApiAuthContext);
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (/popup/i.test(error.message)) return "The sign-in window was blocked or closed. Allow pop-ups for Sitecore and try again.";
    return error.message;
  }
  return String(error);
}

/** Bridges Auth0 into the app: registers the token provider and exposes the sign-in state. */
function Bridge({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, user, error, getAccessTokenSilently, loginWithPopup, logout } = useAuth0();

  useEffect(() => {
    if (!isAuthenticated) return;
    setApiTokenProvider(async () => {
      try {
        return (await getAccessTokenSilently()) || null;
      } catch (e) {
        console.warn("Content Studio: access token could not be refreshed", e);
        return null;
      }
    });
    return () => setApiTokenProvider(null);
  }, [isAuthenticated, getAccessTokenSilently]);

  const value = useMemo<ApiAuthState>(
    () => ({
      available: true,
      isLoading,
      isAuthenticated,
      userName: user?.name ?? user?.email,
      error: error ? describe(error) : undefined,
      // A pop-up, because Sitecore's sign-in page cannot be shown inside the app's iframe.
      signIn: () => loginWithPopup(),
      signOut: () => logout({ openUrl: false }),
    }),
    [isLoading, isAuthenticated, user, error, loginWithPopup, logout],
  );
  return <ApiAuthContext.Provider value={value}>{children}</ApiAuthContext.Provider>;
}

/**
 * Wraps the app in Auth0 when a client ID is configured and Content Studio is connected to Sitecore.
 * The organization, tenant and app come from the Marketplace application context, so one deployment
 * signs users in for whichever tenant opened it.
 */
export function ApiAuthProvider({ children }: { children: ReactNode }) {
  const { appContext } = useIntegration();
  const tenantId = (appContext?.resourceAccess ?? appContext?.resources)?.[0]?.tenantId;
  if (!API_AUTH.clientId || !appContext) return <>{children}</>;
  return (
    <Auth0Provider
      key={`${appContext.organizationId ?? ""}|${tenantId ?? ""}`}
      domain={API_AUTH.domain}
      clientId={API_AUTH.clientId}
      // Refresh tokens in local storage: silent renewal through a hidden iframe fails in browsers
      // that block third-party cookies, which is the normal case inside the Sitecore iframe.
      cacheLocation="localstorage"
      useRefreshTokens
      useRefreshTokensFallback={false}
      authorizationParams={{
        audience: API_AUTH.audience,
        scope: "openid profile email offline_access",
        redirect_uri: `${window.location.origin}/content-studio`,
        // Parameters Sitecore's sign-in expects for a Marketplace app.
        organization_id: appContext.organizationId,
        tenant_id: tenantId,
        product_codes: `mkp_${appContext.id}`,
      }}
    >
      <Bridge>{children}</Bridge>
    </Auth0Provider>
  );
}

// Supplies the bearer token sent to Content Studio's own API.
//
// With Sitecore Marketplace *custom authorization*, the app signs the user in with the Auth0
// client credentials issued for the app and obtains an access token (for example with
// @auth0/auth0-react's getAccessTokenSilently). Register that function here at startup.
// With built-in authorization no verifiable token exists, so no header is sent and the server
// must run in an explicitly allowed unauthenticated mode (sandbox only) — see README.

type TokenProvider = () => Promise<string | null>;

let provider: TokenProvider | null = null;

export function setApiTokenProvider(next: TokenProvider | null): void {
  provider = next;
}

export async function apiAuthHeaders(): Promise<Record<string, string>> {
  if (!provider) return {};
  const token = await provider();
  return token ? { authorization: `Bearer ${token}` } : {};
}

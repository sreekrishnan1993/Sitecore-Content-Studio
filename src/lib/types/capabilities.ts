/** Server capabilities reported by GET /api/extract. Contains no secrets. */
export interface ServerCapabilities {
  maxUploadBytes: number;
  urlImportEnabled: boolean;
  aiProvider: string | null;
  ocrProvider: string | null;
  authMode: "auth0" | "none" | "misconfigured";
  /** From CONTENT_STUDIO_DEPLOYMENT. Only "sandbox" turns on the sandbox write guard. */
  deployment: "sandbox" | "production" | "unmarked";
  /** From CONTENT_STUDIO_SANDBOX_TENANT: the only tenant a sandbox deployment may write to. */
  sandboxTenant: string | null;
}

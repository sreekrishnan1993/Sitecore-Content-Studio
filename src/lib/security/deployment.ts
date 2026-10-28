import type { ServerCapabilities } from "../types/capabilities";

/** Reads CONTENT_STUDIO_DEPLOYMENT and CONTENT_STUDIO_SANDBOX_TENANT. Neither changes authentication. */
export function readDeployment(env: Record<string, string | undefined> = process.env): Pick<ServerCapabilities, "deployment" | "sandboxTenant"> {
  const value = (env.CONTENT_STUDIO_DEPLOYMENT ?? "").trim().toLowerCase();
  const deployment = value === "sandbox" || value === "production" ? value : "unmarked";
  const tenant = env.CONTENT_STUDIO_SANDBOX_TENANT?.trim();
  return { deployment, sandboxTenant: tenant ? tenant.slice(0, 200) : null };
}

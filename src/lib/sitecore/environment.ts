import type { ApplicationContext } from "@sitecore-marketplace-sdk/client";
import type { ServerCapabilities } from "../types/capabilities";

// Identifies the Sitecore environment the app is connected to, and decides whether a sandbox
// deployment may write to it. This is an operational safeguard against testing on the wrong
// tenant, not a security boundary: the host enforces the user's real permissions.

export interface TargetEnvironment {
  /** Human-readable label for confirmations. */
  label: string;
  tenantId?: string;
  tenantName?: string;
  tenantDisplayName?: string;
  resourceId?: string;
  /** How many environments the app has resource access to. The app uses the first. */
  resourceCount: number;
}

export function describeTarget(appContext: ApplicationContext | undefined): TargetEnvironment | null {
  const resources = appContext?.resourceAccess ?? appContext?.resources ?? [];
  const r = resources[0];
  if (!r) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const tenantDisplayName = str(r.tenantDisplayName);
  const tenantName = str(r.tenantName);
  return {
    label: tenantDisplayName ?? tenantName ?? str(r.tenantId) ?? "Unknown environment",
    tenantId: str(r.tenantId),
    tenantName,
    tenantDisplayName,
    resourceId: str(r.resourceId),
    resourceCount: resources.length,
  };
}

export interface WriteGuard {
  allowed: boolean;
  sandbox: boolean;
  /** Why writes are blocked, or a caution to show when they are allowed. */
  message?: string;
}

/**
 * In a deployment marked as a sandbox (CONTENT_STUDIO_DEPLOYMENT=sandbox), writes are allowed only
 * when the app has access to exactly one environment and it matches CONTENT_STUDIO_SANDBOX_TENANT
 * (tenant name, display name, tenant ID or resource ID). Other deployments are not restricted,
 * but are labelled as not being a sandbox.
 */
export function sandboxWriteGuard(target: TargetEnvironment | null, caps: ServerCapabilities | null | undefined): WriteGuard {
  if (!caps) return { allowed: false, sandbox: false, message: "The server configuration could not be read, so the target environment cannot be confirmed." };
  if (caps.deployment !== "sandbox") {
    return { allowed: true, sandbox: false, message: "This deployment is not marked as a sandbox (CONTENT_STUDIO_DEPLOYMENT)." };
  }
  if (!target) return { allowed: false, sandbox: true, message: "No Sitecore environment is connected." };
  if (target.resourceCount !== 1) {
    return { allowed: false, sandbox: true, message: `The app has access to ${target.resourceCount} environments. A sandbox test requires access to exactly one.` };
  }
  const connected = `"${target.label}" (tenant name ${target.tenantName ?? "unknown"}, tenant ID ${target.tenantId ?? "unknown"})`;
  const suggestion = target.tenantName ?? target.tenantId;
  const howTo = suggestion ? ` If that is your sandbox, set CONTENT_STUDIO_SANDBOX_TENANT=${suggestion} in the server's .env file and restart the server.` : "";
  if (!caps.sandboxTenant) {
    return { allowed: false, sandbox: true, message: `This deployment is marked as a sandbox, but CONTENT_STUDIO_SANDBOX_TENANT is not set, so item creation and media upload are disabled. Connected to ${connected}.${howTo}` };
  }
  const expected = caps.sandboxTenant.trim().toLowerCase();
  const matches = [target.tenantName, target.tenantDisplayName, target.tenantId, target.resourceId].some((v) => v?.toLowerCase() === expected);
  if (!matches) {
    return { allowed: false, sandbox: true, message: `Connected to ${connected}, which is not the configured sandbox tenant "${caps.sandboxTenant}". Item creation and media upload are disabled.${howTo}` };
  }
  return { allowed: true, sandbox: true };
}

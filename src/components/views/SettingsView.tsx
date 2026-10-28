"use client";

import { useState } from "react";
import type { ServerCapabilities } from "@/src/lib/types/capabilities";
import { formatBytes } from "@/src/lib/validation/file";
import { SandboxPreflight } from "./SandboxPreflight";
import { useIntegration } from "../state/IntegrationProvider";
import { useStudio } from "../state/StudioProvider";
import { useAsyncData } from "../state/useAsyncData";
import { Alert, Badge } from "../ui";

type Capabilities = ServerCapabilities;

function Capability({ label, on, detail }: { label: string; on: boolean; detail?: string }) {
  return (
    <li style={{ justifyContent: "space-between" }}>
      <span>
        {label}
        {detail && <span className="cs-muted cs-small"> — {detail}</span>}
      </span>
      <Badge tone={on ? "green" : "outline"}>{on ? "Available" : "Not available"}</Badge>
    </li>
  );
}

export function SettingsView() {
  const { adapter, appContext, embedded, settings, updateSettings, connecting } = useIntegration();
  const { clearAll, recent, notify } = useStudio();
  const [rootPath, setRootPath] = useState(settings.templateRootPath);
  const caps = useAsyncData("capabilities", async () => {
    const res = await fetch("/api/extract");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Capabilities;
  });
  const status = adapter.status;
  const rootValid = rootPath.startsWith("/sitecore/templates");

  return (
    <div className="cs-grid-2">
      <section className="cs-card">
        <div className="cs-card-header">
          <h2>Sitecore integration</h2>
          {connecting ? <Badge tone="outline">Connecting</Badge> : <Badge tone={status.mode === "live" ? "green" : "amber"}>{status.mode === "live" ? "Live" : "Demo"}</Badge>}
        </div>
        <div className="cs-card-body cs-stack">
          <p>{status.detail}</p>
          {appContext && (
            <dl className="cs-meta-list">
              <dt>App</dt>
              <dd>{appContext.name ?? appContext.id}</dd>
              <dt>Installation</dt>
              <dd>{appContext.installationId ?? "—"}</dd>
              <dt>Tenant</dt>
              <dd>{appContext.resourceAccess?.[0]?.tenantDisplayName ?? appContext.resourceAccess?.[0]?.tenantName ?? "—"}</dd>
            </dl>
          )}
          <ul className="cs-issues">
            <Capability label="List sites and languages" on={status.mode === "live" && status.canListSites} detail="Sites API via Marketplace SDK" />
            <Capability label="Discover templates" on={status.mode === "live" && status.canDiscoverTemplates} detail="Authoring GraphQL" />
            <Capability label="Create content items" on={status.mode === "live" && status.canCreateItems} detail="Authoring GraphQL createItem; never publishes" />
            <Capability label="Upload media" on={status.mode === "live" && status.canUploadMedia} detail="experimental Agent API upload; opt-in below" />
          </ul>
          {embedded && (
            <label className="cs-row">
              <input
                type="checkbox"
                className="cs-checkbox"
                checked={settings.forceDemo}
                onChange={(e) => {
                  updateSettings({ ...settings, forceDemo: e.target.checked });
                  notify(e.target.checked ? "Switched to demo mode" : "Reconnecting to Sitecore…");
                }}
              />
              Use demo data even when running inside Sitecore
            </label>
          )}
          <label className="cs-row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
            <input
              type="checkbox"
              className="cs-checkbox"
              style={{ marginTop: 3 }}
              checked={settings.experimentalMediaUpload}
              onChange={(e) => {
                updateSettings({ ...settings, experimentalMediaUpload: e.target.checked });
                notify(e.target.checked ? "Experimental media upload enabled" : "Media upload disabled");
              }}
            />
            <span>
              Enable experimental media upload (live mode only)
              <span className="cs-hint" style={{ display: "block" }}>Uploads selected images through the Sitecore Agent API. Not yet verified against a tenant; use in a sandbox first.</span>
            </span>
          </label>
        </div>
      </section>

      <section className="cs-card">
        <div className="cs-card-header">
          <h2>Template discovery</h2>
        </div>
        <form
          className="cs-card-body cs-stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!rootValid) return;
            notify(updateSettings({ ...settings, templateRootPath: rootPath.trim() }) ? "Settings saved" : "Settings could not be saved in this browser");
          }}
        >
          <div className="cs-field">
            <label htmlFor="cs-root-path">Template root path</label>
            <input id="cs-root-path" className="cs-input" value={rootPath} aria-invalid={!rootValid} onChange={(e) => setRootPath(e.target.value)} />
            <span className="cs-hint">{rootValid ? "Templates are discovered up to three levels below this item (live mode)." : "The path must start with /sitecore/templates."}</span>
          </div>
          <div>
            <button type="submit" className="cs-btn cs-primary" disabled={!rootValid || rootPath.trim() === settings.templateRootPath}>
              Save
            </button>
          </div>
        </form>
      </section>

      <section className="cs-card">
        <div className="cs-card-header">
          <h2>Document processing</h2>
        </div>
        <div className="cs-card-body cs-stack">
          {caps.loading && <span className="cs-muted">Checking the extraction service…</span>}
          {caps.error && <Alert tone="error" title="Extraction service unavailable">{caps.error}</Alert>}
          {caps.data && (
            <ul className="cs-issues">
              <Capability label="PDF and DOCX extraction" on detail={`up to ${formatBytes(caps.data.maxUploadBytes)}`} />
              <Capability label="Publication URL import" on={caps.data.urlImportEnabled} />
              <Capability label="OCR for scanned PDFs" on={Boolean(caps.data.ocrProvider)} />
              <Capability
                label="API authentication"
                on={caps.data.authMode === "auth0"}
                detail={caps.data.authMode === "auth0" ? "Auth0 access tokens are verified" : caps.data.authMode === "none" ? "disabled — sandbox/development only" : "not configured — processing is refused"}
              />
              <Capability label="AI classification" on={Boolean(caps.data.aiProvider)} detail={caps.data.aiProvider ?? "rule-based extraction is used"} />
              <Capability
                label="Sandbox deployment"
                on={caps.data.deployment === "sandbox"}
                detail={caps.data.deployment === "sandbox" ? `writes limited to tenant "${caps.data.sandboxTenant ?? "not set — writes disabled"}"` : caps.data.deployment}
              />
            </ul>
          )}
          <p className="cs-small cs-muted">Uploaded files are processed in server memory and are not stored. Limits are configured with server environment variables.</p>
        </div>
      </section>

      <SandboxPreflight />

      <section className="cs-card">
        <div className="cs-card-header">
          <h2>Session data</h2>
        </div>
        <div className="cs-card-body cs-stack">
          <p>{recent.length} document workspace(s) are stored in this browser tab.</p>
          <div>
            <button
              type="button"
              className="cs-btn cs-danger"
              onClick={() => {
                clearAll();
                notify("Session data cleared");
              }}
              disabled={recent.length === 0}
            >
              Clear session data
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

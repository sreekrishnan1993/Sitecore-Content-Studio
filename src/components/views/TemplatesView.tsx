"use client";

import { useState } from "react";
import { useIntegration } from "../state/IntegrationProvider";
import { useAsyncData } from "../state/useAsyncData";
import { Alert, Badge, EmptyState } from "../ui";

export function TemplatesView() {
  const { adapter, settings } = useIntegration();
  const mode = adapter.status.mode;
  const templates = useAsyncData(`templates:${mode}:${settings.templateRootPath}`, () => adapter.listTemplates());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useAsyncData(selectedId ? `template:${mode}:${selectedId}` : null, () => adapter.getTemplate(selectedId as string));

  return (
    <>
      {mode === "demo" ? (
        <Alert tone="info" title="Demo templates">These templates are mock data for demonstration. In SitecoreAI / XM Cloud, templates are read from {settings.templateRootPath}.</Alert>
      ) : (
        <Alert tone="info">Templates are read from <code>{settings.templateRootPath}</code> (three levels deep). Change the root in Settings.</Alert>
      )}
      <div className="cs-results">
        <section className="cs-card">
          <div className="cs-card-header">
            <h2>Templates</h2>
            {templates.data && <Badge tone="outline">{templates.data.length}</Badge>}
          </div>
          {templates.loading && <div className="cs-card-body cs-muted cs-row"><span className="cs-spinner" aria-hidden /> Loading…</div>}
          {templates.error && (
            <div className="cs-card-body">
              <Alert tone="error" title="Templates could not be loaded">{templates.error}</Alert>
            </div>
          )}
          {templates.data?.length === 0 && <EmptyState icon="template" title="No templates found">No content templates exist under the configured template root.</EmptyState>}
          {templates.data?.map((t) => (
            <button key={t.id} type="button" className="cs-nav-item" style={{ borderRadius: 0, padding: "12px 16px", borderBottom: "1px solid var(--cs-border)" }} aria-current={selectedId === t.id ? "page" : undefined} onClick={() => setSelectedId(t.id)}>
              <span style={{ minWidth: 0 }}>
                <strong style={{ display: "block" }}>{t.name}</strong>
                <span className="cs-small cs-muted">{t.path}</span>
              </span>
            </button>
          ))}
        </section>

        <section className="cs-card">
          {!selectedId ? (
            <EmptyState icon="template" title="Select a template">See its fields and their types.</EmptyState>
          ) : detail.loading ? (
            <div className="cs-card-body cs-muted cs-row"><span className="cs-spinner" aria-hidden /> Loading fields…</div>
          ) : detail.error ? (
            <div className="cs-card-body"><Alert tone="error" title="Template fields could not be loaded">{detail.error}</Alert></div>
          ) : detail.data ? (
            <>
              <div className="cs-card-header">
                <div>
                  <h2>{detail.data.name}</h2>
                  {detail.data.description && <p className="cs-small cs-muted">{detail.data.description}</p>}
                </div>
                <Badge tone="outline">{detail.data.fields.length} fields</Badge>
              </div>
              {(detail.data.notes?.length ?? 0) > 0 && (
                <div className="cs-card-body">
                  <Alert tone="warning">{detail.data.notes?.join(" ")}</Alert>
                </div>
              )}
              <div className="cs-table-wrap">
                <table className="cs-table">
                  <thead>
                    <tr><th scope="col">Field</th><th scope="col">Type</th><th scope="col">Section</th><th scope="col">Required</th></tr>
                  </thead>
                  <tbody>
                    {detail.data.fields.map((f) => (
                      <tr key={`${f.section}-${f.name}`}>
                        <td><strong>{f.name}</strong></td>
                        <td>{f.type === "Other" ? f.rawType ?? "Other" : f.type}</td>
                        <td className="cs-muted">
                          {f.section ?? "—"}
                          {f.definedIn && ` · inherited from ${f.definedIn}`}
                        </td>
                        <td>
                          {f.required ? (
                            <Badge tone="red">{f.requiredSource === "validation-rule" ? "Required (validation rule)" : "Required"}</Badge>
                          ) : (
                            <span className="cs-muted">{detail.data?.requiredInfo === "unavailable" ? "Unknown" : "No"}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </>
  );
}

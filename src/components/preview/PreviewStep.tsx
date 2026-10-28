"use client";

import { useRef, useState } from "react";
import { buildFieldValue, selectedTemplate, validateMapping } from "@/src/lib/mapping";
import { describeTarget, sandboxWriteGuard } from "@/src/lib/sitecore/environment";
import { buildCreateItemMutation, joinItemPath } from "@/src/lib/sitecore/graphql";
import type { CreateDiagnostics, CreateItemResult, SitecoreFailureKind } from "@/src/lib/types/sitecore";
import { copyToClipboard } from "@/src/lib/utils/clipboard";
import { imageIssues } from "../media/MediaStep";
import type { Step } from "../shell/routes";
import { useIntegration } from "../state/IntegrationProvider";
import { useStudio, useWorkspace } from "../state/StudioProvider";
import { useServerCapabilities } from "../state/useServerCapabilities";
import { Alert, Badge, Icon } from "../ui";
import { ArticlePreview } from "./ArticlePreview";

type CreateState =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "creating" }
  | { kind: "checking" }
  | { kind: "result"; result: CreateItemResult }
  | { kind: "check-result"; message: string; tone: "info" | "error" };

const FAILURE_TITLES: Partial<Record<SitecoreFailureKind, string>> = {
  permission: "Not created: permission denied",
  schema: "Not created: Sitecore rejected the request",
  validation: "Not created: Sitecore refused the item",
  server: "Not created: Sitecore server error",
  precondition: "Not created: checks before sending failed",
  "unexpected-response": "Not created: unexpected response",
};

/** Sanitized diagnostics (no field values, no tokens) that an author can copy into a support ticket. */
function TechnicalDetails({ diagnostics }: { diagnostics: CreateDiagnostics }) {
  const { notify } = useStudio();
  const text = JSON.stringify(diagnostics, null, 2);
  return (
    <details className="cs-small">
      <summary>Technical details (no field values)</summary>
      <pre className="cs-code">{text}</pre>
      <button
        type="button"
        className="cs-btn cs-ghost cs-sm"
        onClick={async () => notify((await copyToClipboard(text)) ? "Technical details copied" : "Copy failed: the clipboard is not available in this context")}
      >
        <Icon name="copy" /> Copy details
      </button>
    </details>
  );
}

export function PreviewStep({ onEdit }: { onEdit: (step: Step) => void }) {
  const { workspace, dispatch } = useWorkspace();
  const { notify, lastSave } = useStudio();
  const { adapter, appContext } = useIntegration();
  const { data: caps } = useServerCapabilities();
  const mode = adapter.status.mode;
  const target = describeTarget(appContext);
  // Demo creation sends nothing, so the sandbox guard applies to live mode only.
  const guard = mode === "live" ? sandboxWriteGuard(target, caps) : { allowed: true, sandbox: false, message: undefined };
  const { mapping } = workspace;
  const template = selectedTemplate(mapping);
  const [create, setCreate] = useState<CreateState>({ kind: "idle" });
  // Synchronous lock: a double click cannot start two requests before React re-renders.
  const inFlight = useRef(false);

  const issues = validateMapping(template, mapping, workspace, mode);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const fieldValues = template ? template.fields.map((f) => buildFieldValue(f, mapping.fields[f.name], workspace, mode)) : [];
  const toWrite = fieldValues.filter((v) => v.value !== null).map((v) => ({ name: v.field.name, value: v.value as string, type: v.field.type, fieldId: v.field.id }));
  const imageWrites = fieldValues.filter((v) => v.field.type === "Image" && v.value !== null);
  const leftEmpty = fieldValues.filter((v) => v.value === null).map((v) => v.field.name);
  const imageWarnings = workspace.extraction.images.flatMap((img) => {
    const asset = workspace.images.find((a) => a.id === img.id);
    return asset?.selected ? imageIssues(img, asset).map((m) => `${img.fileName}: ${m}`) : [];
  });
  const seo = workspace.cards.filter((c) => c.type === "seo" && c.selected);
  const targetPath = mapping.destinationPath && mapping.itemName ? joinItemPath(mapping.destinationPath.trim(), mapping.itemName.trim()) : undefined;

  const requestPreview =
    template && mapping.language && mapping.itemName
      ? buildCreateItemMutation({
          name: mapping.itemName.trim(),
          templateId: template.id,
          parentPath: mapping.destinationPath?.trim() ?? "",
          parentId: mapping.destinationVerified?.itemId ?? "(resolved from the parent path when sent)",
          language: mapping.language,
          fields: toWrite,
        }).query
      : null;

  const createdAlready = Boolean(workspace.createdItem);
  // A pending record that is still present after a reload has no known outcome.
  const unresolved = workspace.creation && create.kind !== "creating" ? workspace.creation : undefined;
  const canCreate = !createdAlready && !unresolved && guard.allowed && errors.length === 0 && create.kind !== "creating" && create.kind !== "checking";

  const saveDraft = () => {
    dispatch({ type: "mark-draft-saved", at: new Date().toISOString() });
    notify("Draft saved in this browser session");
  };

  const runCreate = async () => {
    if (inFlight.current || !canCreate) return;
    // Re-validate at the moment of sending, not only when the page rendered.
    if (!template || !mapping.destinationPath || !mapping.language || !mapping.itemName || validateMapping(template, mapping, workspace, mode).some((i) => i.level === "error")) {
      setCreate({ kind: "idle" });
      return;
    }
    inFlight.current = true;
    setCreate({ kind: "creating" });
    const itemName = mapping.itemName.trim();
    const parentPath = mapping.destinationPath.trim();
    if (mode === "live") dispatch({ type: "set-creation", creation: { state: "pending", startedAt: new Date().toISOString(), itemName, parentPath } });
    let result: CreateItemResult;
    try {
      result = await adapter.createItem({ name: itemName, templateId: template.id, parentPath, language: mapping.language, fields: toWrite });
    } catch (error) {
      result = { ok: false, reason: "uncertain", message: error instanceof Error ? error.message : String(error) };
    } finally {
      inFlight.current = false;
    }
    if (result.ok) {
      dispatch({ type: "mark-created", itemId: result.itemId, path: result.path, at: new Date().toISOString(), warnings: result.warnings });
    } else if (result.reason === "uncertain") {
      dispatch({ type: "set-creation", creation: { state: "uncertain", startedAt: new Date().toISOString(), itemName, parentPath, message: result.message } });
    } else {
      dispatch({ type: "set-creation", creation: undefined });
    }
    setCreate({ kind: "result", result });
  };

  /** Resolves an uncertain creation by asking Sitecore whether the item exists. */
  const checkInSitecore = async () => {
    if (!workspace.creation || inFlight.current) return;
    inFlight.current = true;
    setCreate({ kind: "checking" });
    const { itemName, parentPath } = workspace.creation;
    try {
      const found = await adapter.findItem(joinItemPath(parentPath, itemName));
      if (found.found) {
        dispatch({ type: "mark-created", itemId: found.itemId, path: found.path, at: new Date().toISOString() });
        setCreate({ kind: "check-result", tone: "info", message: "Sitecore confirms the item exists. It was created by the earlier attempt." });
      } else {
        dispatch({ type: "set-creation", creation: undefined });
        setCreate({ kind: "check-result", tone: "info", message: `No item exists at ${joinItemPath(parentPath, itemName)}. The earlier attempt did not create it, so you can create it now.` });
      }
    } catch (error) {
      setCreate({ kind: "check-result", tone: "error", message: `Sitecore could not be checked: ${error instanceof Error ? error.message : String(error)}. Try again, or look in the Content Editor.` });
    } finally {
      inFlight.current = false;
    }
  };

  const copyFields = async () => {
    const ok = await copyToClipboard(JSON.stringify({ itemName: mapping.itemName, template: template?.name, language: mapping.language, parentPath: mapping.destinationPath, fields: toWrite }, null, 2));
    notify(ok ? "Field values copied as JSON" : "Copy failed: the clipboard is not available in this context");
  };

  return (
    <div className="cs-preview-layout">
      <section className="cs-card" aria-label="Rendered article preview">
        <div className="cs-card-header">
          <h2>Article preview</h2>
          <div className="cs-row">
            <button type="button" className="cs-btn cs-sm" onClick={() => onEdit("board")}>
              <Icon name="edit" /> Edit content
            </button>
            <button type="button" className="cs-btn cs-sm" onClick={() => onEdit("media")}>
              <Icon name="image" /> Edit images
            </button>
          </div>
        </div>
        <ArticlePreview workspace={workspace} />
      </section>

      <aside className="cs-side-panel">
        <section className="cs-card">
          <div className="cs-card-header">
            <h2>Destination</h2>
            <button type="button" className="cs-btn cs-ghost cs-sm" onClick={() => onEdit("mapping")}>
              Change
            </button>
          </div>
          <div className="cs-card-body">
            <dl className="cs-meta-list">
              <dt>Site</dt>
              <dd>{mapping.siteName ?? <span className="cs-muted">Not selected</span>}</dd>
              <dt>Template</dt>
              <dd>{template?.name ?? <span className="cs-muted">Not selected</span>}</dd>
              <dt>Language</dt>
              <dd>{mapping.language ?? <span className="cs-muted">Not selected</span>}</dd>
              <dt>Parent</dt>
              <dd>{mapping.destinationPath || <span className="cs-muted">Not set</span>}</dd>
              <dt>Item name</dt>
              <dd>{mapping.itemName || <span className="cs-muted">Not set</span>}</dd>
              <dt>Fields</dt>
              <dd>
                {toWrite.length} of {template?.fields.length ?? 0} will be written
              </dd>
            </dl>
          </div>
        </section>

        <section className="cs-card">
          <div className="cs-card-header">
            <h2>Validation</h2>
            <div className="cs-row">
              <Badge tone={errors.length ? "red" : "green"}>{errors.length} errors</Badge>
              <Badge tone={warnings.length + imageWarnings.length ? "amber" : "outline"}>{warnings.length + imageWarnings.length} warnings</Badge>
            </div>
          </div>
          <div className="cs-card-body cs-stack">
            {errors.length === 0 && warnings.length === 0 && imageWarnings.length === 0 ? (
              <p className="cs-row" style={{ color: "var(--cs-success)" }}>
                <Icon name="check" /> Ready
              </p>
            ) : (
              <ul className="cs-issues cs-small">
                {[...errors, ...warnings].map((issue, i) => (
                  <li key={i} style={{ color: issue.level === "error" ? "var(--cs-danger)" : "var(--cs-warning)" }}>
                    <Icon name="alert" size={14} /> <span>{issue.message}</span>
                  </li>
                ))}
                {imageWarnings.map((m) => (
                  <li key={m} style={{ color: "var(--cs-warning)" }}>
                    <Icon name="alert" size={14} /> <span>{m}</span>
                  </li>
                ))}
              </ul>
            )}
            {errors.length > 0 && (
              <button type="button" className="cs-btn cs-sm" onClick={() => onEdit("mapping")}>
                Fix in template mapping
              </button>
            )}
          </div>
        </section>

        {seo.length > 0 && (
          <section className="cs-card">
            <div className="cs-card-header">
              <h2>SEO metadata</h2>
            </div>
            <div className="cs-card-body cs-stack cs-small">
              {seo.map((c) => (
                <div key={c.id}>
                  <strong>{c.label ?? "SEO"}</strong> <span className="cs-muted">({c.text.length} chars)</span>
                  <div>{c.text}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="cs-card">
          <div className="cs-card-header">
            <h2>Save & create</h2>
          </div>
          <div className="cs-card-body cs-stack">
            <button type="button" className="cs-btn" onClick={saveDraft} disabled={lastSave?.ok === false}>
              Save draft
            </button>
            {workspace.draftSavedAt && (
              <span className="cs-small cs-muted">Draft saved in this browser session at {new Date(workspace.draftSavedAt).toLocaleTimeString()}. It has not been sent to Sitecore.</span>
            )}
            <hr className="cs-divider" />

            {workspace.createdItem && (
              <Alert tone="success" title="Item created in Sitecore">
                {workspace.createdItem.path}
                <br />
                ID {workspace.createdItem.itemId}. Confirmed by the Sitecore API. It is not published — review and publish it in Sitecore when ready.
                {workspace.createdItem.warnings?.map((w) => (
                  <span key={w} style={{ display: "block", marginTop: 6 }}>
                    ⚠ {w}
                  </span>
                ))}
              </Alert>
            )}

            {mode === "live" && !createdAlready && guard.message && (
              <Alert tone={guard.allowed ? "warning" : "error"} title={guard.allowed ? undefined : "Creation is disabled for this environment"}>
                {guard.message}
              </Alert>
            )}

            {unresolved && !createdAlready && (
              <Alert tone="warning" title="The result of the last creation attempt is unknown">
                <p>
                  {unresolved.state === "pending"
                    ? "Content Studio was closed or reloaded while the item was being created."
                    : `Sitecore did not give a reliable answer${unresolved.message ? ` (${unresolved.message})` : ""}.`}{" "}
                  The item <strong>{joinItemPath(unresolved.parentPath, unresolved.itemName)}</strong> may or may not exist. Creating it again could produce a duplicate, so check first.
                </p>
                <div className="cs-row" style={{ marginTop: 8 }}>
                  <button type="button" className="cs-btn cs-primary cs-sm" onClick={checkInSitecore} disabled={create.kind === "checking"}>
                    {create.kind === "checking" ? <span className="cs-spinner" aria-hidden /> : null} Check in Sitecore
                  </button>
                </div>
              </Alert>
            )}
            {create.kind === "check-result" && <Alert tone={create.tone === "error" ? "error" : "info"}>{create.message}</Alert>}

            {!createdAlready && !unresolved && create.kind === "confirm" && (
              <Alert tone="warning" title={mode === "live" ? "Create this item in Sitecore?" : "Run demo creation?"}>
                <dl className="cs-meta-list" style={{ margin: "6px 0" }}>
                  {mode === "live" && (
                    <>
                      <dt>Environment</dt>
                      <dd>
                        {target?.label ?? "—"} {guard.sandbox ? <Badge tone="green">Sandbox</Badge> : <Badge tone="amber">Not marked as sandbox</Badge>}
                      </dd>
                    </>
                  )}
                  <dt>Site</dt>
                  <dd>{mapping.siteName ?? "—"}</dd>
                  <dt>Template</dt>
                  <dd>
                    {template?.name}
                    {template?.path && <span className="cs-muted"> ({template.path})</span>}
                  </dd>
                  <dt>Parent</dt>
                  <dd>
                    <code>{mapping.destinationPath?.trim()}</code>
                  </dd>
                  <dt>New item</dt>
                  <dd>
                    <code>{targetPath}</code>
                  </dd>
                  <dt>Language</dt>
                  <dd>{mapping.language}</dd>
                  <dt>Writes</dt>
                  <dd>{toWrite.map((f) => f.name).join(", ") || "no fields"}</dd>
                  {imageWrites.length > 0 && (
                    <>
                      <dt>Images</dt>
                      <dd>
                        {imageWrites.map((v) => (
                          <span key={v.field.name} style={{ display: "block" }}>
                            {v.field.name}
                            {v.field.id && <span className="cs-muted"> ({v.field.id})</span>} → {v.display}
                          </span>
                        ))}
                      </dd>
                    </>
                  )}
                  <dt>Leaves empty</dt>
                  <dd>{leftEmpty.join(", ") || "none"}</dd>
                  <dt>Validation</dt>
                  <dd>
                    {errors.length} errors, {warnings.length + imageWarnings.length} warnings
                  </dd>
                </dl>
                {requestPreview && (
                  <details className="cs-small">
                    <summary>Review the exact request</summary>
                    <pre className="cs-code">{requestPreview}</pre>
                  </details>
                )}
                <p>{mode === "live" ? "This creates one unpublished item. Nothing is published." : "Demo mode shows the request that would be sent. Nothing is sent to Sitecore."}</p>
                <div className="cs-row" style={{ marginTop: 8 }}>
                  <button type="button" className="cs-btn cs-primary cs-sm" onClick={runCreate} disabled={!canCreate}>
                    {mode === "live" ? "Create item" : "Show request"}
                  </button>
                  <button type="button" className="cs-btn cs-sm" onClick={() => setCreate({ kind: "idle" })}>
                    Cancel
                  </button>
                </div>
              </Alert>
            )}

            {!createdAlready && !unresolved && create.kind !== "confirm" && (
              <button type="button" className="cs-btn cs-primary" onClick={() => setCreate({ kind: "confirm" })} disabled={!canCreate}>
                {create.kind === "creating" ? <span className="cs-spinner" aria-hidden /> : <Icon name="plus" />}
                {create.kind === "creating" ? "Creating…" : mode === "live" ? "Create content item" : "Create content item (demo)"}
              </button>
            )}
            {errors.length > 0 && !createdAlready && <span className="cs-small cs-muted">Resolve the validation errors to enable item creation.</span>}

            {create.kind === "result" && !create.result.ok && create.result.reason === "demo-mode" && (
              <div className="cs-stack">
                <Alert tone="info" title="Demo mode — no item was created">
                  {create.result.message}
                </Alert>
                <span className="cs-small cs-muted">Authoring GraphQL request that live mode would send:</span>
                <pre className="cs-code">{create.result.preview.query}</pre>
              </div>
            )}
            {create.kind === "result" && !create.result.ok && create.result.reason === "error" && (
              <Alert tone="error" title={(create.result.kind && FAILURE_TITLES[create.result.kind]) || "The item was not created"}>
                {create.result.message}
                {create.result.diagnostics && <TechnicalDetails diagnostics={create.result.diagnostics} />}
              </Alert>
            )}
            {create.kind === "result" && !create.result.ok && create.result.reason === "uncertain" && create.result.diagnostics && <TechnicalDetails diagnostics={create.result.diagnostics} />}
            {create.kind === "result" && create.result.ok && create.result.diagnostics && <TechnicalDetails diagnostics={create.result.diagnostics} />}

            <hr className="cs-divider" />
            <button type="button" className="cs-btn cs-ghost cs-sm" onClick={copyFields} disabled={!template}>
              <Icon name="copy" /> Copy field values as JSON
            </button>
            <p className="cs-small cs-muted">Publishing is a separate step and is never performed by Content Studio.</p>
          </div>
        </section>
      </aside>
    </div>
  );
}

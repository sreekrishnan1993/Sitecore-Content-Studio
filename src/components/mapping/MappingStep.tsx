"use client";

import { useEffect, useRef, useState } from "react";
import { autoMap, buildFieldValue, decodeSource, encodeSource, reconcileMapping, selectedTemplate, siteLanguages, suggestItemName, validateItemName, validateMapping } from "@/src/lib/mapping";
import { CONTENT_ROOT, sameSitecoreId } from "@/src/lib/sitecore/graphql";
import { CONTENT_TYPE_LABELS, CONTENT_TYPES } from "@/src/lib/types/extraction";
import type { IntegrationMode, SitecoreTemplate, SitecoreTemplateField, SitecoreTreeItem } from "@/src/lib/types/sitecore";
import type { Workspace } from "@/src/lib/types/workspace";
import { useIntegration } from "../state/IntegrationProvider";
import { useWorkspace } from "../state/StudioProvider";
import { ItemTreePicker } from "./ItemTreePicker";
import { useAsyncData } from "../state/useAsyncData";
import { Alert, Badge, EmptyState, Icon } from "../ui";

const TYPE_TONE: Record<string, "purple" | "blue" | "green" | "amber" | "outline"> = {
  "Single-Line Text": "outline",
  "Multi-Line Text": "outline",
  "Rich Text": "purple",
  Image: "green",
  "General Link": "blue",
  Date: "amber",
  Datetime: "amber",
  Other: "outline",
};

const short = (text: string, n = 48) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** How an image can be used in this mode: only confirmed uploads can fill a live Image field. */
function imageStatus(asset: Workspace["images"][number] | undefined, mode: IntegrationMode): string {
  if (mode === "demo") return "demo preview only, not in Sitecore";
  const upload = asset?.mediaUpload;
  if (upload?.state === "uploaded") return `uploaded: ${upload.mediaPath ?? upload.mediaItemId}`;
  if (upload?.state === "uncertain") return "upload outcome unknown";
  if (upload?.state === "failed") return "upload failed";
  return "not uploaded";
}

function SourceOptions({ field, workspace, mode }: { field: SitecoreTemplateField; workspace: Workspace; mode: IntegrationMode }) {
  // IDs, flags and numbers cannot come from document text; unsupported types only accept explicit custom text.
  if (field.type === "Reference" || field.type === "Checkbox" || field.type === "Number") return null;
  if (field.type === "Other") return <option value="static">Custom text…</option>;
  if (field.type === "Image") {
    const images = workspace.extraction.images.filter((img) => workspace.images.find((a) => a.id === img.id)?.selected);
    return (
      <optgroup label="Selected images">
        {images.map((img) => (
          <option key={img.id} value={`image:${img.id}`}>
            {img.fileName}
            {img.page !== undefined ? ` (page ${img.page})` : ""} — {imageStatus(workspace.images.find((a) => a.id === img.id), mode)}
          </option>
        ))}
      </optgroup>
    );
  }
  const selected = workspace.cards.filter((c) => c.selected && c.text.trim());
  // Offer every type on the board so an existing mapping stays visible even if its cards are deselected.
  const types = CONTENT_TYPES.filter((t) => workspace.cards.some((c) => c.type === t));
  const meta = workspace.extraction.metadata;
  return (
    <>
      <optgroup label="Content (selected cards)">
        <option value="article">Article body — subheadings, paragraphs and quotes in order</option>
        {types.flatMap((t) => [
          <option key={`${t}-first`} value={`content:${t}:first`}>
            First {CONTENT_TYPE_LABELS[t].toLowerCase()}
          </option>,
          <option key={`${t}-all`} value={`content:${t}:all`}>
            All {CONTENT_TYPE_LABELS[t].toLowerCase()} cards
          </option>,
        ])}
      </optgroup>
      <optgroup label="A specific card">
        {selected.map((c) => (
          <option key={c.id} value={`card:${c.id}:text`}>
            {CONTENT_TYPE_LABELS[c.type]}
            {c.label ? ` (${c.label})` : ""}: {short(c.text)}
          </option>
        ))}
        {selected
          .filter((c) => c.type === "quote" && c.attribution)
          .map((c) => (
            <option key={`${c.id}-attr`} value={`card:${c.id}:attribution`}>
              Quote attribution: {short(c.attribution ?? "")}
            </option>
          ))}
        {selected
          .filter((c) => c.href)
          .map((c) => (
            <option key={`${c.id}-href`} value={`card:${c.id}:href`}>
              URL: {short(c.href ?? "")}
            </option>
          ))}
      </optgroup>
      <optgroup label="Document metadata">
        {meta.author && <option value="metadata:author">Author: {short(meta.author)}</option>}
        {meta.createdAt && <option value="metadata:createdAt">Created date</option>}
        {meta.sourceUrl && <option value="metadata:sourceUrl">Source URL</option>}
        <option value="metadata:fileName">File name</option>
      </optgroup>
      <option value="static">Custom text…</option>
    </>
  );
}

export function MappingStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { workspace, dispatch } = useWorkspace();
  const { adapter, connecting } = useIntegration();
  const mode = adapter.status.mode;
  const { mapping } = workspace;
  const [notices, setNotices] = useState<string[]>([]);
  const workspaceRef = useRef(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  });

  const sites = useAsyncData(`sites:${mode}`, () => adapter.listSites());
  const languages = useAsyncData(`languages:${mode}`, () => adapter.listLanguages());
  const templates = useAsyncData(`templates:${mode}`, () => adapter.listTemplates());
  // Loads the selected template's fields whenever no snapshot for that exact template is present.
  const templateDetail = useAsyncData(mapping.templateId && !selectedTemplate(mapping) ? `template:${mode}:${mapping.templateId}` : null, async () => {
    const requestedId = mapping.templateId as string;
    const template = await adapter.getTemplate(requestedId);
    // Ignore a slow response for a template the author has since replaced.
    if (sameSitecoreId(workspaceRef.current.mapping.templateId, requestedId)) {
      dispatch({ type: "set-mapping", patch: { templateId: template.id, template } });
      dispatch({ type: "replace-field-mappings", fields: autoMap(template, workspaceRef.current, mode) });
    }
    return template;
  });

  // Restored or previously chosen selections must exist in what Sitecore (or demo data) returned.
  // Not while connecting: the placeholder demo adapter would discard a restored live selection.
  useEffect(() => {
    if (connecting) return;
    const result = reconcileMapping(workspaceRef.current.mapping, { sites: sites.data, languages: languages.data, templates: templates.data });
    if (!result) return;
    dispatch({ type: "set-mapping", patch: result.patch });
    if (result.notices.length) setNotices(result.notices);
  }, [connecting, sites.data, languages.data, templates.data, dispatch]);

  // Prefill the item name from the headline once.
  useEffect(() => {
    if (mapping.itemName === undefined) {
      dispatch({ type: "set-mapping", patch: { itemName: suggestItemName(workspace.cards.find((c) => c.type === "headline" && c.selected)?.text) } });
    }
  }, [mapping.itemName, workspace.cards, dispatch]);

  const site = sites.data?.find((s) => s.id === mapping.siteId);
  const roots = useAsyncData(site ? `tree-roots:${mode}:${site.id}` : null, () => adapter.getTreeRoots(site));
  const languageOptions = siteLanguages(languages.data, site);
  const template: SitecoreTemplate | undefined = selectedTemplate(mapping);
  const issues = validateMapping(template, mapping, workspace, mode);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const itemNameError = mapping.itemName !== undefined ? validateItemName(mapping.itemName) : null;

  const destVerified = mode === "live" && mapping.destinationVerified?.path === mapping.destinationPath?.trim();

  // An item read from Sitecore's tree exists, so in live mode selecting it also verifies it.
  const onPickDestination = (item: SitecoreTreeItem) => {
    dispatch({ type: "set-mapping", patch: { destinationPath: item.path, destinationVerified: mode === "live" ? { path: item.path, itemId: item.id } : undefined } });
  };

  const loadError = sites.error || languages.error || templates.error;

  return (
    <div className="cs-stack-lg">
      {mode === "demo" && (
        <Alert tone="info" title="Demo sites and templates">
          The sites, languages and templates below are mock data labelled “(demo)”. In SitecoreAI / XM Cloud they are loaded from your environment.
        </Alert>
      )}
      {notices.length > 0 && (
        <Alert tone="warning" title="Some earlier selections are no longer available">
          {notices.map((n) => (
            <span key={n} style={{ display: "block" }}>
              {n}
            </span>
          ))}
        </Alert>
      )}
      {loadError && (
        <Alert tone="error" title="Sitecore data could not be loaded">
          {loadError}{" "}
          <button type="button" className="cs-btn cs-sm" onClick={() => { sites.reload(); languages.reload(); templates.reload(); }}>
            Retry
          </button>
        </Alert>
      )}

      <section className="cs-card">
        <div className="cs-card-header">
          <h2>Destination</h2>
          {(sites.loading || languages.loading || templates.loading) && (
            <span className="cs-row cs-small cs-muted">
              <span className="cs-spinner" aria-hidden /> Loading from Sitecore…
            </span>
          )}
        </div>
        <div className="cs-card-body cs-grid-3">
          <div className="cs-field">
            <span className="cs-label">Site</span>
            <span id="cs-site-name">{site?.displayName ?? mapping.siteName ?? <span className="cs-muted">None</span>}</span>
            <span className="cs-hint">Chosen on the Upload page.</span>
          </div>
          <div className="cs-field">
            <label htmlFor="cs-lang">Language</label>
            <select id="cs-lang" className="cs-select" value={mapping.language ?? ""} onChange={(e) => dispatch({ type: "set-mapping", patch: { language: e.target.value || undefined } })} disabled={!languages.data}>
              <option value="">Select a language…</option>
              {languageOptions.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name} ({l.code})
                </option>
              ))}
            </select>
          </div>
          <div className="cs-field">
            <label htmlFor="cs-template">Content template</label>
            <select
              id="cs-template"
              className="cs-select"
              value={mapping.templateId ?? ""}
              onChange={(e) => {
                setNotices([]);
                dispatch({ type: "set-mapping", patch: { templateId: e.target.value || undefined } });
              }}
              disabled={!templates.data}
            >
              <option value="">Select a template…</option>
              {templates.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {templates.data && templates.data.length === 0 && <span className="cs-hint">No templates found under the configured template root (see Settings).</span>}
          </div>
          <div className="cs-field">
            <label htmlFor="cs-item-name">Item name</label>
            <input id="cs-item-name" className="cs-input" value={mapping.itemName ?? ""} aria-invalid={!!itemNameError} onChange={(e) => dispatch({ type: "set-mapping", patch: { itemName: e.target.value } })} />
            {itemNameError && <span className="cs-hint" style={{ color: "var(--cs-danger)" }}>{itemNameError}</span>}
          </div>
          <div className="cs-field" style={{ gridColumn: "1 / -1" }}>
            <span className="cs-label">Parent item (destination)</span>
            {!mapping.siteId ? (
              <Alert tone="warning" title="No site selected">
                The site is chosen on the Upload page. Start again from Upload and choose a site to see its content tree.
              </Alert>
            ) : roots.loading ? (
              <span className="cs-row cs-small cs-muted">
                <span className="cs-spinner" aria-hidden /> Loading the content tree…
              </span>
            ) : roots.error ? (
              <Alert tone="error" title="The content tree could not be loaded">
                {roots.error}{" "}
                <button type="button" className="cs-btn cs-sm" onClick={roots.reload}>
                  Retry
                </button>
              </Alert>
            ) : roots.data && roots.data.content.path === CONTENT_ROOT ? (
              // Only the site's own tree is offered; never the whole content tree.
              <Alert tone="error" title="The site's content tree could not be found">
                {roots.data.notes.join(" ") || `The root item of "${mapping.siteName}" could not be found.`} Check that you can read the site in the Content Editor.
              </Alert>
            ) : roots.data ? (
              <ItemTreePicker
                key={roots.data.content.path}
                label="Content tree"
                root={roots.data.content}
                loadChildren={(path) => adapter.getChildren(path)}
                selectedPath={mapping.destinationPath}
                onSelect={onPickDestination}
              />
            ) : null}
            {destVerified ? (
              <span className="cs-hint" style={{ color: "var(--cs-success)" }}>
                Selected in Sitecore: {mapping.destinationVerified?.path}
              </span>
            ) : mapping.destinationPath?.trim() ? (
              <span className="cs-hint">Selected: {mapping.destinationPath}</span>
            ) : roots.data ? (
              <span className="cs-hint">Select the item the new content should be created under.</span>
            ) : null}
          </div>
        </div>
      </section>

      <section className="cs-card">
        <div className="cs-card-header">
          <div>
            <h2>Field mapping</h2>
            {template && <p className="cs-small cs-muted">{template.path ?? template.name}</p>}
            {template?.requiredInfo === "unavailable" && <p className="cs-small" style={{ color: "var(--cs-warning)" }}>Required-field rules could not be read; required fields may not be marked.</p>}
          </div>
          {template && (
            <button type="button" className="cs-btn cs-sm" onClick={() => dispatch({ type: "replace-field-mappings", fields: autoMap(template, workspace, mode) })}>
              <Icon name="sparkle" /> Re-run automatic mapping
            </button>
          )}
        </div>
        {!mapping.templateId ? (
          <EmptyState icon="map" title="Select a template">
            Choose a content template to map the extracted content to its fields.
          </EmptyState>
        ) : templateDetail.loading ? (
          <div className="cs-card-body cs-row cs-muted">
            <span className="cs-spinner" aria-hidden /> Loading template fields…
          </div>
        ) : templateDetail.error ? (
          <div className="cs-card-body">
            <Alert tone="error" title="Template fields could not be loaded">
              {templateDetail.error}{" "}
              <button type="button" className="cs-btn cs-sm" onClick={templateDetail.reload}>
                Retry
              </button>
            </Alert>
          </div>
        ) : !template ? (
          <div className="cs-card-body">
            <Alert tone="warning" title="Template fields are not loaded">
              <button type="button" className="cs-btn cs-sm" onClick={templateDetail.reload}>
                Load fields
              </button>
            </Alert>
          </div>
        ) : template.fields.length === 0 ? (
          <EmptyState icon="map" title="No mappable fields">
            Sitecore returned no fields for “{template.name}”{template.path ? ` (${template.path})` : ""}. Check the template&rsquo;s sections and fields in Sitecore, or choose another template.
          </EmptyState>
        ) : (
          <div className="cs-table-wrap">
            <table className="cs-table">
              <thead>
                <tr>
                  <th scope="col">Sitecore field</th>
                  <th scope="col">Type</th>
                  <th scope="col">Mapped content</th>
                  <th scope="col">Value preview</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {template.fields.map((field) => {
                  const source = mapping.fields[field.name];
                  const value = buildFieldValue(field, source, workspace, mode);
                  const fieldIssues = issues.filter((i) => i.field === field.name);
                  const hasError = fieldIssues.some((i) => i.level === "error");
                  const selectId = `cs-map-${field.name.replace(/\W/g, "-")}`;
                  return (
                    <tr key={field.name}>
                      <td>
                        <strong>{field.name}</strong>
                        {field.required && (
                          <>
                            {" "}
                            <Badge tone="red" title={field.requiredSource === "validation-rule" ? "A Required validation rule is assigned to this field in Sitecore" : "Demo template"}>
                              Required
                            </Badge>
                          </>
                        )}
                        <div className="cs-small cs-muted">
                          {field.section}
                          {field.definedIn && ` · inherited from ${field.definedIn}`}
                        </div>
                        {(field.id || field.rawType) && (
                          <div className="cs-small cs-subtle">
                            {field.rawType && <>Sitecore type: {field.rawType}</>}
                            {field.id && <> · ID {field.id}</>}
                          </div>
                        )}
                      </td>
                      <td>
                        <Badge tone={TYPE_TONE[field.type]} title={field.rawType}>
                          {field.type === "Other" ? field.rawType || "Other" : field.type}
                        </Badge>
                      </td>
                      <td style={{ minWidth: 240 }}>
                        <label className="cs-sr-only" htmlFor={selectId}>
                          Content for {field.name}
                        </label>
                        <select
                          id={selectId}
                          className="cs-select"
                          aria-invalid={hasError}
                          value={encodeSource(source)}
                          onChange={(e) => dispatch({ type: "set-field-mapping", field: field.name, source: decodeSource(e.target.value, source) })}
                        >
                          <option value="none">— Not mapped —</option>
                          <SourceOptions field={field} workspace={workspace} mode={mode} />
                        </select>
                        {source?.kind === "static" && (
                          <input
                            className="cs-input"
                            style={{ marginTop: 6 }}
                            aria-label={`Custom text for ${field.name}`}
                            value={source.value}
                            onChange={(e) => dispatch({ type: "set-field-mapping", field: field.name, source: { kind: "static", value: e.target.value } })}
                          />
                        )}
                      </td>
                      <td>
                        {value.image?.image.src ? (
                          // eslint-disable-next-line @next/next/no-img-element -- extracted image data
                          <img src={value.image.image.src} alt={value.image.asset.altText} style={{ maxWidth: 120, maxHeight: 70, borderRadius: 4 }} />
                        ) : (
                          <div className="cs-value-preview">{value.display || <span className="cs-subtle">—</span>}</div>
                        )}
                      </td>
                      <td>
                        {hasError ? (
                          <Badge tone="red">Error</Badge>
                        ) : fieldIssues.length ? (
                          <Badge tone="amber" title={fieldIssues.map((i) => i.message).join("\n")}>
                            {source && source.kind !== "none" ? "Check" : "Unmapped"}
                          </Badge>
                        ) : (
                          <Badge tone="green">OK</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="cs-card">
        <div className="cs-card-header">
          <h2>Validation</h2>
          <div className="cs-row">
            <Badge tone={errors.length ? "red" : "green"}>{errors.length} errors</Badge>
            <Badge tone={warnings.length ? "amber" : "outline"}>{warnings.length} warnings</Badge>
          </div>
        </div>
        <div className="cs-card-body">
          {issues.length === 0 ? (
            <p className="cs-row" style={{ color: "var(--cs-success)" }}>
              <Icon name="check" /> Everything is mapped and valid.
            </p>
          ) : (
            <ul className="cs-issues">
              {[...errors, ...warnings].map((issue, i) => (
                <li key={i} style={{ color: issue.level === "error" ? "var(--cs-danger)" : "var(--cs-warning)" }}>
                  <Icon name="alert" size={14} />
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <div className="cs-step-footer">
        <button type="button" className="cs-btn" onClick={onBack}>
          <Icon name="arrowLeft" /> Images
        </button>
        <span className="cs-row">
          {errors.length > 0 && <span className="cs-small cs-muted">Resolve {errors.length === 1 ? "the error" : `the ${errors.length} errors`} above to continue.</span>}
          <button type="button" className="cs-btn cs-primary" onClick={onNext} disabled={errors.length > 0}>
            Preview <Icon name="arrowRight" />
          </button>
        </span>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { createSampleExtraction } from "@/src/fixtures/sample-extraction";
import { DEFAULT_MAX_UPLOAD_MB } from "@/src/lib/extraction/limits";
import { apiAuthHeaders } from "@/src/lib/security/client-auth";
import type { ExtractionErrorBody, ExtractionResult } from "@/src/lib/types/extraction";
import { checkFileBasics, formatBytes } from "@/src/lib/validation/file";
import { siteSelectionPatch } from "@/src/lib/mapping";
import { useApiAuth } from "../state/ApiAuth";
import { useIntegration } from "../state/IntegrationProvider";
import { useStudio } from "../state/StudioProvider";
import { useAsyncData } from "../state/useAsyncData";
import { useServerCapabilities } from "../state/useServerCapabilities";
import { Alert, Badge, FileTypeIcon, Icon } from "../ui";

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; progress: number }
  | { kind: "processing"; label: string }
  | { kind: "error"; title: string; message: string };

function readError(status: number, body: unknown): string {
  const message = (body as ExtractionErrorBody | null)?.error?.message;
  return message ?? `The extraction service returned HTTP ${status}.`;
}

export function UploadStep({ onDone }: { onDone: () => void }) {
  const { start, workspace } = useStudio();
  const { data: caps, error: capsError } = useServerCapabilities();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const { adapter, connecting } = useIntegration();
  const sites = useAsyncData(connecting ? null : `sites:${adapter.status.mode}`, () => adapter.listSites());
  const [siteId, setSiteId] = useState("");
  const auth = useApiAuth();
  const [signInError, setSignInError] = useState<string | null>(null);
  const signIn = async () => {
    setSignInError(null);
    try {
      await auth.signIn();
    } catch (error) {
      setSignInError(error instanceof Error && /popup/i.test(error.message) ? "The sign-in window was blocked or closed. Allow pop-ups for Sitecore and try again." : error instanceof Error ? error.message : String(error));
    }
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const maxBytes = caps?.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_MB * 1024 * 1024;
  const busy = phase.kind === "uploading" || phase.kind === "processing";
  // The server requires a signed-in Sitecore user (auth0 mode); the bundled sample does not use the server.
  const needsSignIn = caps?.authMode === "auth0" && !auth.isAuthenticated;
  const serverBlocked = caps?.authMode === "misconfigured" || needsSignIn;

  useEffect(() => () => {
    xhrRef.current?.abort();
    abortRef.current?.abort();
  }, []);

  const pick = (f: File | undefined | null) => {
    if (!f) return;
    const check = checkFileBasics(f.name, f.size, maxBytes);
    setFile(f);
    setFileError(check.ok ? null : check.message);
    setPhase({ kind: "idle" });
  };

  // The Sitecore site is chosen once, here; later steps only show that site's media and content.
  const site = sites.data?.find((s) => s.id === siteId);
  const noSite = !site;

  const finish = (result: ExtractionResult) => {
    if (!site) return;
    start(result, siteSelectionPatch({ fields: {} }, site.id, sites.data));
    onDone();
  };

  const extractFile = async () => {
    if (!file || fileError) return;
    const authHeaders = await apiAuthHeaders();
    const form = new FormData();
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", "/api/extract");
    xhr.responseType = "json";
    for (const [key, value] of Object.entries(authHeaders)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setPhase({ kind: "uploading", progress: Math.round((e.loaded / e.total) * 100) });
    };
    xhr.upload.onload = () => setPhase({ kind: "processing", label: "Extracting text, structure and images…" });
    xhr.onload = () => {
      xhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
        finish(xhr.response as ExtractionResult);
      } else {
        setPhase({ kind: "error", title: "The document could not be processed", message: readError(xhr.status, xhr.response) });
      }
    };
    xhr.onerror = () => {
      xhrRef.current = null;
      setPhase({ kind: "error", title: "Upload failed", message: "The file could not be sent to the extraction service. Check your connection and try again." });
    };
    xhr.onabort = () => {
      xhrRef.current = null;
      setPhase({ kind: "idle" });
    };
    setPhase({ kind: "uploading", progress: 0 });
    xhr.send(form);
  };

  const extractUrl = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: "processing", label: "Fetching and extracting the publication…" });
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await apiAuthHeaders()) },
        body: JSON.stringify({ url: url.trim() }),
        signal: controller.signal,
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setPhase({ kind: "error", title: "The publication could not be imported", message: readError(res.status, body) });
        return;
      }
      finish(body as ExtractionResult);
    } catch (err) {
      if (controller.signal.aborted) {
        setPhase({ kind: "idle" });
        return;
      }
      setPhase({ kind: "error", title: "The publication could not be imported", message: err instanceof Error ? err.message : String(err) });
    } finally {
      abortRef.current = null;
    }
  };

  const cancel = () => {
    xhrRef.current?.abort();
    abortRef.current?.abort();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    if (e.dataTransfer.files.length > 1) {
      setFile(null);
      setFileError("Drop one document at a time.");
      return;
    }
    pick(e.dataTransfer.files[0]);
  };

  const ext = file?.name.toLowerCase().endsWith(".docx") ? "docx" : "pdf";

  return (
    <div className="cs-stack-lg">
      {workspace && (
        <Alert tone="info">
          A new extraction opens a new workspace. Your current document (“{workspace.extraction.metadata.fileName}”) stays available in Recent Documents for this session.
        </Alert>
      )}
      {capsError && <Alert tone="error" title="Extraction service unavailable">The server-side extraction API could not be reached ({capsError}). Uploads will not work until it is available. You can still try the sample.</Alert>}
      {caps?.authMode === "auth0" &&
        (auth.isAuthenticated ? (
          <p className="cs-small cs-muted">
            Signed in{auth.userName ? ` as ${auth.userName}` : ""} for document processing.{" "}
            <button type="button" className="cs-btn cs-ghost cs-sm" onClick={auth.signOut}>
              Sign out
            </button>
          </p>
        ) : auth.available ? (
          <Alert tone="info" title="Sign in to process documents">
            Document upload and URL import need your Sitecore sign-in. It opens in a small window.{" "}
            <button type="button" className="cs-btn cs-primary cs-sm" onClick={signIn} disabled={auth.isLoading}>
              {auth.isLoading ? <span className="cs-spinner" aria-hidden /> : null} Sign in with Sitecore
            </button>
            {(signInError ?? auth.error) && <span style={{ display: "block", marginTop: 6, color: "var(--cs-danger)" }}>{signInError ?? auth.error}</span>}
            {(signInError ?? auth.error) && auth.diagnostics && <span className="cs-small cs-muted" style={{ display: "block", marginTop: 4, wordBreak: "break-all" }}>Sent: {auth.diagnostics}</span>}
          </Alert>
        ) : (
          <Alert tone="warning" title="Sign-in is not available here">
            {connecting
              ? "Connecting to Sitecore…"
              : "Document processing requires a Sitecore sign-in. Open Content Studio from Sitecore; if it is already open there, the app's client ID (NEXT_PUBLIC_CONTENT_STUDIO_AUTH0_CLIENT_ID) is not configured on the server."}{" "}
            You can still try the sample.
          </Alert>
        ))}
      {caps?.authMode === "misconfigured" && (
        <Alert tone="error" title="Document processing is disabled">
          The server has no authentication configured, so it refuses to process documents. An administrator must configure CONTENT_STUDIO_AUTH_MODE (see README). You can still try the sample.
        </Alert>
      )}
      {caps?.authMode === "none" && (
        <Alert tone="warning" title="Unauthenticated test mode">
          The extraction service does not verify who is calling. Use only synthetic or public test documents, never confidential content.
        </Alert>
      )}

      <section className="cs-card" aria-labelledby="cs-site-title">
        <div className="cs-card-header">
          <div>
            <h2 id="cs-site-title">1. Choose the Sitecore site</h2>
            <p className="cs-muted cs-small">The content is created in this site. Later steps show only its media folder and content tree.</p>
          </div>
          {(connecting || sites.loading) && (
            <span className="cs-row cs-small cs-muted">
              <span className="cs-spinner" aria-hidden /> Loading sites…
            </span>
          )}
        </div>
        <div className="cs-card-body cs-stack">
          <div className="cs-field" style={{ maxWidth: 420 }}>
            <label htmlFor="cs-upload-site">Site</label>
            <select id="cs-upload-site" className="cs-select" value={site ? siteId : ""} onChange={(e) => setSiteId(e.target.value)} disabled={!sites.data || busy}>
              <option value="">Select a site…</option>
              {sites.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </select>
            {sites.data && sites.data.length === 0 && <span className="cs-hint">No sites are available to your account.</span>}
          </div>
          {sites.error && (
            <Alert tone="error" title="Sites could not be loaded">
              {sites.error}{" "}
              <button type="button" className="cs-btn cs-sm" onClick={sites.reload}>
                Retry
              </button>
            </Alert>
          )}
        </div>
      </section>

      <section className="cs-card" aria-labelledby="cs-upload-title">
        <div className="cs-card-header">
          <div>
            <h2 id="cs-upload-title">2. Upload a document</h2>
            <p className="cs-muted cs-small">PDF or Word (.docx), up to {formatBytes(maxBytes)}. Text-based PDFs only — scanned documents need OCR, which is not configured.</p>
          </div>
        </div>
        <div className="cs-card-body cs-stack">
          <div
            className="cs-dropzone"
            data-dragging={dragging}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <div className="cs-empty-icon">
              <Icon name="upload" size={22} />
            </div>
            <strong>Drag and drop a PDF or DOCX here</strong>
            <span className="cs-muted cs-small">or</span>
            <button type="button" className="cs-btn" onClick={() => inputRef.current?.click()} disabled={busy}>
              Choose file
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="cs-sr-only"
              aria-label="Choose a PDF or DOCX file"
              tabIndex={-1}
              onChange={(e) => {
                pick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>

          {file && (
            <div className="cs-file-row">
              <FileTypeIcon type={ext} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</strong>
                <span className="cs-small cs-muted">
                  {formatBytes(file.size)} · {file.type || "unknown type"}
                </span>
              </div>
              {fileError ? <Badge tone="red">Not supported</Badge> : <Badge tone="purple">Ready</Badge>}
              <button type="button" className="cs-btn cs-ghost cs-sm" onClick={() => { setFile(null); setFileError(null); }} disabled={busy} aria-label="Remove selected file">
                <Icon name="x" />
              </button>
            </div>
          )}
          {fileError && <Alert tone="error">{fileError}</Alert>}

          {phase.kind === "uploading" && (
            <div className="cs-stack" style={{ gap: 6 }} role="status">
              <div className="cs-row-between cs-small">
                <span>Uploading…</span>
                <span>{phase.progress}%</span>
              </div>
              <div className="cs-progress" aria-hidden>
                <div style={{ width: `${phase.progress}%` }} />
              </div>
            </div>
          )}
          {phase.kind === "processing" && (
            <div className="cs-stack" style={{ gap: 6 }} role="status">
              <span className="cs-small">{phase.label}</span>
              <div className="cs-progress cs-indeterminate" aria-hidden>
                <div />
              </div>
            </div>
          )}
          {phase.kind === "error" && <Alert tone="error" title={phase.title}>{phase.message}</Alert>}

          <div className="cs-row">
            <button type="button" className="cs-btn cs-primary" onClick={extractFile} disabled={noSite || !file || !!fileError || busy || !!capsError || serverBlocked}>
              {busy ? <span className="cs-spinner" aria-hidden /> : <Icon name="sparkle" />}
              Extract content
            </button>
            {noSite && <span className="cs-small cs-muted">Choose a site first.</span>}
            {busy && (
              <button type="button" className="cs-btn" onClick={cancel}>
                Cancel
              </button>
            )}
          </div>
        </div>
      </section>

      <div className="cs-grid-2">
        <section className="cs-card" aria-labelledby="cs-url-title">
          <div className="cs-card-body cs-stack">
            <div className="cs-section-title">
              <Icon name="globe" />
              <h2 id="cs-url-title">Import a publication URL</h2>
            </div>
            {caps && !caps.urlImportEnabled ? (
              <p className="cs-muted">URL import is disabled on this installation (CONTENT_STUDIO_ENABLE_URL_IMPORT=false).</p>
            ) : (
              <form className="cs-stack" onSubmit={extractUrl}>
                <div className="cs-field">
                  <label htmlFor="cs-url">Public article or press release URL</label>
                  <input id="cs-url" className="cs-input" type="url" placeholder="https://example.com/news/press-release" value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy || !caps} />
                  <span className="cs-hint">Static HTML pages and PDFs only. Pages that need JavaScript or a login are not supported.</span>
                </div>
                <div>
                  <button type="submit" className="cs-btn" disabled={noSite || !url.trim() || busy || !caps || serverBlocked}>
                    Import URL
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>

        <section className="cs-card" aria-labelledby="cs-sample-title">
          <div className="cs-card-body cs-stack">
            <div className="cs-section-title">
              <Icon name="file" />
              <h2 id="cs-sample-title">Try the sample</h2>
              <Badge tone="amber">Demo data</Badge>
            </div>
            <p className="cs-muted">Explore the full workflow with a bundled, fictional press release. Sample content is labelled as such throughout and is never treated as uploaded content.</p>
            <div>
              <button type="button" className="cs-btn" onClick={() => finish(createSampleExtraction())} disabled={noSite || busy}>
                Open sample document
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

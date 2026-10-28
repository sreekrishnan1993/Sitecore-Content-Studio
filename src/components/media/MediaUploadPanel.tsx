"use client";

import { useRef, useState } from "react";
import { siteLanguages } from "@/src/lib/mapping";
import { CONTENT_ROOT, isPathWithin, siteMediaFolderPath } from "@/src/lib/sitecore/graphql";
import { describeTarget, sandboxWriteGuard } from "@/src/lib/sitecore/environment";
import { mediaLibraryRelativePath } from "@/src/lib/sitecore/live-adapter";
import type { SitecoreTreeItem } from "@/src/lib/types/sitecore";
import { checkMediaImage } from "@/src/lib/validation/file";
import { ItemTreePicker } from "../mapping/ItemTreePicker";
import { useIntegration } from "../state/IntegrationProvider";
import { useWorkspace } from "../state/StudioProvider";
import { useAsyncData } from "../state/useAsyncData";
import { useServerCapabilities } from "../state/useServerCapabilities";
import { Alert, Badge } from "../ui";

/** Media items (images, files) have no children and are not folders; the folder tree leaves them out. */
function isMediaFile(item: SitecoreTreeItem): boolean {
  return item.hasChildren === false && !/folder/i.test(item.templateName ?? "");
}

/**
 * Experimental: uploads selected images through the Agent API ("xmc.agent.assetsUploadAsset"),
 * proxied by the Sitecore host with the user's credentials. Only shown in live mode when the
 * author has enabled it in Settings. An image is marked uploaded only when Sitecore returns a
 * confirmed media item ID.
 */
export function MediaUploadPanel() {
  const { workspace, dispatch } = useWorkspace();
  const { adapter, appContext } = useIntegration();
  const { data: caps } = useServerCapabilities();
  const target = describeTarget(appContext);
  // Only rendered in live mode, so the sandbox guard always applies.
  const guard = sandboxWriteGuard(target, caps);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const lock = useRef(false);
  const mode = adapter.status.mode;
  const sites = useAsyncData(`sites:${mode}`, () => adapter.listSites());
  const languages = useAsyncData(`languages:${mode}`, () => adapter.listLanguages());
  const site = sites.data?.find((s) => s.id === workspace.mapping.siteId);
  const roots = useAsyncData(site ? `tree-roots:${mode}:${site.id}` : null, () => adapter.getTreeRoots(site));
  const siteMedia = roots.data?.mediaFolder;
  const siteMediaPath = roots.data && roots.data.content.path !== CONTENT_ROOT ? siteMediaFolderPath(roots.data.content.path) : null;
  // Only folders inside the site's media folder can be used: the chosen one, or the site folder itself.
  const chosen = workspace.mapping.mediaFolder;
  const folder = siteMedia ? (chosen && isPathWithin(chosen, siteMedia.path) ? chosen : siteMedia.path) : "";

  const candidates = workspace.extraction.images.filter((img) => {
    const asset = workspace.images.find((a) => a.id === img.id);
    return asset?.selected && img.origin === "extracted" && img.src.startsWith("data:") && !checkMediaImage(img.mimeType, img.byteSize) && !asset.mediaUpload;
  });
  const linkedOnly = workspace.extraction.images.filter((img) => img.origin === "referenced" && workspace.images.find((a) => a.id === img.id)?.selected).length;
  const folderValid = mediaLibraryRelativePath(folder) !== null;
  const missing = [!workspace.mapping.siteKey && "a site (on the Upload page)", !workspace.mapping.language && "a language"].filter(Boolean);

  const upload = async () => {
    if (lock.current || !guard.allowed || !workspace.mapping.siteKey || !workspace.mapping.language) return;
    lock.current = true;
    setRunning(true);
    setConfirming(false);
    try {
      for (const img of candidates) {
        const asset = workspace.images.find((a) => a.id === img.id);
        if (!asset) continue;
        const extension = img.mimeType.split("/")[1].replace("jpeg", "jpg");
        const name = img.fileName.replace(/\.[^.]+$/, "").replace(/[^\w\s-]/g, " ").trim() || "image";
        // Mark as pending first so a reload during the upload cannot trigger a duplicate upload.
        dispatch({ type: "update-image", id: img.id, patch: { mediaUpload: { state: "uncertain", message: "Upload in progress or interrupted.", at: new Date().toISOString() } } });
        let blob: Blob;
        try {
          blob = await (await fetch(img.src)).blob();
        } catch {
          dispatch({ type: "update-image", id: img.id, patch: { mediaUpload: { state: "failed", message: "The image data could not be read.", at: new Date().toISOString() } } });
          continue;
        }
        const result = await adapter.uploadMedia({ file: blob, name, extension, mimeType: img.mimeType, imageId: img.id, folderPath: folder.trim(), language: workspace.mapping.language, siteName: workspace.mapping.siteKey });
        const at = new Date().toISOString();
        dispatch({
          type: "update-image",
          id: img.id,
          patch: {
            mediaUpload: result.ok
              ? { state: "uploaded", mediaItemId: result.mediaItemId, mediaPath: result.mediaPath, embedUrl: result.embedUrl, message: result.warnings?.join(" ") || undefined, at, diagnostics: result.diagnostics }
              : { state: result.reason === "uncertain" ? "uncertain" : "failed", message: result.message, at, diagnostics: result.diagnostics },
          },
        });
      }
    } finally {
      lock.current = false;
      setRunning(false);
    }
  };

  const uploaded = workspace.images.filter((a) => a.mediaUpload);

  return (
    <div className="cs-stack">
      <Alert tone="warning" title="Experimental media upload">
        Uses the Sitecore Agent API through the Marketplace host. An image counts as uploaded only when Sitecore returns a media item ID and that item is found. After uploading, choose the image for an Image field in Template mapping. Confirm results in the Media Library.
      </Alert>
      <div className="cs-grid-2">
        <div className="cs-field">
          <span className="cs-label">Site</span>
          <span>{workspace.mapping.siteName ?? <span className="cs-muted">None — chosen on the Upload page</span>}</span>
        </div>
        <div className="cs-field">
          <label htmlFor="cs-media-lang">Language</label>
          <select id="cs-media-lang" className="cs-select" value={workspace.mapping.language ?? ""} disabled={!languages.data} onChange={(e) => dispatch({ type: "set-mapping", patch: { language: e.target.value || undefined } })}>
            <option value="">Select a language…</option>
            {siteLanguages(languages.data, site).map((l) => (
              <option key={l.code} value={l.code}>
                {l.name} ({l.code})
              </option>
            ))}
          </select>
        </div>
      </div>
      <span className="cs-hint">The language is also used in Template mapping.</span>
      <div className="cs-field">
        <span className="cs-label">Site media folder</span>
        {!workspace.mapping.siteId ? (
          <span className="cs-hint">No site was chosen for this document. Start again from the Upload page and choose a site.</span>
        ) : roots.loading || sites.loading ? (
          <span className="cs-row cs-small cs-muted">
            <span className="cs-spinner" aria-hidden /> Loading the Media Library…
          </span>
        ) : roots.error || sites.error ? (
          <Alert tone="error" title="The Media Library could not be loaded">
            {roots.error ?? sites.error}{" "}
            <button type="button" className="cs-btn cs-sm" onClick={() => (sites.error ? sites.reload() : roots.reload())}>
              Retry
            </button>
          </Alert>
        ) : roots.data && !siteMedia ? (
          <Alert tone="warning" title="This site has no media folder">
            {siteMediaPath
              ? `Content Studio uploads only into the site's own media folder, ${siteMediaPath}, and it does not exist or you cannot read it. Create it in the Media Library, then reload.`
              : "The site's root item could not be found, so its media folder cannot be determined."}
          </Alert>
        ) : roots.data && siteMedia ? (
          <ItemTreePicker
            key={siteMedia.path}
            label="Site media folders"
            root={siteMedia}
            loadChildren={(path) => adapter.getChildren(path)}
            selectedPath={folder}
            onSelect={(item) => dispatch({ type: "set-mapping", patch: { mediaFolder: item.path } })}
            hide={isMediaFile}
          />
        ) : null}
        {folder && <span className="cs-hint">Selected: {folder}</span>}
      </div>
      {missing.length > 0 && <p className="cs-small cs-muted">Select {missing.join(" and ")} before uploading.</p>}
      {candidates.length === 0 && !running && (
        <p className="cs-small cs-muted">
          {linkedOnly > 0
            ? `${linkedOnly} selected image(s) are only linked from the web page, not downloaded, so they cannot be uploaded. Download them from the page and add them in the Media Library.`
            : "No selected images are waiting to be uploaded. Select images above; images already uploaded, or in an unsupported format or size, are not uploaded again."}
        </p>
      )}
      {guard.message && <Alert tone={guard.allowed ? "warning" : "error"}>{guard.message}</Alert>}
      {confirming ? (
        <Alert tone="warning" title={`Upload ${candidates.length} image(s) to ${folder}?`}>
          <p>
            This creates media items in <strong>{target?.label ?? "the connected environment"}</strong>{guard.sandbox ? " (sandbox)" : ""} for site “{workspace.mapping.siteName}” in “
            {workspace.mapping.language}”. Nothing is published.
          </p>
          <div className="cs-row" style={{ marginTop: 8 }}>
            <button type="button" className="cs-btn cs-primary cs-sm" onClick={upload}>
              Upload
            </button>
            <button type="button" className="cs-btn cs-sm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </Alert>
      ) : (
        <div>
          <button type="button" className="cs-btn cs-primary" onClick={() => setConfirming(true)} disabled={running || candidates.length === 0 || !folderValid || missing.length > 0 || !guard.allowed}>
            {running ? <span className="cs-spinner" aria-hidden /> : null} Upload {candidates.length} selected image(s)
          </button>
        </div>
      )}
      {uploaded.length > 0 && (
        <ul className="cs-issues cs-small">
          {uploaded.map((a) => {
            const img = workspace.extraction.images.find((i) => i.id === a.id);
            const state = a.mediaUpload!;
            return (
              <li key={a.id} style={{ justifyContent: "space-between" }}>
                <span>
                  {img?.fileName}: {state.state === "uploaded" ? `${state.mediaPath ?? "media item"} (${state.mediaItemId})` : state.message}
                  {state.state === "uploaded" && state.message && <span className="cs-hint" style={{ display: "block" }}>{state.message}</span>}
                  {state.diagnostics && (
                    <details>
                      <summary>Technical details (no image data)</summary>
                      <pre className="cs-code">{JSON.stringify(state.diagnostics, null, 2)}</pre>
                    </details>
                  )}
                </span>
                <span className="cs-row">
                  <Badge tone={state.state === "uploaded" ? "green" : state.state === "uncertain" ? "amber" : "red"}>
                    {state.state === "uploaded" ? "Uploaded" : state.state === "uncertain" ? "Outcome unknown" : "Failed"}
                  </Badge>
                  {state.state !== "uploaded" && (
                    <button
                      type="button"
                      className="cs-btn cs-ghost cs-sm"
                      title={state.state === "uncertain" ? "Only after checking the Media Library: the upload may have succeeded." : undefined}
                      onClick={() => dispatch({ type: "update-image", id: a.id, patch: { mediaUpload: undefined } })}
                    >
                      {state.state === "uncertain" ? "I checked — allow retry" : "Allow retry"}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

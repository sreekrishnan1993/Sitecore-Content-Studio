"use client";

import { useState } from "react";
import type { ExtractedImage } from "@/src/lib/types/extraction";
import type { ImageAsset } from "@/src/lib/types/workspace";
import { checkMediaImage, formatBytes } from "@/src/lib/validation/file";
import { useIntegration } from "../state/IntegrationProvider";
import { useWorkspace } from "../state/StudioProvider";
import { Alert, Badge, EmptyState, Icon } from "../ui";
import { MediaUploadPanel } from "./MediaUploadPanel";

export function imageIssues(image: ExtractedImage, asset: ImageAsset): string[] {
  const issues: string[] = [];
  if (image.origin === "extracted") {
    const problem = checkMediaImage(image.mimeType, image.byteSize);
    if (problem) issues.push(problem);
  }
  if (asset.selected && !asset.altText.trim()) issues.push("Alt text is required for accessibility.");
  if (asset.altText.length > 250) issues.push("Alt text should be shorter than 250 characters.");
  return issues;
}

function Lightbox({ image, asset, onClose }: { image: ExtractedImage; asset: ImageAsset; onClose: () => void }) {
  return (
    <div className="cs-lightbox" role="dialog" aria-modal="true" aria-label={`Preview of ${image.fileName}`} onClick={onClose} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="cs-lightbox-inner" onClick={(e) => e.stopPropagation()}>
        <div className="cs-row-between">
          <strong>{image.fileName}</strong>
          <button type="button" className="cs-btn cs-sm" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element -- extracted image data */}
        <img src={image.src} alt={asset.altText} />
        <span className="cs-small cs-muted">
          {image.width && image.height ? `${image.width}×${image.height}px` : "Dimensions unknown"}
          {image.page !== undefined && ` · page ${image.page}`}
          {image.byteSize > 0 && ` · ${formatBytes(image.byteSize)}`}
        </span>
      </div>
    </div>
  );
}

export function MediaStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { workspace, dispatch } = useWorkspace();
  const { adapter } = useIntegration();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const images = workspace.extraction.images;
  const assets = new Map(workspace.images.map((a) => [a.id, a]));
  const selected = workspace.images.filter((a) => a.selected).length;
  const preview = previewId ? images.find((i) => i.id === previewId) : undefined;
  const previewAsset = previewId ? assets.get(previewId) : undefined;
  const selectedWithIssues = images.filter((img) => {
    const a = assets.get(img.id);
    return a?.selected && imageIssues(img, a).length > 0;
  }).length;

  return (
    <div className="cs-stack-lg">
      <section className="cs-card">
        <div className="cs-card-header">
          <div>
            <h2>Extracted images</h2>
            <p className="cs-small cs-muted">Images embedded in the source document. Generated suggestions are kept separately below.</p>
          </div>
          <div className="cs-row">
            <Badge tone="purple">
              {selected} of {images.length} selected
            </Badge>
            {selectedWithIssues > 0 && <Badge tone="amber">{selectedWithIssues} need attention</Badge>}
          </div>
        </div>
        <div className="cs-card-body">
          {images.length === 0 ? (
            <EmptyState icon="image" title="No images were extracted">
              This document has no usable embedded images. You can still create content without images.
            </EmptyState>
          ) : (
            <div className="cs-gallery">
              {images.map((img) => {
                const asset = assets.get(img.id);
                if (!asset) return null;
                const issues = imageIssues(img, asset);
                const altId = `cs-alt-${img.id}`;
                return (
                  <div key={img.id} className="cs-thumb" data-selected={asset.selected}>
                    <button type="button" className="cs-thumb-img" onClick={() => setPreviewId(img.id)} disabled={!img.src} aria-label={`Preview ${img.fileName}`}>
                      {img.src ? (
                        // eslint-disable-next-line @next/next/no-img-element -- extracted image data
                        <img src={img.src} alt="" />
                      ) : (
                        <span className="cs-small cs-muted">Image data not kept in this session</span>
                      )}
                    </button>
                    <div className="cs-thumb-body">
                      <label className="cs-row" style={{ flexWrap: "nowrap" }}>
                        <input type="checkbox" className="cs-checkbox" checked={asset.selected} onChange={(e) => dispatch({ type: "update-image", id: img.id, patch: { selected: e.target.checked } })} />
                        <strong className="cs-small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={img.fileName}>
                          {img.fileName}
                        </strong>
                      </label>
                      <div className="cs-row cs-small cs-muted">
                        <Badge tone={img.origin === "extracted" ? "green" : "blue"}>{img.origin === "extracted" ? "From document" : "Referenced URL"}</Badge>
                        {img.page !== undefined && <span>Page {img.page}</span>}
                        <span>{img.width && img.height ? `${img.width}×${img.height}` : "Size unknown"}</span>
                        {img.byteSize > 0 && <span>{formatBytes(img.byteSize)}</span>}
                      </div>
                      <div className="cs-field">
                        <label htmlFor={altId}>Alt text</label>
                        <input id={altId} className="cs-input" value={asset.altText} aria-invalid={asset.selected && !asset.altText.trim()} onChange={(e) => dispatch({ type: "update-image", id: img.id, patch: { altText: e.target.value } })} placeholder="Describe the image" />
                        {img.sourceAltText && asset.altText !== img.sourceAltText && <span className="cs-hint">Source alt text: “{img.sourceAltText}”</span>}
                      </div>
                      <div className="cs-field">
                        <label htmlFor={`cs-cap-${img.id}`}>Caption</label>
                        <textarea id={`cs-cap-${img.id}`} className="cs-textarea" style={{ minHeight: 52 }} value={asset.caption} onChange={(e) => dispatch({ type: "update-image", id: img.id, patch: { caption: e.target.value } })} />
                      </div>
                      {issues.length > 0 && (
                        <ul className="cs-issues cs-small" style={{ color: "var(--cs-warning)" }}>
                          {issues.map((i) => (
                            <li key={i}>
                              <Icon name="alert" size={14} /> {i}
                            </li>
                          ))}
                        </ul>
                      )}
                      {img.src.startsWith("data:") && (
                        <a className="cs-btn cs-sm" href={img.src} download={img.fileName}>
                          Download original
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="cs-card">
        <div className="cs-card-header">
          <h2>Upload destination</h2>
        </div>
        <div className="cs-card-body cs-stack">
          {adapter.status.canUploadMedia ? (
            <MediaUploadPanel />
          ) : (
            <Alert tone="info" title="Media upload is not connected">
              {adapter.status.mode === "demo"
                ? "In demo mode no files are uploaded. Selected images, alt text and captions are used in the preview only."
                : "Uploading to the Sitecore Media Library is off. The documented GraphQL uploadMedia flow needs the user's access token, which the Marketplace client SDK does not expose. An experimental upload through the Agent API can be enabled in Settings for sandbox testing. Otherwise, download images and upload them in the Media Library."}
            </Alert>
          )}
        </div>
      </section>

      <section className="cs-card">
        <div className="cs-card-header">
          <h2>Generated image suggestions</h2>
          <Badge tone="outline">Not configured</Badge>
        </div>
        <div className="cs-card-body">
          <p className="cs-muted cs-small">No image-generation provider is configured. Suggestions would appear here, clearly separated from images extracted from the document.</p>
        </div>
      </section>

      <div className="cs-step-footer">
        <button type="button" className="cs-btn" onClick={onBack}>
          <Icon name="arrowLeft" /> Whiteboard
        </button>
        <button type="button" className="cs-btn cs-primary" onClick={onNext}>
          Template mapping <Icon name="arrowRight" />
        </button>
      </div>

      {preview && previewAsset && preview.src && <Lightbox image={preview} asset={previewAsset} onClose={() => setPreviewId(null)} />}
    </div>
  );
}

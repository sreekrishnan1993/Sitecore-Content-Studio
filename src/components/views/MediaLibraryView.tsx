"use client";

import type { Navigate } from "../shell/ContentStudioApp";
import { useIntegration } from "../state/IntegrationProvider";
import { useStudio } from "../state/StudioProvider";
import { Alert, Badge, EmptyState } from "../ui";

export function MediaLibraryView({ navigate }: { navigate: Navigate }) {
  const { recent, open } = useStudio();
  const { adapter } = useIntegration();
  const docs = recent.filter((ws) => ws.extraction.images.length > 0);

  return (
    <>
      <Alert tone="info" title="Session media">
        Images extracted from documents in this session. {adapter.status.canUploadMedia ? "" : "Uploading to the Sitecore Media Library or a DAM is not connected in this version; download originals from the Images step to upload them manually."}
      </Alert>
      {docs.length === 0 ? (
        <section className="cs-card">
          <EmptyState icon="image" title="No images yet" action={<button type="button" className="cs-btn cs-primary" onClick={() => navigate({ view: "create", step: "upload" })}>Upload a document</button>}>
            Images embedded in uploaded documents appear here.
          </EmptyState>
        </section>
      ) : (
        docs.map((ws) => (
          <section key={ws.id} className="cs-card">
            <div className="cs-card-header">
              <div className="cs-row">
                <h2>{ws.extraction.metadata.fileName}</h2>
                {ws.extraction.isSample && <Badge tone="amber">Sample</Badge>}
              </div>
              <button type="button" className="cs-btn cs-sm" onClick={() => open(ws.id) && navigate({ view: "create", step: "media" })}>
                Edit images
              </button>
            </div>
            <div className="cs-card-body cs-gallery">
              {ws.extraction.images.map((img) => {
                const asset = ws.images.find((a) => a.id === img.id);
                return (
                  <figure key={img.id} className="cs-thumb" data-selected={asset?.selected} style={{ margin: 0 }}>
                    <div className="cs-thumb-img" style={{ cursor: "default" }}>
                      {img.src ? (
                        // eslint-disable-next-line @next/next/no-img-element -- extracted image data
                        <img src={img.src} alt={asset?.altText ?? ""} />
                      ) : (
                        <span className="cs-small cs-muted">Image data not kept in this session</span>
                      )}
                    </div>
                    <figcaption className="cs-thumb-body cs-small">
                      <strong>{img.fileName}</strong>
                      <span className="cs-muted">
                        {asset?.selected ? "Selected" : "Not selected"} · {asset?.altText ? "Alt text set" : "No alt text"}
                      </span>
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          </section>
        ))
      )}
    </>
  );
}

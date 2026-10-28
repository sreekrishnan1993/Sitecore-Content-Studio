"use client";

import { formatBytes } from "@/src/lib/validation/file";
import type { Navigate } from "../shell/ContentStudioApp";
import { useStudio } from "../state/StudioProvider";
import { Badge, EmptyState, FileTypeIcon } from "../ui";

export function RecentList({ navigate, limit }: { navigate: Navigate; limit?: number }) {
  const { recent, open, remove, workspace } = useStudio();
  const items = limit ? recent.slice(0, limit) : recent;

  if (items.length === 0) {
    return (
      <EmptyState icon="clock" title="No documents in this session" action={<button type="button" className="cs-btn cs-primary" onClick={() => navigate({ view: "create", step: "upload" })}>Upload a document</button>}>
        Documents you extract are kept in this browser tab until it is closed.
      </EmptyState>
    );
  }

  return (
    <div>
      {items.map((ws) => (
        <div key={ws.id} className="cs-list-row">
          <FileTypeIcon type={ws.extraction.metadata.fileType} />
          <div className="cs-list-row-main">
            <strong title={ws.extraction.metadata.fileName}>{ws.extraction.metadata.fileName}</strong>
            <span className="cs-small cs-muted">
              {formatBytes(ws.extraction.metadata.fileSize)} · {ws.cards.length} cards ({ws.cards.filter((c) => c.selected).length} selected) · {ws.extraction.images.length} images · updated {new Date(ws.updatedAt).toLocaleTimeString()}
            </span>
          </div>
          <div className="cs-row">
            {ws.extraction.isSample && <Badge tone="amber">Sample</Badge>}
            {ws.createdItem ? <Badge tone="green">Created in Sitecore</Badge> : ws.draftSavedAt ? <Badge tone="blue">Draft saved</Badge> : <Badge tone="outline">In progress</Badge>}
            {workspace?.id === ws.id && <Badge tone="purple">Open</Badge>}
            <button
              type="button"
              className="cs-btn cs-sm"
              onClick={() => {
                if (open(ws.id)) navigate({ view: "create", step: "board" });
              }}
            >
              Open
            </button>
            <button type="button" className="cs-btn cs-ghost cs-sm cs-danger" onClick={() => remove(ws.id)} aria-label={`Remove ${ws.extraction.metadata.fileName} from this session`}>
              Remove
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function RecentView({ navigate }: { navigate: Navigate }) {
  const { recent, clearAll } = useStudio();
  return (
    <section className="cs-card">
      <div className="cs-card-header">
        <div>
          <h2>Documents in this session</h2>
          <p className="cs-small cs-muted">Stored in this browser tab only (session storage). Up to 8 documents are kept.</p>
        </div>
        {recent.length > 0 && (
          <button type="button" className="cs-btn cs-sm cs-danger" onClick={clearAll}>
            Clear all
          </button>
        )}
      </div>
      <RecentList navigate={navigate} />
    </section>
  );
}

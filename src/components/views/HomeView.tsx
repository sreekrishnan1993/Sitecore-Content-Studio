"use client";

import type { Navigate } from "../shell/ContentStudioApp";
import { useIntegration } from "../state/IntegrationProvider";
import { useStudio } from "../state/StudioProvider";
import { Alert, Badge, Icon, type IconName } from "../ui";
import { RecentList } from "./RecentView";

const STEPS: Array<{ icon: IconName; title: string; text: string }> = [
  { icon: "upload", title: "Upload", text: "PDF, Word or a public publication URL. Files are processed in memory and not stored." },
  { icon: "sparkle", title: "Extract", text: "Headlines, summaries, quotes, statistics, links, metadata and images — each with its source location." },
  { icon: "edit", title: "Curate", text: "Select, edit, reorder and copy content cards on an interactive whiteboard." },
  { icon: "map", title: "Map & create", text: "Map content to a Sitecore template, preview it, and create an unpublished item." },
];

export function HomeView({ navigate }: { navigate: Navigate }) {
  const { workspace, recent } = useStudio();
  const { adapter, connecting } = useIntegration();

  return (
    <>
      <section className="cs-card cs-hero">
        <div className="cs-stack" style={{ maxWidth: 620 }}>
          <h1 style={{ fontSize: 26 }}>Turn PR documents into structured Sitecore content</h1>
          <p className="cs-muted">Extract reusable content from press releases, reports and publications, review it, and map it to your content templates. Authors stay in control: nothing is created without review, and nothing is published automatically.</p>
          <div className="cs-row">
            <button type="button" className="cs-btn cs-primary" onClick={() => navigate({ view: "create", step: "upload" })}>
              <Icon name="upload" /> Create from document
            </button>
            <button
              type="button"
              className="cs-btn"
              // The sample also starts on the Upload page, where the Sitecore site is chosen.
              onClick={() => navigate({ view: "create", step: "upload" })}
            >
              Try the sample
            </button>
          </div>
        </div>
      </section>

      {!connecting && adapter.status.mode === "demo" && (
        <Alert tone="info" title="Demo mode">
          {adapter.status.detail} Document extraction works fully; sites and templates are mock data and no items are created in Sitecore.
        </Alert>
      )}
      {!connecting && adapter.status.mode === "live" && <Alert tone="success" title="Connected to Sitecore">{adapter.status.detail}</Alert>}

      {workspace && (
        <section className="cs-card">
          <div className="cs-card-body cs-row-between">
            <div>
              <h2>Continue where you left off</h2>
              <p className="cs-muted cs-small">
                {workspace.extraction.isSample && <Badge tone="amber">Sample</Badge>} {workspace.extraction.metadata.fileName} · {workspace.cards.filter((c) => c.selected).length} cards selected
              </p>
            </div>
            <button type="button" className="cs-btn cs-primary" onClick={() => navigate({ view: "create", step: "board" })}>
              Open whiteboard <Icon name="arrowRight" />
            </button>
          </div>
        </section>
      )}

      <div className="cs-grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        {STEPS.map((s) => (
          <div key={s.title} className="cs-card cs-feature">
            <div className="cs-feature-icon">
              <Icon name={s.icon} />
            </div>
            <h3>{s.title}</h3>
            <p className="cs-small cs-muted">{s.text}</p>
          </div>
        ))}
      </div>

      <section className="cs-card">
        <div className="cs-card-header">
          <h2>Recent documents</h2>
          {recent.length > 0 && (
            <button type="button" className="cs-btn cs-ghost cs-sm" onClick={() => navigate({ view: "recent" })}>
              View all
            </button>
          )}
        </div>
        <RecentList navigate={navigate} limit={3} />
      </section>
    </>
  );
}

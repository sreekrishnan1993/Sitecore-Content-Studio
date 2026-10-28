"use client";

import type { ContentType, ExtractedBlock, ListItem, SourceRef } from "@/src/lib/types/extraction";
import { displayLevels } from "@/src/lib/mapping";
import { formatBytes } from "@/src/lib/validation/file";
import { useWorkspace } from "../state/StudioProvider";
import { Alert, Badge, EmptyState, FileTypeIcon, Icon, OriginBadge } from "../ui";

const GROUPS: Array<{ title: string; types: ContentType[]; empty: string }> = [
  { title: "Headline & subheadings", types: ["headline", "subheading"], empty: "No headline or subheadings were detected." },
  { title: "Executive summary", types: ["summary"], empty: "No summary or lead paragraph was detected." },
  { title: "Body content", types: ["body", "list"], empty: "No body text or lists were found." },
  { title: "Quotations", types: ["quote"], empty: "No quotations were found in the source text." },
  { title: "Key statistics", types: ["statistic"], empty: "No statistics were detected." },
  { title: "Calls to action", types: ["cta"], empty: "No call to action was detected." },
  { title: "Captions", types: ["caption"], empty: "No figure or table captions were found." },
  { title: "Links", types: ["link"], empty: "No links were found." },
  { title: "SEO metadata", types: ["seo"], empty: "No SEO metadata could be derived." },
];

export function SourceLine({ source, children }: { source?: SourceRef; children?: React.ReactNode }) {
  return (
    <div className="cs-source">
      {children}
      {source?.page !== undefined && <span>Page {source.page}</span>}
      {source?.location && <span title={source.location}>{source.location}</span>}
      {!source?.page && !source?.location && <span>Source location unavailable</span>}
    </div>
  );
}

function ListView({ items, ordered }: { items: ListItem[]; ordered?: boolean }) {
  const List = ordered ? "ol" : "ul";
  const levels = displayLevels(items);
  return (
    <List>
      {items.map((item, i) => (
        <li key={i} style={{ marginLeft: levels[i] * 18 }}>
          {item.text}
        </li>
      ))}
    </List>
  );
}

function BlockItem({ block }: { block: ExtractedBlock }) {
  return (
    <div className="cs-result-item">
      {block.type === "quote" ? (
        <blockquote>
          “{block.text}”{block.attribution && <span className="cs-muted" style={{ fontStyle: "normal" }}> — {block.attribution}</span>}
        </blockquote>
      ) : block.type === "link" || (block.type === "cta" && block.href) ? (
        <span>
          {block.text}{" "}
          {block.href && (
            <a href={block.href} target="_blank" rel="noopener noreferrer" className="cs-small">
              {block.href}
            </a>
          )}
        </span>
      ) : block.type === "list" ? (
        <ListView items={block.items ?? []} ordered={block.ordered} />
      ) : (
        <span className="cs-result-text" style={{ fontWeight: block.type === "headline" ? 650 : undefined, fontSize: block.type === "headline" ? 17 : undefined }}>
          {block.label && <strong className="cs-muted">{block.label}: </strong>}
          {block.text}
        </span>
      )}
      <SourceLine source={block.source}>
        <OriginBadge origin={block.origin} />
        {block.type === "subheading" && <Badge tone="outline">Subheading</Badge>}
        {block.containedIn && <Badge tone="outline" title="This text is also part of a paragraph card.">Inside a paragraph</Badge>}
        {block.type === "list" && <Badge tone="outline">{block.items?.length ?? 0} items</Badge>}
        {block.confidence !== undefined && (
          <span title={block.evidence?.join("; ")} style={{ color: block.confidence < 0.6 ? "var(--cs-warning)" : undefined }}>
            {block.confidence < 0.6 ? "Uncertain" : "Confidence"} {Math.round(block.confidence * 100)}%
          </span>
        )}
      </SourceLine>
      {block.source?.sourceText && block.source.sourceText !== block.text && (
        <details className="cs-small">
          <summary className="cs-muted" style={{ cursor: "pointer" }}>Show source text</summary>
          <p style={{ marginTop: 6 }}>{block.source.sourceText}</p>
        </details>
      )}
    </div>
  );
}

export function ResultsStep({ onNext }: { onNext: () => void }) {
  const { workspace } = useWorkspace();
  const { extraction } = workspace;
  const { metadata } = extraction;

  const meta: Array<[string, string | undefined]> = [
    ["Title", metadata.title],
    ["Author", metadata.author],
    ["Subject", metadata.subject],
    ["Keywords", metadata.keywords],
    ["Description", metadata.description],
    ["Created", metadata.createdAt && new Date(metadata.createdAt).toLocaleString()],
    ["Modified", metadata.modifiedAt && new Date(metadata.modifiedAt).toLocaleString()],
    ["Source URL", metadata.sourceUrl],
  ];

  return (
    <div className="cs-stack-lg">
      <div className="cs-results">
        <aside className="cs-card">
          <div className="cs-card-body cs-stack">
            <div className="cs-row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
              <FileTypeIcon type={metadata.fileType} />
              <div style={{ minWidth: 0 }}>
                <strong style={{ wordBreak: "break-word" }}>{metadata.fileName}</strong>
                <div className="cs-small cs-muted">
                  {metadata.fileType.toUpperCase()} · {formatBytes(metadata.fileSize)}
                  {metadata.pageCount !== undefined && ` · ${metadata.pageCount} page${metadata.pageCount === 1 ? "" : "s"}`} · {metadata.wordCount.toLocaleString()} words
                </div>
              </div>
            </div>
            {extraction.isSample ? <Badge tone="amber">Sample data</Badge> : <Badge tone="green">Processed successfully</Badge>}
            <hr className="cs-divider" />
            <h3>Document metadata</h3>
            <dl className="cs-meta-list">
              {meta.map(([label, value]) => (
                <div key={label} style={{ display: "contents" }}>
                  <dt>{label}</dt>
                  <dd>{value || <span className="cs-muted">Not present</span>}</dd>
                </div>
              ))}
            </dl>
            <hr className="cs-divider" />
            <div className="cs-small cs-muted">
              Extracted {new Date(extraction.extractedAt).toLocaleString()} by <code>{extraction.provider}</code>. Classification is rule-based; no AI provider is configured.
            </div>
            <div className="cs-row cs-small">
              <OriginBadge origin="extracted" /> verbatim source text
            </div>
            <div className="cs-row cs-small">
              <OriginBadge origin="derived" /> generated from source text by rules
            </div>
          </div>
        </aside>

        <div className="cs-stack-lg">
          {extraction.warnings.length > 0 && (
            <Alert tone="warning" title={`${extraction.warnings.length} extraction note${extraction.warnings.length === 1 ? "" : "s"}`}>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {extraction.warnings.map((w, i) => (
                  <li key={i}>{w.message}</li>
                ))}
              </ul>
            </Alert>
          )}

          {GROUPS.map((group) => {
            const blocks = extraction.blocks.filter((b) => group.types.includes(b.type));
            return (
              <section key={group.title} className="cs-card">
                <div className="cs-card-header">
                  <h2>{group.title}</h2>
                  <Badge tone="outline">{blocks.length}</Badge>
                </div>
                <div className="cs-card-body cs-result-group">
                  {blocks.length === 0 ? <p className="cs-muted cs-small">{group.empty}</p> : blocks.map((b) => <BlockItem key={b.id} block={b} />)}
                </div>
              </section>
            );
          })}

          <section className="cs-card">
            <div className="cs-card-header">
              <h2>Embedded images</h2>
              <Badge tone="outline">{extraction.images.length}</Badge>
            </div>
            <div className="cs-card-body">
              {extraction.images.length === 0 ? (
                <EmptyState icon="image" title="No images found">
                  No usable embedded images were found in this document.
                </EmptyState>
              ) : (
                <div className="cs-gallery">
                  {extraction.images.map((img) => (
                    <figure key={img.id} className="cs-thumb" style={{ margin: 0 }}>
                      <div className="cs-thumb-img" style={{ cursor: "default" }}>
                        {img.src ? (
                          // eslint-disable-next-line @next/next/no-img-element -- data URLs from the document
                          <img src={img.src} alt={img.sourceAltText ?? `Extracted image ${img.fileName}`} />
                        ) : (
                          <span className="cs-small cs-muted">Image data not kept in this session</span>
                        )}
                      </div>
                      <figcaption className="cs-thumb-body cs-small">
                        <strong>{img.fileName}</strong>
                        <span className="cs-muted">
                          {img.page !== undefined && `Page ${img.page} · `}
                          {img.width && img.height ? `${img.width}×${img.height}px` : "Dimensions unknown"}
                          {img.origin === "referenced" && " · referenced by URL"}
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      <div className="cs-step-footer">
        <span />
        <button type="button" className="cs-btn cs-primary" onClick={onNext}>
          Open whiteboard <Icon name="arrowRight" />
        </button>
      </div>
    </div>
  );
}

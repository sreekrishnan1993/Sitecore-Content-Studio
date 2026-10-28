"use client";

import { articleCards, displayLevels, selectedCards } from "@/src/lib/mapping";
import { cardParagraphs } from "@/src/lib/workspace";
import type { Workspace } from "@/src/lib/types/workspace";

/** Renders the selected content as a draft article. All text is rendered as React text (never as HTML). */
export function ArticlePreview({ workspace }: { workspace: Workspace }) {
  const cards = selectedCards(workspace);
  const headline = cards.find((c) => c.type === "headline");
  const summary = cards.find((c) => c.type === "summary");
  const flow = articleCards(workspace);
  const stats = cards.filter((c) => c.type === "statistic");
  const ctas = cards.filter((c) => c.type === "cta");
  const links = cards.filter((c) => c.type === "link");
  const images = workspace.images
    .filter((i) => i.selected)
    .map((asset) => ({ asset, image: workspace.extraction.images.find((x) => x.id === asset.id) }))
    .filter((x): x is { asset: typeof x.asset; image: NonNullable<typeof x.image> } => Boolean(x.image?.src));
  const [hero, ...moreImages] = images;
  const { metadata } = workspace.extraction;

  if (cards.length === 0 && images.length === 0) {
    return (
      <div className="cs-article">
        <p className="cs-muted">Nothing is selected yet. Select content cards on the whiteboard to build the article.</p>
      </div>
    );
  }

  return (
    <article className="cs-article" aria-label="Draft article preview">
      {headline ? <h1>{headline.text}</h1> : <p className="cs-muted">No headline selected</p>}
      <div className="cs-article-meta">
        {metadata.author && <span>By {metadata.author}</span>}
        {metadata.createdAt && <span>{new Date(metadata.createdAt).toLocaleDateString()}</span>}
        {workspace.extraction.isSample && <span>Sample content</span>}
      </div>
      {summary && <p className="cs-article-lead">{summary.text}</p>}
      {hero && (
        <figure>
          {/* eslint-disable-next-line @next/next/no-img-element -- extracted image data */}
          <img src={hero.image.src} alt={hero.asset.altText} />
          {hero.asset.caption && <figcaption>{hero.asset.caption}</figcaption>}
        </figure>
      )}
      {flow.map((card) => {
        if (card.type === "subheading") return <h2 key={card.id}>{card.text}</h2>;
        if (card.type === "quote")
          return (
            <blockquote key={card.id}>
              “{card.text.replace(/^[“"]|[”"]$/g, "")}”{card.attribution && <cite>— {card.attribution}</cite>}
            </blockquote>
          );
        if (card.type === "list") {
          const List = card.ordered ? "ol" : "ul";
          const levels = displayLevels(card.items ?? []);
          return (
            <List key={card.id}>
              {(card.items ?? []).map((item, i) => (
                <li key={i} style={{ marginLeft: levels[i] * 20 }}>
                  {item.text}
                </li>
              ))}
            </List>
          );
        }
        return cardParagraphs(card).map((paragraph, i) => <p key={`${card.id}-${i}`}>{paragraph}</p>);
      })}
      {stats.length > 0 && (
        <aside className="cs-article-stats" aria-label="Key statistics">
          <strong>Key figures</strong>
          {stats.map((s) => (
            <span key={s.id}>{s.text}</span>
          ))}
        </aside>
      )}
      {moreImages.map(({ asset, image }) => (
        <figure key={asset.id}>
          {/* eslint-disable-next-line @next/next/no-img-element -- extracted image data */}
          <img src={image.src} alt={asset.altText} />
          {asset.caption && <figcaption>{asset.caption}</figcaption>}
        </figure>
      ))}
      {ctas.map((c) =>
        c.href ? (
          <p key={c.id}>
            <a href={c.href} target="_blank" rel="noopener noreferrer">
              {c.text}
            </a>
          </p>
        ) : (
          <p key={c.id}>
            <strong>{c.text}</strong>
          </p>
        ),
      )}
      {links.length > 0 && (
        <div className="cs-article-meta" style={{ display: "grid", gap: 4 }}>
          <strong>Related links</strong>
          {links.map((l) => (
            <a key={l.id} href={l.href} target="_blank" rel="noopener noreferrer">
              {l.text}
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

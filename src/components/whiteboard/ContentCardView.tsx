"use client";

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { isSafeHref } from "@/src/lib/extraction/text";
import { CONTENT_TYPE_LABELS, CONTENT_TYPES, type ContentType, type ListItem } from "@/src/lib/types/extraction";
import type { ContentCard } from "@/src/lib/types/workspace";
import { displayLevels } from "@/src/lib/mapping";
import { cardParagraphs, REGROUPABLE_TYPES, type CardPatch } from "@/src/lib/workspace";
import { Icon, OriginBadge, TYPE_COLORS } from "../ui";

export interface CardHandlers {
  onToggle: (id: string) => void;
  onUpdate: (id: string, patch: CardPatch) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onCopy: (card: ContentCard) => void;
  onMove: (id: string, delta: number) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOverCard: (id: string) => void;
  onDropOnCard: (id: string) => void;
  onMerge: (id: string) => void;
  onSplit: (id: string, at: number) => void;
}

/** Below this, the card shows its classification evidence so the author can check it. */
const LOW_CONFIDENCE = 0.6;
const MAX_LIST_LEVEL = 4;

interface Props extends CardHandlers {
  card: ContentCard;
  index: number;
  total: number;
  dragging: boolean;
  dropTarget: boolean;
  startEditing?: boolean;
  /** The next card on the board has the same type and can be merged into this one. */
  canMergeNext: boolean;
}

export function ContentCardView({ card, index, total, dragging, dropTarget, startEditing, canMergeNext, ...h }: Props) {
  const [editing, setEditing] = useState(Boolean(startEditing));
  const [splitting, setSplitting] = useState(false);
  const [draft, setDraft] = useState({ text: card.text, attribution: card.attribution ?? "", href: card.href ?? "", items: card.items ?? [], ordered: Boolean(card.ordered) });
  const isList = card.type === "list";
  const paragraphs = isList ? [] : cardParagraphs(card);
  const levels = displayLevels(card.items ?? []);
  const parts = isList ? (card.items?.length ?? 0) : paragraphs.length;
  const canSplit = REGROUPABLE_TYPES.has(card.type) && parts > 1;
  const setItem = (i: number, patch: Partial<ListItem>) => setDraft({ ...draft, items: draft.items.map((item, j) => (j === i ? { ...item, ...patch } : item)) });
  const [hrefError, setHrefError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const headingId = `cs-card-${card.id}`;

  useEffect(() => {
    if (editing) textRef.current?.focus();
  }, [editing]);

  const beginEdit = () => {
    setDraft({ text: card.text, attribution: card.attribution ?? "", href: card.href ?? "", items: card.items ?? [{ text: "", level: 0 }], ordered: Boolean(card.ordered) });
    setHrefError(null);
    setSplitting(false);
    setEditing(true);
  };

  const save = () => {
    const href = draft.href.trim();
    if (href && !isSafeHref(href)) {
      setHrefError("Enter a full http(s):// or mailto: address.");
      return;
    }
    const patch: CardPatch = isList ? { items: draft.items.filter((i) => i.text.trim()), ordered: draft.ordered } : { text: draft.text };
    if (card.type === "quote") patch.attribution = draft.attribution.trim() || undefined;
    if (card.type === "cta" || card.type === "link") patch.href = href || undefined;
    h.onUpdate(card.id, patch);
    setEditing(false);
  };

  const onEditorKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setEditing(false);
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  };

  const onGripKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      h.onMove(card.id, -1);
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      h.onMove(card.id, 1);
    }
  };

  return (
    <article
      className="cs-content-card"
      data-type={card.type}
      data-selected={card.selected}
      data-dragging={dragging}
      data-drop-target={dropTarget}
      aria-labelledby={headingId}
      draggable={armed && !editing}
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.id);
        h.onDragStart(card.id);
      }}
      onDragEnd={() => {
        setArmed(false);
        h.onDragEnd();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        h.onDragOverCard(card.id);
      }}
      onDrop={(e) => {
        e.preventDefault();
        h.onDropOnCard(card.id);
      }}
    >
      <header className="cs-cc-head">
        <button
          type="button"
          className="cs-cc-grip"
          aria-label={`Reorder card ${index + 1} of ${total}. Drag, or use arrow keys to move.`}
          title="Drag to reorder (or focus and use arrow keys)"
          onPointerDown={() => setArmed(true)}
          onPointerUp={() => setArmed(false)}
          onKeyDown={onGripKey}
        >
          <Icon name="grip" />
        </button>
        <input type="checkbox" className="cs-checkbox" checked={card.selected} onChange={() => h.onToggle(card.id)} aria-label={`Include this ${CONTENT_TYPE_LABELS[card.type].toLowerCase()} in the content`} />
        <span className="cs-type-dot" style={{ background: TYPE_COLORS[card.type] }} aria-hidden />
        <select
          className="cs-select"
          style={{ height: 26, padding: "0 6px", width: "auto", border: "none", fontWeight: 600, fontSize: 12, background: "transparent" }}
          value={card.type}
          onChange={(e) => h.onUpdate(card.id, { type: e.target.value as ContentType })}
          aria-label="Content type"
          id={headingId}
        >
          {CONTENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {CONTENT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        {card.label && <span className="cs-small cs-muted">{card.label}</span>}
        {card.confidence !== undefined && card.confidence < LOW_CONFIDENCE && card.origin === "extracted" && (
          <span className="cs-badge cs-amber" title={`Uncertain classification (${Math.round(card.confidence * 100)}%): ${card.evidence?.join("; ") ?? "no evidence"}. Change the type if it is wrong.`}>
            Check type
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>
          <OriginBadge origin={card.origin} edited={card.edited} />
        </span>
      </header>

      <div className="cs-cc-body">
        {editing ? (
          <div className="cs-stack" style={{ gap: 8 }}>
            <label className="cs-sr-only" htmlFor={`${headingId}-text`}>
              Text
            </label>
            {isList ? (
              <div className="cs-stack" style={{ gap: 6 }} role="group" aria-label="List items">
                {draft.items.map((item, i) => (
                  <div key={i} className="cs-row" style={{ flexWrap: "nowrap", gap: 4, paddingLeft: item.level * 18 }}>
                    <input
                      className="cs-input"
                      aria-label={`Item ${i + 1}`}
                      value={item.text}
                      onChange={(e) => setItem(i, { text: e.target.value })}
                      onKeyDown={onEditorKey}
                      autoFocus={i === 0}
                    />
                    <button type="button" className="cs-btn cs-ghost cs-sm" onClick={() => setItem(i, { level: Math.max(0, item.level - 1) })} disabled={item.level === 0} aria-label={`Outdent item ${i + 1}`} title="Outdent">
                      ‹
                    </button>
                    <button type="button" className="cs-btn cs-ghost cs-sm" onClick={() => setItem(i, { level: Math.min(MAX_LIST_LEVEL, item.level + 1) })} disabled={i === 0 || item.level >= MAX_LIST_LEVEL} aria-label={`Indent item ${i + 1}`} title="Indent">
                      ›
                    </button>
                    <button type="button" className="cs-btn cs-ghost cs-sm cs-danger" onClick={() => setDraft({ ...draft, items: draft.items.filter((_, j) => j !== i) })} aria-label={`Remove item ${i + 1}`} title="Remove item">
                      ×
                    </button>
                  </div>
                ))}
                <div className="cs-row">
                  <button type="button" className="cs-btn cs-sm" onClick={() => setDraft({ ...draft, items: [...draft.items, { text: "", level: draft.items[draft.items.length - 1]?.level ?? 0 }] })}>
                    <Icon name="plus" /> Add item
                  </button>
                  <label className="cs-row cs-small">
                    <input type="checkbox" className="cs-checkbox" checked={draft.ordered} onChange={(e) => setDraft({ ...draft, ordered: e.target.checked })} /> Numbered
                  </label>
                </div>
              </div>
            ) : (
              <textarea id={`${headingId}-text`} ref={textRef} className="cs-textarea" value={draft.text} rows={Math.min(12, Math.max(3, Math.ceil(draft.text.length / 60) + paragraphs.length))} onChange={(e) => setDraft({ ...draft, text: e.target.value })} onKeyDown={onEditorKey} />
            )}
            {!isList && REGROUPABLE_TYPES.has(card.type) && <span className="cs-hint">Separate paragraphs with a blank line.</span>}
            {card.type === "quote" && (
              <div className="cs-field">
                <label htmlFor={`${headingId}-attr`}>Attribution</label>
                <input id={`${headingId}-attr`} className="cs-input" value={draft.attribution} onChange={(e) => setDraft({ ...draft, attribution: e.target.value })} onKeyDown={onEditorKey} placeholder="Name, role" />
              </div>
            )}
            {(card.type === "cta" || card.type === "link") && (
              <div className="cs-field">
                <label htmlFor={`${headingId}-href`}>URL</label>
                <input id={`${headingId}-href`} className="cs-input" value={draft.href} aria-invalid={!!hrefError} onChange={(e) => setDraft({ ...draft, href: e.target.value })} onKeyDown={onEditorKey} placeholder="https://" />
                {hrefError && <span className="cs-hint" style={{ color: "var(--cs-danger)" }}>{hrefError}</span>}
              </div>
            )}
            <div className="cs-row">
              <button type="button" className="cs-btn cs-primary cs-sm" onClick={save}>
                Save
              </button>
              <button type="button" className="cs-btn cs-sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <span className="cs-small cs-muted">Ctrl+Enter to save · Esc to cancel</span>
            </div>
          </div>
        ) : (
          <>
            <div
              className="cs-cc-text"
              role="button"
              tabIndex={0}
              onClick={beginEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  beginEdit();
                }
              }}
              aria-label="Edit text"
            >
              {!card.text ? (
                <span className="cs-muted">Empty card — click to write</span>
              ) : isList ? (
                <ol className="cs-cc-list" data-ordered={Boolean(card.ordered)}>
                  {(card.items ?? []).map((item, i) => (
                    <li key={i} style={{ marginLeft: levels[i] * 18 }} data-level={levels[i]}>
                      {item.text}
                    </li>
                  ))}
                </ol>
              ) : paragraphs.length > 1 ? (
                paragraphs.map((p, i) => (
                  <p key={i} className="cs-cc-para">
                    {p}
                  </p>
                ))
              ) : (
                card.text
              )}
            </div>
            {splitting && canSplit && (
              <div className="cs-stack" style={{ gap: 4 }} role="group" aria-label="Choose where to split">
                <span className="cs-small cs-muted">Split this card into two:</span>
                {Array.from({ length: parts - 1 }, (_, i) => (
                  <button
                    key={i}
                    type="button"
                    className="cs-btn cs-sm"
                    onClick={() => {
                      h.onSplit(card.id, i + 1);
                      setSplitting(false);
                    }}
                  >
                    ✂ Before {isList ? `item ${i + 2}: ` : `paragraph ${i + 2}: `}
                    {(isList ? card.items?.[i + 1]?.text : paragraphs[i + 1])?.slice(0, 40)}…
                  </button>
                ))}
              </div>
            )}
            {card.attribution && <span className="cs-small cs-muted">— {card.attribution}</span>}
            {card.href && (
              <a className="cs-small" href={card.href} target="_blank" rel="noopener noreferrer" style={{ wordBreak: "break-all" }}>
                {card.href}
              </a>
            )}
          </>
        )}
      </div>

      <footer className="cs-cc-foot">
        <span className="cs-source" title={[card.source?.sourceText, card.evidence?.length ? `Why: ${card.evidence.join("; ")}` : ""].filter(Boolean).join("\n\n") || undefined}>
          {card.source?.page !== undefined ? `Page ${card.source.page}` : card.origin === "manual" ? "Added by author" : card.source?.location ?? "No source location"}
        </span>
        <div className="cs-cc-actions">
          <button type="button" className="cs-btn cs-ghost cs-icon cs-sm" onClick={() => h.onMove(card.id, -1)} disabled={index === 0} aria-label="Move up" title="Move up">
            <Icon name="up" />
          </button>
          <button type="button" className="cs-btn cs-ghost cs-icon cs-sm" onClick={() => h.onMove(card.id, 1)} disabled={index === total - 1} aria-label="Move down" title="Move down">
            <Icon name="down" />
          </button>
          <button type="button" className="cs-btn cs-ghost cs-icon cs-sm" onClick={beginEdit} aria-label="Edit card" title="Edit">
            <Icon name="edit" />
          </button>
          <button type="button" className="cs-btn cs-ghost cs-icon cs-sm" onClick={() => h.onCopy(card)} aria-label="Copy text to clipboard" title="Copy to clipboard">
            <Icon name="copy" />
          </button>
          {canSplit && !editing && (
            <button type="button" className="cs-btn cs-ghost cs-sm" onClick={() => setSplitting((v) => !v)} aria-pressed={splitting} title="Split into two cards">
              Split…
            </button>
          )}
          {canMergeNext && !editing && (
            <button type="button" className="cs-btn cs-ghost cs-sm" onClick={() => h.onMerge(card.id)} title="Merge with the next card of the same type">
              Merge ↓
            </button>
          )}
          <button type="button" className="cs-btn cs-ghost cs-icon cs-sm" onClick={() => h.onDuplicate(card.id)} aria-label="Duplicate card" title="Duplicate">
            <Icon name="duplicate" />
          </button>
          <button type="button" className="cs-btn cs-ghost cs-icon cs-sm cs-danger" onClick={() => h.onDelete(card.id)} aria-label="Delete card" title="Delete">
            <Icon name="trash" />
          </button>
        </div>
      </footer>
    </article>
  );
}

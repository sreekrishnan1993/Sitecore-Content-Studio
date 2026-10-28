"use client";

import { useMemo, useState } from "react";
import { CONTENT_TYPE_LABELS, CONTENT_TYPES, type ContentType } from "@/src/lib/types/extraction";
import type { ContentCard } from "@/src/lib/types/workspace";
import { copyToClipboard } from "@/src/lib/utils/clipboard";
import { createId } from "@/src/lib/utils/id";
import { REGROUPABLE_TYPES } from "@/src/lib/workspace";
import { ArticlePreview } from "../preview/ArticlePreview";
import { useStudio, useWorkspace } from "../state/StudioProvider";
import { Alert, Badge, EmptyState, Icon, TypeBadge } from "../ui";
import { ContentCardView, type CardHandlers } from "./ContentCardView";

export function WhiteboardStep({ onBack, onNext, onPreview }: { onBack: () => void; onNext: () => void; onPreview: () => void }) {
  const { workspace, dispatch } = useWorkspace();
  const { notify, lastSave } = useStudio();
  const [filter, setFilter] = useState<ContentType | "all">("all");
  const [newType, setNewType] = useState<ContentType>("body");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<{ card: ContentCard; index: number } | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const { cards } = workspace;
  const visible = filter === "all" ? cards : cards.filter((c) => c.type === filter);
  const selectedCount = cards.filter((c) => c.selected).length;
  const counts = useMemo(() => {
    const map = new Map<ContentType, { total: number; selected: number }>();
    for (const c of cards) {
      const entry = map.get(c.type) ?? { total: 0, selected: 0 };
      entry.total++;
      if (c.selected) entry.selected++;
      map.set(c.type, entry);
    }
    return map;
  }, [cards]);

  const handlers: CardHandlers = {
    onToggle: (id) => dispatch({ type: "toggle-card", id }),
    onUpdate: (id, patch) => dispatch({ type: "update-card", id, patch }),
    onDelete: (id) => {
      const index = cards.findIndex((c) => c.id === id);
      if (index >= 0) setDeleted({ card: cards[index], index });
      dispatch({ type: "delete-card", id });
    },
    onDuplicate: (id) => {
      dispatch({ type: "duplicate-card", id });
      notify("Card duplicated");
    },
    onCopy: async (card) => {
      const text = card.type === "quote" && card.attribution ? `“${card.text}” — ${card.attribution}` : card.href && card.type !== "link" ? `${card.text} ${card.href}` : card.href ?? card.text;
      notify((await copyToClipboard(card.type === "link" ? `${card.text} (${card.href})` : text)) ? "Copied to clipboard" : "Copy failed: the clipboard is not available in this context");
    },
    onMove: (id, delta) => {
      // Move relative to the visible (possibly filtered) sequence.
      const vIndex = visible.findIndex((c) => c.id === id);
      const target = visible[vIndex + delta];
      if (!target) return;
      dispatch({ type: "move-card", id, toIndex: cards.findIndex((c) => c.id === target.id) });
      window.setTimeout(() => document.querySelector<HTMLButtonElement>(`[aria-labelledby="cs-card-${id}"] .cs-cc-grip`)?.focus(), 0);
    },
    onDragStart: (id) => setDraggingId(id),
    onDragEnd: () => {
      setDraggingId(null);
      setDropId(null);
    },
    onDragOverCard: (id) => {
      if (draggingId && id !== draggingId) setDropId(id);
    },
    onMerge: (id) => {
      dispatch({ type: "merge-cards", id });
      notify("Cards merged");
    },
    onSplit: (id, at) => {
      dispatch({ type: "split-card", id, at });
      notify("Card split in two");
    },
    onDropOnCard: (id) => {
      if (draggingId && id !== draggingId) {
        dispatch({ type: "move-card", id: draggingId, toIndex: cards.findIndex((c) => c.id === id) });
      }
      setDraggingId(null);
      setDropId(null);
    },
  };

  const addCard = () => {
    const id = createId("card");
    dispatch({ type: "add-card", cardType: newType, id });
    setFilter((f) => (f === "all" || f === newType ? f : "all"));
    setEditId(id);
  };

  /** Merging works on board order, so the next card must be adjacent and of the same type. */
  const canMergeNext = (card: ContentCard) => {
    const next = cards[cards.findIndex((c) => c.id === card.id) + 1];
    return Boolean(next && next.type === card.type && REGROUPABLE_TYPES.has(card.type));
  };

  const setVisibleSelected = (selected: boolean) => dispatch({ type: "select-cards", ids: visible.map((c) => c.id), selected });

  return (
    <div className="cs-board-layout">
      <div className="cs-stack">
        <div className="cs-card cs-board-toolbar">
          <div className="cs-filter-chips" role="group" aria-label="Filter cards by type">
            <button type="button" className="cs-chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              All ({cards.length})
            </button>
            {CONTENT_TYPES.filter((t) => counts.has(t)).map((t) => (
              <button key={t} type="button" className="cs-chip" aria-pressed={filter === t} onClick={() => setFilter(t)}>
                {CONTENT_TYPE_LABELS[t]} ({counts.get(t)?.total})
              </button>
            ))}
          </div>
          <div className="cs-row">
            <button type="button" className="cs-btn cs-sm" onClick={() => setVisibleSelected(true)}>
              Select all
            </button>
            <button type="button" className="cs-btn cs-sm" onClick={() => setVisibleSelected(false)}>
              Deselect all
            </button>
            <label className="cs-sr-only" htmlFor="cs-new-type">
              New card type
            </label>
            <select id="cs-new-type" className="cs-select" style={{ height: 28, width: "auto", fontSize: 12, padding: "0 8px" }} value={newType} onChange={(e) => setNewType(e.target.value as ContentType)}>
              {CONTENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CONTENT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <button type="button" className="cs-btn cs-primary cs-sm" onClick={addCard}>
              <Icon name="plus" /> Add card
            </button>
          </div>
        </div>

        {deleted && (
          <Alert tone="info">
            <span className="cs-row">
              Card deleted.
              <button
                type="button"
                className="cs-btn cs-sm"
                onClick={() => {
                  dispatch({ type: "restore-card", card: deleted.card, index: deleted.index });
                  setDeleted(null);
                  notify("Card restored");
                }}
              >
                Undo
              </button>
              <button type="button" className="cs-btn cs-ghost cs-sm" onClick={() => setDeleted(null)}>
                Dismiss
              </button>
            </span>
          </Alert>
        )}

        <div className="cs-board" aria-label="Content whiteboard">
          {visible.length === 0 ? (
            <div style={{ gridColumn: "1 / -1" }}>
              <EmptyState icon="file" title={cards.length === 0 ? "The whiteboard is empty" : "No cards of this type"}>
                {cards.length === 0 ? "Add a card to start writing, or go back and extract another document." : "Choose another filter or add a card of this type."}
              </EmptyState>
            </div>
          ) : (
            visible.map((card, i) => (
              <ContentCardView
                key={card.id}
                card={card}
                index={i}
                total={visible.length}
                dragging={draggingId === card.id}
                dropTarget={dropId === card.id}
                startEditing={editId === card.id}
                canMergeNext={canMergeNext(card)}
                {...handlers}
              />
            ))
          )}
        </div>
      </div>

      <aside className="cs-side-panel">
        <section className="cs-card">
          <div className="cs-card-body cs-stack">
            <div className="cs-row-between">
              <h2>Selection</h2>
              <Badge tone="purple">
                {selectedCount} of {cards.length} selected
              </Badge>
            </div>
            <ul className="cs-issues">
              {CONTENT_TYPES.filter((t) => counts.has(t)).map((t) => (
                <li key={t} style={{ justifyContent: "space-between" }}>
                  <TypeBadge type={t} />
                  <span className="cs-muted">
                    {counts.get(t)?.selected}/{counts.get(t)?.total}
                  </span>
                </li>
              ))}
            </ul>
            <p className="cs-small cs-muted">The article uses selected cards in board order. Statistics and quotes that also appear inside a paragraph start deselected to avoid repetition.</p>
            <button type="button" className="cs-btn" onClick={() => setShowPreview(true)} disabled={selectedCount === 0}>
              <Icon name="eye" /> Preview draft article
            </button>
          </div>
        </section>
        <section className="cs-card">
          <div className="cs-card-body cs-stack cs-small">
            <strong>Workspace</strong>
            <span className="cs-muted">
              {lastSave?.ok === false ? "Not saved — session storage unavailable." : `Saved in this browser session · last change ${new Date(workspace.updatedAt).toLocaleTimeString()}`}
            </span>
            <span className="cs-muted">Tip: drag cards by the grip, or focus the grip and use the arrow keys.</span>
          </div>
        </section>
        <div className="cs-row" style={{ justifyContent: "space-between" }}>
          <button type="button" className="cs-btn" onClick={onBack}>
            <Icon name="arrowLeft" /> Results
          </button>
          <button type="button" className="cs-btn cs-primary" onClick={onNext}>
            Images <Icon name="arrowRight" />
          </button>
        </div>
        <button type="button" className="cs-btn cs-ghost" onClick={onPreview}>
          Skip to final preview
        </button>
      </aside>

      {showPreview && (
        <div className="cs-lightbox" role="dialog" aria-modal="true" aria-label="Draft article preview" onClick={() => setShowPreview(false)} onKeyDown={(e) => e.key === "Escape" && setShowPreview(false)}>
          <div className="cs-lightbox-inner" style={{ width: "min(900px, 100%)" }} onClick={(e) => e.stopPropagation()}>
            <div className="cs-row-between">
              <strong>Draft article preview</strong>
              <button type="button" className="cs-btn cs-sm" onClick={() => setShowPreview(false)} autoFocus>
                Close
              </button>
            </div>
            <ArticlePreview workspace={workspace} />
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isPathWithin } from "@/src/lib/sitecore/graphql";
import type { SitecoreTreeItem } from "@/src/lib/types/sitecore";

type Children = { state: "error"; message: string } | { state: "loaded"; items: SitecoreTreeItem[] };

const keyOf = (path: string) => path.toLowerCase().replace(/\/+$/, "");

/** The root and every ancestor of each path below it, so those paths are visible when the tree opens. */
function initialExpanded(root: SitecoreTreeItem, openPaths: Array<string | undefined>): Set<string> {
  const expanded = new Set([keyOf(root.path)]);
  for (const path of openPaths) {
    if (!path || !isPathWithin(path, root.path)) continue;
    const rest = path.replace(/\/+$/, "").slice(root.path.replace(/\/+$/, "").length).split("/").filter(Boolean);
    let current = root.path.replace(/\/+$/, "");
    for (const segment of rest.slice(0, -1)) {
      current = `${current}/${segment}`;
      expanded.add(keyOf(current));
    }
  }
  return expanded;
}

export interface ItemTreePickerProps {
  /** Accessible name of the tree. */
  label: string;
  root: SitecoreTreeItem;
  loadChildren: (path: string) => Promise<SitecoreTreeItem[]>;
  selectedPath?: string;
  /** Paths to reveal when the tree opens (their ancestors are expanded), e.g. the current selection. */
  openPaths?: Array<string | undefined>;
  onSelect: (item: SitecoreTreeItem) => void;
  /** Items to leave out of the tree. */
  hide?: (item: SitecoreTreeItem) => boolean;
}

/**
 * A lazily loaded Sitecore item tree. Children are read from Sitecore only when a node is opened.
 * Remount it (key) when the root changes.
 */
export function ItemTreePicker({ label, root, loadChildren, selectedPath, openPaths = [], onSelect, hide }: ItemTreePickerProps) {
  const [expanded, setExpanded] = useState(() => initialExpanded(root, [selectedPath, ...openPaths]));
  const [children, setChildren] = useState<Record<string, Children>>({});
  const requested = useRef(new Set<string>());
  const loadRef = useRef(loadChildren);
  useEffect(() => {
    loadRef.current = loadChildren;
  });

  const load = useCallback(async (path: string) => {
    const key = keyOf(path);
    if (requested.current.has(key)) return;
    requested.current.add(key);
    let result: Children;
    try {
      result = { state: "loaded", items: await loadRef.current(path) };
    } catch (error) {
      result = { state: "error", message: error instanceof Error ? error.message : String(error) };
    }
    setChildren((prev) => ({ ...prev, [key]: result }));
  }, []);

  // Load the children of every open node (initially the root and the ancestors of the selection).
  useEffect(() => {
    for (const key of expanded) void load(key);
  }, [expanded, load]);

  const toggle = (item: SitecoreTreeItem) => {
    const key = keyOf(item.path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const retry = (item: SitecoreTreeItem) => {
    const key = keyOf(item.path);
    requested.current.delete(key);
    setChildren((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    void load(item.path);
  };

  const renderNode = (item: SitecoreTreeItem, depth: number) => {
    const key = keyOf(item.path);
    const open = expanded.has(key);
    const kids = children[key];
    const expandable = item.hasChildren !== false;
    const selected = !!selectedPath && keyOf(selectedPath) === key;
    const name = item.displayName ?? item.name;
    const visible = kids?.state === "loaded" ? kids.items.filter((child) => !hide?.(child)) : [];
    const indent = { paddingLeft: 8 + (depth + 1) * 18 };
    return (
      <li key={key} role="treeitem" aria-expanded={expandable ? open : undefined} aria-selected={selected}>
        <div className="cs-tree-row" data-selected={selected || undefined} style={{ paddingLeft: 8 + depth * 18 }}>
          {expandable ? (
            <button type="button" className="cs-tree-toggle" aria-label={`${open ? "Collapse" : "Expand"} ${name}`} onClick={() => toggle(item)}>
              {open ? "▾" : "▸"}
            </button>
          ) : (
            <span className="cs-tree-toggle" aria-hidden />
          )}
          <button type="button" className="cs-tree-label" title={item.path} aria-pressed={selected} onClick={() => onSelect(item)}>
            {name}
            {item.displayName && <span className="cs-subtle"> ({item.name})</span>}
          </button>
        </div>
        {open && expandable && (
          <ul role="group">
            {!kids ? (
              <li className="cs-tree-status" style={indent}>
                <span className="cs-spinner" aria-hidden /> Loading…
              </li>
            ) : kids.state === "error" ? (
              <li className="cs-tree-status" style={{ ...indent, color: "var(--cs-danger)" }}>
                {kids.message}{" "}
                <button type="button" className="cs-btn cs-ghost cs-sm" onClick={() => retry(item)}>
                  Retry
                </button>
              </li>
            ) : visible.length === 0 ? (
              <li className="cs-tree-status cs-subtle" style={indent}>
                No child items
              </li>
            ) : (
              visible.map((child) => renderNode(child, depth + 1))
            )}
          </ul>
        )}
      </li>
    );
  };

  return (
    <ul className="cs-tree" role="tree" aria-label={label}>
      {renderNode(root, 0)}
    </ul>
  );
}

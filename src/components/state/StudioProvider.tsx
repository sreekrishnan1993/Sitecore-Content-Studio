"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ExtractionResult } from "@/src/lib/types/extraction";
import type { MappingState, Workspace } from "@/src/lib/types/workspace";
import { createWorkspace, workspaceReducer, type WorkspaceAction } from "@/src/lib/workspace";
import { clearWorkspaces, loadWorkspaces, removeWorkspace, saveWorkspace, type SaveOutcome, type StoredWorkspace } from "@/src/lib/workspace/storage";

interface StudioValue {
  workspace: StoredWorkspace | null;
  dispatch: (action: WorkspaceAction) => void;
  /** Opens a new workspace; `mapping` carries selections made before extraction (the site). */
  start: (extraction: ExtractionResult, mapping?: Omit<MappingState, "fields">) => void;
  open: (id: string) => boolean;
  close: () => void;
  recent: StoredWorkspace[];
  remove: (id: string) => void;
  clearAll: () => void;
  lastSave: SaveOutcome | null;
  notify: (message: string) => void;
}

const StudioContext = createContext<StudioValue | null>(null);

export function StudioProvider({ children }: { children: ReactNode }) {
  // Restore the most recent workspace of this browser session.
  const [workspace, setWorkspace] = useState<StoredWorkspace | null>(() => loadWorkspaces()[0] ?? null);
  const [recent, setRecent] = useState<StoredWorkspace[]>(() => loadWorkspaces());
  const [lastSave, setLastSave] = useState<SaveOutcome | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; message: string }>>([]);
  const toastId = useRef(0);

  const notify = useCallback((message: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  // Debounced persistence to sessionStorage.
  useEffect(() => {
    if (!workspace) return;
    const timer = window.setTimeout(() => {
      const outcome = saveWorkspace(workspace);
      setLastSave(outcome);
      setRecent(loadWorkspaces());
      if (!outcome.ok) console.error("Content Studio: workspace could not be saved to session storage:", outcome.error);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [workspace]);

  const dispatch = useCallback((action: WorkspaceAction) => {
    setWorkspace((ws) => (ws ? workspaceReducer(ws, action) : ws));
  }, []);

  const start = useCallback((extraction: ExtractionResult, mapping?: Omit<MappingState, "fields">) => setWorkspace(createWorkspace(extraction, mapping)), []);

  const open = useCallback((id: string) => {
    const found = loadWorkspaces().find((w) => w.id === id);
    if (found) setWorkspace(found);
    return Boolean(found);
  }, []);

  const close = useCallback(() => setWorkspace(null), []);

  const remove = useCallback((id: string) => {
    removeWorkspace(id);
    setRecent(loadWorkspaces());
    setWorkspace((ws) => (ws?.id === id ? null : ws));
  }, []);

  const clearAll = useCallback(() => {
    clearWorkspaces();
    setRecent([]);
    setWorkspace(null);
  }, []);

  const value = useMemo(
    () => ({ workspace, dispatch, start, open, close, recent, remove, clearAll, lastSave, notify }),
    [workspace, dispatch, start, open, close, recent, remove, clearAll, lastSave, notify],
  );

  return (
    <StudioContext.Provider value={value}>
      {children}
      <div className="cs-toast-region" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="cs-toast">
            {t.message}
          </div>
        ))}
      </div>
    </StudioContext.Provider>
  );
}

export function useStudio(): StudioValue {
  const value = useContext(StudioContext);
  if (!value) throw new Error("useStudio must be used inside StudioProvider");
  return value;
}

/** For screens that require an open workspace. */
export function useWorkspace(): { workspace: Workspace; dispatch: (action: WorkspaceAction) => void } {
  const { workspace, dispatch } = useStudio();
  if (!workspace) throw new Error("No workspace is open");
  return { workspace, dispatch };
}

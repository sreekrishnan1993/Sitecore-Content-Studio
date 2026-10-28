import type { Workspace } from "../types/workspace";

// Browser-session persistence. Workspaces live in sessionStorage (cleared when the tab closes);
// nothing is sent to a server. Image data can exceed the storage quota, in which case the
// workspace is stored without image data and the UI says so.

const WORKSPACES_KEY = "content-studio:v1:workspaces";
const SETTINGS_KEY = "content-studio:v1:settings";
const MAX_RECENT = 8;

export interface StoredWorkspace extends Workspace {
  imagesNotPersisted?: boolean;
}

export interface SaveOutcome {
  ok: boolean;
  imagesDropped: boolean;
  error?: string;
}

function read<T>(storage: Storage | undefined, key: string, fallback: T): T {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch (error) {
    console.warn(`Content Studio: could not read ${key}`, error);
    return fallback;
  }
}

function session(): Storage | undefined {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : undefined;
  } catch {
    return undefined;
  }
}

function local(): Storage | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function loadWorkspaces(): StoredWorkspace[] {
  return read<StoredWorkspace[]>(session(), WORKSPACES_KEY, []);
}

export function saveWorkspace(ws: Workspace): SaveOutcome {
  const storage = session();
  if (!storage) return { ok: false, imagesDropped: false, error: "Session storage is not available in this browser context." };
  const others = loadWorkspaces().filter((w) => w.id !== ws.id);
  const write = (entry: StoredWorkspace) => storage.setItem(WORKSPACES_KEY, JSON.stringify([entry, ...others].slice(0, MAX_RECENT)));
  try {
    write(ws);
    return { ok: true, imagesDropped: false };
  } catch {
    try {
      const withoutImages: StoredWorkspace = {
        ...ws,
        imagesNotPersisted: ws.extraction.images.length > 0,
        extraction: { ...ws.extraction, images: ws.extraction.images.map((i) => (i.src.startsWith("data:") ? { ...i, src: "" } : i)) },
      };
      write(withoutImages);
      return { ok: true, imagesDropped: withoutImages.imagesNotPersisted ?? false };
    } catch (error) {
      return { ok: false, imagesDropped: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export function removeWorkspace(id: string): void {
  const storage = session();
  if (!storage) return;
  try {
    storage.setItem(WORKSPACES_KEY, JSON.stringify(loadWorkspaces().filter((w) => w.id !== id)));
  } catch (error) {
    console.warn("Content Studio: could not update session storage", error);
  }
}

export function clearWorkspaces(): void {
  try {
    session()?.removeItem(WORKSPACES_KEY);
  } catch (error) {
    console.warn("Content Studio: could not clear session storage", error);
  }
}

export interface StudioSettings {
  templateRootPath: string;
  forceDemo: boolean;
  /** Opt-in: upload images through the Agent API (not yet verified against a tenant). */
  experimentalMediaUpload: boolean;
}

export const DEFAULT_SETTINGS: StudioSettings = { templateRootPath: "/sitecore/templates/Project", forceDemo: false, experimentalMediaUpload: false };

export function loadSettings(): StudioSettings {
  return { ...DEFAULT_SETTINGS, ...read<Partial<StudioSettings>>(local(), SETTINGS_KEY, {}) };
}

export function saveSettings(settings: StudioSettings): boolean {
  try {
    local()?.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch (error) {
    console.warn("Content Studio: could not save settings", error);
    return false;
  }
}

export const VIEWS = ["home", "create", "recent", "templates", "media", "settings"] as const;
export type View = (typeof VIEWS)[number];

export const STEPS = ["upload", "results", "board", "media", "mapping", "preview"] as const;
export type Step = (typeof STEPS)[number];

export const STEP_LABELS: Record<Step, string> = {
  upload: "Upload",
  results: "Extraction results",
  board: "Whiteboard",
  media: "Images & media",
  mapping: "Template mapping",
  preview: "Preview & create",
};

export interface Route {
  view: View;
  step: Step;
}

export function parseHash(hash: string): Route {
  const [view, step] = hash.replace(/^#\/?/, "").split("/");
  return {
    view: (VIEWS as readonly string[]).includes(view) ? (view as View) : "home",
    step: (STEPS as readonly string[]).includes(step) ? (step as Step) : "upload",
  };
}

export function toHash(route: Partial<Route> & { view: View }): string {
  return route.view === "create" ? `#/create/${route.step ?? "upload"}` : `#/${route.view}`;
}

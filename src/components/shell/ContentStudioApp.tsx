"use client";

import { useCallback, useEffect, useState } from "react";
import { IntegrationProvider, useIntegration } from "../state/IntegrationProvider";
import { StudioProvider, useStudio } from "../state/StudioProvider";
import { Badge, Icon, type IconName } from "../ui";
import { CreateView } from "../views/CreateView";
import { HomeView } from "../views/HomeView";
import { MediaLibraryView } from "../views/MediaLibraryView";
import { RecentView } from "../views/RecentView";
import { SettingsView } from "../views/SettingsView";
import { TemplatesView } from "../views/TemplatesView";
import { parseHash, toHash, type Route, type View } from "./routes";

const NAV: Array<{ view: View; label: string; icon: IconName }> = [
  { view: "home", label: "Home", icon: "home" },
  { view: "create", label: "Create from Document", icon: "upload" },
  { view: "recent", label: "Recent Documents", icon: "clock" },
  { view: "templates", label: "Templates", icon: "template" },
  { view: "media", label: "Media Library", icon: "image" },
  { view: "settings", label: "Settings", icon: "settings" },
];

const TITLES: Record<View, string> = {
  home: "Home",
  create: "Create from Document",
  recent: "Recent Documents",
  templates: "Templates",
  media: "Media Library",
  settings: "Settings",
};

export type Navigate = (route: Partial<Route> & { view: View }) => void;

export function ModeBadge() {
  const { adapter, connecting } = useIntegration();
  if (connecting) {
    return (
      <Badge tone="outline">
        <span className="cs-spinner" style={{ width: 10, height: 10 }} aria-hidden /> Connecting to Sitecore
      </Badge>
    );
  }
  return adapter.status.mode === "live" ? (
    <Badge tone="green" title={adapter.status.detail}>
      Live · Sitecore connected
    </Badge>
  ) : (
    <Badge tone="amber" title={adapter.status.detail}>
      Demo mode
    </Badge>
  );
}

function Shell() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const { workspace } = useStudio();

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback<Navigate>((next) => {
    const hash = toHash(next);
    if (window.location.hash !== hash) window.location.hash = hash;
    setRoute(parseHash(hash));
    document.getElementById("cs-main")?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, []);

  const subtitle =
    route.view === "create" && workspace ? `${workspace.extraction.isSample ? "Sample · " : ""}${workspace.extraction.metadata.fileName}` : "Turn documents into structured Sitecore content";

  return (
    <div className="cs-app">
      <nav className="cs-sidebar" aria-label="Content Studio">
        <div className="cs-brand">
          <div className="cs-brand-mark" aria-hidden>
            CS
          </div>
          <div>
            <div className="cs-brand-name">Content Studio</div>
            <div className="cs-brand-sub">for Sitecore</div>
          </div>
        </div>
        {NAV.map((item) => (
          <button
            key={item.view}
            type="button"
            className="cs-nav-item"
            aria-current={route.view === item.view ? "page" : undefined}
            onClick={() => navigate({ view: item.view, step: item.view === "create" ? (workspace ? route.step : "upload") : undefined })}
          >
            <Icon name={item.icon} />
            {item.label}
          </button>
        ))}
        <div className="cs-sidebar-footer">
          <ModeBadge />
          <span>Nothing is published automatically.</span>
        </div>
      </nav>
      <div className="cs-main">
        <header className="cs-topbar">
          <div className="cs-topbar-title">
            <h1>{TITLES[route.view]}</h1>
            <span title={subtitle}>{subtitle}</span>
          </div>
          <ModeBadge />
        </header>
        <main id="cs-main" tabIndex={-1} className="cs-page" style={{ outline: "none" }}>
          {route.view === "home" && <HomeView navigate={navigate} />}
          {route.view === "create" && <CreateView step={route.step} navigate={navigate} />}
          {route.view === "recent" && <RecentView navigate={navigate} />}
          {route.view === "templates" && <TemplatesView />}
          {route.view === "media" && <MediaLibraryView navigate={navigate} />}
          {route.view === "settings" && <SettingsView />}
        </main>
      </div>
    </div>
  );
}

export default function ContentStudioApp() {
  return (
    <div className="cs-root">
      <IntegrationProvider>
        <StudioProvider>
          <Shell />
        </StudioProvider>
      </IntegrationProvider>
    </div>
  );
}

"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ApplicationContext } from "@sitecore-marketplace-sdk/client";
import { useMarketplaceClient, type UseMarketplaceClientOptions } from "@/src/utils/hooks/useMarketplaceClient";
import type { SitecoreAdapter } from "@/src/lib/sitecore/adapter";
import { DemoSitecoreAdapter, demoStatus } from "@/src/lib/sitecore/demo-adapter";
import { LiveSitecoreAdapter } from "@/src/lib/sitecore/live-adapter";
import { loadSettings, saveSettings, type StudioSettings } from "@/src/lib/workspace/storage";

type Connection =
  | { state: "connecting" }
  | { state: "live"; adapter: SitecoreAdapter; appContext: ApplicationContext }
  | { state: "demo"; adapter: SitecoreAdapter };

interface IntegrationValue {
  adapter: SitecoreAdapter;
  connecting: boolean;
  appContext?: ApplicationContext;
  embedded: boolean;
  settings: StudioSettings;
  updateSettings: (settings: StudioSettings) => boolean;
}

const IntegrationContext = createContext<IntegrationValue | null>(null);

const CONNECT_TIMEOUT_MS = 15_000;
const CLIENT_OPTIONS: UseMarketplaceClientOptions = { autoInit: true };

function isEmbedded(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

/** Connects to the Marketplace host. Only mounted when running inside an iframe. */
function MarketplaceConnector({ settings, onConnection }: { settings: StudioSettings; onConnection: (c: Connection) => void }) {
  const { client, error, isInitialized } = useMarketplaceClient(CLIENT_OPTIONS);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      onConnection({ state: "demo", adapter: new DemoSitecoreAdapter(demoStatus("The Sitecore host did not respond, so Content Studio is running in demo mode.")) });
    }, CONNECT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [onConnection]);

  useEffect(() => {
    if (error) {
      console.error("Content Studio: Marketplace client failed to initialize", error);
      onConnection({ state: "demo", adapter: new DemoSitecoreAdapter(demoStatus(`The Marketplace SDK could not connect (${error.message}). Demo mode is active.`)) });
      return;
    }
    if (!isInitialized || !client) return;
    let cancelled = false;
    client
      .query("application.context")
      .then((res) => {
        if (cancelled) return;
        const appContext = res.data;
        const resource = appContext?.resourceAccess?.[0] ?? appContext?.resources?.[0];
        // Sitecore's Marketplace SDK examples use the live Context ID for Authoring/Sites calls.
        const contextId: string | undefined = resource?.context?.live || resource?.context?.preview;
        if (!appContext || !contextId) {
          onConnection({
            state: "demo",
            adapter: new DemoSitecoreAdapter(demoStatus("The app is installed, but it has no SitecoreAI / XM Cloud resource access. Grant the app access to an environment to enable live mode.")),
          });
          return;
        }
        const tenant = resource?.tenantDisplayName || resource?.tenantName || "your Sitecore environment";
        onConnection({ state: "live", appContext, adapter: new LiveSitecoreAdapter(client, contextId, { templateRootPath: settings.templateRootPath, experimentalMediaUpload: settings.experimentalMediaUpload }, tenant) });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("Content Studio: application.context query failed", err);
        onConnection({ state: "demo", adapter: new DemoSitecoreAdapter(demoStatus("The application context could not be read from Sitecore. Demo mode is active.")) });
      });
    return () => {
      cancelled = true;
    };
  }, [client, error, isInitialized, onConnection, settings.templateRootPath, settings.experimentalMediaUpload]);

  return null;
}

export function IntegrationProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<StudioSettings>(() => loadSettings());
  const [embedded] = useState(isEmbedded);
  const wantsLive = embedded && !settings.forceDemo;
  const [connection, setConnection] = useState<Connection>(() =>
    wantsLive
      ? { state: "connecting" }
      : {
          state: "demo",
          adapter: new DemoSitecoreAdapter(
            demoStatus(settings.forceDemo ? "Demo mode was selected in Settings." : "Content Studio is running outside Sitecore, so it uses demo data. Open it from SitecoreAI / XM Cloud to connect."),
          ),
        },
  );

  const onConnection = useCallback((c: Connection) => {
    setConnection((prev) => (prev.state === "connecting" || c.state === "live" ? c : prev));
  }, []);

  const updateSettings = useCallback(
    (next: StudioSettings) => {
      const saved = saveSettings(next);
      setSettings(next);
      const nextWantsLive = embedded && !next.forceDemo;
      setConnection(
        nextWantsLive
          ? { state: "connecting" }
          : { state: "demo", adapter: new DemoSitecoreAdapter(demoStatus(next.forceDemo ? "Demo mode was selected in Settings." : "Content Studio is running outside Sitecore, so it uses demo data.")) },
      );
      return saved;
    },
    [embedded],
  );

  const value = useMemo<IntegrationValue>(() => {
    const adapter = connection.state === "connecting" ? new DemoSitecoreAdapter(demoStatus("Connecting to Sitecore…")) : connection.adapter;
    return {
      adapter,
      connecting: connection.state === "connecting",
      appContext: connection.state === "live" ? connection.appContext : undefined,
      embedded,
      settings,
      updateSettings,
    };
  }, [connection, embedded, settings, updateSettings]);

  return (
    <IntegrationContext.Provider value={value}>
      {wantsLive && connection.state === "connecting" && <MarketplaceConnector settings={settings} onConnection={onConnection} />}
      {children}
    </IntegrationContext.Provider>
  );
}

export function useIntegration(): IntegrationValue {
  const value = useContext(IntegrationContext);
  if (!value) throw new Error("useIntegration must be used inside IntegrationProvider");
  return value;
}

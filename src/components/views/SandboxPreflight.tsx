"use client";

import { useState } from "react";
import { runPreflight, type PreflightCheck } from "@/src/lib/sitecore/preflight";
import { useIntegration } from "../state/IntegrationProvider";
import { useServerCapabilities } from "../state/useServerCapabilities";
import { Badge } from "../ui";

const TONE = { pass: "green", warn: "amber", fail: "red", skip: "outline" } as const;
const LABEL = { pass: "Pass", warn: "Check", fail: "Fail", skip: "Skipped" } as const;

/** Read-only checks to run inside Sitecore (sandbox or production deployment). Creates and uploads nothing. */
export function SandboxPreflight() {
  const { adapter, appContext, settings, connecting } = useIntegration();
  const caps = useServerCapabilities();
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    try {
      setChecks(
        await runPreflight({
          adapter,
          appContext,
          capabilities: caps.data,
          capabilitiesError: caps.error,
          templateRootPath: settings.templateRootPath,
          experimentalMediaUpload: settings.experimentalMediaUpload,
          route: "/content-studio",
        }),
      );
    } finally {
      setRunning(false);
    }
  };

  const failed = checks?.filter((c) => c.status === "fail").length ?? 0;

  return (
    <section className="cs-card">
      <div className="cs-card-header">
        <h2>Preflight</h2>
        {checks && <Badge tone={failed ? "red" : "green"}>{failed ? `${failed} failed` : "Ready"}</Badge>}
      </div>
      <div className="cs-card-body cs-stack">
        <p className="cs-small cs-muted">Read-only checks: server configuration, target environment, extension point, Sites API, languages and Authoring GraphQL. Nothing is created or uploaded.</p>
        <div>
          <button type="button" className="cs-btn cs-primary" onClick={run} disabled={running || connecting || (!caps.data && !caps.error)}>
            {running ? <span className="cs-spinner" aria-hidden /> : null} Run preflight
          </button>
        </div>
        {checks && (
          <ul className="cs-issues cs-small">
            {checks.map((c) => (
              <li key={c.id} style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                <span>
                  <strong>{c.label}</strong> — {c.detail}
                </span>
                <Badge tone={TONE[c.status]}>{LABEL[c.status]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

"use client";

import type { Navigate } from "../shell/ContentStudioApp";
import { STEP_LABELS, STEPS, type Step } from "../shell/routes";
import { useStudio } from "../state/StudioProvider";
import { Alert, Badge } from "../ui";
import { UploadStep } from "../upload/UploadStep";
import { ResultsStep } from "../extraction/ResultsStep";
import { WhiteboardStep } from "../whiteboard/WhiteboardStep";
import { MediaStep } from "../media/MediaStep";
import { MappingStep } from "../mapping/MappingStep";
import { PreviewStep } from "../preview/PreviewStep";

export function CreateView({ step, navigate }: { step: Step; navigate: Navigate }) {
  const { workspace, lastSave } = useStudio();
  const active: Step = workspace ? step : "upload";
  const activeIndex = STEPS.indexOf(active);
  const go = (s: Step) => navigate({ view: "create", step: s });

  return (
    <>
      <ol className="cs-stepper" aria-label="Workflow steps">
        {STEPS.map((s, i) => (
          <li key={s} className="cs-step" data-state={s === active ? "current" : i < activeIndex ? "done" : "todo"}>
            <button type="button" onClick={() => go(s)} disabled={!workspace && s !== "upload"} aria-current={s === active ? "step" : undefined}>
              <span className="cs-step-num">{i + 1}</span>
              {STEP_LABELS[s]}
            </button>
          </li>
        ))}
      </ol>

      {workspace?.extraction.isSample && active !== "upload" && (
        <Alert tone="info" title="You are working with sample data">
          This fictional press release is bundled with Content Studio for demonstration. It did not come from a file you uploaded.
        </Alert>
      )}
      {workspace?.imagesNotPersisted && (
        <Alert tone="warning" title="Images were not kept in session storage">
          The extracted images were too large to keep in this browser session after a reload. Text cards are intact; re-upload the document to work with its images.
        </Alert>
      )}
      {lastSave && !lastSave.ok && <Alert tone="warning" title="Workspace not saved">Changes could not be stored in this browser session ({lastSave.error}). They will be lost if you reload.</Alert>}

      {active === "upload" && <UploadStep onDone={() => go("results")} />}
      {workspace && active === "results" && <ResultsStep onNext={() => go("board")} />}
      {workspace && active === "board" && <WhiteboardStep onBack={() => go("results")} onNext={() => go("media")} onPreview={() => go("preview")} />}
      {workspace && active === "media" && <MediaStep onBack={() => go("board")} onNext={() => go("mapping")} />}
      {workspace && active === "mapping" && <MappingStep onBack={() => go("media")} onNext={() => go("preview")} />}
      {workspace && active === "preview" && <PreviewStep onEdit={go} />}
      {workspace && active !== "upload" && (
        <p className="cs-small cs-muted">
          <Badge tone="outline">Session</Badge> This workspace is saved in this browser tab only and is cleared when the tab is closed.
        </p>
      )}
    </>
  );
}

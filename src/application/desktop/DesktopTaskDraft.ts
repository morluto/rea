import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { exportedStateFiles } from "../../domain/desktop/appExport.js";
import { DRAFT_PROMPT } from "../../domain/desktop/appTask.js";
import { draftTaskFiles } from "../../domain/desktop/appTaskDraft.js";
import { desktopApplicationStateSchema } from "../../domain/desktop/desktopState.js";
import { isWithinAny } from "../../domain/desktop/desktopStateDiff.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import {
  inspectDesktopApplicationState,
  readDesktopCapture,
  type DesktopStateReaders,
} from "./DesktopApplicationState.js";
import {
  DESKTOP_PROVIDER,
  desktopOperationFailure,
} from "./DesktopCaptureRefusals.js";
import { exportEnvironmentName } from "./DesktopExportInstall.js";

const OPERATION = "describe_desktop_application_task";

const DRAFT_LIMITATIONS = [
  "Files are those under the paths the export owns, whose state differs between the capture's first and last version; data/get serves nothing else.",
  "Suggested checks and views cover documents, or the app's own state when no document changed; each check is derived from the net change and is a starting point, not a task.",
  "Views longer than 200 items or strings longer than 2,000 characters are cut here (view_cut); inspect-desktop-application-state shows every view whole.",
];

const draft = async (
  folder: string,
  readers: DesktopStateReaders,
  signal: AbortSignal | undefined,
): Promise<Evidence> => {
  const { evidence, capture } = await readDesktopCapture(folder, signal);
  const stateEvidence = await inspectDesktopApplicationState(
    folder,
    readers,
    signal,
  );
  if (stateEvidence instanceof AnalysisError) throw stateEvidence;
  const state = desktopApplicationStateSchema.parse(
    stateEvidence.normalized_result,
  );
  const { files, paths } = exportedStateFiles(capture, state);
  const drafted = draftTaskFiles(files, (home) => isWithinAny(home, paths));
  const environment = exportEnvironmentName(capture, undefined);
  const checkpoints = state.capture.checkpoints;
  const result = {
    application: {
      environment,
      title: capture.application.desktop_entry?.name ?? environment,
      window_class: capture.session.window_match?.class ?? null,
    },
    owned_paths: [...paths],
    checkpoints: { baseline: checkpoints[0], final: checkpoints.at(-1) },
    files: drafted.map(({ file, role, baseline, final, change }) => ({
      file,
      role,
      baseline,
      final,
      change,
    })),
    task: {
      name: "change",
      prompt: DRAFT_PROMPT,
      checks: drafted
        .flatMap((file) => file.suggested)
        .map((check, index) => ({
          id: `check-${String(index + 1)}`,
          ...check,
        })),
    },
  } as unknown as JsonValue;
  signal?.throwIfAborted();
  return createEvidence(undefined, DESKTOP_PROVIDER, {
    predicateType: "rea.desktop-application-task-draft",
    operation: OPERATION,
    parameters: { capture_evidence_id: evidence.evidence_id },
    result,
    confidence: "inferred",
    authority: "analyst-inference",
    limitations: [...DRAFT_LIMITATIONS, ...capture.limitations],
  });
};

/** Describe how a capture's files changed, with a task draft an agent completes and passes to the export. */
export const draftDesktopApplicationTask = async (
  folder: string,
  readers: DesktopStateReaders,
  signal?: AbortSignal,
): Promise<Evidence | AnalysisError> => {
  try {
    return await draft(folder, readers, signal);
  } catch (cause: unknown) {
    return desktopOperationFailure(
      cause,
      signal,
      OPERATION,
      "Desktop task draft",
    );
  }
};

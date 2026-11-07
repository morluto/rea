import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { exportedStateFiles } from "../../domain/desktop/appExport.js";
import { DRAFT_PROMPT } from "../../domain/desktop/appTask.js";
import {
  withheldFiles,
  type WithholdSelection,
} from "../../domain/desktop/appWithheld.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { draftTaskFiles } from "../../domain/desktop/appTaskDraft.js";
import { draftNotes } from "../../domain/desktop/appTaskDraftNotes.js";
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
import {
  selectStateEnds,
  type CheckpointSelection,
} from "./DesktopStateVersions.js";

const OPERATION = "describe_desktop_application_task";

const DRAFT_LIMITATIONS = [
  "Files are those under the paths the export owns, whose state differs between the seed and end checkpoints, by default the capture's first and last; data/get serves nothing else.",
  "Suggested checks, values, guards and views cover documents, or the app's own state when no document changed; each check is derived from the net change and is a starting point, not a task.",
  "Values cover XML, archives, JSON and key files: at most 20 entries and 8 KB a file and 24 KB a draft, each value cut at 600 characters (values_cut says when any is left out).",
  "Views longer than 200 items or strings longer than 2,000 characters are cut here (view_cut); inspect-desktop-application-state shows every view whole.",
];

/** Checks with ids `PREFIX-1`, `PREFIX-2` and on, in order. */
const numbered = <Check extends object>(
  prefix: string,
  checks: readonly Check[],
) =>
  checks.map((check, index) => ({
    id: `${prefix}-${String(index + 1)}`,
    ...check,
  }));

/** Which checkpoints a draft reads, and which files it leaves out as withheld sign-in state. */
export type DraftSelection = CheckpointSelection & {
  readonly withhold?: WithholdSelection | undefined;
};

const draft = async (
  folder: string,
  readers: DesktopStateReaders,
  signal: AbortSignal | undefined,
  selection: DraftSelection,
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
  const { checkpoints } = state.capture;
  const ends = selectStateEnds(checkpoints, selection, OPERATION);
  const { files, dconf, paths, homePath } = exportedStateFiles(capture, state);
  const withheld = withheldFiles(
    capture.state.checkpoints,
    homePath,
    paths,
    selection.withhold ?? {},
  );
  if (!withheld.ok)
    throw new AnalysisInputError(OPERATION, {
      userMessage: `REA cannot withhold the sign-in state: ${withheld.error}.`,
      conformsToInputContract: true,
    });
  const held = new Set(withheld.value);
  const drafted = draftTaskFiles(
    files,
    (home) => isWithinAny(home, paths) && !held.has(home),
    ends,
  );
  const notes = draftNotes(files, {
    drafted,
    owned: paths,
    dconf,
    ends,
    checkpoints,
  });
  const environment = exportEnvironmentName(capture, undefined);
  const result = {
    application: {
      environment,
      title: capture.application.desktop_entry?.name ?? environment,
      window_class: capture.session.window_match?.class ?? null,
    },
    owned_paths: [...paths],
    checkpoints: {
      baseline: checkpoints[ends.seed],
      final: checkpoints[ends.end],
    },
    files: drafted.map(
      ({ file, role, baseline, final, change, values, values_cut }) => ({
        file,
        role,
        baseline,
        final,
        change,
        values,
        values_cut,
      }),
    ),
    task: {
      name: "change",
      prompt: DRAFT_PROMPT,
      checks: numbered(
        "check",
        drafted.flatMap((file) => file.suggested),
      ),
    },
    guards: numbered(
      "guard",
      drafted.flatMap((file) => file.guards),
    ),
    notes,
    withheld_files: withheld.value,
  } as unknown as JsonValue;
  signal?.throwIfAborted();
  return createEvidence(undefined, DESKTOP_PROVIDER, {
    predicateType: "rea.desktop-application-task-draft",
    operation: OPERATION,
    parameters: {
      capture_evidence_id: evidence.evidence_id,
      seed_checkpoint: selection.seed ?? null,
      end_checkpoint: selection.end ?? null,
    },
    result,
    confidence: "inferred",
    authority: "analyst-inference",
    limitations: [...DRAFT_LIMITATIONS, ...capture.limitations],
  });
};

/**
 * Describe how a capture's files changed between the seed and end
 * checkpoints, with a task draft an agent completes and passes to the export.
 */
export const draftDesktopApplicationTask = async (
  folder: string,
  readers: DesktopStateReaders,
  signal?: AbortSignal,
  selection: DraftSelection = {},
): Promise<Evidence | AnalysisError> => {
  try {
    return await draft(folder, readers, signal, selection);
  } catch (cause: unknown) {
    return desktopOperationFailure(
      cause,
      signal,
      OPERATION,
      "Desktop task draft",
    );
  }
};

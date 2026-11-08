import { z } from "zod";

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  END_CHECKPOINT,
  SEED_CHECKPOINT,
} from "../../domain/desktop/buildCapture.js";
import { installsFromPackageFile } from "../../domain/desktop/appExportInstall.js";
import {
  SIGN_IN_END,
  SIGN_IN_START,
} from "../../domain/desktop/appWithheld.js";
import { draftNoteSchema } from "../../domain/desktop/appTaskDraftNotes.js";
import { draftValueSchema } from "../../domain/desktop/appTaskDraftValues.js";
import { desktopApplicationCaptureSchema } from "../../domain/desktop/desktopCapture.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { ControlledComputer } from "../../desktop/BuildComputerController.js";
import {
  ENDS,
  readOutput,
  reportedFailure,
  runRea,
} from "./DesktopBuildCommands.js";

const STOP = "stop_build_capture";

const draftResultSchema = z.looseObject({
  files: z.array(
    z.looseObject({
      file: z.string(),
      role: z.string(),
      change: jsonValueSchema,
      values: z.array(draftValueSchema).default([]),
      values_cut: z.boolean().default(false),
    }),
  ),
  task: z.looseObject({
    name: z.string(),
    prompt: z.string(),
    checks: z.array(jsonObjectSchema),
  }),
  guards: z.array(jsonObjectSchema).default([]),
  notes: z.array(draftNoteSchema).default([]),
  // A draft from before withheld files were left out lists none.
  withheld_files: z.array(z.string()).default([]),
});

/** A drafted file's value as the stop returns it. */
type DraftValue = {
  readonly pointer: string;
  readonly kind: string;
  readonly before: JsonValue;
  readonly after: JsonValue;
  readonly note?: string;
  readonly refers_to?: {
    readonly attribute?: string;
    readonly value: string;
    readonly element: string;
  }[];
  readonly alternatives?: string[];
};

/** A draft's note as the stop returns it. */
type DraftNote = {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly files?: { readonly file: string; readonly role: string }[];
  readonly more?: number;
  readonly elements?: string[];
  readonly pointers?: string[];
  readonly error?: string;
};

/** A value without the optional fields the draft left out. */
const draftValue = ({
  pointer,
  kind,
  before,
  after,
  note,
  refers_to,
  alternatives,
}: z.infer<typeof draftValueSchema>): DraftValue => ({
  pointer,
  kind,
  before,
  after,
  ...(note === undefined ? {} : { note }),
  ...(refers_to === undefined
    ? {}
    : {
        refers_to: refers_to.map(({ attribute, value, element }) => ({
          ...(attribute === undefined ? {} : { attribute }),
          value,
          element,
        })),
      }),
  ...(alternatives === undefined ? {} : { alternatives }),
});

/** A note without the optional fields the draft left out. */
const draftNote = ({
  code,
  message,
  file,
  files,
  more,
  elements,
  pointers,
  error,
}: z.infer<typeof draftNoteSchema>): DraftNote => ({
  code,
  message,
  ...(file === undefined ? {} : { file }),
  ...(files === undefined
    ? {}
    : { files: files.map(({ file: home, role }) => ({ file: home, role })) }),
  ...(more === undefined ? {} : { more }),
  ...(elements === undefined ? {} : { elements }),
  ...(pointers === undefined ? {} : { pointers }),
  ...(error === undefined ? {} : { error }),
});

/** A stopped capture: its checkpoints, what it found of the app and the draft between seed and end. */
export type StoppedCapture = {
  readonly end_reason: string;
  readonly checkpoints: {
    readonly name: string;
    readonly trigger: string;
    readonly changes: number;
    readonly retained_files: number;
  }[];
  readonly package: {
    readonly kind: string;
    readonly name: string | null;
    readonly version: string | null;
    readonly sources: string[];
  };
  readonly limitations: string[];
  readonly draft: {
    readonly seed_checkpoint: string;
    readonly end_checkpoint: string;
    readonly files: {
      readonly file: string;
      readonly role: string;
      readonly change: JsonValue;
      /** The values the change added, changed and removed, at the pointers a check names them by. */
      readonly values: DraftValue[];
      readonly values_cut: boolean;
    }[];
    readonly task: {
      readonly name: string;
      readonly prompt: string;
      readonly checks: Readonly<Record<string, JsonValue>>[];
    };
    /** Checks that the rest stays as it was, outside the task until an author adds them. */
    readonly guards: Readonly<Record<string, JsonValue>>[];
    /** Why the draft has no files, or why a file's suggestions are thin. */
    readonly notes: DraftNote[];
    /** Files the sign-in window changed, which the draft leaves out and the export withholds. */
    readonly withheld_files: string[];
  } | null;
  readonly draft_refusal?: string;
};

/** The task draft between `seed` and `end`, or why there is none. */
const draftTask = async (
  computer: ControlledComputer,
  folder: string,
  checkpoints: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<Pick<StoppedCapture, "draft" | "draft_refusal">> => {
  const missing = [SEED_CHECKPOINT, END_CHECKPOINT].filter(
    (name) => !checkpoints.has(name),
  );
  if (missing.length > 0)
    return {
      draft: null,
      draft_refusal: `No draft: the capture has no ${missing.join(" or ")} checkpoint; capture again and mark ${SEED_CHECKPOINT} once the seed is saved and ${END_CHECKPOINT} once the edit is.`,
    };
  const stdout = `${folder}/draft.json`;
  const { stdoutBytes: bytes } = await runRea(
    computer,
    [
      "describe-desktop-application-task",
      `${folder}/capture`,
      ...ENDS,
      ...(checkpoints.has(SIGN_IN_START) && checkpoints.has(SIGN_IN_END)
        ? ["--withhold-from", SIGN_IN_START, "--withhold-to", SIGN_IN_END]
        : []),
      "--json",
    ],
    { stdout, signal },
  );
  const output = await readOutput(computer, stdout, bytes, signal);
  if (output.kind === "failure")
    return { draft: null, draft_refusal: output.failure.message };
  const draft = draftResultSchema.parse(output.result);
  return {
    draft: {
      seed_checkpoint: SEED_CHECKPOINT,
      end_checkpoint: END_CHECKPOINT,
      files: draft.files.map(({ file, role, change, values, values_cut }) => ({
        file,
        role,
        change,
        values: values.map(draftValue),
        values_cut,
      })),
      task: {
        name: draft.task.name,
        prompt: draft.task.prompt,
        checks: draft.task.checks,
      },
      guards: draft.guards,
      notes: draft.notes.map(draftNote),
      withheld_files: draft.withheld_files,
    },
  };
};

/**
 * What a capture that has exited recorded, read from its own Evidence: the
 * checkpoints it holds, which the draft and the export trust over the
 * acknowledgements REA happened to receive, whether the export installs the
 * app from its package file, and the stop's summary with the draft between
 * `seed` and `end`. A capture that reported a failure is one.
 */
export const summarizeCapture = async (
  computer: ControlledComputer,
  capture: { readonly folder: string; readonly outputBytes: number },
  signal: AbortSignal,
): Promise<
  Result<
    {
      readonly checkpoints: Set<string>;
      readonly packageFile: boolean;
      readonly stopped: StoppedCapture;
    },
    AnalysisError
  >
> => {
  const output = await readOutput(
    computer,
    `${capture.folder}/capture.out`,
    capture.outputBytes,
    signal,
  );
  if (output.kind === "failure")
    return err(reportedFailure(STOP, output, "The capture failed: "));
  const recorded = desktopApplicationCaptureSchema.parse(output.result);
  const checkpoints = new Set(
    recorded.state.checkpoints.map((checkpoint) => checkpoint.name),
  );
  const { package: installed } = recorded.application;
  return ok({
    checkpoints,
    packageFile: installsFromPackageFile(installed, recorded.host.architecture),
    stopped: {
      end_reason: recorded.session.end_reason,
      checkpoints: recorded.state.checkpoints.map((checkpoint) => ({
        name: checkpoint.name,
        trigger: checkpoint.trigger,
        changes: checkpoint.changes.length,
        retained_files: checkpoint.retained.length,
      })),
      package: {
        kind: installed.kind,
        name: installed.name,
        version: installed.version,
        sources: [...installed.sources],
      },
      limitations: [...recorded.limitations],
      ...(await draftTask(computer, capture.folder, checkpoints, signal)),
    },
  });
};

import { z } from "zod";

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  END_CHECKPOINT,
  SEED_CHECKPOINT,
} from "../../domain/desktop/buildCapture.js";
import { installsFromPackageFile } from "../../domain/desktop/appExportInstall.js";
import { DRAFT_NOTE_CODES } from "../../domain/desktop/appTaskDraftNotes.js";
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
    }),
  ),
  task: z.looseObject({
    name: z.string(),
    prompt: z.string(),
    checks: z.array(jsonObjectSchema),
  }),
  notes: z
    .array(
      z.looseObject({
        code: z.enum(DRAFT_NOTE_CODES),
        message: z.string(),
        files: z
          .array(z.looseObject({ file: z.string(), role: z.string() }))
          .optional(),
        more: z.int().nonnegative().optional(),
      }),
    )
    .default([]),
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
    }[];
    readonly task: {
      readonly name: string;
      readonly prompt: string;
      readonly checks: Readonly<Record<string, JsonValue>>[];
    };
    /** Why the draft has no files; empty when it has some. */
    readonly notes: {
      readonly code: string;
      readonly message: string;
      readonly files?: { readonly file: string; readonly role: string }[];
      readonly more?: number;
    }[];
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
  const bytes = await runRea(
    computer,
    [
      "describe-desktop-application-task",
      `${folder}/capture`,
      ...ENDS,
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
      files: draft.files.map(({ file, role, change }) => ({
        file,
        role,
        change,
      })),
      task: {
        name: draft.task.name,
        prompt: draft.task.prompt,
        checks: draft.task.checks,
      },
      notes: draft.notes.map(({ code, message, files, more }) => ({
        code,
        message,
        ...(files === undefined
          ? {}
          : { files: files.map(({ file, role }) => ({ file, role })) }),
        ...(more === undefined ? {} : { more }),
      })),
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

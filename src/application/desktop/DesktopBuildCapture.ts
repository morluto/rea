import { z } from "zod";

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  END_CHECKPOINT,
  SEED_CHECKPOINT,
} from "../../domain/desktop/buildCapture.js";
import {
  desktopApplicationCaptureSchema,
  desktopCaptureProgressSchema,
  type DesktopCaptureEvent,
} from "../../domain/desktop/desktopCapture.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { ControlledComputer } from "../../desktop/BuildComputerController.js";
import {
  adapterError,
  controller,
  ENDS,
  errorText,
  readOutput,
  refused,
  runRea,
  WORK,
  type Answer,
} from "./DesktopBuildCommands.js";
import {
  exportBuild,
  type BuildExportRequest,
  type ExportedBuild,
} from "./DesktopBuildExport.js";

const START = "start_build_capture";
const MARK = "mark_build_checkpoint";
const STOP = "stop_build_capture";
const EXPORT = "export_build_environment";

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
});

/** The capture's progress event in a line the controller waited for. */
const eventOf = (line: string): DesktopCaptureEvent | undefined =>
  desktopCaptureProgressSchema.parse(JSON.parse(line)).rea_progress.event;

/** Why the capture is not answering, from what the controller saw instead of the event. */
const notAnswered = (operation: string, answer: Answer): AnalysisError =>
  adapterError(
    operation,
    answer.error ??
      (answer.exited === undefined
        ? `The capture did not answer in time. Its last progress: ${answer.progress ?? ""}`
        : `The capture ended with exit status ${String(answer.exited)}. ${answer.output ?? ""} ${answer.progress ?? ""}`.trim()),
  );

interface CaptureRun {
  readonly folder: string;
  status: "running" | "stopping" | "stopped" | "failed";
  readonly checkpoints: Map<
    string,
    Extract<DesktopCaptureEvent, { kind: "checkpoint" }>
  >;
  exports: number;
}

/**
 * REA's capture of a build computer's app, run inside the computer by REA's
 * controller: start it, take named checkpoints with their acknowledgements,
 * stop it and draft the task between `seed` and `end`, then export the
 * bundle with the agent's task and bring it back to this host.
 */
export class DesktopBuildCapture {
  #count = 0;
  #run: CaptureRun | undefined;

  constructor(
    private readonly computer: ControlledComputer,
    private readonly desktopEntry: string | undefined,
  ) {}

  async start(
    input: { readonly arguments?: readonly string[] },
    signal: AbortSignal,
  ): Promise<
    Result<
      {
        readonly desktop_entry: string;
        readonly package_lists: number;
        readonly package_lists_error: string | null;
      },
      AnalysisError
    >
  > {
    const entry = this.desktopEntry;
    if (entry === undefined)
      return err(
        refused(
          START,
          "This computer was started from a bundle folder; REA captures the app of a computer started from a request, which installs REA inside it.",
          "Start a computer from a request with start_build_computer and capture its app there.",
        ),
      );
    const status = this.#run?.status;
    if (status === "running" || status === "stopping")
      return err(
        refused(
          START,
          "A capture is already running on this computer.",
          "Stop it with stop_build_capture before starting another.",
        ),
      );
    this.#count += 1;
    const run: CaptureRun = {
      folder: `${WORK}/captures/${String(this.#count)}`,
      status: "running",
      checkpoints: new Map(),
      exports: 0,
    };
    this.#run = run;
    try {
      const answer = await controller(
        this.computer,
        "start",
        {
          work: WORK,
          capture: run.folder,
          desktop_entry: entry,
          arguments: [...(input.arguments ?? [])],
          timeout_s: 120,
          apt_timeout_s: 600,
        },
        { timeoutS: 720, signal },
      );
      const event =
        answer.line === undefined ? undefined : eventOf(answer.line);
      if (event?.kind !== "window_open") {
        run.status = "failed";
        if (answer.timed_out === true)
          await controller(
            this.computer,
            "stop",
            { capture: run.folder, timeout_s: 60 },
            { timeoutS: 60, signal },
          ).catch(() => undefined);
        return err(notAnswered(START, answer));
      }
      return ok({
        desktop_entry: entry,
        package_lists: answer.apt?.lists ?? 0,
        package_lists_error: answer.apt?.error ?? null,
      });
    } catch (cause: unknown) {
      run.status = "failed";
      return err(adapterError(START, errorText(cause), cause));
    }
  }

  async mark(
    name: string,
    signal: AbortSignal,
  ): Promise<
    Result<
      Omit<Extract<DesktopCaptureEvent, { kind: "checkpoint" }>, "kind">,
      AnalysisError
    >
  > {
    const run = this.#run;
    if (run?.status !== "running")
      return err(
        refused(
          MARK,
          "No capture is running on this computer.",
          "Start one with start_build_capture.",
        ),
      );
    if (run.checkpoints.has(name))
      return err(
        refused(
          MARK,
          `A checkpoint named ${name} was already taken.`,
          "Each name is taken once per capture; use another name, or capture again to retake it.",
        ),
      );
    try {
      const answer = await controller(
        this.computer,
        "mark",
        { capture: run.folder, name, timeout_s: 600 },
        { timeoutS: 600, signal },
      );
      const event =
        answer.line === undefined ? undefined : eventOf(answer.line);
      if (event?.kind === "checkpoint_refused")
        return err(refused(MARK, event.reason, "Use another checkpoint name."));
      if (event?.kind !== "checkpoint") {
        if (answer.exited !== undefined) run.status = "failed";
        return err(notAnswered(MARK, answer));
      }
      run.checkpoints.set(name, event);
      const { kind: _kind, ...taken } = event;
      return ok(taken);
    } catch (cause: unknown) {
      return err(adapterError(MARK, errorText(cause), cause));
    }
  }

  async stop(
    signal: AbortSignal,
  ): Promise<Result<StoppedCapture, AnalysisError>> {
    const run = this.#run;
    if (run?.status !== "running")
      return err(
        refused(
          STOP,
          "No capture is running on this computer.",
          "Start one with start_build_capture.",
        ),
      );
    run.status = "stopping";
    try {
      const answer = await controller(
        this.computer,
        "stop",
        { capture: run.folder, timeout_s: 600 },
        { timeoutS: 600, signal },
      );
      if (answer.exit_code === undefined || answer.output_bytes === undefined) {
        run.status = "running";
        return err(notAnswered(STOP, answer));
      }
      run.status = "stopped";
      const output = await readOutput(
        this.computer,
        `${run.folder}/capture.out`,
        answer.output_bytes,
        signal,
      );
      if (output.kind === "failure") {
        run.status = "failed";
        return err(
          adapterError(STOP, `The capture failed: ${output.failure.message}`),
        );
      }
      const capture = desktopApplicationCaptureSchema.parse(output.result);
      const { package: installed } = capture.application;
      return ok({
        end_reason: capture.session.end_reason,
        checkpoints: capture.state.checkpoints.map((checkpoint) => ({
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
        limitations: [...capture.limitations],
        ...(await this.#draft(run, signal)),
      });
    } catch (cause: unknown) {
      if (run.status === "stopping") run.status = "running";
      return err(adapterError(STOP, errorText(cause), cause));
    }
  }

  /** The task draft between `seed` and `end`, or why there is none. */
  async #draft(
    run: CaptureRun,
    signal: AbortSignal,
  ): Promise<Pick<StoppedCapture, "draft" | "draft_refusal">> {
    const missing = [SEED_CHECKPOINT, END_CHECKPOINT].filter(
      (name) => !run.checkpoints.has(name),
    );
    if (missing.length > 0)
      return {
        draft: null,
        draft_refusal: `No draft: the capture has no ${missing.join(" or ")} checkpoint; capture again and mark ${SEED_CHECKPOINT} once the seed is saved and ${END_CHECKPOINT} once the edit is.`,
      };
    const stdout = `${run.folder}/draft.json`;
    const bytes = await runRea(
      this.computer,
      [
        "describe-desktop-application-task",
        `${run.folder}/capture`,
        ...ENDS,
        "--json",
      ],
      { stdout, signal },
    );
    const output = await readOutput(this.computer, stdout, bytes, signal);
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
      },
    };
  }

  /** Export the bundle with the agent's task inside the computer and write it to a folder on this host. */
  async export(
    input: BuildExportRequest,
    signal: AbortSignal,
  ): Promise<Result<ExportedBuild, AnalysisError>> {
    const run = this.#run;
    if (
      run?.status !== "stopped" ||
      !run.checkpoints.has(SEED_CHECKPOINT) ||
      !run.checkpoints.has(END_CHECKPOINT)
    )
      return err(
        refused(
          EXPORT,
          `Export needs a stopped capture with ${SEED_CHECKPOINT} and ${END_CHECKPOINT} checkpoints; capture with start_build_capture, mark both and stop it.`,
          "Capture with start_build_capture, mark seed and end, then call stop_build_capture.",
        ),
      );
    run.exports += 1;
    return exportBuild(
      this.computer,
      { folder: run.folder, attempt: run.exports },
      input,
      signal,
    );
  }
}

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
  } | null;
  readonly draft_refusal?: string;
};

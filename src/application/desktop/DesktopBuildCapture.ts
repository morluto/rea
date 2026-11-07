import { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { BuildRequest } from "../../domain/desktop/appBuild.js";
import type { KnownSecret } from "../../domain/desktop/buildSecrets.js";
import {
  BUILD_PACKAGE_FILE,
  extraPackagesOf,
} from "../../domain/desktop/appBuild.js";
import {
  END_CHECKPOINT,
  SEED_CHECKPOINT,
} from "../../domain/desktop/buildCapture.js";
import {
  desktopCaptureProgressSchema,
  type DesktopCaptureEvent,
} from "../../domain/desktop/desktopCapture.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok, type Result } from "../../domain/result.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import type { ControlledComputer } from "../../desktop/BuildComputerController.js";
import {
  endedCapture,
  notAnswered,
  type CaptureStep,
} from "./DesktopBuildCaptureFailure.js";
import {
  adapterError,
  controller,
  errorText,
  refused,
  WORK,
  type Answer,
} from "./DesktopBuildCommands.js";
import {
  exportBuild,
  type BuildExportRequest,
  type ExportedBuild,
} from "./DesktopBuildExport.js";
import {
  summarizeCapture,
  type StoppedCapture,
} from "./DesktopBuildSummary.js";

const START = "start_build_capture";
const MARK = "mark_build_checkpoint";
const STOP = "stop_build_capture";
const EXPORT = "export_build_environment";
/** The start's step, for a capture that ended before the app's window opened. */
const STARTING: CaptureStep = {
  operation: START,
  when: "before the app's window opened",
  afterAppExit:
    "The app does not run as installed: check what it needs, such as a runtime its stderr names, and name that package in an archive install's extra_packages, or install the app from another source, on a new build computer; close this one.",
};
/** A checkpoint's step, for a capture that ended before acknowledging it. */
const marking = (name: string): CaptureStep => ({
  operation: MARK,
  when: `before checkpoint ${name}`,
  afterAppExit:
    "The capture ended with the app: stop_build_capture reads what it recorded, then start_build_capture captures again.",
});
const NOT_RUNNING = [
  "No capture is running on this computer.",
  "Start one with start_build_capture.",
] as const;

/** What the agent asks of a capture's launch: arguments for the app, and files or folders in the home that are its state. */
export interface CaptureInput {
  readonly arguments?: readonly string[] | undefined;
  readonly state_paths?: readonly string[] | undefined;
}

/** A taken checkpoint as the tool reports it: changed files null when the REA in the computer predates them. */
type CheckpointTaken = Omit<
  Extract<DesktopCaptureEvent, { kind: "checkpoint" }>,
  "kind" | "changed_files" | "more_changed_files"
> & {
  readonly changed_files: string[] | null;
  readonly more_changed_files: number | null;
};

/** The capture's progress event in a line the controller waited for. */
const eventOf = (line: string): DesktopCaptureEvent | undefined =>
  desktopCaptureProgressSchema.parse(JSON.parse(line)).rea_progress.event;

/**
 * One capture in the computer. `unreleased` is a capture that may be
 * running although its start failed, kept until a stop is confirmed;
 * `stopped` keeps the stop's result once it was read, so a retried stop
 * resumes or repeats it.
 */
interface CaptureRun {
  readonly folder: string;
  status: "running" | "unreleased" | "stopped" | "released";
  /** Checkpoints the capture acknowledged, then those its own Evidence records. */
  checkpoints: Set<string>;
  /** The capture's package installs only from its file, so the export takes the request's URL. */
  packageFile?: boolean;
  outputBytes?: number;
  stopped?: StoppedCapture;
  exports: number;
}

/** The capture of a failed start may still run; REA still owns it. */
const unreleasedError = (
  operation: string,
  run: CaptureRun,
  cause: AnalysisError | undefined,
) =>
  new ProviderAdapterError(AGENTENV_PROVIDER, operation, {
    userMessage: `The capture REA began in ~/${run.folder} could not be confirmed stopped${cause === undefined ? "" : ` after: ${cause.message}`}.`,
    remediationAction:
      "Call start_build_capture again, which retries its stop first, or close the computer.",
    cleanup: {
      reason: "its stop was not confirmed",
      resources: [`~/${run.folder}`],
    },
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * REA's capture of a build computer's app, run inside the computer by REA's
 * controller: start it, take named checkpoints with their acknowledgements,
 * stop it and draft the task between `seed` and `end`, then export the
 * bundle with the agent's task and bring it back to this host. Every step
 * can be asked again after a lost answer.
 */
export class DesktopBuildCapture {
  #count = 0;
  #run: CaptureRun | undefined;
  readonly #entry: string | undefined;
  readonly #packageFile: { readonly url: string } | undefined;
  /** What the request named beside the app, which the export installs too, so a package file's dependencies outlive an install by name. */
  readonly #extraPackages: readonly string[];

  /** `secrets` lists the secrets no exported bundle may hold. */
  constructor(
    private readonly computer: ControlledComputer,
    request: BuildRequest | undefined,
    private readonly secrets: () => Promise<readonly KnownSecret[]> = () =>
      Promise.resolve([]),
  ) {
    this.#entry = request?.desktop_entry;
    this.#packageFile =
      request?.install.kind === "package_file"
        ? { url: request.install.url }
        : undefined;
    this.#extraPackages = request === undefined ? [] : extraPackagesOf(request);
  }

  async start(
    input: CaptureInput,
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
    const entry = this.#entry;
    if (entry === undefined)
      return err(
        refused(
          START,
          "This computer was started from a bundle folder; REA captures the app of a computer started from a request, which installs REA inside it.",
          "Start a computer from a request with start_build_computer and capture its app there.",
        ),
      );
    const previous = this.#run;
    if (previous?.status === "running")
      return err(
        refused(
          START,
          "A capture is already running on this computer.",
          "Stop it with stop_build_capture before starting another.",
        ),
      );
    if (
      previous?.status === "unreleased" &&
      !(await this.#release(previous, signal))
    )
      return err(unreleasedError(START, previous, undefined));
    this.#count += 1;
    const run: CaptureRun = {
      folder: `${WORK}/captures/${String(this.#count)}`,
      status: "running",
      checkpoints: new Set(),
      exports: 0,
    };
    this.#run = run;
    const started = await this.#launch(run, entry, input, signal);
    if (started.ok) return started;
    // An answer naming no live capture means none runs; anything else may have left one running.
    const released =
      started.error.answer !== undefined &&
      started.error.answer.timed_out !== true;
    if (released) run.status = "released";
    else if (!(await this.#release(run, signal)))
      return err(unreleasedError(START, run, started.error.failure));
    return err(started.error.failure);
  }

  async #launch(
    run: CaptureRun,
    entry: string,
    input: CaptureInput,
    signal: AbortSignal,
  ): Promise<
    Result<
      {
        readonly desktop_entry: string;
        readonly package_lists: number;
        readonly package_lists_error: string | null;
      },
      { readonly failure: AnalysisError; readonly answer?: Answer }
    >
  > {
    let answer: Answer;
    try {
      answer = await controller(
        this.computer,
        "start",
        {
          work: WORK,
          capture: run.folder,
          desktop_entry: entry,
          arguments: [...(input.arguments ?? [])],
          state_paths: [...(input.state_paths ?? [])],
          ...(this.#packageFile === undefined
            ? {}
            : { package_file: BUILD_PACKAGE_FILE }),
          timeout_s: 120,
          apt_timeout_s: 600,
        },
        { timeoutS: 720, signal },
      );
    } catch (cause: unknown) {
      return err({ failure: adapterError(START, errorText(cause), cause) });
    }
    if (answer.refused !== undefined)
      return err({
        failure: refused(
          START,
          answer.refused,
          "Name files or folders under the computer's home in state_paths, relative to it or absolute, with no link on the way leading out of it.",
        ),
        answer,
      });
    const event = answer.line === undefined ? undefined : eventOf(answer.line);
    if (event?.kind !== "window_open")
      return err({
        failure: await endedCapture(
          this.computer,
          { ...STARTING, folder: run.folder },
          answer,
          signal,
        ),
        answer,
      });
    return ok({
      desktop_entry: entry,
      package_lists: answer.apt?.lists ?? 0,
      package_lists_error: answer.apt?.error ?? null,
    });
  }

  /** Stop a capture whose start failed; true once the computer confirms it ended or never launched. */
  async #release(run: CaptureRun, signal: AbortSignal): Promise<boolean> {
    try {
      const answer = await controller(
        this.computer,
        "stop",
        { capture: run.folder, timeout_s: 120 },
        { timeoutS: 120, signal },
      );
      const confirmed =
        answer.absent === true || typeof answer.exit_code === "number";
      run.status = confirmed ? "released" : "unreleased";
      return confirmed;
    } catch {
      run.status = "unreleased";
      return false;
    }
  }

  async mark(
    name: string,
    signal: AbortSignal,
  ): Promise<Result<CheckpointTaken, AnalysisError>> {
    const run = this.#run;
    if (run?.status !== "running") return err(refused(MARK, ...NOT_RUNNING));
    if (run.checkpoints.has(name))
      return err(
        refused(
          MARK,
          `A checkpoint named ${name} was already taken.`,
          "Each name is taken once per capture; use another name, or capture again to retake it.",
        ),
      );
    try {
      // A checkpoint the capture already took, whose answer was lost, comes back from its log.
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
      if (event?.kind !== "checkpoint")
        return err(
          await endedCapture(
            this.computer,
            { ...marking(name), folder: run.folder },
            answer,
            signal,
          ),
        );
      run.checkpoints.add(name);
      const {
        kind: _kind,
        changed_files: changed,
        more_changed_files: more,
        ...taken
      } = event;
      return ok({
        ...taken,
        changed_files: changed ?? null,
        more_changed_files: more ?? null,
      });
    } catch (cause: unknown) {
      return err(adapterError(MARK, errorText(cause), cause));
    }
  }

  /** Stop the capture, read what it recorded and draft the task; asked again, it resumes or repeats the result. */
  async stop(
    signal: AbortSignal,
  ): Promise<Result<StoppedCapture, AnalysisError>> {
    const run = this.#run;
    if (run?.status === "unreleased")
      return (await this.#release(run, signal))
        ? err(
            refused(
              STOP,
              `The capture of the failed start in ~/${run.folder} is now stopped; no capture is running.`,
              "Start one with start_build_capture.",
            ),
          )
        : err(unreleasedError(STOP, run, undefined));
    if (run === undefined || run.status === "released")
      return err(refused(STOP, ...NOT_RUNNING));
    if (run.stopped !== undefined) return ok(run.stopped);
    try {
      if (run.outputBytes === undefined) {
        const answer = await controller(
          this.computer,
          "stop",
          { capture: run.folder, timeout_s: 600 },
          { timeoutS: 600, signal },
        );
        if (answer.exit_code === undefined || answer.output_bytes === undefined)
          return err(notAnswered(STOP, answer));
        run.status = "stopped";
        run.outputBytes = answer.output_bytes;
      }
      const summary = await summarizeCapture(
        this.computer,
        { folder: run.folder, outputBytes: run.outputBytes },
        signal,
      );
      if (!summary.ok) {
        run.status = "released";
        return summary;
      }
      run.checkpoints = summary.value.checkpoints;
      run.packageFile = summary.value.packageFile;
      run.stopped = summary.value.stopped;
      return ok(summary.value.stopped);
    } catch (cause: unknown) {
      return err(
        cause instanceof AnalysisError
          ? cause
          : adapterError(STOP, errorText(cause), cause),
      );
    }
  }

  /** Export the bundle with the agent's task inside the computer and write it to a folder on this host. */
  async export(
    input: BuildExportRequest,
    signal: AbortSignal,
  ): Promise<Result<ExportedBuild, AnalysisError>> {
    const run = this.#run;
    if (
      run?.stopped === undefined ||
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
      {
        folder: run.folder,
        attempt: run.exports,
        ...(this.#packageFile === undefined || run.packageFile !== true
          ? {}
          : { packageUrl: this.#packageFile.url }),
        extraPackages: this.#extraPackages,
        secrets: await this.secrets(),
      },
      input,
      signal,
    );
  }
}

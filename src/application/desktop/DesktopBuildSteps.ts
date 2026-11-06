import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { ProgressReporter } from "../ProgressReporter.js";
import type { StoppedCapture } from "./DesktopBuildSummary.js";
import type {
  BuildComputerSteps,
  DesktopBuildComputers,
  ForwardedResult,
} from "./DesktopBuildComputers.js";
import type { ExportedBuild } from "./DesktopBuildExport.js";
import type {
  CheckedTask,
  DesktopBuildWitness,
} from "./DesktopBuildWitness.js";

const unknownComputer = (operation: string) =>
  new AnalysisInputError(operation, {
    userMessage:
      "No build computer has this id in this REA server; start one with start_build_computer.",
    remediationAction: "Start one with start_build_computer.",
    conformsToInputContract: true,
  });

type Identified<Value> = { readonly computer_id: string } & Value;

/**
 * The build steps on a held computer: REA's capture of its app, the draft,
 * the export and the task's witness, each named by the computer's id.
 */
export class DesktopBuildSteps {
  constructor(
    private readonly computers: Pick<DesktopBuildComputers, "steps">,
  ) {}

  /** Start REA's capture of the computer's app, inside the computer, and show the opened app. */
  async startCapture(
    input: {
      readonly computer_id: string;
      readonly arguments?: readonly string[] | undefined;
      readonly state_paths?: readonly string[] | undefined;
    },
    signal: AbortSignal,
  ): Promise<
    Result<
      ForwardedResult<
        Identified<{
          readonly desktop_entry: string;
          readonly package_lists: number;
          readonly package_lists_error: string | null;
          readonly screenshot: Readonly<Record<string, JsonValue>> | null;
        }>
      >,
      AnalysisError
    >
  > {
    const steps = this.computers.steps(input.computer_id);
    if (steps === undefined) return err(unknownComputer("start_build_capture"));
    // The screenshot of the opened app takes the same turn as the start.
    return steps.turns.run("start_build_capture", signal, async (turn) => {
      const { computer_id: _id, ...launch } = input;
      const started = await steps.capture.start(launch, turn);
      if (!started.ok) return started;
      // A failed screenshot only leaves it out, but a close or abort meanwhile cancels the start: it saved nothing to report.
      const shot = await steps.computer
        .callTool("computer_screenshot", {}, turn)
        .catch(() => undefined);
      if (turn.aborted)
        return err(
          new AnalysisCancelledError("start_build_capture", {
            cause: turn.reason,
          }),
        );
      return ok({
        value: {
          computer_id: input.computer_id,
          ...started.value,
          screenshot:
            shot === undefined || shot.isError ? null : shot.structured,
        },
        content: shot === undefined || shot.isError ? [] : shot.content,
      });
    });
  }

  markCheckpoint(
    input: { readonly computer_id: string; readonly name: string },
    signal: AbortSignal,
  ) {
    return this.#on(
      input.computer_id,
      "mark_build_checkpoint",
      signal,
      async (steps, turn) => {
        const taken = await steps.capture.mark(input.name, turn);
        return taken.ok ? ok({ checkpoint: taken.value }) : taken;
      },
    );
  }

  stopCapture(
    input: { readonly computer_id: string },
    signal: AbortSignal,
  ): Promise<Result<Identified<StoppedCapture>, AnalysisError>> {
    return this.#on(
      input.computer_id,
      "stop_build_capture",
      signal,
      (steps, turn) => steps.capture.stop(turn),
    );
  }

  exportEnvironment(
    input: Parameters<BuildComputerSteps["capture"]["export"]>[0] & {
      readonly computer_id: string;
    },
    signal: AbortSignal,
  ): Promise<Result<Identified<ExportedBuild>, AnalysisError>> {
    const { computer_id: id, ...request } = input;
    return this.#on(id, "export_build_environment", signal, (steps, turn) =>
      steps.capture.export(request, turn),
    );
  }

  checkTask(
    input: Parameters<DesktopBuildWitness["check"]>[0] & {
      readonly computer_id: string;
    },
    signal: AbortSignal,
    progress?: ProgressReporter,
  ): Promise<Result<Identified<CheckedTask>, AnalysisError>> {
    const { computer_id: id, ...request } = input;
    return this.#on(id, "check_build_task", signal, (steps, turn) =>
      steps.witness.check(request, turn, progress),
    );
  }

  /** Run one step on a held computer, on its turn among the computer's calls, and name the computer in its result. */
  async #on<Value extends object>(
    id: string,
    operation: string,
    signal: AbortSignal,
    run: (
      steps: BuildComputerSteps,
      signal: AbortSignal,
    ) => Promise<Result<Value, AnalysisError>>,
  ): Promise<Result<Identified<Value>, AnalysisError>> {
    const steps = this.computers.steps(id);
    if (steps === undefined) return err(unknownComputer(operation));
    const result = await steps.turns.run(operation, signal, (turn) =>
      run(steps, turn),
    );
    return result.ok ? ok({ computer_id: id, ...result.value }) : result;
  }
}

import {
  processCaptureCancelled,
  type ProcessCaptureError,
} from "./ProcessCaptureError.js";
import { captureProcessScenario } from "./ProcessHarness.js";
import type {
  ProcessCapture,
  ProcessExecutionPolicy,
  ProcessScenario,
} from "../domain/processCapture.js";
import { compareProcessCaptures } from "../domain/processComparison.js";
import { PROCESS_COMPARISON_DIMENSIONS } from "../domain/processComparison.js";
import {
  analyzeProcessRepeatability,
  bindProcessScenario,
  type ProcessPairedExperiment,
} from "../domain/processPairedExperiment.js";
import { err, ok, type Result } from "../domain/result.js";

/** Capture seam used by paired process experiments. */
export interface ProcessCapturePort {
  capture(
    scenario: ProcessScenario,
    policy: ProcessExecutionPolicy,
    signal?: AbortSignal,
  ): Promise<Result<ProcessCapture, ProcessCaptureError>>;
}

interface PairedProcessExperimentEvidence {
  readonly authority_runs: readonly ProcessCapture[];
  readonly candidate_runs: readonly ProcessCapture[];
  readonly authority_repeatability: ReturnType<
    typeof analyzeProcessRepeatability
  >;
  readonly candidate_repeatability: ReturnType<
    typeof analyzeProcessRepeatability
  >;
}

/** Repeatability evidence and either a stable comparison or its blocking reason. */
export type PairedProcessExperimentResult = PairedProcessExperimentEvidence &
  (
    | {
        readonly cross_side: ReturnType<typeof compareProcessCaptures>;
        readonly cross_side_blocked_reason: null;
      }
    | {
        readonly cross_side: null;
        readonly cross_side_blocked_reason: string;
      }
  );

const productionCapturePort: ProcessCapturePort = {
  capture: captureProcessScenario,
};

const captureRepeats = async (input: {
  readonly scenario: ProcessScenario;
  readonly repeatCount: number;
  readonly policy: ProcessExecutionPolicy;
  readonly port: ProcessCapturePort;
  readonly signal?: AbortSignal;
}): Promise<Result<readonly ProcessCapture[], ProcessCaptureError>> => {
  const captures: ProcessCapture[] = [];
  for (let index = 0; index < input.repeatCount; index += 1) {
    if (input.signal?.aborted === true) return err(processCaptureCancelled());
    const capture = await input.port.capture(
      input.scenario,
      input.policy,
      input.signal,
    );
    if (!capture.ok) return err(capture.error);
    captures.push(capture.value);
  }
  return ok(captures);
};

/** Execute repeatability-first authority/candidate captures under one contract. */
export const runPairedProcessExperiment = async (
  experiment: ProcessPairedExperiment,
  policy: ProcessExecutionPolicy,
  options: {
    readonly signal?: AbortSignal;
    readonly capturePort?: ProcessCapturePort;
    readonly now?: () => number;
  } = {},
): Promise<Result<PairedProcessExperimentResult, ProcessCaptureError>> => {
  const port = options.capturePort ?? productionCapturePort;
  const authorityScenario = bindProcessScenario(
    experiment.shared_scenario,
    experiment.authority,
  );
  const candidateScenario = bindProcessScenario(
    experiment.shared_scenario,
    experiment.candidate,
  );
  const authorityRuns = await captureRepeats({
    scenario: authorityScenario,
    repeatCount: experiment.repeat_count,
    policy,
    port,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!authorityRuns.ok) return authorityRuns;
  const candidateRuns = await captureRepeats({
    scenario: candidateScenario,
    repeatCount: experiment.repeat_count,
    policy,
    port,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!candidateRuns.ok) return candidateRuns;
  const authorityRepeatability = analyzeProcessRepeatability(
    authorityRuns.value,
    experiment.required_dimensions,
  );
  const candidateRepeatability = analyzeProcessRepeatability(
    candidateRuns.value,
    experiment.required_dimensions,
  );
  const stable = authorityRepeatability.stable && candidateRepeatability.stable;
  const allDimensionsRequired = PROCESS_COMPARISON_DIMENSIONS.every(
    (dimension) => experiment.required_dimensions.includes(dimension),
  );
  const authorityLatest = authorityRuns.value.at(-1);
  const candidateLatest = candidateRuns.value.at(-1);
  const crossSideOutcome =
    stable &&
    allDimensionsRequired &&
    authorityLatest !== undefined &&
    candidateLatest !== undefined
      ? {
          cross_side: compareProcessCaptures(authorityLatest, candidateLatest, {
            maxCaptureAgeMs: experiment.freshness_policy.max_capture_age_ms,
            ...(options.now === undefined ? {} : { now: options.now }),
          }),
          cross_side_blocked_reason: null,
        }
      : {
          cross_side: null,
          cross_side_blocked_reason: !allDimensionsRequired
            ? "Cross-side comparison is blocked until every returned dimension is required and repeatable."
            : "Cross-side comparison is blocked because a required same-side dimension is unstable.",
        };
  return ok({
    authority_runs: authorityRuns.value,
    candidate_runs: candidateRuns.value,
    authority_repeatability: authorityRepeatability,
    candidate_repeatability: candidateRepeatability,
    ...crossSideOutcome,
  });
};

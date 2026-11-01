import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import type { ProcessScenario } from "../../domain/process/processScenario.js";
import { processCaptureOwnershipUnavailableReason } from "../../process/capture/ProcessCaptureCapability.js";
import { resolveProcessScenarioRuntimePaths } from "../../process/capture/ProcessScenarioRuntimeValidation.js";
import { err, ok, type Result } from "../../domain/result.js";

/** A scenario whose executable and observation paths are resolved for execution. */
export type ResolvedProcessScenario = Omit<ProcessScenario, "dry_run">;

/**
 * Resolve a scenario for a dry run. This applies the same executable, working
 * directory, path and platform admission checks as a capture, then stops
 * before any process is launched.
 */
export const prepareProcessScenarioPlan = async (
  scenario: ProcessScenario,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal,
): Promise<Result<ResolvedProcessScenario, AnalysisError>> => {
  if (signal?.aborted === true)
    return err(
      new AnalysisCancelledError("capture_process_scenario", {
        cause: signal.reason,
      }),
    );
  const ownershipReason = processCaptureOwnershipUnavailableReason(platform);
  if (ownershipReason !== undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        "rea-process",
        "capture_process_scenario",
        ownershipReason,
        { userMessage: ownershipReason },
      ),
    );
  try {
    const { dry_run: _dryRun, ...resolved } =
      await resolveProcessScenarioRuntimePaths(scenario, environment, platform);
    return ok(resolved);
  } catch (cause: unknown) {
    return err(
      cause instanceof AnalysisError
        ? cause
        : new AnalysisInputError("capture_process_scenario", { cause }, []),
    );
  }
};

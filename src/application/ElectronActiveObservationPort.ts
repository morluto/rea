import type { ExecutionOptions, ProviderIdentity } from "./AnalysisProvider.js";
import type { AnalysisError } from "../domain/errors.js";
import type {
  ElectronActiveObservationInput,
  ElectronActiveObservationResult,
} from "../domain/electronActiveObservation.js";
import type { Result } from "../domain/result.js";

/** Provider-neutral boundary for owned Electron runtime experiments. */
export interface ElectronActiveObservationPort {
  identity(): ProviderIdentity;
  capture(
    input: ElectronActiveObservationInput,
    options?: ExecutionOptions,
  ): Promise<Result<ElectronActiveObservationResult, AnalysisError>>;
}

import type { ExecutionOptions, ProviderIdentity } from "./AnalysisProvider.js";
import type { AnalysisError } from "../domain/errors.js";
import type {
  ElectronPageInspection,
  ElectronTargetList,
  InspectElectronPageInput,
  ListElectronTargetsInput,
} from "../domain/electronObservation.js";
import type { Result } from "../domain/result.js";

/** Provider-neutral boundary for root-confined Electron file-page observation. */
export interface ElectronObservationPort {
  identity(): ProviderIdentity;
  listTargets(
    input: ListElectronTargetsInput,
    options?: ExecutionOptions,
  ): Promise<Result<ElectronTargetList, AnalysisError>>;
  inspectPage(
    input: InspectElectronPageInput,
    options?: ExecutionOptions,
  ): Promise<Result<ElectronPageInspection, AnalysisError>>;
}

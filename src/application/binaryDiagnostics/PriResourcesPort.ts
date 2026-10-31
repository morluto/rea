import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectPriResourcesInput,
  PriResources,
} from "../../domain/native/priResources.js";
import type { Result } from "../../domain/result.js";

/** Stable read and PRI decoding boundary, independent of an active analysis session. */
export interface PriResourcesPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectPriResourcesInput,
    options?: ExecutionOptions,
  ): Promise<Result<PriResources, AnalysisError>>;
}

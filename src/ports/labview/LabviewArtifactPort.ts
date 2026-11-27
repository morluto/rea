import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectLabviewArtifactInput,
  LabviewArtifact,
} from "../../domain/labview/labviewArtifact.js";
import type { Result } from "../../domain/result.js";

/** Replaceable offline RSRC reader with no target-execution authority. */
export interface LabviewArtifactPort {
  readonly identity: ProviderIdentity;
  close(): Promise<void>;
  inspect(
    input: InspectLabviewArtifactInput,
    options?: ExecutionOptions,
  ): Promise<Result<LabviewArtifact, AnalysisError>>;
}

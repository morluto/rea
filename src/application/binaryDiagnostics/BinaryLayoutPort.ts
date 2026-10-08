import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  BinaryLayout,
  InspectBinaryLayoutInput,
} from "../../domain/native/binaryLayout.js";
import type { Result } from "../../domain/result.js";
import type { ProviderIdentity } from "../AnalysisProvider.js";

/** Replaceable offline binary-layout provider; owns its parser and process protocol. */
export interface BinaryLayoutPort {
  readonly identity: ProviderIdentity;
  inspect(
    input: InspectBinaryLayoutInput,
    options?: ExecutionOptions,
  ): Promise<Result<BinaryLayout, AnalysisError>>;
}

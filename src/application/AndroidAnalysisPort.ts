import type {
  AnalysisExecution,
  ExecutionOptions,
} from "./AnalysisProvider.js";
import type { AndroidRequest } from "../domain/androidAnalysis.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";

/** Static Android inspection boundary; implementation details belong to the provider. */
export interface AndroidAnalysisPort {
  execute(
    target: BinaryTarget,
    request: AndroidRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}

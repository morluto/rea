import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import type { AndroidRequest } from "../../domain/android/androidAnalysis.js";
import type { BinaryTarget } from "../../domain/binaryTarget.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";

/** Static Android inspection boundary; implementation details belong to the provider. */
export interface AndroidAnalysisPort {
  /** Cancel active work and join cleanup of any retained provider resources. */
  close(): Promise<void>;
  execute(
    target: BinaryTarget,
    request: AndroidRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JavaScriptRecoveryInput } from "../domain/javascriptRecovery.js";
import type { Result } from "../domain/result.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "./AnalysisProvider.js";

/** Typed boundary for upstream source recovery without exposing its protocol. */
export interface JavaScriptRecoveryPort {
  recover(
    input: JavaScriptRecoveryInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}

import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import type { HarmonyAbcRequest } from "../../domain/harmony/harmonyAbcAnalysis.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";

/** File-oriented HarmonyOS Ark bytecode engines; bridge admission stays separate. */
export interface HarmonyAbcAnalysisPort {
  close?(): Promise<void>;
  execute(
    request: HarmonyAbcRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}

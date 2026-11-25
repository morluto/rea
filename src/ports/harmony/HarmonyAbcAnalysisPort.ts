import type {
  AnalysisExecution,
  ExecutionOptions,
  ProviderAvailability,
} from "../AnalysisProvider.js";
import type {
  HarmonyAbcOperation,
  HarmonyAbcRequest,
} from "../../domain/harmony/harmonyAbcAnalysis.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";

/** Readiness and the producer surface a configured checkout advertises. */
export type HarmonyAbcAnalysisAvailability =
  | (Extract<ProviderAvailability, { status: "available" }> & {
      readonly supportedOperations: readonly HarmonyAbcOperation[];
    })
  | Extract<ProviderAvailability, { status: "unavailable" }>;

/** File-oriented HarmonyOS Ark bytecode engines; bridge admission stays separate. */
export interface HarmonyAbcAnalysisPort {
  close?(): Promise<void>;
  execute(
    request: HarmonyAbcRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}

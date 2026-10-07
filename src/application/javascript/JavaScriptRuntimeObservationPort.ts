import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type {
  JavaScriptRuntimeObservation,
  JavaScriptRuntimeTargetList,
  ListJavaScriptRuntimeTargetsInput,
  ObserveJavaScriptRuntimeInput,
} from "../../domain/javascriptRuntimeObservation.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";

/** Provider-neutral boundary for passive Node/Electron Inspector observation. */
export interface JavaScriptRuntimeObservationPort {
  identity(): ProviderIdentity;
  listTargets(
    input: ListJavaScriptRuntimeTargetsInput,
    options?: ExecutionOptions,
  ): Promise<Result<JavaScriptRuntimeTargetList, AnalysisError>>;
  observe(
    input: ObserveJavaScriptRuntimeInput,
    options?: ExecutionOptions,
  ): Promise<Result<JavaScriptRuntimeObservation, AnalysisError>>;
}

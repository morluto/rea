import type { ExecutionOptions, ProviderIdentity } from "./AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";
import type {
  ObserveWebExecutionInput,
  WebExecution,
} from "../domain/webExecution.js";
import type {
  InspectWebEventListenersInput,
  WebEventListeners,
} from "../domain/webEventListeners.js";

/** Provider-neutral live source attribution operations with distinct instrumentation authority. */
export interface WebRuntimePort {
  identity(): ProviderIdentity;
  observeExecution(
    input: ObserveWebExecutionInput,
    options?: ExecutionOptions,
  ): Promise<Result<WebExecution, AnalysisError>>;
  inspectEventListeners(
    input: InspectWebEventListenersInput,
    options?: ExecutionOptions,
  ): Promise<Result<WebEventListeners, AnalysisError>>;
}

import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { InspectWasmArtifactInput } from "../../domain/wasm/wasmArtifact.js";
import type { Result } from "../../domain/result.js";

/** Replaceable offline WASM inspection engine, independent of target execution and network clients. */
export interface WasmArtifactPort {
  inspect(
    input: InspectWasmArtifactInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}

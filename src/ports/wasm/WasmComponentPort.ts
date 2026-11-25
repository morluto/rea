import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  InspectWasmComponentInput,
  WasmComponent,
} from "../../domain/wasm/wasmComponent.js";

/** Replaceable offline component decoder with no instantiation or execution authority. */
export interface WasmComponentPort {
  readonly identity: ProviderIdentity;
  /** Retry cleanup of read resources whose release failed. */
  close(): Promise<void>;
  inspect(
    input: InspectWasmComponentInput,
    options?: ExecutionOptions,
  ): Promise<Result<WasmComponent, AnalysisError>>;
}

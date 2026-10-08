import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { InspectEvmInterfaceInput } from "../../domain/evm/evmInterface.js";
import type { Result } from "../../domain/result.js";

/** Replaceable offline interface-recovery engine, independent of wallets and chain clients. */
export interface EvmInterfacePort {
  inspect(
    input: InspectEvmInterfaceInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  EvmProxy,
  InspectEvmProxyInput,
} from "../../domain/evm/evmProxy.js";
import type { Result } from "../../domain/result.js";
import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";

/** Port for offline proxy recognition over one local bytecode carrier. */
export interface EvmProxyPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectEvmProxyInput,
    options?: ExecutionOptions,
  ): Promise<Result<EvmProxy, AnalysisError>>;
}

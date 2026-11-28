import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  SolidityMetadataVerification,
  VerifySolidityMetadataInput,
} from "../../domain/evm/solidityMetadataBinding.js";
import type { Result } from "../../domain/result.js";
import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";

/** Port for offline verification of a Solidity metadata commitment. */
export interface SolidityMetadataBindingPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: VerifySolidityMetadataInput,
    options?: ExecutionOptions,
  ): Promise<Result<SolidityMetadataVerification, AnalysisError>>;
}

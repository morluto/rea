import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  UnityAddressables,
  UnityAddressablesProviderInput,
} from "../../domain/unity/unityAddressables.js";
import type { Result } from "../../domain/result.js";

/** Replaceable offline catalog reader with no bundle, network or target-execution authority. */
export interface UnityAddressablesPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: UnityAddressablesProviderInput,
    options?: ExecutionOptions,
  ): Promise<Result<UnityAddressables, AnalysisError>>;
}

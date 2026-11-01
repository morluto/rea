import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectUnityAssetsInput,
  UnityAssets,
} from "../../domain/unity/unityAssets.js";
import type { Result } from "../../domain/result.js";

/** Stable read and SerializedFile decoding, independent of a disassembler session. */
export interface UnityAssetsPort {
  readonly identity: ProviderIdentity;
  close(): Promise<void>;
  inspect(
    input: InspectUnityAssetsInput,
    options?: ExecutionOptions,
  ): Promise<Result<UnityAssets, AnalysisError>>;
}

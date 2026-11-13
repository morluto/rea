import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  UnrealPak,
  UnrealPakProviderInput,
} from "../../domain/unreal/unrealPak.js";

/** Replaceable offline pak index reader with no extraction, decryption or decompression authority. */
export interface UnrealPakPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: UnrealPakProviderInput,
    options?: ExecutionOptions,
  ): Promise<Result<UnrealPak, AnalysisError>>;
}

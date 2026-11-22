import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectNativeInitializersInput,
  NativeInitializers,
} from "../../domain/native/nativeInitializers.js";
import type { Result } from "../../domain/result.js";

/** Stable read and initializer decode, independent of a disassembler session. */
export interface NativeInitializersPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectNativeInitializersInput,
    options?: ExecutionOptions,
  ): Promise<Result<NativeInitializers, AnalysisError>>;
}

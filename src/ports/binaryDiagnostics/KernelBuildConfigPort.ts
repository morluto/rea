import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectKernelBuildConfigInput,
  KernelBuildConfig,
} from "../../domain/native/kernelBuildConfig.js";
import type { Result } from "../../domain/result.js";

/** Stable read and kernel build-config decoding, independent of a disassembler session. */
export interface KernelBuildConfigPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectKernelBuildConfigInput,
    options?: ExecutionOptions,
  ): Promise<Result<KernelBuildConfig, AnalysisError>>;
}

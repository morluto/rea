import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  BinaryHardening,
  InspectBinaryHardeningInput,
} from "../../domain/native/binaryHardening.js";
import type { Result } from "../../domain/result.js";

/** Stable read and header hardening decode, independent of a disassembler session. */
export interface BinaryHardeningPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectBinaryHardeningInput,
    options?: ExecutionOptions,
  ): Promise<Result<BinaryHardening, AnalysisError>>;
}

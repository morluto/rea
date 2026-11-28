import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectPeUnwindRangesInput,
  PeUnwindRanges,
} from "../../domain/native/peUnwindRanges.js";
import type { Result } from "../../domain/result.js";

/** Stable read and x64 exception-directory decoding, independent of a disassembler session. */
export interface PeUnwindRangesPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectPeUnwindRangesInput,
    options?: ExecutionOptions,
  ): Promise<Result<PeUnwindRanges, AnalysisError>>;
}

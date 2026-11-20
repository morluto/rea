import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  ElfUnwindRanges,
  InspectElfUnwindRangesInput,
} from "../../domain/native/elfUnwindRanges.js";
import type { Result } from "../../domain/result.js";

/** Stable read and ELF unwind-table decoding, independent of a disassembler session. */
export interface ElfUnwindRangesPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectElfUnwindRangesInput,
    options?: ExecutionOptions,
  ): Promise<Result<ElfUnwindRanges, AnalysisError>>;
}

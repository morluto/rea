import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectMachoFunctionStartsInput,
  MachoFunctionStarts,
} from "../../domain/native/machoFunctionStarts.js";
import type { Result } from "../../domain/result.js";

/** Stable read and Mach-O function-start decoding, independent of a disassembler session. */
export interface MachoFunctionStartsPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectMachoFunctionStartsInput,
    options?: ExecutionOptions,
  ): Promise<Result<MachoFunctionStarts, AnalysisError>>;
}

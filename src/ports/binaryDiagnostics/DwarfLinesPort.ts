import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  DwarfLinesReport,
  InspectDwarfLinesInput,
} from "../../domain/native/dwarfLines.js";
import type { Result } from "../../domain/result.js";

/** Stable read and DWARF line-number program decoding, independent of a disassembler session. */
export interface DwarfLinesPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectDwarfLinesInput,
    options?: ExecutionOptions,
  ): Promise<Result<DwarfLinesReport, AnalysisError>>;
}

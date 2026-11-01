import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  DwarfUnitsReport,
  InspectDwarfUnitsInput,
} from "../../domain/native/dwarfUnits.js";
import type { Result } from "../../domain/result.js";

/** Stable read and DWARF compile-unit decoding, independent of a disassembler session. */
export interface DwarfUnitsPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectDwarfUnitsInput,
    options?: ExecutionOptions,
  ): Promise<Result<DwarfUnitsReport, AnalysisError>>;
}

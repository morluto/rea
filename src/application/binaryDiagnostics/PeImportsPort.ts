import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectPeImportsInput,
  PeImports,
} from "../../domain/native/peImports.js";
import type { Result } from "../../domain/result.js";

/** Stable read and PE imports decoding boundary, independent of an active disassembler session. */
export interface PeImportsPort {
  readonly identity: ProviderIdentity;
  inspect(
    input: InspectPeImportsInput,
    options?: ExecutionOptions,
  ): Promise<Result<any, AnalysisError>>;
}

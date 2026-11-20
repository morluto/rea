import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  ElfDependencies,
  InspectElfDependenciesInput,
} from "../../domain/native/elfDependencies.js";
import type { Result } from "../../domain/result.js";

/** Stable read and ELF dynamic-dependency decoding, independent of a disassembler session. */
export interface ElfDependenciesPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectElfDependenciesInput,
    options?: ExecutionOptions,
  ): Promise<Result<ElfDependencies, AnalysisError>>;
}

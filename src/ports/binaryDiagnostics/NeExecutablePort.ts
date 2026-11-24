import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectNeExecutableInput,
  NeExecutable,
} from "../../domain/native/neExecutable.js";
import type { Result } from "../../domain/result.js";

/** Stable read and NE decoding boundary, independent of an active disassembler session. */
export interface NeExecutablePort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectNeExecutableInput,
    options?: ExecutionOptions,
  ): Promise<Result<NeExecutable, AnalysisError>>;
}

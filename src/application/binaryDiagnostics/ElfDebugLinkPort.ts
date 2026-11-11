import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  ElfDebugLink,
  InspectElfDebugLinkInput,
} from "../../domain/native/elfDebugLink.js";
import type { Result } from "../../domain/result.js";

/** Stable read and separate-debug linkage decoding, independent of a disassembler session. */
export interface ElfDebugLinkPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectElfDebugLinkInput,
    options?: ExecutionOptions,
  ): Promise<Result<ElfDebugLink, AnalysisError>>;
}

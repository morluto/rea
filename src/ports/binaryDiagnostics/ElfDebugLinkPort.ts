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

/** Decoded linkage facts, including partial reports on failure; the application owns Evidence. */
export interface ElfDebugLinkPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectElfDebugLinkInput,
    options?: ExecutionOptions,
  ): Promise<Result<ElfDebugLink, AnalysisError>>;
}

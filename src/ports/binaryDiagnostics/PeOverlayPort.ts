import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectPeOverlayInput,
  PeOverlay,
} from "../../domain/native/peOverlay.js";
import type { Result } from "../../domain/result.js";

/** Stable read and PE overlay decoding, independent of a disassembler session. */
export interface PeOverlayPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectPeOverlayInput,
    options?: ExecutionOptions,
  ): Promise<Result<PeOverlay, AnalysisError>>;
}

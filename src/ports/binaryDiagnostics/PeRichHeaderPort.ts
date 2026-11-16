import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectPeRichHeaderInput,
  PeRichHeader,
} from "../../domain/native/peRichHeader.js";
import type { Result } from "../../domain/result.js";

/** Stable read and PE Rich header decoding, independent of a disassembler session. */
export interface PeRichHeaderPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectPeRichHeaderInput,
    options?: ExecutionOptions,
  ): Promise<Result<PeRichHeader, AnalysisError>>;
}

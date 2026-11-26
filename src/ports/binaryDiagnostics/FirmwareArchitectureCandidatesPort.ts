import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  FirmwareArchitectureCandidates,
  InspectFirmwareArchitectureCandidatesInput,
} from "../../domain/firmware/firmwareArchitectureCandidates.js";
import type { Result } from "../../domain/result.js";

/** Stable read and firmware CPU/endianness/base candidate scanning, independent of a disassembler session. */
export interface FirmwareArchitectureCandidatesPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectFirmwareArchitectureCandidatesInput,
    options?: ExecutionOptions,
  ): Promise<Result<FirmwareArchitectureCandidates, AnalysisError>>;
}

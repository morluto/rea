import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  FirmwareVectorTable,
  InspectFirmwareVectorTableInput,
} from "../../domain/firmware/firmwareVectorTable.js";
import type { Result } from "../../domain/result.js";

/** Port for read-only static firmware interrupt/trap vector table decoding. */
export interface FirmwareVectorTablePort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectFirmwareVectorTableInput,
    options?: ExecutionOptions,
  ): Promise<Result<FirmwareVectorTable, AnalysisError>>;
}

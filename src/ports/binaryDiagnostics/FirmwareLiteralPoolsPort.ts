import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  FirmwareLiteralPoolsReport,
  InspectFirmwareLiteralPoolsInput,
} from "../../domain/firmware/firmwareLiteralPools.js";
import type { Result } from "../../domain/result.js";

/** Port for read-only PC-relative literal-pool disassembly and MMIO pointer attribution. */
export interface FirmwareLiteralPoolsPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectFirmwareLiteralPoolsInput,
    options?: ExecutionOptions,
  ): Promise<Result<FirmwareLiteralPoolsReport, AnalysisError>>;
}

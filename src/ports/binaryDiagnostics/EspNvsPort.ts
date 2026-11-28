import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  EspNvsProviderInput,
  EspNvsReport,
} from "../../domain/firmware/espNvs.js";
import type { Result } from "../../domain/result.js";

/** Port for read-only static ESP-IDF Non-Volatile Storage (NVS) partition decoding. */
export interface EspNvsPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: EspNvsProviderInput,
    options?: ExecutionOptions,
  ): Promise<Result<EspNvsReport, AnalysisError>>;
}

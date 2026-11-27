import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  InspectYaraMatchesInput,
  YaraMatches,
  YaraScanSettings,
} from "../../domain/yara/yaraMatches.js";

/** One admitted scan: the validated request and its resolved controls. */
export interface YaraScanRequest {
  readonly input: InspectYaraMatchesInput;
  readonly settings: YaraScanSettings;
}

/** Runs the caller-selected yara command against one stable local file. */
export interface YaraMatchesPort {
  readonly identity: ProviderIdentity;
  close(): Promise<void>;
  inspect(
    request: YaraScanRequest,
    options?: ExecutionOptions,
  ): Promise<Result<YaraMatches, AnalysisError>>;
}

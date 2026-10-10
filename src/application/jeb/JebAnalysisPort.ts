import type {
  AnalysisExecution,
  ExecutionOptions,
  ProviderAvailability,
} from "../AnalysisProvider.js";
import type { JebRequest } from "../../domain/jeb/jebAnalysis.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";

/**
 * JEB inspection boundary served by a caller-supplied running engine client.
 * Implementation details belong to the provider adapter.
 */
export interface JebAnalysisPort {
  /** Probe the running JEB client without opening a project. */
  inspectAvailability(signal?: AbortSignal): Promise<ProviderAvailability>;
  /** Release engine connection state; the JEB client itself keeps running. */
  close(): Promise<void>;
  execute(
    request: JebRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}

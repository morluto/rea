import type {
  AnalysisExecution,
  ExecutionOptions,
  ProviderAvailability,
} from "../AnalysisProvider.js";
import type { UefiRequest } from "../../domain/uefi/uefiFirmwareAnalysis.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";

/**
 * Pure UEFI firmware analysis boundary: static flash-image mapping and
 * budgeted extraction with one owned LZMA worker lane.
 * Implementation details belong to the provider adapter.
 */
export interface UefiAnalysisPort {
  /** Pure parsing; the provider is effectively always available. */
  inspectAvailability(signal?: AbortSignal): Promise<ProviderAvailability>;
  /** The provider holds only short-lived per-request workers; safe to call always. */
  close(): Promise<void>;
  execute(
    request: UefiRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}

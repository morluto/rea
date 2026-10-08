/** Stable tags exposed by safe analysis-error projections. */
const ANALYSIS_ERROR_TAGS = [
  "AnalysisProtocolError",
  "AnalysisInputError",
  "AnalysisAccessDeniedError",
  "AnalysisArtifactChangedError",
  "AnalysisOutputError",
  "AnalysisCapabilityUnavailableError",
  "AnalysisUnsupportedTargetError",
  "AnalysisCancelledError",
  "AnalysisTimeoutError",
  "AnalysisResourceConstraintError",
  "ProviderSelectionError",
  "ProviderAdapterError",
  "BrowserObservationError",
  "ArtifactOperationError",
  "ProcessCaptureError",
  "EvidenceIntegrityError",
  "EvidenceFileError",
  "UnknownRegistryError",
  "HopperTimeoutError",
  "HopperCancelledError",
  "HopperProtocolError",
  "HopperRemoteError",
  "HopperProcessError",
  "HopperStartError",
  "ConfigurationError",
  "NoBinaryOpenError",
  "BinaryTargetError",
] as const;

/** Stable tag for an expected analysis failure. */
export type AnalysisErrorTag = (typeof ANALYSIS_ERROR_TAGS)[number];

/** Retained command output associated with a typed failure; truncation stays explicit. */
export interface AnalysisCapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/** Optional provider-neutral context that must survive typed error projection. */
export interface AnalysisErrorOptions extends ErrorOptions {
  readonly capturedOutput?: AnalysisCapturedOutput;
}

/** Base class for expected analysis, provider, and session failures. */
export abstract class AnalysisError extends Error {
  readonly capturedOutput: AnalysisCapturedOutput | undefined;
  constructor(message: string, options?: AnalysisErrorOptions) {
    super(message, options);
    this.capturedOutput =
      options?.capturedOutput === undefined
        ? undefined
        : { ...options.capturedOutput };
  }
  abstract readonly _tag: AnalysisErrorTag;
  readonly userMessage: string | undefined = undefined;
  readonly userCategory: "cancelled" | undefined = undefined;
  readonly cleanupIncomplete: boolean = false;
  readonly cleanupResources: readonly string[] = [];
  readonly executionFailure: string | undefined = undefined;
  readonly partialObservation: PartialProcessCaptureObservation | undefined =
    undefined;
  readonly cleanupReport: ProcessCaptureCleanupReport | undefined = undefined;
}
import type {
  PartialProcessCaptureObservation,
  ProcessCaptureCleanupReport,
} from "./process/processCapture.js";

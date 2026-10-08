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
  readonly stdout_bytes?: number;
  readonly stderr_bytes?: number;
  readonly exit_code?: number | null;
  readonly signal?: string | null;
}

/** Cleanup uncertainty attached to the original typed analysis failure. */
export interface AnalysisCleanupObservation {
  readonly reason: string;
  readonly resources: readonly string[];
}

/** Optional provider-neutral context that must survive typed error projection. */
export interface AnalysisErrorOptions extends ErrorOptions {
  readonly capturedOutput?: AnalysisCapturedOutput;
  readonly cleanup?: AnalysisCleanupObservation;
  readonly partialObservation?: AnalysisPartialObservation;
}

/** Base class for expected analysis, provider, and session failures. */
export abstract class AnalysisError extends Error {
  readonly capturedOutput: AnalysisCapturedOutput | undefined;
  readonly cleanup: AnalysisCleanupObservation | undefined;
  readonly cleanupIncomplete: boolean;
  readonly cleanupResources: readonly string[];
  constructor(message: string, options?: AnalysisErrorOptions) {
    super(message, options);
    this.capturedOutput =
      options?.capturedOutput === undefined
        ? undefined
        : { ...options.capturedOutput };
    this.cleanup = options?.cleanup;
    this.cleanupIncomplete = options?.cleanup !== undefined;
    this.cleanupResources = options?.cleanup?.resources ?? [];
    this.partialObservation = options?.partialObservation;
  }
  abstract readonly _tag: AnalysisErrorTag;
  readonly userMessage: string | undefined = undefined;
  readonly userCategory: "cancelled" | undefined = undefined;
  readonly executionFailure: string | undefined = undefined;
  readonly partialObservation: AnalysisPartialObservation | undefined;
  readonly cleanupReport: ProcessCaptureCleanupReport | undefined = undefined;
}
import type {
  PartialProcessCaptureObservation,
  ProcessCaptureCleanupReport,
} from "./process/processCapture.js";
import type { FileOffsetPartialObservation } from "./native/fileOffsetPartialObservation.js";
import type { NativeCallPartialObservation } from "./native/nativeCallPartialObservation.js";
import type { ElectronActivePartialObservation } from "./javascript/electronActiveObservation.js";

/** Provider-neutral evidence collected before a typed analysis failure. */
export type AnalysisPartialObservation =
  | PartialProcessCaptureObservation
  | NativeCallPartialObservation
  | FileOffsetPartialObservation
  | ElectronActivePartialObservation;

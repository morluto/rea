import {
  ArtifactReaderFailure,
  type CleanupFailedRead,
} from "../artifacts/ArtifactReader.js";
import {
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
  artifactFileCompletion,
  artifactFilePrimaryFacts,
  bindArtifactFileCleanup,
} from "../artifacts/ArtifactFileOperation.js";
import {
  projectSelectedArtifactFileFailure,
  stableArtifactInputFailure,
  type RequestField,
} from "../artifacts/StableArtifactFailure.js";
import { completedStableArtifactObservation } from "../artifacts/StableArtifactObservation.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import {
  AnalysisArtifactChangedError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  classifyProviderOutcome,
  type ProviderOutcomeContext,
} from "../process/classifyProviderOutcome.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import {
  providerOutcomeOf,
  type ProviderOutcome,
} from "../process/ProviderOutcome.js";

/** The selected file one provider phase reads, and how it names it. */
export interface ProviderFileDialect {
  readonly path: string;
  /** Names the file in an unreadable-path refusal, such as "bytecode carrier". */
  readonly description: string;
  /** The request field that selected the file; `path` when omitted. */
  readonly field?: RequestField;
  /** The provider's read budget and recovery for a file larger than it admits. */
  readonly fileSize?: (
    cause: ArtifactReaderFailure,
    details: AnalysisErrorOptions,
  ) => AnalysisError;
  /**
   * Retain the completed read's byte identity on the reported failure. A
   * provider that retains richer acquired evidence itself leaves this off.
   */
  readonly retainCompletedIdentity?: boolean;
}

/**
 * What one provider supplies so its raw failures can be classified: its own
 * typed refusals, its command dialect, the file it read, and what it reports
 * for a cause nothing recognised. Everything else is shared.
 */
export interface ProviderFailureDialect {
  readonly providerId: string;
  readonly operation: string;
  /**
   * Provider-owned typed failures, examined before the shared file facts.
   * `details` carries the unresolved cleanup of a failed read.
   */
  readonly recognise?: (
    cause: unknown,
    details: AnalysisErrorOptions,
  ) => AnalysisError | undefined;
  /** How this provider's owned commands report; absent when none ran. */
  readonly command?: (outcome: ProviderOutcome) => ProviderOutcomeContext;
  /**
   * Report for a command whose cleanup failed, given its classified primary.
   * Without it the primary is composed with the unresolved resources.
   */
  readonly commandCleanup?: (
    failure: CleanupFailedCommand,
    primary: AnalysisError,
    outcome: ProviderOutcome,
  ) => AnalysisError;
  /** The selected file this phase reads; absent when it reads none. */
  readonly file?: ProviderFileDialect;
  /**
   * What the producing phase's own signal reports when it cancelled a read,
   * such as that phase's deadline timeout; undefined when the phase's caller
   * cancelled it. The phase owns this fact. Without it, or when it reports
   * nothing, the read's cancellation is reported as a cancellation.
   */
  readonly interruption?: (
    details: Omit<AnalysisErrorOptions, "cause">,
  ) => AnalysisError | undefined;
  /**
   * Report for a selected-file read whose own cleanup failed, given what the
   * read reports apart from that cleanup: its classified failed outcome or its
   * cancellation, or undefined when only the cleanup failed. Without it the
   * unresolved cleanup is attached to the reported failure.
   */
  readonly readCleanup?: (
    read: CleanupFailedRead,
    primary: AnalysisError | undefined,
  ) => AnalysisError;
  /** Output a finished command left before a later read was cancelled. */
  readonly observedOutput?: AnalysisCapturedOutput | undefined;
  /** What the provider reports for a cause none of the above recognised. */
  readonly unclassified: (
    cause: unknown,
    details: AnalysisErrorOptions,
  ) => AnalysisError;
}

type CleanupFailedCommand = OwnedCommandFailure & {
  readonly cleanupFailure: string;
};

const cleanupFailedRead = (cause: unknown): cause is CleanupFailedRead =>
  cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined;

/** A read's cancellation: the producing phase's interruption, else a cancellation. */
const readCancellation = (
  reason: unknown,
  dialect: ProviderFailureDialect,
  details: Omit<AnalysisErrorOptions, "cause">,
): AnalysisError =>
  dialect.interruption?.(details) ??
  cancelledBy(dialect.operation, carriedReason(reason), details);

/** What a read whose cleanup failed reports apart from that cleanup. */
const readPrimary = (
  read: CleanupFailedRead,
  dialect: ProviderFailureDialect,
): AnalysisError | undefined => {
  const observed =
    dialect.observedOutput === undefined
      ? {}
      : { capturedOutput: dialect.observedOutput };
  if (read instanceof ArtifactFileCleanupFailure) {
    const outcome = read.fileCleanupFailure.outcome;
    if (outcome.kind === "failed")
      return classifyProviderFailure(outcome.cause, dialect);
    const cancellation = artifactFileCompletion(read)?.cancellation;
    if (cancellation !== undefined)
      return readCancellation(cancellation.reason, dialect, observed);
  }
  return read.reason === "cancelled"
    ? readCancellation(artifactFileCancellationCause(read), dialect, observed)
    : undefined;
};

const cleanupFailed = (cause: unknown): cause is CleanupFailedCommand =>
  cause instanceof OwnedCommandFailure && cause.cleanupFailure !== null;

const commandFailure = (
  cause: unknown,
  outcome: ProviderOutcome,
  dialect: ProviderFailureDialect,
  command: (outcome: ProviderOutcome) => ProviderOutcomeContext,
): AnalysisError => {
  const context = command(outcome);
  if (!cleanupFailed(cause)) return classifyProviderOutcome(outcome, context);
  if (dialect.commandCleanup === undefined)
    return analysisErrorWithCleanupFailure(
      classifyProviderOutcome(outcome, context),
      new ProviderCleanupError(
        dialect.providerId,
        cause.resources,
        { reason: cause.cleanupFailure },
        { operation: dialect.operation, cause },
      ),
      dialect.operation,
    );
  // The provider's cleanup report retains the output once; its primary needs
  // only recovery facts.
  const primary = classifyProviderOutcome(
    { ...outcome, output: undefined },
    context,
  );
  return dialect.commandCleanup(cause, primary, outcome);
};

/** Shared facts about a selected file read. */
const fileFailure = (
  cause: unknown,
  dialect: ProviderFailureDialect,
  details: AnalysisErrorOptions,
): AnalysisError | undefined => {
  const { operation, file } = dialect;
  const { cause: physical, origin } = artifactFilePrimaryFacts(cause);
  if (
    origin === "owned-or-classified" &&
    physical instanceof ArtifactReaderFailure
  ) {
    if (physical.reason === "cancelled") {
      // The reader's recorded abort reason is the cancellation's cause.
      const { cause: _reader, ...cancellationDetails } = details;
      return readCancellation(
        artifactFileCancellationCause(physical),
        dialect,
        {
          ...cancellationDetails,
          // What the reader had already established stays reported.
          ...(physical.partialObservation === undefined
            ? {}
            : { partialObservation: physical.partialObservation }),
          ...(dialect.observedOutput === undefined
            ? {}
            : { capturedOutput: dialect.observedOutput }),
        },
      );
    }
    if (file === undefined) return undefined;
    if (physical.reason === "integrity")
      return new AnalysisArtifactChangedError(
        operation,
        file.path,
        physical.message,
        { ...details, cause },
      );
    if (physical.reason === "limit" && physical.boundary === "file-size")
      return file.fileSize?.(physical, { ...details, cause });
    if (physical.reason === "path" || physical.reason === "format")
      return stableArtifactInputFailure(
        physical,
        operation,
        file.field,
        details,
      );
    return undefined;
  }
  return file === undefined
    ? undefined
    : projectSelectedArtifactFileFailure(
        physical,
        operation,
        file.path,
        file.description,
        file.field,
        details,
      );
};

/**
 * The one mapping from a raw provider failure to a typed error. Typed analysis
 * errors pass through; supervised command outcomes go to
 * `classifyProviderOutcome`; selected-file failures go to the shared stable
 * artifact projections, keeping the read's cleanup and identity. Only what none of them recognises reaches the
 * provider's `unclassified` report.
 */
export const classifyProviderFailure = (
  cause: unknown,
  dialect: ProviderFailureDialect,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const outcome =
    dialect.command === undefined ? undefined : providerOutcomeOf(cause);
  if (outcome !== undefined && dialect.command !== undefined)
    return commandFailure(cause, outcome, dialect, dialect.command);
  if (dialect.readCleanup !== undefined && cleanupFailedRead(cause))
    return dialect.readCleanup(cause, readPrimary(cause, dialect));
  // A failed read's unresolved cleanup stays on whatever it is reported as.
  const details: AnalysisErrorOptions =
    cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
      ? { cleanup: cause.cleanup }
      : {};
  const failure =
    dialect.recognise?.(cause, details) ??
    fileFailure(cause, dialect, details) ??
    dialect.unclassified(cause, details);
  const { file } = dialect;
  const observation =
    file?.retainCompletedIdentity === true
      ? completedStableArtifactObservation(cause, file.path)
      : undefined;
  if (observation !== undefined) failure.retainPartialObservation(observation);
  bindArtifactFileCleanup(cause, failure);
  return failure;
};

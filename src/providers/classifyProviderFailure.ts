import {
  ArtifactReaderFailure,
  type CleanupFailedRead,
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
  artifactFileCompletion,
  artifactFilePrimaryFacts,
  bindArtifactFileCleanup,
  projectSelectedArtifactFileFailure,
  stableArtifactInputFailure,
  type RequestField,
  readerIntegrityFailure,
  completedStableArtifactObservation,
} from "../resources/index.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { cancelledBy, carriedReason } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  classifyLaunchFailure,
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
   * Attribution for a typed failure a lower layer already classified, such as
   * the accepted operation and the redacted endpoint it reached. Without it a
   * typed failure passes through unchanged.
   */
  readonly attribute?: (failure: AnalysisError) => AnalysisError;
  /**
   * Provider-owned typed failures, examined before the shared file facts.
   * `details` carries the unresolved cleanup of a failed read.
   */
  readonly recognise?: (
    cause: unknown,
    details: AnalysisErrorOptions,
  ) => AnalysisError | undefined;
  /**
   * How this provider's owned commands report; absent when none ran. The
   * dialect's `providerId` names the provider.
   */
  readonly command?: (
    outcome: ProviderOutcome,
  ) => Omit<ProviderOutcomeContext, "providerId">;
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
  /** Facts this provider reports with a cancelled read, such as its path. */
  readonly diagnostics?: Readonly<Record<string, JsonValue>>;
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

/**
 * A read's cancellation: the producing phase's interruption, else a
 * cancellation. Either keeps what the read had already established, the
 * output a finished command left, and the provider's facts about the read.
 */
const readCancellation = (
  reason: unknown,
  read: ArtifactReaderFailure,
  dialect: ProviderFailureDialect,
  details: Omit<AnalysisErrorOptions, "cause"> = {},
): AnalysisError => {
  const reported = {
    ...details,
    ...(read.partialObservation === undefined
      ? {}
      : { partialObservation: read.partialObservation }),
    ...(dialect.observedOutput === undefined
      ? {}
      : { capturedOutput: dialect.observedOutput }),
    ...(dialect.diagnostics === undefined
      ? {}
      : { diagnostics: { ...details.diagnostics, ...dialect.diagnostics } }),
  };
  return (
    dialect.interruption?.(reported) ??
    cancelledBy(dialect.operation, carriedReason(reason), reported)
  );
};

/** What a read whose cleanup failed reports apart from that cleanup. */
const readPrimary = (
  read: CleanupFailedRead,
  dialect: ProviderFailureDialect,
): AnalysisError | undefined => {
  if (read instanceof ArtifactFileCleanupFailure) {
    const outcome = read.fileCleanupFailure.outcome;
    if (outcome.kind === "failed")
      return classifyProviderFailure(outcome.cause, dialect);
    const cancellation = artifactFileCompletion(read)?.cancellation;
    if (cancellation !== undefined)
      return readCancellation(cancellation.reason, read, dialect);
  }
  return read.reason === "cancelled"
    ? readCancellation(artifactFileCancellationCause(read), read, dialect)
    : undefined;
};

const cleanupFailed = (cause: unknown): cause is CleanupFailedCommand =>
  cause instanceof OwnedCommandFailure && cause.cleanupFailure !== null;

const commandFailure = (
  cause: unknown,
  outcome: ProviderOutcome,
  dialect: ProviderFailureDialect,
  command: NonNullable<ProviderFailureDialect["command"]>,
): AnalysisError => {
  const context = { providerId: dialect.providerId, ...command(outcome) };
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
        physical,
        dialect,
        cancellationDetails,
      );
    }
    if (file === undefined) return undefined;
    if (physical.reason === "integrity")
      return readerIntegrityFailure(operation, file.path, physical, {
        ...details,
        cause,
      });
    if (physical.reason === "limit" && physical.boundary === "file-size")
      return file.fileSize?.(physical, { ...details, cause });
    // Only a path-kind refusal is the caller's selection; byte faults are
    // the target's and keep the reader's own classification.
    if (physical.reason === "path")
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
 * errors pass through, attributed by the dialect when it says how; supervised command outcomes go to
 * `classifyProviderOutcome`; selected-file failures go to the shared stable
 * artifact projections, keeping the read's cleanup and identity. Only what none of them recognises reaches the
 * provider's `unclassified` report.
 */
export const classifyProviderFailure = (
  cause: unknown,
  dialect: ProviderFailureDialect,
): AnalysisError => {
  if (cause instanceof AnalysisError)
    return dialect.attribute?.(cause) ?? cause;
  const outcome = providerOutcomeOf(cause);
  if (outcome !== undefined && dialect.command !== undefined)
    return commandFailure(cause, outcome, dialect, dialect.command);
  // A launcher's failure is classified by the shared owner even for a phase
  // whose dialect describes no command reports.
  if (outcome?.kind === "launch-failed")
    return classifyLaunchFailure(outcome.failure, {
      providerId: dialect.providerId,
      operation: dialect.operation,
      details: { cause },
    });
  const { file } = dialect;
  const observation =
    file?.retainCompletedIdentity === true
      ? completedStableArtifactObservation(cause, file.path)
      : undefined;
  if (dialect.readCleanup !== undefined && cleanupFailedRead(cause)) {
    // The read's report carries what it completed onto its primary.
    if (observation !== undefined) cause.retainPartialObservation(observation);
    return dialect.readCleanup(cause, readPrimary(cause, dialect));
  }
  // A failed read's unresolved cleanup stays on whatever it is reported as.
  const details: AnalysisErrorOptions =
    cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
      ? { cleanup: cause.cleanup }
      : {};
  const failure =
    dialect.recognise?.(cause, details) ??
    fileFailure(cause, dialect, details) ??
    dialect.unclassified(cause, details);
  if (observation !== undefined) failure.retainPartialObservation(observation);
  bindArtifactFileCleanup(cause, failure);
  return failure;
};

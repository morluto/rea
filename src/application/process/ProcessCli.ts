import { HOST_PLATFORM } from "../../platform/HostPlatform.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../../domain/result.js";
import { analysisErrorWithCleanupDependencies } from "../../domain/analysisErrorCleanup.js";
import { analysisErrorWithCancellation } from "../../domain/analysisErrorCancellation.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  type AnalysisInputIssue,
  cancelledBy,
  carriedReason,
} from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import type { AnalysisErrorProjection } from "../../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import {
  describeValidationFailure,
  firstValidationIssue,
} from "../../domain/validationFailure.js";
import { PROCESS_PROVIDER } from "../../domain/process/processEvidenceProvider.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { processScenarioSchema } from "../../domain/process/processScenario.js";
import { unsupportedProcessCaptureProvider } from "./ProcessComparisonService.js";
import { createProgressReporter } from "../../ports/ProgressReporter.js";
import { captureProcessScenario } from "../../process/capture/ProcessHarness.js";
import { ProcessCaptureResourceScope } from "../../process/capture/ProcessCaptureLifecycle.js";
import { ProcessCaptureError } from "../../process/capture/ProcessCaptureError.js";
import {
  createProcessCaptureEvidence,
  createProcessScenarioPlanEvidence,
  wrongWorkflowIssueFacts,
  type ProcessCaptureEvidenceFailure,
} from "./ProcessEvidence.js";
import { prepareProcessScenarioPlan } from "./ProcessScenarioPreparation.js";
import { readJsonFile, jsonFileReadCleanupLeases } from "../JsonFiles.js";
import {
  ArtifactReaderFailure,
  artifactPrimaryCleanupLeases,
  bindArtifactFileCleanup,
  AnalysisCleanupLease,
  ArtifactResourceScope,
} from "../../resources/index.js";
import { EvidenceFileError } from "../../domain/evidenceErrors.js";
import type { Evidence } from "../../domain/evidence.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { unsupportedEvidenceFormatError } from "../../domain/evidenceValidation.js";
import { isUnsupportedEvidenceFormat } from "../../domain/evidenceFormat.js";

/** Preserve the owning reader's facts when retaining a different cause. */
const artifactFailureFacts = (failure: ArtifactReaderFailure) => ({
  ...failure.primaryFacts(),
  ...(failure.cleanup === undefined ? {} : { cleanup: failure.cleanup }),
  ...(failure.partialObservation === undefined
    ? {}
    : { partialObservation: failure.partialObservation }),
  ...(failure.cancellation === undefined
    ? {}
    : { cancellation: failure.cancellation }),
});

/** Keep the completed capture or primary failure while its exact owner retries. */
class RetainedProcessCaptureFailure extends ArtifactReaderFailure {
  constructor(
    failure: ArtifactReaderFailure,
    readonly outcome: Result<Evidence, unknown>,
    readonly owner: AnalysisCleanupLease,
    readonly primary: AnalysisError | undefined,
  ) {
    super(
      failure.reason,
      failure.message,
      {
        cause: failure,
        ...artifactFailureFacts(failure),
        ...(failure.cleanupLeases === undefined
          ? {}
          : { cleanupLeases: failure.cleanupLeases }),
      },
      failure.details,
    );
  }
}

/** Safe process-command failure returned to the CLI adapter. */
export interface ProcessCliErrorOutput extends AnalysisErrorProjection {
  readonly error: "Process command failed";
}

/** Capture one JSON scenario through the shared process harness and Evidence contract. */
export const captureProcessScenarioFile = async (
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  signal?: AbortSignal,
) =>
  withProcessInputResources(
    "capture_process_scenario",
    signal,
    async (resources) => {
      const input = await readJson(
        path,
        "capture_process_scenario",
        signal,
        resources,
      );
      const parsed = processScenarioSchema.safeParse(input);
      if (!parsed.success)
        throw analysisInputErrorFromIssues(
          "capture_process_scenario",
          parsed.error.issues,
          input,
          { cause: parsed.error },
        );
      if (parsed.data.dry_run) {
        const prepared = await prepareProcessScenarioPlan(
          parsed.data,
          environment,
          HOST_PLATFORM.platform,
          signal,
        );
        if (!prepared.ok) throw prepared.error;
        return createProcessScenarioPlanEvidence(
          prepared.value,
          HOST_PLATFORM.platform,
        );
      }
      const progress = createProgressReporter(
        async (update) => {
          process.stderr.write(`${JSON.stringify({ rea_progress: update })}\n`);
        },
        { minimumIntervalMs: 100 },
      );
      const resourceScope = new ProcessCaptureResourceScope();
      let captureOutcome: Result<Evidence, unknown>;
      try {
        const captured = await captureProcessScenario(
          parsed.data,
          signal,
          HOST_PLATFORM.platform,
          environment,
          undefined,
          undefined,
          progress,
          resourceScope,
        );
        captureOutcome = captured.ok
          ? ok(createProcessCaptureEvidence(parsed.data, captured.value))
          : captured;
      } catch (cause: unknown) {
        captureOutcome = err(cause);
      }
      try {
        await resourceScope.close();
      } catch (cause: unknown) {
        const owner = new AnalysisCleanupLease(() => resourceScope.close(), {
          get cleanupResources() {
            return cause instanceof AnalysisError
              ? cause.cleanupResources
              : undefined;
          },
        });
        resources.retain({
          kind: "lease",
          resource: "process capture resources",
          lease: owner,
        });
        const original = captureOutcome.ok ? undefined : captureOutcome.error;
        const priorIncomplete =
          original instanceof AnalysisError && original.cleanupIncomplete;
        const primary = captureOutcome.ok
          ? cause
          : original instanceof AnalysisError && cause instanceof AnalysisError
            ? original instanceof ProcessCaptureError
              ? original.withFinalization({ cleanupFailure: cause })
              : analysisErrorWithCleanupDependencies(
                  original,
                  cause,
                  "capture_process_scenario",
                )
            : new AggregateError(
                [original, cause],
                "Process capture and cleanup failed",
                { cause: original },
              );
        const failure = ArtifactReaderFailure.withCleanup(
          primary,
          ArtifactReaderFailure.cleanupObservation(
            cause,
            "process capture resources",
          ),
          captureOutcome.ok ? captureOutcome.value : undefined,
          priorIncomplete ? undefined : [owner],
        );
        throw new RetainedProcessCaptureFailure(
          failure,
          captureOutcome,
          owner,
          primary instanceof AnalysisError ? primary : undefined,
        );
      }
      if (!captureOutcome.ok) throw captureOutcome.error;
      return captureOutcome.value;
    },
  );

/**
 * Report a capture read from a CLI file as that file's document: its own
 * validation issues, or the side it was given for.
 */
export const projectCaptureFileFailure = (
  failure: ProcessCaptureEvidenceFailure,
  side: "left" | "right",
  input: unknown,
): AnalysisError => {
  switch (failure.kind) {
    case "invalid-evidence":
      if (isUnsupportedEvidenceFormat(failure.cause))
        return unsupportedEvidenceFormatError(failure.cause, side);
      return analysisInputErrorFromIssues(
        "compare_process_captures",
        failure.cause.issues,
        input,
        { cause: failure.cause },
      );
    case "wrong-workflow":
      return processInputFailure(
        "compare_process_captures",
        "Capture evidence is not from the current process-capture workflow. Create new capture evidence, then try again.",
        [side],
        "invalid_value",
        wrongWorkflowIssueFacts(failure),
      );
    case "unsupported-provider":
      return unsupportedProcessCaptureProvider(side, failure);
    case "invalid-capture":
      return invalidCaptureEvidence(failure.cause, side);
  }
};

const invalidCaptureEvidence = (cause: unknown, side: "left" | "right") => {
  const issue = firstValidationIssue(cause);
  return processInputFailure(
    "compare_process_captures",
    `Capture evidence is malformed (${describeValidationFailure(cause)}). Create new capture evidence, then try again.`,
    [side],
    "invalid_value",
    issue === undefined
      ? undefined
      : {
          observed: {
            issue_path: ["normalized_result", ...issue.path],
            ...(issue.constraint === undefined
              ? {}
              : { constraint: issue.constraint }),
            remaining_issue_count: issue.remainingIssueCount,
          },
        },
  );
};

const readJson = async (
  path: string,
  operation: "capture_process_scenario",
  signal: AbortSignal | undefined,
  resources: ArtifactResourceScope,
): Promise<unknown> => {
  if (signal?.aborted) throw cancelledBy(operation, signal);
  const loaded = await readJsonFile(path, signal, resources, operation);
  if (!loaded.ok && loaded.error instanceof AnalysisCancelledError)
    throw cancelledBy(operation, carriedReason(loaded.error.cause));
  if (loaded.ok) {
    if (signal?.aborted) throw cancelledBy(operation, signal);
    return loaded.value;
  }
  if (loaded.error._tag !== "EvidenceFileError") throw loaded.error;
  if (loaded.error.reason === "io") throw loaded.error;
  const detail = describeValidationFailure(loaded.error.cause);
  throw processInputFailure(
    operation,
    loaded.error.reason === "invalid-json"
      ? `Process input file is not valid UTF-8 JSON: ${path} (${detail}). Repair the file, then try again.`
      : loaded.error.reason === "symlink-traversal"
        ? `Process input file could not be read: ${path} (${detail}). Repair the symbolic-link chain or select another file.`
        : `Process input file could not be read: ${path} (${detail}). Check the reported filesystem constraint and retry.`,
    ["input_file"],
    "invalid_value",
    // Read and parse failures share one issue reason; name which one occurred.
    { observed: { file_reason: loaded.error.reason } },
  );
};

const processInputFailure = (
  operation: string,
  userMessage: string,
  path: readonly (string | number)[],
  reason: "invalid_value" | "missing_argument",
  facts?: Pick<AnalysisInputIssue, "expected" | "observed">,
): AnalysisInputError =>
  new AnalysisInputError(operation, { userMessage }, [
    { path, reason, message: userMessage, ...facts },
  ]);

const cliAnalysisError = (error: AnalysisError): ProcessCliErrorOutput => ({
  error: "Process command failed",
  ...projectAnalysisError(error),
});

/** Project retained input cleanup only when the CLI delivers the error. */
export const projectProcessCliInputCleanupError = (
  cause: unknown,
): ProcessCliErrorOutput => {
  if (
    !(cause instanceof ProviderAdapterError) ||
    !(cause.cause instanceof ArtifactReaderFailure) ||
    cause.cause.cleanup === undefined
  )
    throw cause;
  return cliAnalysisError(cause);
};

/**
 * This catch includes target execution, and the projection stays non-retryable.
 * Tell the user what happened; do not ask them to run the command again.
 */
export const PROCESS_UNEXPECTED_FAILURE_REMEDIATION =
  "Do not repeat this command. Tell the user the process command could not complete, give them the reported reason, and ask them to check the scenario or capture files it read. If those files are valid, report the failure with its diagnostics.";

/** Preserve typed failures and local diagnostics at the process CLI boundary. */
const projectProcessCliError = (
  cause: unknown,
  operation: "capture_process_scenario",
  signal?: AbortSignal,
): ProcessCliErrorOutput => {
  const failure =
    cause instanceof AnalysisError
      ? cause
      : new ProviderAdapterError(PROCESS_PROVIDER.id, operation, {
          cause,
          diagnostics: { phase: "process_cli" },
          userMessage: `Process command could not complete: ${describeValidationFailure(cause)}`,
          remediationAction: PROCESS_UNEXPECTED_FAILURE_REMEDIATION,
        });
  return cliAnalysisError(
    signal?.aborted
      ? analysisErrorWithCancellation(failure, cancelledBy(operation, signal))
      : failure,
  );
};

/** Retain a reader failure's exact cleanup proof while recording later cancellation. */
const artifactFailureWithCancellation = (
  failure: ArtifactReaderFailure,
  cancellation: AnalysisCancelledError,
): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    failure.reason,
    failure.message,
    {
      cause: new AggregateError(
        [failure, cancellation],
        "Process input failed and was cancelled",
        { cause: failure },
      ),
      ...artifactFailureFacts(failure),
      ...(failure.cleanupLeases === undefined
        ? {}
        : { cleanupLeases: failure.cleanupLeases }),
    },
    failure.details,
  );

/** One invocation owns every input descriptor through final cleanup and retry. */
const withProcessInputResources = async (
  operation: "capture_process_scenario",
  signal: AbortSignal | undefined,
  run: (resources: ArtifactResourceScope) => Promise<Evidence>,
): Promise<Evidence | ProcessCliErrorOutput> => {
  const resources = new ArtifactResourceScope();
  let outcome: Result<Evidence, unknown>;
  try {
    outcome = ok(await run(resources));
  } catch (cause: unknown) {
    outcome = err(cause);
  }
  try {
    await resources.close();
  } catch (cause: unknown) {
    const cleanup = ArtifactReaderFailure.cleanupObservation(
      cause,
      resources.cleanupResources,
    );
    const cancellation = signal?.aborted
      ? cancelledBy(
          operation,
          signal,
          outcome.ok ? { partialObservation: outcome.value } : {},
        )
      : undefined;
    const primary = outcome.ok
      ? cancellation === undefined
        ? cause
        : new ArtifactReaderFailure(
            "cancelled",
            "Process input cleanup cancelled",
            {
              cause: cancellation,
              cancellation: { reason: cancellation.cause },
              partialObservation: outcome.value,
            },
          )
      : cancellation === undefined
        ? outcome.error
        : outcome.error instanceof AnalysisError
          ? analysisErrorWithCancellation(outcome.error, cancellation)
          : outcome.error instanceof ArtifactReaderFailure
            ? artifactFailureWithCancellation(outcome.error, cancellation)
            : new AggregateError(
                [outcome.error, cancellation],
                "Process input failed and was cancelled",
                { cause: outcome.error },
              );
    // JSON input owns the exact artifact failure used to bind this error's
    // cleanup group. Other AnalysisErrors may own independent resources.
    const inherited =
      primary instanceof EvidenceFileError
        ? (jsonFileReadCleanupLeases(primary) ??
          artifactPrimaryCleanupLeases(primary))
        : artifactPrimaryCleanupLeases(primary);
    const local =
      cause instanceof ArtifactReaderFailure ? cause.cleanupLeases : undefined;
    const leases =
      inherited === undefined || local === undefined
        ? undefined
        : [...new Set([...inherited, ...local])];
    let failure = ArtifactReaderFailure.withCleanup(
      primary,
      cleanup,
      outcome.ok ? outcome.value : undefined,
      leases,
    );
    if (leases === undefined && cause instanceof ArtifactReaderFailure) {
      // Keep local retry authority reachable when coverage of the primary is unknown.
      failure = new ArtifactReaderFailure(
        failure.reason,
        failure.message,
        {
          cause: new AggregateError(
            [failure, cause],
            "Process and input cleanup remain incomplete",
          ),
          ...artifactFailureFacts(failure),
        },
        failure.details,
      );
    }
    const typedPrimary =
      primary instanceof AnalysisError
        ? primary
        : primary instanceof RetainedProcessCaptureFailure
          ? primary.primary
          : undefined;
    const error = new ProviderAdapterError(PROCESS_PROVIDER.id, operation, {
      cause: failure,
      cleanupPrimary: typedPrimary,
      cleanup: failure.cleanup,
      partialObservation: failure.partialObservation,
      userMessage: failure.userMessage ?? failure.message,
    });
    bindArtifactFileCleanup(failure, error);
    throw error;
  }
  if (
    !outcome.ok &&
    outcome.error instanceof RetainedProcessCaptureFailure &&
    outcome.error.owner.released
  )
    outcome = outcome.error.outcome;
  if (!outcome.ok)
    return projectProcessCliError(outcome.error, operation, signal);
  const completed = completeProviderEvidence(outcome.value, signal);
  return completed.ok ? completed.value : cliAnalysisError(completed.error);
};

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../../domain/result.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { analysisErrorWithCancellation } from "../../domain/analysisErrorCancellation.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import type { AnalysisErrorProjection } from "../../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { describeValidationFailure } from "../../domain/validationFailure.js";
import { PROCESS_PROVIDER } from "../../domain/process/processEvidenceProvider.js";
import {
  analysisInputErrorFromIssues,
  projectInputIssues,
} from "../../domain/inputIssueProjection.js";
import { processTraceSpecificationSchema } from "../../domain/process/processTraceSpecification.js";
import { processScenarioSchema } from "../../domain/process/processScenario.js";
import {
  compareParsedProcessEvidence,
  readProcessComparisonSource,
} from "./ProcessComparisonService.js";
import { createProgressReporter } from "../ProgressReporter.js";
import { captureProcessScenario } from "../../process/capture/ProcessHarness.js";
import { ProcessCaptureResourceScope } from "../../process/capture/ProcessCaptureLifecycle.js";
import { ProcessCaptureError } from "../../process/capture/ProcessCaptureError.js";
import {
  createProcessCaptureEvidence,
  createProcessScenarioPlanEvidence,
  type ProcessCaptureEvidenceFailure,
} from "./ProcessEvidence.js";
import { prepareProcessScenarioPlan } from "./ProcessScenarioPreparation.js";
import { readJsonFile, jsonFileReadCleanupLeases } from "../JsonFiles.js";
import {
  ArtifactReaderFailure,
  artifactPrimaryCleanupLeases,
} from "../../artifacts/ArtifactReader.js";
import { bindArtifactFileCleanup } from "../../artifacts/ArtifactFileOperation.js";
import { AnalysisCleanupLease } from "../../artifacts/AnalysisCleanupLease.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { EvidenceFileError } from "../../domain/evidenceErrors.js";
import type { Evidence } from "../../domain/evidence.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

/** Preserve the owning reader's facts when retaining a different cause. */
const artifactFailureFacts = (failure: ArtifactReaderFailure) => ({
  ...(failure.userMessage === undefined
    ? {}
    : { userMessage: failure.userMessage }),
  ...(failure.resolvedPath === undefined
    ? {}
    : { resolvedPath: failure.resolvedPath }),
  ...(failure.boundary === undefined ? {} : { boundary: failure.boundary }),
  ...(failure.admission === undefined ? {} : { admission: failure.admission }),
  ...(failure.readerLimit === undefined
    ? {}
    : { readerLimit: failure.readerLimit }),
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
          process.platform,
          signal,
        );
        if (!prepared.ok) throw prepared.error;
        return createProcessScenarioPlanEvidence(
          prepared.value,
          process.platform,
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
          process.platform,
          environment,
          undefined,
          undefined,
          progress,
          resourceScope,
        );
        captureOutcome = captured.ok
          ? ok(createProcessCaptureEvidence(parsed.data, captured.value))
          : err(captured.error);
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
              : analysisErrorWithCleanupFailure(
                  original,
                  cause,
                  "capture_process_scenario",
                ).bindCleanupDependencies([original, cause])
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

/** Compare two capture Evidence files and emit derived comparison Evidence. */
export const compareProcessEvidenceFiles = async (
  leftPath: string,
  rightPath: string,
  traceSpecPath?: string,
  signal?: AbortSignal,
) =>
  withProcessInputResources(
    "compare_process_captures",
    signal,
    async (resources) => {
      const leftInput = await readJson(
        leftPath,
        "compare_process_captures",
        signal,
        resources,
      );
      const left = readProcessComparisonSource(
        "left",
        leftInput,
        projectCaptureFileFailure,
      );
      if (!left.ok) throw left.error;
      const rightInput = await readJson(
        rightPath,
        "compare_process_captures",
        signal,
        resources,
      );
      const right = readProcessComparisonSource(
        "right",
        rightInput,
        projectCaptureFileFailure,
      );
      if (!right.ok) throw right.error;
      const traceSpecification =
        traceSpecPath === undefined
          ? undefined
          : parseTraceSpecification(
              await readJson(
                traceSpecPath,
                "compare_process_captures",
                signal,
                resources,
              ),
            );
      const result = compareParsedProcessEvidence(
        left.value,
        right.value,
        traceSpecification === undefined ? {} : { traceSpecification },
      );
      if (!result.ok) throw result.error;
      return result.value.evidence;
    },
  );

/** Preserve CLI file diagnostics while sharing all source interpretation. */
const projectCaptureFileFailure = (
  failure: ProcessCaptureEvidenceFailure,
  side: "left" | "right",
  input: unknown,
): AnalysisError => {
  switch (failure.kind) {
    case "invalid-evidence":
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
      );
    case "unsupported-provider":
      return new AnalysisInputError("compare_process_captures", undefined, [
        {
          path: [side, "provider"],
          reason: "invalid_value",
          message: `The ${side} Evidence provider ${failure.provider.id} v${failure.provider.version} (${failure.provider.name}) is not the current or supported legacy ${PROCESS_PROVIDER.id} v${PROCESS_PROVIDER.version} process capture provider.`,
        },
      ]);
    case "invalid-capture":
      return invalidCaptureEvidence(failure.cause, side);
  }
};

const parseTraceSpecification = (input: unknown) => {
  const parsed = processTraceSpecificationSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  // Match the MCP boundary: the operation name and a trace_spec-rooted path.
  throw new AnalysisInputError(
    "compare_process_captures",
    { cause: parsed.error },
    projectInputIssues(parsed.error.issues, input).map((issue) => ({
      ...issue,
      path: ["trace_spec", ...issue.path],
    })),
  );
};

const invalidCaptureEvidence = (cause: unknown, side: "left" | "right") =>
  processInputFailure(
    "compare_process_captures",
    `Capture evidence is malformed (${describeValidationFailure(cause)}). Create new capture evidence, then try again.`,
    [side],
    "invalid_value",
  );

const readJson = async (
  path: string,
  operation: "capture_process_scenario" | "compare_process_captures",
  signal: AbortSignal | undefined,
  resources: ArtifactResourceScope,
): Promise<unknown> => {
  if (signal?.aborted)
    throw new AnalysisCancelledError(operation, { cause: signal.reason });
  const loaded = await readJsonFile(path, signal, resources, operation);
  if (!loaded.ok && loaded.error instanceof AnalysisCancelledError)
    throw new AnalysisCancelledError(operation, { cause: loaded.error.cause });
  if (loaded.ok) {
    if (signal?.aborted)
      throw new AnalysisCancelledError(operation, { cause: signal.reason });
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
  );
};

const processInputFailure = (
  operation: string,
  userMessage: string,
  path: readonly (string | number)[],
  reason: "invalid_value" | "missing_argument",
): AnalysisInputError =>
  new AnalysisInputError(operation, { userMessage }, [
    { path, reason, message: userMessage },
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
const PROCESS_UNEXPECTED_FAILURE_REMEDIATION =
  "Do not repeat this command. Tell the user the process command could not complete and ask them to check the input files, then run `rea doctor`.";

/** Preserve typed failures and local diagnostics at the process CLI boundary. */
const projectProcessCliError = (
  cause: unknown,
  operation: "capture_process_scenario" | "compare_process_captures",
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
      ? analysisErrorWithCancellation(
          failure,
          new AnalysisCancelledError(operation, { cause: signal.reason }),
        )
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
  operation: "capture_process_scenario" | "compare_process_captures",
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
      ? new AnalysisCancelledError(operation, {
          cause: signal.reason,
          ...(outcome.ok ? { partialObservation: outcome.value } : {}),
        })
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

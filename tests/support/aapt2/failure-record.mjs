import { OwnedCommandFailure } from "../../../dist/process/OwnedCommand.js";
import { DarwinProcessOwnershipInspectionError } from "../../../dist/process/DarwinProcessRunTokenReader.js";
import { projectAnalysisError } from "../../../dist/domain/analysisErrorProjection.js";
import { ExperimentCommandCleanupFailure } from "../command-scope.mjs";

/** Stop results retain non-JSON inspection capabilities; reports retain only facts. */
const cleanupRecord = (result, options) => ({
  status: result.status,
  ...(result.reason === undefined ? {} : { reason: result.reason }),
  ...(result.cleanupResult === undefined
    ? {}
    : { cleanup_result: result.cleanupResult }),
  ...(result.inspectionCleanup === undefined
    ? {}
    : {
        inspection_failures: result.inspectionCleanup.failures.map(
          ({ failure, cause }) => ({
            failure: failureRecord(failure, options),
            cause: failureRecord(cause, options),
          }),
        ),
      }),
});

/**
 * Preserve receipt diagnostics without serializing live owners. Use the error
 * types from the same module graph as the command owner (source or built).
 */
export const createFailureRecorder = ({
  commandFailure = OwnedCommandFailure,
  darwinFailure = DarwinProcessOwnershipInspectionError,
} = {}) => {
  const recordFailure = (
    cause,
    { diagnostics = true, seen = new Set() } = {},
  ) => {
    if (!(cause instanceof Error)) return { message: String(cause) };
    const commandExited = cause.name === "VerifierCommandExitError";
    const record = {
      name: cause.name,
      message: commandExited
        ? `Command exited with code ${cause.code}`
        : cause.message,
    };
    if (seen.has(cause)) return { ...record, already_recorded: true };
    seen.add(cause);
    if (cause instanceof commandFailure) {
      // Never serialize a live cleanup capability or the ambient child environment.
      Object.assign(record, {
        reason: cause.reason,
        snapshot:
          diagnostics || cause.snapshot === null
            ? cause.snapshot
            : {
                exitCode: cause.snapshot.exitCode,
                signal: cause.snapshot.signal,
              },
        collection_failure: cause.collectionFailure,
        cleanup_failure: cause.cleanupFailure,
        ...(cause.cancellation === undefined
          ? {}
          : {
              cancellation: {
                reason: recordFailure(cause.cancellation.reason, {
                  diagnostics,
                  seen,
                }),
              },
            }),
        ...(cause.cleanupResult === undefined
          ? {}
          : { cleanup_result: cause.cleanupResult }),
        resources: cause.resources,
      });
    }
    if (cause instanceof ExperimentCommandCleanupFailure)
      record.cleanup_result = cleanupRecord(cause.result, {
        diagnostics,
        seen,
      });
    if (commandExited) {
      const { exitCode, signal } = cause.snapshot;
      record.reason = "process";
      record.snapshot = diagnostics ? cause.snapshot : { exitCode, signal };
      record.collection_failure = false;
      record.cleanup_failure = null;
      record.resources = [];
    }
    if (cause instanceof darwinFailure) {
      if (diagnostics) {
        record.compiler_outcome = cause.compilerOutcome;
        record.captured_output = cause.capturedOutput;
      } else if (cause.compilerOutcome !== undefined) {
        const { stderr: _stderr, ...facts } = cause.compilerOutcome;
        record.compiler_outcome = { ...facts, stderr_omitted: true };
      }
      if (cause.cleanupFailure !== undefined)
        record.cleanup_failure = projectAnalysisError(cause.cleanupFailure);
      if (cause.cancellation !== undefined)
        record.cancellation = {
          reason: recordFailure(cause.cancellation.reason, {
            diagnostics,
            seen,
          }),
        };
    }
    if ("code" in cause && ["string", "number"].includes(typeof cause.code))
      record.code = cause.code;
    if (cause instanceof AggregateError)
      record.errors = cause.errors.map((error) =>
        recordFailure(error, { diagnostics, seen }),
      );
    if (cause.cause !== undefined)
      record.cause = recordFailure(cause.cause, { diagnostics, seen });
    return record;
  };
  return recordFailure;
};

export const failureRecord = createFailureRecorder();

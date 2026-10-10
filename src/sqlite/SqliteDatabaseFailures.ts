import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import {
  SQLITE_DATABASE_LIMITS,
  SQLITE_PROVIDER_IDENTITY,
} from "./SqliteDatabaseLimits.js";

/** Preserve diagnostics independently of worker exit and private-root cleanup. */
export const capturedSqliteOutput = (
  snapshot: ProviderProcessSnapshot,
): AnalysisCapturedOutput => ({
  stdout: snapshot.stdout.text,
  stderr: snapshot.stderr.text,
  truncated: snapshot.diagnosticTruncated === true,
});

/** Preserve artifact, caller, process, resource and output failure meanings. */
export const sqliteDatabaseFailure = (
  cause: unknown,
  path: string,
  phase: string,
): AnalysisError => {
  const operation = "inspect_sqlite_database";
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(operation, path, cause.message, {
        cause,
      });
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(operation, { cause });
    return new AnalysisInputError(operation, { cause }, [
      {
        path: ["path"],
        reason: cause.reason === "limit" ? "out_of_range" : "invalid_format",
        message: cause.message,
      },
    ]);
  }
  if (cause instanceof OwnedCommandFailure) {
    const projected = ownedCommandFailure(cause);
    if (projected !== undefined) return projected;
  }
  if (phase === "artifact-read" && cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(operation, path, cause.code, {
        cause,
      });
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      return new AnalysisInputError(operation, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected database file set could not be read (${String(cause.code)}): ${path}`,
        },
      ]);
  }
  return new ProviderAdapterError(SQLITE_PROVIDER_IDENTITY.id, operation, {
    cause,
    diagnostics: {
      phase,
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
      ...(cause instanceof OwnedCommandFailure && cause.snapshot !== null
        ? {
            failure_kind: cause.reason,
            exit_code: cause.snapshot.exitCode ?? null,
            signal: cause.snapshot.signal ?? null,
            captured_output: { ...capturedSqliteOutput(cause.snapshot) },
          }
        : {}),
    },
  });
};

const ownedCommandFailure = (
  cause: OwnedCommandFailure,
): AnalysisError | undefined => {
  const operation = "inspect_sqlite_database";
  const capturedOutput =
    cause.snapshot === null ? undefined : capturedSqliteOutput(cause.snapshot);
  const options = {
    cause,
    ...(capturedOutput === undefined ? {} : { capturedOutput }),
  };
  if (cause.cleanupFailure !== null)
    return new ProviderCleanupError(
      SQLITE_PROVIDER_IDENTITY.id,
      cause.resources,
      {
        reason: cause.cleanupFailure,
        previous_error: {
          failure_kind: cause.reason,
          message: cause.message,
        },
        ...(capturedOutput === undefined
          ? {}
          : { captured_output: { ...capturedOutput } }),
      },
      { operation, cause },
    );
  if (cause.reason === "cancelled")
    return new AnalysisCancelledError(operation, options);
  if (cause.reason === "timeout")
    return new AnalysisTimeoutError(
      operation,
      SQLITE_DATABASE_LIMITS.timeoutMs,
      options,
    );
  if (cause.reason === "output-limit")
    return new AnalysisOutputError(operation, cause.message, options);
  if (
    cause.snapshot?.stderr.text.includes("JavaScript heap out of memory") ===
    true
  )
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      "Owned SQLite worker reported JavaScript heap exhaustion.",
      {
        javascript_heap_bytes: 256 * 1024 * 1024,
      },
      options,
    );
  return undefined;
};

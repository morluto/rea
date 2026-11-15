import { capturedProviderOutput } from "../process/capturedProviderOutput.js";
import { MAX_NODE_TIMER_DELAY_MS } from "../domain/analysisResourceLimits.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  stableArtifactInputFailure,
  readerIntegrityFailure,
} from "../artifacts/StableArtifactFailure.js";
import {
  ArtifactFileCleanupFailure,
  bindArtifactFileCleanup,
} from "../artifacts/ArtifactFileOperation.js";
import {
  projectAnalysisError,
  projectAnalysisErrorWithoutCapturedOutput,
} from "../domain/analysisErrorProjection.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import { providerOutcomeOf } from "../process/ProviderOutcome.js";
import { runtimeExhaustionReport } from "../process/RuntimeExhaustion.js";
import { DEFAULT_SQLITE_WORKER_TIMEOUT_MS } from "../domain/sqlite/sqliteDatabase.js";
import { SQLITE_PROVIDER_IDENTITY } from "../domain/sqlite/SqliteProviderIdentity.js";
import { SQLITE_DATABASE_LIMITS } from "./SqliteDatabaseLimits.js";
import { SqliteSnapshotAcquisitionFailure } from "./SqliteDatabaseSnapshot.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../providers/classifyProviderFailure.js";

/** Keep typed cleanup history and one canonical output owner, including after resolution. */
export const createSqliteCleanupError = (
  resources: readonly string[],
  diagnostics: Readonly<Record<string, JsonValue>>,
  options: Omit<AnalysisErrorOptions, "diagnostics">,
): ProviderCleanupError => {
  const capturedOutput =
    options.capturedOutput ?? options.cleanupPrimary?.capturedOutput;
  const previous =
    options.cleanupPrimary === undefined
      ? null
      : capturedOutput === undefined
        ? projectAnalysisError(options.cleanupPrimary)
        : projectAnalysisErrorWithoutCapturedOutput(options.cleanupPrimary);
  return new ProviderCleanupError(
    SQLITE_PROVIDER_IDENTITY.id,
    resources,
    {
      ...diagnostics,
      previous_error: previous ?? diagnostics.previous_error ?? null,
    },
    {
      ...options,
      operation: "inspect_sqlite_database",
      ...(capturedOutput === undefined ? {} : { capturedOutput }),
    },
  );
};

/** The file-set member a filesystem error names, if it is the database, its WAL or its journal. */
const busyMember = (cause: Error, path: string): string => {
  const failed = "path" in cause ? cause.path : undefined;
  return typeof failed === "string" &&
    [path, `${path}-wal`, `${path}-journal`].includes(failed)
    ? failed
    : path;
};

const OPERATION = "inspect_sqlite_database";

/**
 * The SQLite dialect for the shared provider failure classifier: snapshot
 * acquisition, the selected database file set, and the owned worker.
 */
export const sqliteDatabaseDialect = (
  path: string,
  phase: string,
  signal?: AbortSignal,
  workerTimeoutMs = DEFAULT_SQLITE_WORKER_TIMEOUT_MS,
): ProviderFailureDialect => {
  const dialect: ProviderFailureDialect = {
    providerId: SQLITE_PROVIDER_IDENTITY.id,
    operation: OPERATION,
    recognise: (cause) => {
      if (cause instanceof SqliteSnapshotAcquisitionFailure)
        return classifyProviderFailure(
          cause.operationCause,
          dialect,
        ).retainPrimaryDiagnostics({
          snapshot_acquisition: {
            consistency: "unverified",
            members: cause.completedMembers.map((member) => ({ ...member })),
          },
        });
      if (cause instanceof ArtifactReaderFailure) {
        if (cause.reason === "io" && cause.cause !== undefined)
          return classifyProviderFailure(cause.cause, dialect);
        // The shared owner names the integrity check that failed.
        if (cause.reason === "integrity")
          return readerIntegrityFailure(OPERATION, path, cause);
        // The shared owner reports the read's cancellation.
        return cause.reason === "cancelled"
          ? undefined
          : stableArtifactInputFailure(cause, OPERATION);
      }
      if (cause instanceof Error && cause.name === "AbortError")
        return cancelledBy(
          OPERATION,
          carriedReason(
            signal?.aborted === true && cause.cause === signal.reason
              ? signal.reason
              : cause,
          ),
        );
      if (cause instanceof OwnedCommandFailure)
        return ownedCommandFailure(cause, path, workerTimeoutMs);
      // Windows reports a sharing violation as EBUSY: another process holds
      // the file without read sharing. The unchanged request succeeds once
      // that process releases it. Name the member of the file set that was
      // busy (the database, its WAL or its journal) when the error says.
      if (
        phase === "artifact-read" &&
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "EBUSY"
      )
        return new AnalysisCapabilityUnavailableError(
          SQLITE_PROVIDER_IDENTITY.id,
          OPERATION,
          `Selected database file set is in use by another process (EBUSY): ${busyMember(cause, path)}`,
          {
            cause,
            retryable: true,
            userMessage:
              "The selected SQLite database is held open by another process without read sharing. Close that application or inspect a copy, then retry.",
          },
        );
      return undefined;
    },
    // A database file the read could not open names the selected file set.
    ...(phase === "artifact-read"
      ? { file: { path, description: "database file set" } }
      : {}),
    readCleanup: (read, primary) => {
      // A plain read failure carries its physical cause beside the cleanup.
      const previous =
        primary ??
        (read instanceof ArtifactFileCleanupFailure || read.cause === undefined
          ? undefined
          : classifyProviderFailure(read.cause, dialect));
      const error = createSqliteCleanupError(
        read.cleanup.resources,
        { reason: read.cleanup.reason },
        {
          cause: read,
          ...(previous === undefined ? {} : { cleanupPrimary: previous }),
        },
      );
      bindArtifactFileCleanup(read, error);
      return error;
    },
    unclassified: (cause) =>
      new ProviderAdapterError(SQLITE_PROVIDER_IDENTITY.id, OPERATION, {
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
                captured_output: { ...capturedProviderOutput(cause.snapshot) },
              }
            : {}),
        },
      }),
  };
  return dialect;
};

const ownedCommandFailure = (
  cause: OwnedCommandFailure,
  selectedPath: string,
  workerTimeoutMs: number,
): AnalysisError | undefined => {
  const operation = "inspect_sqlite_database";
  const capturedOutput =
    cause.snapshot === null
      ? undefined
      : capturedProviderOutput(cause.snapshot);
  const optionsWithoutCause =
    capturedOutput === undefined ? {} : { capturedOutput };
  const options = { cause, ...optionsWithoutCause };
  // Preserve the same typed primary whether or not owned cleanup also fails.
  const timeout =
    cause.reason === "timeout"
      ? new AnalysisTimeoutError(operation, workerTimeoutMs, {
          ...options,
          userMessage: `The SQLite worker reached its ${String(workerTimeoutMs)} ms server/provider deadline (worker_timeout_ms). This is not a whole-inspection or MCP client deadline.`,
          remediationAction: `${
            workerTimeoutMs < MAX_NODE_TIMER_DELAY_MS
              ? `Increase worker_timeout_ms above ${String(workerTimeoutMs)} (integer milliseconds, maximum ${String(MAX_NODE_TIMER_DELAY_MS)}), or use rea inspect-sqlite-database <path> --worker-timeout-ms <milliseconds> on the CLI.`
              : `worker_timeout_ms is already at the maximum supported ${String(MAX_NODE_TIMER_DELAY_MS)} ms; no higher worker deadline is supported. Report the blocker or narrow the question with caller approval.`
          } This per-call setting needs no server restart. It covers worker startup, queries and reply writing, not snapshot acquisition or final reply reads/cleanup. Allow client headroom for the whole call; increasing only the client deadline does not change the worker budget. Keep the selected database/WAL and requested facts; narrow table/columns/schema_scope/row_limit only if the question permits it. Byte and heap safety limits remain fixed. Resolve incomplete cleanup before retrying; do not repeat the unchanged failed call.`,
        })
      : undefined;
  if (cause.cleanupFailure !== null)
    return createSqliteCleanupError(
      cause.resources,
      {
        reason: cause.cleanupFailure,
        ...(timeout === undefined
          ? {
              previous_error: {
                failure_kind: cause.reason,
                message: cause.message,
              },
            }
          : {}),
      },
      {
        ...options,
        ...(timeout === undefined ? {} : { cleanupPrimary: timeout }),
      },
    );
  if (cause.reason === "cancelled")
    return cancelledBy(
      operation,
      carriedReason(
        cause.cancellation === undefined ? cause : cause.cancellation.reason,
      ),
      optionsWithoutCause,
    );
  if (timeout !== undefined) return timeout;
  // The supervisor observed V8's heap report as output streamed, so a
  // retention budget or a stack trace that overflowed it cannot hide it.
  const outcome = providerOutcomeOf(cause);
  if (outcome.kind === "runtime-exhausted")
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      "Owned SQLite worker reported JavaScript heap exhaustion.",
      {
        javascript_heap_bytes: 256 * 1024 * 1024,
      },
      {
        ...options,
        diagnostics: {
          selected_path: selectedPath,
          runtime_exhaustion_report: runtimeExhaustionReport(
            outcome.exhaustion,
          ),
        },
      },
    );
  if (cause.reason === "output-limit")
    return new AnalysisOutputError(operation, cause.message, {
      ...options,
      userMessage: `SQLite worker diagnostics exceeded the ${String(SQLITE_DATABASE_LIMITS.diagnosticBytes)}-byte capture allowance. This release has no runtime override.`,
      remediationAction: `The SQLite diagnostic capture allowance is ${String(SQLITE_DATABASE_LIMITS.diagnosticBytes)} bytes. This release has no runtime override. worker_timeout_ms does not raise it. Repeating the unchanged request fails the same way.`,
    });
  return undefined;
};

import {
  deadlineParameterLimit,
  MAX_NODE_TIMER_DELAY_MS,
} from "../domain/analysisResourceLimits.js";
import { capturedProviderOutput } from "../process/capturedProviderOutput.js";
import {
  ArtifactReaderFailure,
  stableArtifactInputFailure,
  readerIntegrityFailure,
  ArtifactFileCleanupFailure,
  bindArtifactFileCleanup,
} from "../resources/index.js";
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
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import { isAbortOf } from "../process/SignalAbort.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import type { ProviderOutcome } from "../process/ProviderOutcome.js";
import type { ProviderOutcomeContext } from "../process/classifyProviderOutcome.js";
import { DEFAULT_SQLITE_WORKER_TIMEOUT_MS } from "../domain/sqlite/sqliteDatabase.js";
import { SQLITE_PROVIDER_IDENTITY } from "../domain/sqlite/SqliteProviderIdentity.js";
import {
  SQLITE_DATABASE_LIMITS,
  SQLITE_WORKER_HEAP_BYTES,
} from "./SqliteDatabaseLimits.js";
import { SqliteSnapshotAcquisitionFailure } from "./SqliteDatabaseSnapshot.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../providers/classifyProviderFailure.js";
import { errorMessage } from "../kernel/errorMessage.js";

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
      // Only the caller's own abort is a cancellation. An abort error with
      // another reason, or with no caller abort, is classified as itself.
      if (isAbortOf(cause, signal)) return cancelledBy(OPERATION, signal);
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
    command: (outcome) =>
      sqliteWorkerCommand(outcome, path, workerTimeoutMs, { phase, path }),
    commandCleanup: sqliteWorkerCleanup,
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
          reason: errorMessage(cause),
        },
      }),
  };
  return dialect;
};

/** The selected worker deadline, its setting and what it does not cover. */
const sqliteWorkerTimeout = (
  workerTimeoutMs: number,
): ProviderOutcomeContext["timeout"] => ({
  ms: workerTimeoutMs,
  userMessage: `The SQLite worker reached its ${String(workerTimeoutMs)} ms server/provider deadline (worker_timeout_ms). This is not a whole-inspection or MCP client deadline.`,
  limit: deadlineParameterLimit(
    "worker_timeout_ms",
    workerTimeoutMs,
    DEFAULT_SQLITE_WORKER_TIMEOUT_MS,
  ),
  remediationAction: `${
    workerTimeoutMs < MAX_NODE_TIMER_DELAY_MS
      ? `Increase worker_timeout_ms above ${String(workerTimeoutMs)} (integer milliseconds, maximum ${String(MAX_NODE_TIMER_DELAY_MS)}).`
      : `worker_timeout_ms is already at the maximum supported ${String(MAX_NODE_TIMER_DELAY_MS)} ms; no higher worker deadline is supported. Report the blocker or narrow the question with caller approval.`
  } This per-call setting needs no server restart. It covers worker startup, queries and reply writing, not snapshot acquisition or final reply reads/cleanup. Allow client headroom for the whole call; increasing only the client deadline does not change the worker budget. Keep the selected database/WAL and requested facts; narrow table/columns/schema_scope/row_limit only if the question permits it. Byte and heap safety limits remain fixed. Resolve incomplete cleanup before retrying; do not repeat the unchanged failed call.`,
});

/** The fixed diagnostic capture allowance the owned worker's output exceeded. */
const SQLITE_DIAGNOSTIC_CAPTURE = fixedAllowanceOptions(
  `The SQLite worker diagnostic capture allowance of ${String(SQLITE_DATABASE_LIMITS.diagnosticBytes)} bytes (this release has no runtime override; worker_timeout_ms does not raise it)`,
  "capture",
  { limit: SQLITE_DATABASE_LIMITS.diagnosticBytes, unit: "bytes" },
);

/**
 * How the owned SQLite worker's outcomes report. The shared classifier owns
 * cancellation, the deadline, the capture allowance and the runtime's heap
 * report; an exit or a collection failure has no SQLite meaning beyond the
 * facts the provider's unclassified report keeps.
 */
const sqliteWorkerCommand = (
  outcome: ProviderOutcome,
  selectedPath: string,
  workerTimeoutMs: number,
  phaseDiagnostics: Readonly<Record<string, JsonValue>>,
): ProviderOutcomeContext => ({
  providerId: SQLITE_PROVIDER_IDENTITY.id,
  operation: OPERATION,
  capturedOutput: capturedProviderOutput,
  details:
    outcome.kind === "runtime-exhausted"
      ? { diagnostics: { selected_path: selectedPath } }
      : {},
  timeout: sqliteWorkerTimeout(workerTimeoutMs),
  outputLimit: {
    reason: `SQLite worker diagnostics exceeded the ${String(SQLITE_DATABASE_LIMITS.diagnosticBytes)}-byte capture allowance.`,
    limits: {
      diagnostic_capture_bytes: SQLITE_DATABASE_LIMITS.diagnosticBytes,
    },
    recovery: SQLITE_DIAGNOSTIC_CAPTURE,
  },
  runtimeExhaustion: () => ({
    limits: { javascript_heap_bytes: SQLITE_WORKER_HEAP_BYTES },
    recovery: {
      retryable: false,
      remediationAction: `The SQLite worker's ${String(SQLITE_DATABASE_LIMITS.workerHeapMiB)} MiB JavaScript heap is fixed in this release; worker_timeout_ms does not raise it. Narrow table, columns, schema_scope or row_limit only if the question permits it; repeating the unchanged request is expected to fail the same way.`,
    },
  }),
  // The unclassified report keeps the output in its diagnostics, beside the
  // examined exit facts, so the classified output is not repeated.
  dialect: (exit, _details, unclassified) =>
    unclassified({
      capturedOutput: undefined,
      diagnostics: {
        ...phaseDiagnostics,
        ...(exit.output === undefined
          ? {}
          : {
              captured_output: {
                ...capturedProviderOutput(exit.output.snapshot),
              },
            }),
      },
    }),
});

/**
 * A worker whose cleanup failed reports that cleanup. A deadline stays its
 * typed primary; any other outcome is recorded as the failure it was.
 */
const sqliteWorkerCleanup = (
  command: OwnedCommandFailure & { readonly cleanupFailure: string },
  primary: AnalysisError,
  outcome: ProviderOutcome,
): AnalysisError => {
  const timeout = outcome.kind === "timeout" ? primary : undefined;
  return createSqliteCleanupError(
    command.resources,
    {
      reason: command.cleanupFailure,
      ...(timeout === undefined
        ? {
            previous_error: {
              failure_kind: command.reason,
              message: command.message,
            },
          }
        : {}),
    },
    {
      cause: command,
      ...(command.snapshot === null
        ? {}
        : { capturedOutput: capturedProviderOutput(command.snapshot) }),
      ...(timeout === undefined ? {} : { cleanupPrimary: timeout }),
    },
  );
};

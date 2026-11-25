import { capturedProviderOutput } from "../process/capturedProviderOutput.js";
import { safeParseUtf8Json } from "../domain/safeJson.js";
import {
  bindArtifactFileCleanup,
  artifactFileCancellationError,
  completedStableArtifact,
  readStableArtifact,
  ArtifactReaderFailure,
  type ArtifactResourceScope,
} from "../resources/index.js";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type {
  AnalysisCapturedOutput,
  AnalysisError,
} from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  AnalysisInputError,
  AnalysisCapabilityUnavailableError,
  AnalysisTargetFailureError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import {
  sqliteDatabaseSchema,
  type InspectSqliteDatabaseInput,
} from "../domain/sqlite/sqliteDatabase.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../providers/classifyProviderFailure.js";
import { runOwnedCommand } from "../process/OwnedCommand.js";
import type {
  ProviderProcessSupervisor,
  ProviderProcessStopResult,
} from "../process/ProviderProcess.js";
import {
  SQLITE_DATABASE_LIMITS,
  SQLITE_INSPECTION_REASONS,
  SQLITE_STRUCTURED_INSPECTION_REASONS,
  SQLITE_WORKER_HEAP_BYTES,
} from "./SqliteDatabaseLimits.js";
import { errorMessage } from "../kernel/errorMessage.js";

const operation = "inspect_sqlite_database";
const {
  artifact: _artifactSchema,
  wal: _walSchema,
  worker_timeout_ms: _workerTimeoutSchema,
  ...inspectionShape
} = sqliteDatabaseSchema.shape;
const inspectionSchema = z.strictObject(inspectionShape);
const replySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), inspection: inspectionSchema }),
  z.discriminatedUnion("reason", [
    z.strictObject({
      ok: z.literal(false),
      reason: z
        .enum(SQLITE_INSPECTION_REASONS)
        .exclude(SQLITE_STRUCTURED_INSPECTION_REASONS),
      message: z.string(),
    }),
    z.strictObject({
      ok: z.literal(false),
      reason: z.literal("column-evaluation"),
      message: z.string(),
      readable_columns: z.array(z.string()),
    }),
    z.strictObject({
      ok: z.literal(false),
      reason: z.literal("column-limit"),
      message: z.string(),
      selected_columns: z.int().positive(),
      engine_column_limit: z.int().positive(),
    }),
  ]),
]);
/** Replaceable launcher retains the shared owned-process supervision boundary. */
export type SqliteWorkerLauncher = NonNullable<
  Parameters<typeof runOwnedCommand>[2]
>["launcher"];

/** Validated worker facts and the exact reply descriptor's finalization outcome. */
interface SqliteWorkerInspection {
  readonly inspection: z.output<typeof inspectionSchema>;
  readonly finalization: AnalysisError | undefined;
}

// Each input rejection names the caller argument that requires correction.
const rejectedArgument = {
  unsupported: "path",
  selection: "table",
  "column-selection": "columns",
  "row-offset": "row_offset",
} as const;

const rejectedReply = (
  reply: z.output<typeof replySchema> & { ok: false },
  selectedPath: string,
  capturedOutput: AnalysisCapturedOutput,
) => {
  if (reply.reason === "unavailable")
    return new AnalysisCapabilityUnavailableError(
      "sqlite",
      operation,
      reply.message,
      { capturedOutput, userMessage: reply.message },
    );
  if (reply.reason === "column-evaluation") {
    const readable = reply.readable_columns;
    return new AnalysisCapabilityUnavailableError(
      "sqlite",
      operation,
      reply.message,
      {
        capturedOutput,
        userMessage: reply.message,
        related: { parameters: ["columns", "table", "schema_scope"] },
        remediationAction: `The database is readable; only the listed column values failed. REA's SQLite connection loads no extensions or application functions and disables schema trust. ${
          readable.length === 0
            ? "No other readable column was found"
            : `Select columns whose values were read: columns: ${JSON.stringify(readable)}`
        }; omit table and use schema_scope: database to read the stored declarations without evaluating rows. Obtaining the failed values needs a SQLite connection able to evaluate them. Do not repeat the unchanged request.`,
      },
    );
  }
  if (reply.reason === "row-evaluation")
    return new AnalysisCapabilityUnavailableError(
      "sqlite",
      operation,
      reply.message,
      {
        capturedOutput,
        userMessage: reply.message,
        diagnostics: { selected_path: selectedPath },
        remediationAction:
          "SQLite read the selected schema but could not prepare or evaluate the requested rows. REA's private connection loads no extensions, application functions or application collations. The SQLite reason may identify a missing dependency; an unidentified query failure does not establish database corruption. Omit table and use schema_scope: database to inspect stored declarations. Obtaining the requested values may require the application's supported consistent export. Do not repeat the unchanged row request.",
      },
    );
  if (reply.reason === "memory")
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      reply.message,
      {
        javascript_heap_bytes: SQLITE_WORKER_HEAP_BYTES,
      },
      { capturedOutput, diagnostics: { selected_path: selectedPath } },
    );
  if (reply.reason === "output-limit")
    return new AnalysisResourceConstraintError(
      operation,
      "transport",
      reply.message,
      {
        sqlite_value_or_record_bytes: SQLITE_DATABASE_LIMITS.outputBytes,
        sqlite_sql_statement_bytes: SQLITE_DATABASE_LIMITS.outputBytes,
        worker_reply_bytes: SQLITE_DATABASE_LIMITS.outputBytes,
      },
      {
        capturedOutput,
        diagnostics: { selected_path: selectedPath },
        retryable: false,
        remediationAction:
          "The SQLite value/record, SQL statement and worker JSON reply allowances are each fixed at 16 MiB; this refusal does not identify which was exceeded. worker_timeout_ms and client deadlines do not raise them. If it preserves the requested facts, select exact columns, reduce row_limit, or use schema_scope: inventory instead of database. This worker refusal leaves no completed Evidence to retrieve. Do not repeat the unchanged request or truncate required database bytes.",
      },
    );
  if (reply.reason === "column-limit")
    return new AnalysisResourceConstraintError(
      operation,
      "capacity",
      reply.message,
      {
        selected_result_columns: reply.selected_columns,
        engine_result_column_limit: reply.engine_column_limit,
      },
      {
        capturedOutput,
        diagnostics: { selected_path: selectedPath },
        retryable: false,
        remediationAction: `The selected database is readable; only the combined projection exceeded this connection's native result-column limit. Request at most ${String(reply.engine_column_limit)} columns per call, splitting wider facts across calls, or omit table to inspect stored declarations with schema_scope: database. The limit belongs to SQLite's connection, so worker_timeout_ms and client deadlines do not raise it. Do not repeat the unchanged request.`,
      },
    );
  // SQLite established that the selected snapshot's bytes are not a valid
  // database: a target refusal at the caller's path, not a bad argument.
  if (reply.reason === "malformed")
    return new AnalysisTargetFailureError(
      operation,
      selectedPath,
      { kind: "malformed", format: "sqlite", detail: reply.message },
      { capturedOutput },
    );
  const argument = rejectedArgument[reply.reason];
  return new AnalysisInputError(operation, { capturedOutput }, [
    {
      path: [argument],
      reason: "invalid_format",
      // The worker sees only the private snapshot, so name the caller's selection here.
      message:
        argument === "path"
          ? `Selected SQLite database is invalid (${reply.message}): ${selectedPath}`
          : reply.message,
    },
  ]);
};

/** Execute only the private snapshot and validate the bounded worker protocol. */
export const executeSqliteDatabaseWorker = async (request: {
  readonly input: InspectSqliteDatabaseInput;
  readonly root: string;
  readonly snapshotPath: string;
  readonly timeoutMs: number;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly resourceScope: ArtifactResourceScope;
  readonly launcher?: SqliteWorkerLauncher;
  readonly signal?: AbortSignal;
  readonly captured: (output: AnalysisCapturedOutput) => void;
  readonly retainCleanup?: (
    owner: ProviderProcessSupervisor,
    result: Extract<ProviderProcessStopResult, { status: "incomplete" }>,
  ) => void;
}): Promise<SqliteWorkerInspection> => {
  const requestPath = join(request.root, "request.json");
  const replyPath = join(request.root, "reply.json");
  await writeFile(
    requestPath,
    JSON.stringify({
      snapshot_path: request.snapshotPath,
      reply_path: replyPath,
      input: request.input,
    }),
    { flag: "wx", mode: 0o600 },
  );
  const { NODE_OPTIONS: _ambientNodeOptions, ...environment } =
    request.environment;
  const execution = await runOwnedCommand(
    {
      command: process.execPath,
      arguments: [
        `--max-old-space-size=${String(SQLITE_DATABASE_LIMITS.workerHeapMiB)}`,
        fileURLToPath(new URL("./SqliteDatabaseWorker.js", import.meta.url)),
        requestPath,
      ],
      cwd: request.root,
      expectedCommand: null,
      runId: `rea-sqlite-database-${randomUUID()}`,
      hostEnvironment: environment,
    },
    {
      timeoutMs: request.timeoutMs,
      diagnosticBytes: SQLITE_DATABASE_LIMITS.diagnosticBytes,
      runtime: "v8",
    },
    {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.launcher === undefined ? {} : { launcher: request.launcher }),
      ...(request.retainCleanup === undefined
        ? {}
        : { retainCleanup: request.retainCleanup }),
    },
  );
  const capturedOutput = capturedProviderOutput(execution);
  request.captured(capturedOutput);
  let reply: z.output<typeof replySchema>;
  let finalization: AnalysisError | undefined;
  try {
    let file;
    try {
      file = await readStableArtifact(
        replyPath,
        SQLITE_DATABASE_LIMITS.outputBytes,
        request.signal,
        undefined,
        request.resourceScope,
      );
    } catch (cause: unknown) {
      const completed = completedStableArtifact(cause);
      if (!(cause instanceof ArtifactReaderFailure) || completed === undefined)
        throw cause;
      finalization = sqliteReplyCompletionFailure(cause, capturedOutput);
      file = completed;
    }
    const decoded = safeParseUtf8Json(file.bytes);
    if (!decoded.ok) throw decoded.cause;
    reply = replySchema.parse(decoded.value);
  } catch (cause: unknown) {
    throw sqliteReplyFinalizationFailure(
      classifyProviderFailure(cause, sqliteReplyReadDialect(capturedOutput)),
      finalization,
    );
  }
  if (!reply.ok)
    throw sqliteReplyFinalizationFailure(
      rejectedReply(reply, request.input.path, capturedOutput),
      finalization,
    );
  return { inspection: reply.inspection, finalization };
};

/**
 * How a failed worker-reply read is reported. The shared classifier keeps a
 * typed failure, the read's cancellation and its unresolved cleanup; anything
 * else means the owned worker's reply is missing or malformed.
 */
const sqliteReplyReadDialect = (
  capturedOutput: AnalysisCapturedOutput,
): ProviderFailureDialect => ({
  providerId: "sqlite",
  operation,
  observedOutput: capturedOutput,
  unclassified: (cause, details) =>
    new AnalysisOutputError(
      operation,
      `Owned SQLite worker reply is missing or malformed: ${errorMessage(cause)}`,
      { ...details, cause, capturedOutput },
    ),
});

/** Stable bytes remain usable when only their descriptor's final close failed. */
const sqliteReplyCompletionFailure = (
  cause: ArtifactReaderFailure,
  capturedOutput: AnalysisCapturedOutput,
): AnalysisError => {
  if (cause.cleanup === undefined)
    return classifyProviderFailure(
      cause,
      sqliteReplyReadDialect(capturedOutput),
    );
  const cleanup = new ProviderCleanupError(
    "sqlite",
    cause.cleanup.resources,
    { phase: "reply_descriptor_close", reason: cause.cleanup.reason },
    { operation, cause, capturedOutput },
  );
  bindArtifactFileCleanup(cause, cleanup);
  if (cause.reason !== "cancelled") return cleanup;
  const cancellation = artifactFileCancellationError(operation, cause, {
    capturedOutput,
  });
  return analysisErrorWithCleanupDependencies(cancellation, cleanup, operation);
};

/** A malformed reply or producer refusal stays primary over its later close. */
export const sqliteReplyFinalizationFailure = (
  primary: AnalysisError,
  finalization: AnalysisError | undefined,
): AnalysisError =>
  finalization === undefined
    ? primary
    : finalization.cleanupIncomplete
      ? analysisErrorWithCleanupDependencies(primary, finalization, operation)
      : primary.retainSecondaryFailure(finalization);

import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import type { SqliteDatabasePort } from "../application/sqlite/SqliteDatabasePort.js";
import type {
  AnalysisCapturedOutput,
  AnalysisError,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  inspectSqliteDatabaseInputSchema,
  sqliteDatabaseSchema,
  type InspectSqliteDatabaseInput,
} from "../domain/sqlite/sqliteDatabase.js";
import { isAbsolute } from "node:path";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import { sqliteDatabaseFailure } from "./SqliteDatabaseFailures.js";
import { SQLITE_PROVIDER_IDENTITY } from "./SqliteDatabaseLimits.js";
import { captureSqliteDatabaseSnapshot } from "./SqliteDatabaseSnapshot.js";

import {
  executeSqliteDatabaseWorker,
  type SqliteWorkerLauncher,
} from "./SqliteDatabaseWorkerExecution.js";

const operation = "inspect_sqlite_database";
type SqliteOutcome = Result<AnalysisExecution, AnalysisError>;
type SqliteRuntimeRoot = Pick<PrivateRuntimeRoot, "path" | "close">;
interface PendingSnapshotCleanup {
  readonly result: SqliteOutcome;
  readonly output: AnalysisCapturedOutput | undefined;
  process: ProviderProcessSupervisor | undefined;
}
/** Inspect a provider-owned copy through a cancellable SQLite child, without source writes. */
export class SqliteDatabaseProvider implements SqliteDatabasePort {
  readonly #active = new Set<Promise<SqliteOutcome>>();
  readonly #pendingCleanup = new Map<
    SqliteRuntimeRoot,
    PendingSnapshotCleanup
  >();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #retryPromise: Promise<Result<null, AnalysisError>> | undefined;
  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: SqliteWorkerLauncher,
    readonly createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-sqlite-database-" }),
  ) {}

  /** Return exact original DB/WAL identities and current schema/selected committed rows. */
  async inspect(
    input: InspectSqliteDatabaseInput,
    options?: ExecutionOptions,
  ): Promise<SqliteOutcome> {
    if (this.#closed) return err(new AnalysisCancelledError(operation));
    const inspection = this.#inspect(input, options);
    this.#active.add(inspection);
    try {
      return await inspection;
    } finally {
      this.#active.delete(inspection);
    }
  }

  /** Await active inspections and retry retained roots; failed closes remain retryable. */
  close(): Promise<void> {
    this.#closed = true;
    this.#closePromise ??= Promise.allSettled(this.#active)
      .then(async () => {
        const cleaned = await this.#retryCleanup();
        if (!cleaned.ok) throw cleaned.error;
      })
      .catch((cause: unknown) => {
        this.#closePromise = undefined;
        throw cause;
      });
    return this.#closePromise;
  }

  #retryCleanup(): Promise<Result<null, AnalysisError>> {
    this.#retryPromise ??= this.#cleanupPending().finally(() => {
      this.#retryPromise = undefined;
    });
    return this.#retryPromise;
  }

  async #cleanupPending(): Promise<Result<null, AnalysisError>> {
    const failures: AnalysisError[] = [];
    for (const [root, pending] of [...this.#pendingCleanup]) {
      if (pending.process !== undefined) {
        const stopped = await pending.process.stop();
        if (stopped.status === "incomplete") {
          failures.push(
            new ProviderCleanupError(
              SQLITE_PROVIDER_IDENTITY.id,
              [
                pending.process.launch.ownership?.runId ??
                  "owned-sqlite-worker",
                root.path,
              ],
              {
                reason: stopped.reason,
                previous_error: pending.result.ok
                  ? null
                  : projectAnalysisError(pending.result.error),
                ...(pending.output === undefined
                  ? {}
                  : { captured_output: { ...pending.output } }),
              },
              { operation },
            ),
          );
          continue;
        }
        pending.process = undefined;
      }
      const cleaned = await cleanupSqliteRoot(
        root,
        pending.result,
        pending.output,
      );
      if (cleaned.ok) this.#pendingCleanup.delete(root);
      else failures.push(cleaned.error);
    }
    if (failures.length === 1 && failures[0] !== undefined)
      return err(failures[0]);
    return failures.length === 0
      ? ok(null)
      : err(
          new ProviderCleanupError(
            SQLITE_PROVIDER_IDENTITY.id,
            failures.flatMap((failure) => failure.cleanupResources),
            { failures: failures.map(projectAnalysisError) },
            { operation },
          ),
        );
  }

  async #inspect(
    input: InspectSqliteDatabaseInput,
    options?: ExecutionOptions,
  ): Promise<SqliteOutcome> {
    let root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let processOwner: ProviderProcessSupervisor | undefined;
    let retainedOutput: AnalysisCapturedOutput | undefined;
    let phase = "configuration";
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      if (options?.signal?.aborted) throw new AnalysisCancelledError(operation);
      validateSqliteInput(input);
      const retired = await this.#retryCleanup();
      if (!retired.ok) return retired;
      if (this.#closed || options?.signal?.aborted)
        throw new AnalysisCancelledError(operation);
      root = await this.createRuntime();
      phase = "artifact-read";
      const snapshot = await captureSqliteDatabaseSnapshot(
        input.path,
        root.path,
        options?.signal,
      );
      phase = "worker";
      const inspection = await executeSqliteDatabaseWorker({
        input,
        root: root.path,
        snapshotPath: snapshot.snapshotPath,
        environment: this.environment,
        ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        captured: (output) => {
          retainedOutput = output;
        },
      });
      const validated = sqliteDatabaseSchema.safeParse({
        artifact: snapshot.artifact,
        wal: snapshot.wal,
        ...inspection,
      });
      if (!validated.success)
        throw new AnalysisOutputError(
          operation,
          "SQLite worker report dimensions or identity fields are invalid",
          retainedOutput === undefined
            ? undefined
            : { capturedOutput: retainedOutput },
        );
      result = ok(createSqliteObservation(validated.data, input.path));
    } catch (cause: unknown) {
      if (cause instanceof OwnedCommandFailure)
        processOwner = cause.cleanupOwner;
      const failure = sqliteDatabaseFailure(cause, input.path, phase);
      retainedOutput ??= failure.capturedOutput;
      result = err(selectedFailure(failure, options?.signal, retainedOutput));
    }
    if (root !== undefined) {
      if (processOwner !== undefined) {
        this.#pendingCleanup.set(root, {
          result,
          output: retainedOutput,
          process: processOwner,
        });
        return result;
      }
      const cleaned = await cleanupSqliteRoot(root, result, retainedOutput);
      if (!cleaned.ok) {
        this.#pendingCleanup.set(root, {
          result,
          output: retainedOutput,
          process: undefined,
        });
        return cleaned;
      }
    }
    return completedResult(result, options?.signal, retainedOutput);
  }
}

const selectedFailure = (
  failure: AnalysisError,
  signal?: AbortSignal,
  output?: AnalysisCapturedOutput,
): AnalysisError =>
  signal?.aborted &&
  failure._tag !== "AnalysisCancelledError" &&
  !failure.cleanupIncomplete
    ? new AnalysisCancelledError(
        operation,
        output === undefined ? undefined : { capturedOutput: output },
      )
    : failure;
const completedResult = (
  result: Result<AnalysisExecution, AnalysisError>,
  signal?: AbortSignal,
  output?: AnalysisCapturedOutput,
): Result<AnalysisExecution, AnalysisError> =>
  result.ok && signal?.aborted
    ? err(
        new AnalysisCancelledError(
          operation,
          output === undefined ? undefined : { capturedOutput: output },
        ),
      )
    : result;

const createSqliteObservation = (
  report: ReturnType<typeof sqliteDatabaseSchema.parse>,
  path: string,
): AnalysisExecution => {
  const locations: AnalysisExecution["locations"][number][] = [
    { kind: "artifact-path", path },
  ];
  if (report.wal !== null)
    locations.push({ kind: "artifact-path", path: report.wal.path });
  return createAnalysisExecution(
    report,
    { ...SQLITE_PROVIDER_IDENTITY, version: `SQLite ${report.engine.version}` },
    {
      rawResult: null,
      subject: { path, format: "file", sha256: report.artifact.sha256 },
      locations,
      limitations: report.limitations,
    },
  );
};
const cleanupSqliteRoot = async (
  root: Pick<PrivateRuntimeRoot, "path" | "close">,
  result: Result<AnalysisExecution, AnalysisError>,
  output?: AnalysisCapturedOutput,
): Promise<Result<null, AnalysisError>> => {
  try {
    await root.close();
    return ok(null);
  } catch (cause: unknown) {
    return err(
      new ProviderCleanupError(
        SQLITE_PROVIDER_IDENTITY.id,
        [root.path],
        {
          reason: cause instanceof Error ? cause.message : String(cause),
          previous_error: result.ok ? null : projectAnalysisError(result.error),
          previous_result: result.ok ? result.value.result : null,
          ...(output === undefined ? {} : { captured_output: { ...output } }),
        },
        { operation, cause },
      ),
    );
  }
};

const validateSqliteInput = (input: InspectSqliteDatabaseInput): void => {
  const parsed = inspectSqliteDatabaseInputSchema.safeParse(input);
  if (!parsed.success || !isAbsolute(input.path))
    throw new AnalysisInputError(operation, undefined, [
      {
        path: ["path"],
        reason: "invalid_format",
        message: parsed.success
          ? "path must be an absolute local filesystem path"
          : parsed.error.message,
      },
    ]);
};

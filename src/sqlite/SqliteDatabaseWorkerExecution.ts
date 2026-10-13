import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import {
  sqliteDatabaseSchema,
  type InspectSqliteDatabaseInput,
} from "../domain/sqlite/sqliteDatabase.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { runOwnedCommand } from "../process/OwnedCommand.js";
import { capturedSqliteOutput } from "./SqliteDatabaseFailures.js";
import { SQLITE_DATABASE_LIMITS } from "./SqliteDatabaseLimits.js";

const operation = "inspect_sqlite_database";
const {
  artifact: _artifactSchema,
  wal: _walSchema,
  ...inspectionShape
} = sqliteDatabaseSchema.shape;
const inspectionSchema = z.strictObject(inspectionShape);
const replySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), inspection: inspectionSchema }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum([
      "format",
      "selection",
      "column-selection",
      "unsupported",
      "unavailable",
      "output-limit",
      "memory",
    ]),
    message: z.string(),
  }),
]);
/** Replaceable launcher retains the shared owned-process supervision boundary. */
export type SqliteWorkerLauncher = NonNullable<
  Parameters<typeof runOwnedCommand>[2]
>["launcher"];

// Each input rejection names the caller argument that requires correction.
const rejectedArgument = {
  format: "path",
  unsupported: "path",
  selection: "table",
  "column-selection": "columns",
} as const;

const rejectedReply = (
  reply: z.output<typeof replySchema> & { ok: false },
  capturedOutput: AnalysisCapturedOutput,
) => {
  if (reply.reason === "unavailable")
    return new AnalysisCapabilityUnavailableError(
      "sqlite",
      operation,
      reply.message,
      { capturedOutput, userMessage: reply.message },
    );
  if (reply.reason === "memory")
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      reply.message,
      {
        javascript_heap_bytes: 256 * 1024 * 1024,
      },
      { capturedOutput },
    );
  if (reply.reason === "output-limit")
    return new AnalysisResourceConstraintError(
      operation,
      "transport",
      reply.message,
      {
        sqlite_value_or_record_bytes: SQLITE_DATABASE_LIMITS.outputBytes,
        worker_reply_bytes: SQLITE_DATABASE_LIMITS.outputBytes,
      },
      { capturedOutput },
    );
  return new AnalysisInputError(operation, { capturedOutput }, [
    {
      path: [rejectedArgument[reply.reason]],
      reason: "invalid_format",
      message: reply.message,
    },
  ]);
};

/** Execute only the private snapshot and validate the bounded worker protocol. */
export const executeSqliteDatabaseWorker = async (request: {
  readonly input: InspectSqliteDatabaseInput;
  readonly root: string;
  readonly snapshotPath: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly resourceScope: ArtifactResourceScope;
  readonly launcher?: SqliteWorkerLauncher;
  readonly signal?: AbortSignal;
  readonly captured: (output: AnalysisCapturedOutput) => void;
}): Promise<z.output<typeof inspectionSchema>> => {
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
        "--max-old-space-size=256",
        fileURLToPath(new URL("./SqliteDatabaseWorker.js", import.meta.url)),
        requestPath,
      ],
      cwd: request.root,
      expectedCommand: null,
      runId: `rea-sqlite-database-${randomUUID()}`,
      hostEnvironment: environment,
    },
    {
      timeoutMs: SQLITE_DATABASE_LIMITS.timeoutMs,
      diagnosticBytes: SQLITE_DATABASE_LIMITS.diagnosticBytes,
    },
    {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.launcher === undefined ? {} : { launcher: request.launcher }),
    },
  );
  const capturedOutput = capturedSqliteOutput(execution);
  request.captured(capturedOutput);
  let reply: z.output<typeof replySchema>;
  try {
    const file = await readStableArtifact(
      replyPath,
      SQLITE_DATABASE_LIMITS.outputBytes,
      request.signal,
      undefined,
      request.resourceScope,
    );
    reply = replySchema.parse(JSON.parse(file.bytes.toString("utf8")));
  } catch (cause: unknown) {
    const options = {
      cause,
      capturedOutput,
      ...(cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
        ? { cleanup: cause.cleanup }
        : {}),
    };
    if (request.signal?.aborted)
      throw new AnalysisCancelledError(operation, options);
    throw new AnalysisOutputError(
      operation,
      `Owned SQLite worker reply is missing or malformed: ${cause instanceof Error ? cause.message : String(cause)}`,
      options,
    );
  }
  if (!reply.ok) throw rejectedReply(reply, capturedOutput);
  return reply.inspection;
};

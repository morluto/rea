import { z } from "incur";
import { resolve } from "node:path";
import { createSqliteDatabaseService } from "../composition/sqlite.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Resolve an operator-selected SQLite snapshot through the shared inspection workflow. */
export const registerSqliteCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = createSqliteDatabaseService(environment);
  cli.command(CLI_COMMANDS.inspectSqliteDatabase, {
    description:
      "Inspect SQLite schema and optional ordinary-table rows from a local snapshot",
    args: z.object({
      path: z.string().describe("Local SQLite database snapshot"),
    }),
    options: z.object({
      table: z
        .string()
        .optional()
        .describe("Exact ordinary table name to read"),
      column: z
        .array(z.string())
        .optional()
        .describe(
          "Repeat to select exact row columns in the requested order; requires table",
        ),
      schemaScope: z
        .enum(["inventory", "selected_table", "database"])
        .optional()
        .describe(
          "Compact inventory by default, or selected-table details when table is supplied; database requests full schema",
        ),
      rowLimit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Positive safe integer row count; default 20; requires table",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectSqliteDatabase, async () => {
          const inspection = await service
            .inspect(
              {
                path: resolve(args.path),
                ...(options.table === undefined
                  ? {}
                  : { table: options.table }),
                ...(options.rowLimit === undefined
                  ? {}
                  : { row_limit: options.rowLimit }),
                ...(options.column === undefined
                  ? {}
                  : { columns: options.column }),
                ...(options.schemaScope === undefined
                  ? {}
                  : { schema_scope: options.schemaScope }),
              },
              { signal },
            )
            .then(
              (result) => ({ result }),
              (cause: unknown) => ({ cause }),
            );
          try {
            await service.close();
          } catch (cause: unknown) {
            const primary =
              "cause" in inspection
                ? inspection.cause
                : inspection.result.ok
                  ? undefined
                  : inspection.result.error;
            if (
              primary instanceof AnalysisError &&
              cause instanceof AnalysisError
            )
              throw analysisErrorWithCleanupFailure(
                primary,
                cause,
                "inspect_sqlite_database",
              );
            if ("cause" in inspection)
              throw new AggregateError(
                [inspection.cause, cause],
                "SQLite inspection and provider cleanup both failed",
                { cause: inspection.cause },
              );
            throw cause;
          }
          if ("cause" in inspection) throw inspection.cause;
          return inspection.result.ok
            ? inspection.result.value
            : projectAnalysisError(inspection.result.error);
        }),
      ),
  });
};

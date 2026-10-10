import { z } from "incur";
import { resolve } from "node:path";
import { createSqliteDatabaseService } from "../composition/sqlite.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
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
      rowLimit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Positive safe integer row count; default 100; requires table",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectSqliteDatabase, async () => {
          try {
            const result = await service.inspect(
              {
                path: resolve(args.path),
                ...(options.table === undefined
                  ? {}
                  : { table: options.table }),
                ...(options.rowLimit === undefined
                  ? {}
                  : { row_limit: options.rowLimit }),
              },
              { signal },
            );
            return result.ok
              ? result.value
              : projectAnalysisError(result.error);
          } finally {
            await service.close();
          }
        }),
      ),
  });
};

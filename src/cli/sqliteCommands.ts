import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { z } from "incur";
import { createSqliteDatabaseService } from "../composition/sqlite.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { cliDecimalField } from "./options.js";
import {
  inspectSqliteDatabaseInputSchema,
  sqliteTableSelectionSchema,
  SQLITE_TABLE_REQUIRED_SELECTION_FIELDS,
} from "../domain/sqlite/sqliteDatabase.js";

const selectionAliases = {
  table: "table",
  columns: "column",
  schema_scope: "schemaScope",
  row_limit: "rowLimit",
  row_offset: "rowOffset",
} as const;

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
      path: localPathStringSchema.describe("Local SQLite database snapshot"),
    }),
    options: z
      .object({
        workerTimeoutMs: cliDecimalField(
          inspectSqliteDatabaseInputSchema.shape.worker_timeout_ms,
        ),
        table: sqliteTableSelectionSchema.shape.table.describe(
          "Exact ordinary table name to read",
        ),
        column: sqliteTableSelectionSchema.shape.columns.describe(
          "Repeat to select exact row columns in the requested order; requires table",
        ),
        schemaScope: sqliteTableSelectionSchema.shape.schema_scope.describe(
          "Compact inventory by default, or selected-table details when table is supplied; database requests full schema",
        ),
        rowLimit: cliDecimalField(
          inspectSqliteDatabaseInputSchema.shape.row_limit,
        ).describe(
          "Positive safe integer row count; default 20; requires table",
        ),
        rowOffset: cliDecimalField(
          inspectSqliteDatabaseInputSchema.shape.row_offset,
        ).describe(
          "Non-negative safe integer rows to skip before the window; default 0; requires table",
        ),
      })
      .superRefine((options, context) => {
        const selection = sqliteTableSelectionSchema.safeParse({
          table: options.table,
          columns: options.column,
          schema_scope: options.schemaScope,
          row_limit: options.rowLimit,
          row_offset: options.rowOffset,
        });
        if (selection.success) return;
        for (const issue of selection.error.issues) {
          const path = issue.path.map((field) =>
            typeof field === "string" && field in selectionAliases
              ? selectionAliases[field as keyof typeof selectionAliases]
              : field,
          );
          context.addIssue({ ...issue, path });
        }
      })
      .meta({
        dependentRequired: Object.fromEntries(
          SQLITE_TABLE_REQUIRED_SELECTION_FIELDS.map((field) => [
            selectionAliases[field],
            ["table"],
          ]),
        ),
        if: {
          properties: { schemaScope: { const: "selected_table" } },
          required: ["schemaScope"],
        },
        then: { required: ["table"] },
      }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectSqliteDatabase, () =>
          finishCliEvidenceCommand(
            args.path,
            () =>
              service.inspect(
                {
                  path: absoluteCallerPath(args.path),
                  ...(options.workerTimeoutMs === undefined
                    ? {}
                    : { worker_timeout_ms: options.workerTimeoutMs }),
                  ...(options.table === undefined
                    ? {}
                    : { table: options.table }),
                  ...(options.rowLimit === undefined
                    ? {}
                    : { row_limit: options.rowLimit }),
                  ...(options.rowOffset === undefined
                    ? {}
                    : { row_offset: options.rowOffset }),
                  ...(options.column === undefined
                    ? {}
                    : { columns: options.column }),
                  ...(options.schemaScope === undefined
                    ? {}
                    : { schema_scope: options.schemaScope }),
                },
                { signal },
              ),
            service,
            "sqlite",
            "inspect_sqlite_database",
            signal,
          ).then(projectCliAnalysisResult),
        ),
      ),
  });
};

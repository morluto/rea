import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { createSqliteDatabaseService } from "../composition/sqlite.js";
import { SQLITE_TOOL_CONTRACTS } from "../contracts/sqlite/sqliteToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  inspectWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** Resolve an operator-selected SQLite snapshot through the shared inspection workflow. */
export const registerSqliteCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = createSqliteDatabaseService(environment);
  const contract = contractNamed(
    SQLITE_TOOL_CONTRACTS,
    "inspect_sqlite_database",
  );
  registerContractCommand(
    cli,
    logger,
    contract,
    {
      command: CLI_COMMANDS.inspectSqliteDatabase,
      description:
        "Inspect SQLite schema and optional ordinary-table rows from a local snapshot",
      positionals: ["path"],
      callerPaths: ["path"],
      crossFieldRules: "argv",
      fields: {
        path: { description: "Local SQLite database snapshot" },
        table: { description: "Exact ordinary table name to read" },
        columns: {
          name: "column",
          description:
            "Repeat to select exact row columns in the requested order; requires table",
        },
        schema_scope: {
          description:
            "Compact inventory by default, or selected-table details when table is supplied; database requests full schema",
        },
        row_limit: {
          description:
            "Positive safe integer row count; default 20; requires table",
        },
        row_offset: {
          description:
            "Non-negative safe integer rows to skip before the window; default 0; requires table",
        },
      },
    },
    inspectWithService(() => service, "sqlite"),
  );
};

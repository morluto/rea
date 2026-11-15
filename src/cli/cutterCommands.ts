import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { createCutterBridgeService } from "../composition/cutter.js";
import { CUTTER_TOOL_CONTRACTS } from "../contracts/cutterToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  analyzeWithService,
  registerContractCommand,
} from "./contractCommand.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import type { CliInstance } from "./types.js";

/** Register commands that control an already-running Cutter instance. */
export const registerCutterCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const createCutter = () => createCutterBridgeService(environment);

  registerContractCommand(
    cli,
    logger,
    contractNamed(CUTTER_TOOL_CONTRACTS, "list_cutter_sessions"),
    {
      command: CLI_COMMANDS.listCutterSessions,
      description:
        "List live Cutter instances connected through the REA Python plugin bridge",
    },
    // Discovery returns the session list itself, not Evidence.
    (_input, { operation, signal }) => {
      const cutter = createCutter();
      return finishAnalysisCommand(
        () => cutter.listSessions({ signal }),
        cutter,
        "cutter",
        operation,
        signal,
      ).then(projectCliAnalysisResult);
    },
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(CUTTER_TOOL_CONTRACTS, "cutter_command"),
    {
      command: CLI_COMMANDS.cutterCommand,
      description:
        "Execute one Rizin command in a selected live Cutter instance",
      positionals: ["session_id", "expected_generation", "command"],
      fields: {
        session_id: {
          description: "Session ID copied from list-cutter-sessions.",
        },
        expected_generation: {
          description: "Session generation returned by list-cutter-sessions.",
        },
        command: {
          description: "One unrestricted Rizin command to run in Cutter.",
        },
        // `--json` selects the CLI's own output format.
        json: {
          name: "jsonOutput",
          description:
            "Return command-specific JSON output when available (independent of CLI output formatting).",
        },
      },
    },
    analyzeWithService(() => {
      const cutter = createCutter();
      return {
        inspect: (input, options) => cutter.execute(input, options),
        close: () => cutter.close(),
      };
    }, "cutter"),
  );
};

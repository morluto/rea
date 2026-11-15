import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { createPythonPycService } from "../composition/pythonPyc.js";
import { PYTHON_PYC_TOOL_CONTRACTS } from "../contracts/python/pythonPycToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  deliverWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** Inspect operator-selected pyc files through the same shared workflow as MCP. */
export const registerPythonPycCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(PYTHON_PYC_TOOL_CONTRACTS, "inspect_python_pyc"),
    {
      command: CLI_COMMANDS.inspectPythonPyc,
      description:
        "Inspect a supported CPython 3.7–3.15 pyc header and marshal code objects without executing bytecode",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
      fields: {
        path: { description: "Local CPython .pyc file" },
        view: {
          description:
            "JSON python-pyc view; requires --detail summary and --evidence_output",
        },
      },
    },
    deliverWithService(createPythonPycService, "rea-python-pyc"),
  );
};

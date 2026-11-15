import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { createDesktopApplicationService } from "../composition/desktop.js";
import { DESKTOP_APPLICATION_TOOL_CONTRACTS } from "../contracts/desktopApplicationToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  deliverWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** One-shot complete Evidence can be saved and queried with inspect-analysis-view. */
export const registerDesktopApplicationCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(
      DESKTOP_APPLICATION_TOOL_CONTRACTS,
      "inspect_desktop_application",
    ),
    {
      command: CLI_COMMANDS.inspectDesktopApplication,
      description:
        "Identify desktop runtime candidates from bounded directory and header observations",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      fields: {
        path: { description: "Local installation directory" },
        max_entries: {
          name: "max_entries",
          description:
            "Maximum directory entries to examine; exhaustion leaves partial coverage",
        },
        max_probe_bytes: {
          name: "max_probe_bytes",
          description: "Maximum total bytes read from selected file ranges",
        },
      },
    },
    deliverWithService(createDesktopApplicationService, "rea-artifact-graph"),
  );
};

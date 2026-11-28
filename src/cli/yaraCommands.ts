import type { Logger } from "pino";

import { createYaraMatchesService } from "../composition/yara.js";
import { YARA_TOOL_CONTRACTS } from "../contracts/yara/yaraToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { inspectWithService } from "./contractCommandRunners.js";
import type { CliInstance } from "./types.js";

/** Scan an operator-selected file with operator-selected rules, as over MCP. */
export const registerYaraCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(YARA_TOOL_CONTRACTS, "inspect_yara_matches"),
    {
      description:
        "Scan a local file with caller-supplied YARA rule files using the installed yara command",
      positionals: ["path"],
      callerPaths: ["path", "rule_paths"],
      fields: {
        path: { description: "Local file to scan" },
        rule_paths: {
          name: "rule_paths",
          description: "Local YARA rule source files",
        },
      },
    },
    inspectWithService(
      () => createYaraMatchesService(environment),
      "rea-yara-matches",
    ),
  );
};

import { Cli, z } from "incur";

import {
  captureProcessScenarioFile,
  compareProcessEvidenceFiles,
} from "./application/ProcessCli.js";
import { logCliCommand } from "./cliLogging.js";
import type { Logger } from "./logger.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";

/** Register Process Capture v4 one-shot commands through shared application services. */
export const registerProcessCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.captureProcess, {
    description: "Capture one approved Process Capture v4 JSON scenario",
    args: z.object({ scenario: z.string().describe("Scenario JSON path") }),
    run: ({ args }) =>
      logCliCommand(logger, "capture-process", () =>
        captureProcessScenarioFile(args.scenario),
      ),
  });
  cli.command(CLI_COMMANDS.compareProcessCaptures, {
    description: "Compare two Process Capture v4 Evidence JSON files",
    args: z.object({
      left: z.string().describe("Left capture Evidence JSON path"),
      right: z.string().describe("Right capture Evidence JSON path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "compare-process-captures", () =>
        compareProcessEvidenceFiles(args.left, args.right),
      ),
  });
};

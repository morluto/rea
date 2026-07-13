import { Cli, z } from "incur";

import {
  captureProcessScenarioFile,
  compareProcessEvidenceFiles,
} from "./application/ProcessCli.js";
import { logCliCommand } from "./cliLogging.js";
import type { Logger } from "./logger.js";

/** Register Process Capture v3 one-shot commands through shared application services. */
export const registerProcessCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("capture-process", {
    description: "Capture one approved Process Capture v3 JSON scenario",
    args: z.object({ scenario: z.string().describe("Scenario JSON path") }),
    run: ({ args }) =>
      logCliCommand(logger, "capture-process", () =>
        captureProcessScenarioFile(args.scenario),
      ),
  });
  cli.command("compare-process-captures", {
    description: "Compare two Process Capture v3 Evidence JSON files",
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

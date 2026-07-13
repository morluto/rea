import { Cli, Errors, z } from "incur";

import {
  captureProcessScenarioFile,
  compareProcessEvidenceFiles,
  isProcessCliErrorOutput,
} from "./application/ProcessCli.js";
import { logCliCommand } from "./cliLogging.js";
import type { Logger } from "./logger.js";

const requireProcessCommandSuccess = async <Value>(
  execute: () => Promise<Value>,
): Promise<Value> => {
  const value = await execute();
  if (isProcessCliErrorOutput(value))
    throw new Errors.IncurError({
      code: "PROCESS_COMMAND_FAILED",
      message: value.message,
      retryable: false,
    });
  return value;
};

/** Register Process Capture v4 one-shot commands through shared application services. */
export const registerProcessCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("capture-process", {
    description: "Capture one approved Process Capture v4 JSON scenario",
    args: z.object({ scenario: z.string().describe("Scenario JSON path") }),
    run: ({ args }) =>
      logCliCommand(logger, "capture-process", () =>
        requireProcessCommandSuccess(() =>
          captureProcessScenarioFile(args.scenario),
        ),
      ),
  });
  cli.command("compare-process-captures", {
    description: "Compare two Process Capture v4 Evidence JSON files",
    args: z.object({
      left: z.string().describe("Left capture Evidence JSON path"),
      right: z.string().describe("Right capture Evidence JSON path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "compare-process-captures", () =>
        requireProcessCommandSuccess(() =>
          compareProcessEvidenceFiles(args.left, args.right),
        ),
      ),
  });
};

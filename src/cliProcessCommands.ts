import { Cli, z } from "incur";

import {
  captureProcessScenarioFile,
  compareProcessEvidenceFiles,
} from "./application/ProcessCli.js";
import { logCliCommand } from "./cliLogging.js";
import type { Logger } from "./logger.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { parseCliJsonInput } from "./cliJsonInput.js";
import {
  replayMachineRunInputSchema,
  runReplayMachine,
} from "./domain/replayMachineRun.js";
import { AnalysisInputError, projectAnalysisError } from "./domain/errors.js";
import { projectInputIssues } from "./domain/inputIssueProjection.js";

/** Register Process Capture v4 one-shot commands through shared application services. */
export const registerProcessCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  registerReplayMachineCommand(cli, logger);
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
      traceSpec: z
        .string()
        .optional()
        .describe("Optional partial-order or finite-trace specification path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "compare-process-captures", () =>
        compareProcessEvidenceFiles(args.left, args.right, args.traceSpec),
      ),
  });
};

const registerReplayMachineCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.runReplayMachine, {
    description:
      "Run ordered protocol events directly through a finite replay machine",
    args: z.object({
      inputJson: z.string().describe("Inline replay JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, CLI_COMMANDS.runReplayMachine, async () => {
        const input = await parseCliJsonInput(
          args.inputJson,
          CLI_COMMANDS.runReplayMachine,
        );
        if (!input.ok) return input.error;
        const parsed = replayMachineRunInputSchema.safeParse(input.value);
        return parsed.success
          ? runReplayMachine(parsed.data)
          : {
              error: "Process command failed",
              ...projectAnalysisError(
                new AnalysisInputError(
                  CLI_COMMANDS.runReplayMachine,
                  {
                    cause: parsed.error,
                  },
                  projectInputIssues(parsed.error.issues, input.value),
                ),
              ),
            };
      }),
  });
};

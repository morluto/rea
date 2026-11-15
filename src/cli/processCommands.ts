import { Cli, z } from "incur";

import {
  captureProcessScenarioFile,
  compareProcessEvidenceFiles,
  projectProcessCliInputCleanupError,
} from "../application/process/ProcessCli.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Register direct process capture and comparison commands. */
export const registerProcessCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  cli.command(CLI_COMMANDS.captureProcess, {
    description: "Capture one caller-selected process scenario",
    args: z.object({
      scenario: localPathStringSchema.describe("Scenario JSON path"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "capture-process", () =>
          captureProcessScenarioFile(args.scenario, environment, signal).catch(
            projectProcessCliInputCleanupError,
          ),
        ),
      ),
  });
  cli.command(CLI_COMMANDS.compareProcessCaptures, {
    description: "Compare two process capture Evidence JSON files",
    args: z.object({
      left: localPathStringSchema.describe("Left capture Evidence JSON path"),
      right: localPathStringSchema.describe("Right capture Evidence JSON path"),
      traceSpec: localPathStringSchema
        .optional()
        .describe("Optional partial-order or finite-trace specification path"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "compare-process-captures", () =>
          compareProcessEvidenceFiles(
            args.left,
            args.right,
            args.traceSpec,
            signal,
          ).catch(projectProcessCliInputCleanupError),
        ),
      ),
  });
};

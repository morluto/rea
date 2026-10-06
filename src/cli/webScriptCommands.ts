import { Cli, z } from "incur";

import { exportWebScripts } from "../application/WebScriptExportService.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "../logger.js";

/** Register the local captured-script export CLI workflow. */
export const registerWebScriptCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.exportWebScripts, {
    description:
      "Export retained website scripts into an absent directory for static JavaScript analysis",
    args: z.object({
      capturePath: z
        .string()
        .describe("Absolute path to saved page or scenario capture JSON"),
      outputDirectory: z
        .string()
        .describe(
          "Absolute absent directory for verified scripts and manifest",
        ),
    }),
    run: ({ args }) =>
      logCliCommand(logger, CLI_COMMANDS.exportWebScripts, async () => {
        const result = await exportWebScripts({
          capture_path: args.capturePath,
          output_directory: args.outputDirectory,
        });
        return result.ok
          ? result.value
          : {
              error: "Script export failed",
              ...projectAnalysisError(result.error),
            };
      }),
  });
};

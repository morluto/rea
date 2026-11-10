import { Cli, z } from "incur";

import { exportWebScripts } from "../application/WebScriptExportService.js";
import { exportWebScriptsInputSchema } from "../domain/webScriptExport.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { WEB_SCRIPT_EXPORT_PROVIDER } from "../domain/investigationProviders.js";

/** Register the local captured-script export CLI workflow. */
export const registerWebScriptCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.exportWebScripts, {
    description:
      "Export retained website scripts into an absent directory for static JavaScript analysis",
    args: z.object({
      capturePath: exportWebScriptsInputSchema.shape.capture_path,
      outputDirectory: exportWebScriptsInputSchema.shape.output_directory,
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.exportWebScripts, async () => {
          const resources = new ArtifactResourceScope();
          const result = await finishAnalysisCommand(
            () =>
              exportWebScripts(
                {
                  capture_path: args.capturePath,
                  output_directory: args.outputDirectory,
                },
                resources,
                { signal },
              ),
            resources,
            WEB_SCRIPT_EXPORT_PROVIDER.id,
            "export_web_scripts",
            signal,
            "Web script export resources",
          );
          return result.ok
            ? result.value
            : { error: "Script export failed", ...result.error };
        }),
      ),
  });
};

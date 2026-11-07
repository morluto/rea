import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import {
  javascriptRecoveryInputSchema,
  MAX_JAVASCRIPT_RECOVERY_ADDITIONAL_PATHS,
} from "../domain/javascript/javascriptRecovery.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { z } from "incur";
import { JavaScriptRecoveryService } from "../application/javascript/JavaScriptRecoveryService.js";
import { createJavaScriptRecoveryProvider } from "../composition/javascriptRecovery.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Share source recovery with MCP while keeping CLI spelling at this boundary. */
export const registerJavaScriptRecoveryCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const service = new JavaScriptRecoveryService(
    createJavaScriptRecoveryProvider(environment),
  );
  cli.command(CLI_COMMANDS.recoverJavaScriptSources, {
    description:
      "Recover readable JavaScript modules with source provenance and verified files",
    args: z.object({
      path: localPathStringSchema.describe(
        javascriptRecoveryInputSchema.shape.path.description!,
      ),
      outputDirectory: localPathStringSchema.describe(
        javascriptRecoveryInputSchema.shape.output_directory.description!,
      ),
    }),
    options: z.object({
      additionalPath: z
        .array(localPathStringSchema)
        .max(MAX_JAVASCRIPT_RECOVERY_ADDITIONAL_PATHS)
        .optional()
        .describe(
          javascriptRecoveryInputSchema.shape.additional_paths.description!,
        ),
      extractionMode: javascriptRecoveryInputSchema.shape.extraction_mode
        .removeDefault()
        .optional()
        .describe(
          javascriptRecoveryInputSchema.shape.extraction_mode.description!,
        ),
      rewriteLevel: javascriptRecoveryInputSchema.shape.rewrite_level
        .removeDefault()
        .optional()
        .describe(
          javascriptRecoveryInputSchema.shape.rewrite_level.description!,
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.recoverJavaScriptSources, () =>
          finishAnalysisCommand(
            () =>
              service.recover(
                {
                  path: args.path,
                  output_directory: args.outputDirectory,
                  ...(options.additionalPath === undefined
                    ? {}
                    : { additional_paths: options.additionalPath }),
                  ...(options.extractionMode === undefined
                    ? {}
                    : { extraction_mode: options.extractionMode }),
                  ...(options.rewriteLevel === undefined
                    ? {}
                    : { rewrite_level: options.rewriteLevel }),
                },
                { signal },
              ),
            service,
            "wakaru",
            "recover_javascript_sources",
            signal,
          ).then(projectCliAnalysisResult),
        ),
      ),
  });
};

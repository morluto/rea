import { z } from "incur";
import { JavaScriptRecoveryService } from "../application/JavaScriptRecoveryService.js";
import { createJavaScriptRecoveryProvider } from "../composition/javascriptRecovery.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "../logger.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

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
      path: z
        .string()
        .describe("Absolute UTF-8 JavaScript input; never executed"),
      outputDirectory: z.string().describe("Absolute absent output directory"),
    }),
    options: z.object({
      extractionMode: z
        .enum(["structural", "heuristic", "inspection"])
        .optional(),
      rewriteLevel: z.enum(["minimal", "standard", "aggressive"]).optional(),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.recoverJavaScriptSources,
          async () => {
            const result = await service.recover(
              {
                path: args.path,
                output_directory: args.outputDirectory,
                ...(options.extractionMode === undefined
                  ? {}
                  : { extraction_mode: options.extractionMode }),
                ...(options.rewriteLevel === undefined
                  ? {}
                  : { rewrite_level: options.rewriteLevel }),
              },
              { signal },
            );
            return result.ok
              ? result.value
              : projectAnalysisError(result.error);
          },
        ),
      ),
  });
};

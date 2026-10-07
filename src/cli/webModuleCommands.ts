import { z } from "incur";
import { createWebModuleTraceService } from "../composition/webModules.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "../logger.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Expose the same selected-context module trace through the CLI. */
export const registerWebModuleCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const service = createWebModuleTraceService(environment);
  cli.command(CLI_COMMANDS.traceWebModuleImports, {
    description:
      "Trace one captured script's native imports to URLs and captured source candidates",
    args: z.object({
      manifestPath: z
        .string()
        .describe("Absolute export_web_scripts manifest path"),
      scriptIndex: z.coerce
        .number()
        .int()
        .min(0)
        .describe("Zero-based manifest script index"),
    }),
    options: z.object({
      importerUrl: z
        .string()
        .optional()
        .describe("Explicit HTTP(S) importer URL"),
      importMapPath: z
        .string()
        .optional()
        .describe("Absolute local import-map JSON"),
      importMapBaseUrl: z
        .string()
        .optional()
        .describe("HTTP(S) import-map base URL"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.traceWebModuleImports, async () => {
          const result = await service.trace(
            {
              manifest_path: args.manifestPath,
              script_index: args.scriptIndex,
              ...(options.importerUrl === undefined
                ? {}
                : { importer_url: options.importerUrl }),
              ...(options.importMapPath === undefined &&
              options.importMapBaseUrl === undefined
                ? {}
                : {
                    import_map: {
                      path: options.importMapPath,
                      base_url: options.importMapBaseUrl,
                    },
                  }),
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};

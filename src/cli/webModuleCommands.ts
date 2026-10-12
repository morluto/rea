import { z } from "incur";
import { createWebModuleTraceService } from "../composition/webModules.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { webModuleTraceInputSchema } from "../domain/webModuleTrace.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

const importMapInputSchema =
  webModuleTraceInputSchema.shape.import_map.unwrap();

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
      manifestPath: webModuleTraceInputSchema.shape.manifest_path,
      scriptIndex: z.coerce
        .number()
        .int()
        .min(0)
        .describe("Zero-based manifest script index"),
    }),
    options: z.object({
      importerUrl: webModuleTraceInputSchema.shape.importer_url,
      importMapPath: importMapInputSchema.shape.path
        .optional()
        .describe(
          "Absolute local import-map JSON path; requires --import-map-base-url",
        ),
      importMapBaseUrl: importMapInputSchema.shape.base_url
        .optional()
        .describe("HTTP(S) import-map base URL; requires --import-map-path"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        try {
          return await logCliCommand(
            logger,
            CLI_COMMANDS.traceWebModuleImports,
            async () => {
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
              return result.ok
                ? result.value
                : projectAnalysisError(result.error);
            },
          );
        } finally {
          await service.close();
        }
      }),
  });
};

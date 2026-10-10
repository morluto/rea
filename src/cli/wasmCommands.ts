import { z } from "incur";
import { resolve } from "node:path";
import { createWasmArtifactService } from "../composition/wasm.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Resolve all caller-selected artifact paths through the shared workflow. */
export const registerWasmCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = createWasmArtifactService(environment);
  cli.command(CLI_COMMANDS.inspectWasmArtifact, {
    description: "Inspect an explicit local WASM artifact with WABT",
    args: z.object({
      path: z.string().describe("Local WASM artifact"),
    }),
    options: z.object({
      glue_paths: z
        .array(z.string())
        .optional()
        .describe("Selected local JavaScript glue paths"),
      candidate_paths: z
        .array(z.string())
        .optional()
        .describe("Explicit local WASM candidates"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectWasmArtifact, async () => {
          const result = await service.inspect(
            {
              path: resolve(args.path),
              glue_paths: options.glue_paths?.map((path) => resolve(path)),
              candidate_paths: options.candidate_paths?.map((path) =>
                resolve(path),
              ),
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};

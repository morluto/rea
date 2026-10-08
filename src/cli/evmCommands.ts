import { z } from "incur";
import { resolve } from "node:path";
import { createEvmInterfaceService } from "../composition/evm.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "../logger.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Resolve operator paths and preserve explicit encoding through the shared workflow. */
export const registerEvmCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = createEvmInterfaceService(environment);
  cli.command(CLI_COMMANDS.inspectEvmInterface, {
    description: "Infer interface candidates from explicit local EVM bytecode",
    args: z.object({
      path: z.string().describe("Local bytecode carrier"),
      encoding: z
        .enum(["raw", "hex"])
        .describe("Selected carrier representation"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectEvmInterface, async () => {
          const result = await service.inspect(
            { path: resolve(args.path), encoding: args.encoding },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};

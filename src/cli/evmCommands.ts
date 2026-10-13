import { z } from "incur";
import { resolve } from "node:path";
import { evmInterfaceModule } from "../composition/evm.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Resolve operator paths and preserve explicit encoding through the shared workflow. */
export const registerEvmCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = evmInterfaceModule.create(environment);
  cli.command(evmInterfaceModule.cliCommand, {
    description: "Infer interface candidates from explicit local EVM bytecode",
    args: z.object({
      path: z.string().describe("Local bytecode carrier"),
      encoding: z
        .enum(["raw", "hex"])
        .describe("Selected carrier representation"),
    }),
    run: ({ args }) =>
      withCommandCancellation(async (signal) => {
        try {
          return await logCliCommand(
            logger,
            evmInterfaceModule.cliCommand,
            async () => {
              const result = await service.inspect(
                { path: resolve(args.path), encoding: args.encoding },
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

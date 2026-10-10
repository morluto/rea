import { z } from "incur";
import { resolve } from "node:path";
import { createGoBinaryService } from "../composition/go.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Resolve caller paths and inspect static build metadata through the shared workflow. */
export const registerGoCommands = (cli: CliInstance, logger: Logger): void => {
  const service = createGoBinaryService();
  cli.command(CLI_COMMANDS.inspectGoBinary, {
    description:
      "Inspect embedded Go compiler, modules and build settings without target execution",
    args: z.object({
      path: z.string().describe("Local ELF, PE or thin Mach-O image"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectGoBinary, async () => {
          const result = await service.inspect(
            { path: resolve(args.path) },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};

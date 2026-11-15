import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { toolContract } from "../contracts/toolContracts.js";
import {
  registerContractCommand,
  type runDirectOnTarget,
} from "./contractCommand.js";
import { nativeTarget } from "./options.js";
import type { CliInstance } from "./types.js";

/** Register `rea decompile-all`, the directory export of provider pseudocode. */
export const registerDecompileDirectoryCommand = (
  cli: CliInstance,
  logger: Logger,
  run: ReturnType<typeof runDirectOnTarget>,
): void => {
  registerContractCommand(
    cli,
    logger,
    toolContract("decompile_all"),
    {
      command: CLI_COMMANDS.decompileAll,
      description:
        "Write every function's pseudocode into a directory and return a manifest",
      sessionTarget: nativeTarget(
        "App or program path",
        "Load a local analysis snapshot. decompile-all does not update it.",
      ),
      callerPaths: ["output_directory"],
      fields: {
        output_directory: {
          name: "output",
          description:
            "Output directory. A relative path is resolved from the working directory. The parent must exist.",
        },
      },
    },
    run,
  );
};

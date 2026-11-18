import { createCliShell } from "../../../src/cli/cliShell.js";
import type { CliResultOutput } from "../../../src/cli/cliResultOutput.js";
import { cliCommands } from "../../../src/cli/commandRegistry.js";
import type { CliInstance } from "../../../src/cli/types.js";

/** The real command dispatcher with fixture-owned command definitions and output. */
export const createCommandCli = (resultOutput?: CliResultOutput) =>
  createCliShell({ selectedEnvironment: {}, registrations: [], resultOutput });

/** List ordinary commands before routed ones so parity prefers their direct projections. */
export const registeredContractDescriptions = (cli: CliInstance) => {
  const entries = cliCommands(cli);
  return {
    commands: [
      ...entries.flatMap(({ source }) =>
        source.kind === "contract" ? [source.description] : [],
      ),
      ...entries.flatMap(({ source }) =>
        source.kind === "routed" ? source.descriptions : [],
      ),
    ],
    documents: entries.flatMap(({ source }) =>
      source.kind === "document" ? [source.description] : [],
    ),
  };
};

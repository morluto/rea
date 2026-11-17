import { createCliShell } from "../../../src/cli/cliShell.js";
import type { CliResultOutput } from "../../../src/cli/cliResultOutput.js";

/** The real command dispatcher with fixture-owned command definitions and output. */
export const createCommandCli = (resultOutput?: CliResultOutput) =>
  createCliShell({ selectedEnvironment: {}, registrations: [], resultOutput });

import { registerManagedCommands } from "../../src/cli/managedCommands.js";
import { cliCommand } from "../../src/cli/commandRegistry.js";
import { cliCommandFor } from "../../src/contracts/cliCommandNames.js";
import { createDirectAnalysis } from "../../src/composition/directAnalysis.js";
import type { DirectAnalysis } from "../../src/composition/directAnalysis.js";
import { silentLogger } from "../../src/logger.js";
import { isRecord } from "../../src/kernel/isRecord.js";
import { createCommandCli } from "../support/cli/commandCli.js";

type ManagedEvidenceRunner = DirectAnalysis["runManagedProviderEvidence"];

/**
 * The registered compare-managed-members command, run in this process with
 * the production managed Evidence runner unless a test supplies one.
 */
export const managedComparisonCommand = (
  runManagedProviderEvidence: ManagedEvidenceRunner = createDirectAnalysis({})
    .runManagedProviderEvidence,
) => {
  const cli = createCommandCli();
  registerManagedCommands(cli, silentLogger, {
    runProviderAnalysis: () => {
      throw new Error("Comparison runs only managed Evidence");
    },
    runManagedProviderEvidence,
  });
  const command = cliCommand(
    cli,
    cliCommandFor("compare_managed_members"),
  )?.definition;
  if (command === undefined)
    throw new Error("compare-managed-members is not registered");
  /** Run the command as argv would select it, returning its JSON output. */
  return async (
    leftPath: string,
    rightPath: string,
    options: Readonly<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> => {
    const value = await command.run({
      args: { leftPath, rightPath },
      options,
      structuredOutput: false,
    });
    if (!isRecord(value))
      throw new Error("Managed comparison did not return a document");
    return value;
  };
};

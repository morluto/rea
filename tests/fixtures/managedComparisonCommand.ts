import { registerManagedCommands } from "../../src/cli/managedCommands.js";
import { cliCommandFor } from "../../src/contracts/cliCommandNames.js";
import { createDirectAnalysis } from "../../src/composition/directAnalysis.js";
import type { DirectAnalysis } from "../../src/composition/directAnalysis.js";
import { silentLogger } from "../../src/logger.js";

type ManagedEvidenceRunner = DirectAnalysis["runManagedProviderEvidence"];

/**
 * The registered compare-managed-members command, run in this process with
 * the production managed Evidence runner unless a test supplies one.
 */
export const managedComparisonCommand = (
  runManagedProviderEvidence: ManagedEvidenceRunner = createDirectAnalysis({})
    .runManagedProviderEvidence,
) => {
  let registered:
    | { run(input: unknown): Promise<Record<string, unknown>> }
    | undefined;
  const cli = {
    command: (
      name: string,
      definition: { run(input: unknown): Promise<Record<string, unknown>> },
    ) => {
      if (name === cliCommandFor("compare_managed_members"))
        registered = definition;
      return cli;
    },
  } as unknown as Parameters<typeof registerManagedCommands>[0];
  registerManagedCommands(cli, silentLogger, {
    runProviderAnalysis: () => {
      throw new Error("Comparison runs only managed Evidence");
    },
    runManagedProviderEvidence,
  });
  const command = registered;
  if (command === undefined)
    throw new Error("compare-managed-members is not registered");
  /** Run the command as argv would select it, returning its JSON output. */
  return (
    leftPath: string,
    rightPath: string,
    options: Readonly<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> =>
    command.run({ args: { leftPath, rightPath }, options });
};

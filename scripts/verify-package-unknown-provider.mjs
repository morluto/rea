import { json, runWithStatus } from "./lib/verify-package-core.mjs";

/** Verify that an unknown --provider is rejected by the packaged CLI. */
export async function verifyUnknownProvider({ cli, environment }) {
  const unknownProviderExecution = await runWithStatus(
    cli,
    ["analyze", process.execPath, "--provider", "missing-provider", "--json"],
    environment,
  );
  const unknownProvider = json(unknownProviderExecution.stdout);
  if (
    unknownProviderExecution.status !== 1 ||
    unknownProvider.details?.selection_reason !== "unknown_provider" ||
    unknownProvider.details?.requested_provider_id !== "missing-provider"
  )
    throw new Error(
      `packaged CLI provider selection failed: ${JSON.stringify(unknownProvider)}`,
    );
}

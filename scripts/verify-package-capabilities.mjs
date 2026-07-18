import { json, run } from "./lib/verify-package-core.mjs";

/** Verify packaged capabilities, providers, and non-Linux search results. */
export async function verifyPackageCapabilitiesAndSearch({ cli, environment }) {
  const capabilities = json(
    await run(cli, ["capabilities", "--json"], environment),
  );
  if (!Array.isArray(capabilities.capabilities))
    throw new Error("packaged capabilities CLI failed");
  const providers = json(await run(cli, ["providers", "--json"], environment));
  if (
    !Array.isArray(providers.providers) ||
    providers.providers.some(({ id }) => typeof id !== "string") ||
    providers.analysis_provider_binding !== null ||
    providers.analysis_provider_candidates?.find(
      ({ provider }) => provider?.id === "hopper",
    )?.target_support?.status !== "unknown"
  )
    throw new Error("packaged providers CLI failed");
  if (process.platform !== "linux") {
    const searchResult = json(
      await run(
        cli,
        ["search", process.execPath, "fixture", "--json"],
        environment,
      ),
    );
    if (
      searchResult.operation !== "search_strings" ||
      searchResult.normalized_result?.items?.length !== 1
    )
      throw new Error(
        `packaged search CLI failed: ${JSON.stringify(searchResult)}`,
      );
  }
}

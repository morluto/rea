import { json, run } from "./lib/verify-package-core.mjs";

/** Verify packaged capabilities, providers, and non-Linux search results. */
export async function verifyPackageCapabilitiesAndSearch({ cli, environment }) {
  const capabilities = json(
    await run(cli, ["capabilities", "--json"], environment),
  );
  if (!Array.isArray(capabilities.capabilities))
    throw new Error("packaged capabilities CLI failed");
  const providers = json(await run(cli, ["providers", "--json"], environment));
  const candidates = providers.analysis_provider_candidates;
  if (
    !Array.isArray(candidates) ||
    candidates.some(
      (candidate) =>
        typeof candidate?.provider?.id !== "string" ||
        candidate.selected !== false,
    ) ||
    providers.analysis_provider_binding !== null ||
    candidates.find(({ provider }) => provider?.id === "hopper")?.target_support
      ?.status !== "unknown"
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
      !Array.isArray(searchResult.normalized_result)
    )
      throw new Error(
        `packaged search CLI failed: ${JSON.stringify(searchResult)}`,
      );
  }
}

import { json, run, runWithStatus } from "./lib/verify-package-core.mjs";

/** Run platform-specific deep-analysis smoke tests. */
export async function verifyPackagePlatform({ cli, environment }) {
  if (process.platform === "linux") {
    const unsupportedExecution = await runWithStatus(
      cli,
      ["analyze", process.execPath, "--json"],
      environment,
    );
    assertLinuxPackageProviderFailure(unsupportedExecution);
  } else {
    const overview = json(
      await run(cli, ["analyze", process.execPath, "--json"], environment),
    );
    if (
      overview.operation !== "binary_overview" ||
      overview.normalized_result?.procedure_count < 1
    )
      throw new Error(
        `packaged Hopper-backed analyze CLI failed: ${JSON.stringify(overview)}`,
      );
    const inspected = json(
      await run(
        cli,
        [
          "inspect",
          process.execPath,
          "--detail",
          "detailed",
          "--limit",
          "1",
          "--json",
        ],
        environment,
      ),
    );
    if (
      inspected.operation !== "binary_overview" ||
      inspected.normalized_result?.detail !== "detailed"
    )
      throw new Error("packaged inspect CLI failed");
    const functionResult = json(
      await run(
        cli,
        ["function", process.execPath, "0x1000", "--json"],
        environment,
      ),
    );
    if (
      functionResult.operation !== "analyze_function" ||
      functionResult.provider?.id !== "hopper" ||
      functionResult.normalized_result?.procedure?.address !== "0x1000"
    )
      throw new Error(
        `packaged function CLI failed: ${JSON.stringify(functionResult)}`,
      );
    const xrefs = json(
      await run(
        cli,
        ["xrefs", process.execPath, "0x1000", "--json"],
        environment,
      ),
    );
    if (
      xrefs.operation !== "xrefs" ||
      JSON.stringify(xrefs.normalized_result) !== JSON.stringify(["0x1000"])
    )
      throw new Error(`packaged xrefs CLI failed: ${JSON.stringify(xrefs)}`);
    const trace = json(
      await run(
        cli,
        ["trace", process.execPath, "fixture", "--json"],
        environment,
      ),
    );
    if (trace.operation !== "trace_feature")
      throw new Error(`packaged trace CLI failed: ${JSON.stringify(trace)}`);
  }
}

/** Require the declared unsupported build or an exact missing-Xvfb diagnostic, never arbitrary provider failure. */
export const assertLinuxPackageProviderFailure = (execution) => {
  const failure = json(execution.stdout);
  const details = failure?.details;
  const diagnostic = details?.diagnostics;
  const unsupportedBuild =
    details?.failure_code === "unsupported_hopper_build" &&
    details.exit_code === 72;
  const missingDisplayDependency =
    details?.failure_code === "runtime_dependency_unavailable" &&
    details.exit_code === 79 &&
    diagnostic?.component === "hopper_private_display" &&
    diagnostic.operation === "probe" &&
    diagnostic.reason === "missing_xvfb" &&
    diagnostic.status === "error" &&
    diagnostic.failure_code === "runtime_dependency_unavailable" &&
    diagnostic.strategy === "unavailable";
  if (
    execution.status !== 1 ||
    failure?.code !== "provider_unavailable" ||
    (!unsupportedBuild && !missingDisplayDependency)
  )
    throw new Error(
      `packaged Linux Hopper verification did not fail closed: ${JSON.stringify(failure)}`,
    );
};

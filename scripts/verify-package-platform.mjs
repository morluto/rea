import { json, run, runWithStatus } from "./lib/verify-package-core.mjs";

/** Run platform-specific deep-analysis smoke tests. */
export async function verifyPackagePlatform({ cli, environment }) {
  if (process.platform === "linux") {
    const unsupportedExecution = await runWithStatus(
      cli,
      ["analyze", process.execPath, "--json"],
      environment,
    );
    const unsupported = json(unsupportedExecution.stdout);
    if (
      unsupportedExecution.status !== 1 ||
      unsupported.details?.failure_code !== "unsupported_hopper_build"
    )
      throw new Error(
        `packaged Linux Hopper verification did not fail closed: ${JSON.stringify(unsupported)}`,
      );
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

import { describe, expect, it } from "vitest";

import {
  assertLinuxPackageProviderFailure,
  verifyPackagePlatform,
} from "../../../scripts/verify-package-platform.mjs";

const missingDisplay = {
  code: "provider_unavailable",
  details: {
    failure_code: "runtime_dependency_unavailable",
    exit_code: 79,
    diagnostics: {
      component: "hopper_private_display",
      operation: "probe",
      reason: "missing_xvfb",
      status: "error",
      failure_code: "runtime_dependency_unavailable",
      strategy: "unavailable",
    },
  },
};
const execution = (failure: unknown, status = 1) => ({
  status,
  stdout: JSON.stringify(failure),
});

const overview = (
  procedure_count?: unknown,
  operation = "binary_overview",
) => ({
  operation,
  ...(procedure_count === undefined
    ? {}
    : { normalized_result: { procedure_count } }),
});

const verifyMacOS = async (
  analyze: unknown,
  inspect: unknown,
): Promise<void> => {
  const outputs: Readonly<Record<string, unknown>> = {
    analyze,
    inspect,
    function: {
      operation: "analyze_function",
      provider: { id: "hopper" },
      normalized_result: { procedure: { address: "0x1000" } },
    },
    xrefs: { operation: "xrefs", normalized_result: ["0x1000"] },
    trace: { operation: "trace_feature" },
  };
  await verifyPackagePlatform({
    cli: "fixture-cli",
    environment: {},
    platform: "darwin",
    commands: {
      run: async (_cli, arguments_) =>
        JSON.stringify(outputs[arguments_[0]!]) ?? "",
      runWithStatus: async () => {
        throw new Error("Unexpected status command in macOS fixture");
      },
    },
  });
};

describe("packaged Linux failure verification", () => {
  it("accepts the unsupported fixture build or an exact missing display dependency", () => {
    expect(() =>
      assertLinuxPackageProviderFailure(execution(missingDisplay)),
    ).not.toThrow();
    expect(() =>
      assertLinuxPackageProviderFailure(
        execution({
          code: "provider_unavailable",
          details: { failure_code: "unsupported_hopper_build", exit_code: 72 },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertLinuxPackageProviderFailure(
        execution({
          code: "provider_unavailable",
          details: {
            stage: "launch",
            launch_rejection: {
              boundary: "publisher_verification",
              reason: "unsupported_hopper_build",
            },
          },
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    execution({
      code: "provider_unavailable",
      details: {
        stage: "launch",
        launch_rejection: {
          boundary: "publisher_verification",
          reason: "download",
        },
      },
    }),
    execution({
      code: "provider_unavailable",
      details: {
        stage: "analysis",
        launch_rejection: {
          boundary: "publisher_verification",
          reason: "unsupported_hopper_build",
        },
      },
    }),
    execution({
      code: "provider_unavailable",
      details: {
        stage: "launch",
        launch_rejection: {
          boundary: "publisher_verification",
          reason: "unsupported_hopper_build",
        },
        exit_code: 72,
      },
    }),
    execution(missingDisplay, 0),
    execution({ code: "provider_unavailable" }),
    execution({
      ...missingDisplay,
      details: {
        failure_code: "runtime_dependency_unavailable",
        exit_code: 79,
      },
    }),
    execution({
      ...missingDisplay,
      details: {
        ...missingDisplay.details,
        diagnostics: {
          ...missingDisplay.details.diagnostics,
          reason: "ownership_mismatch",
        },
      },
    }),
    execution({
      ...missingDisplay,
      details: { failure_code: "unsupported_hopper_build", exit_code: 75 },
    }),
    execution({ ...missingDisplay, code: "internal_error" }),
  ])(
    "rejects success, unrelated failures, and incomplete diagnostics: %j",
    (result) => {
      expect(() => assertLinuxPackageProviderFailure(result)).toThrow(
        "did not fail closed",
      );
    },
  );
});

describe("packaged analyze and inspect result guards", () => {
  it("accepts positive integer procedure counts for both commands", async () => {
    await verifyMacOS(overview(1), overview(2));
  });

  it("reports the stage that refused malformed package overview output", async () => {
    const valid = overview(4);
    await expect(verifyMacOS(undefined, valid)).rejects.toBeInstanceOf(
      SyntaxError,
    );
    for (const invalid of [
      null,
      overview(),
      overview(0),
      overview(1.5),
      overview(2, "other_operation"),
    ])
      await expect(verifyMacOS(invalid, valid)).rejects.toThrow(
        "packaged Hopper-backed analyze CLI failed",
      );
    await expect(verifyMacOS(valid, overview(0))).rejects.toThrow(
      "packaged inspect CLI failed",
    );
  });
});

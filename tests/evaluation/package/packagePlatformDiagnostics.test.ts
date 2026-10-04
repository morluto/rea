import { describe, expect, it } from "vitest";

import { assertLinuxPackageProviderFailure } from "../../../scripts/verify-package-platform.mjs";

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
  });

  it.each([
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

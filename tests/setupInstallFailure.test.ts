import { describe, expect, it } from "vitest";

import {
  setupInstallFailure,
  type HopperInstallFailureReason,
} from "../src/application/SetupInstallFailure.js";

describe("setup installer failure projection", () => {
  it.each([
    ["unsupported_host", "unsupported_host"],
    ["download", "download_failed"],
    ["release_metadata", "download_failed"],
    ["integrity", "integrity_mismatch"],
    [
      "authorization_or_package_manager",
      "authorization_or_package_manager_failed",
    ],
    ["launcher_missing", "launcher_missing"],
    ["runtime_dependencies", "runtime_dependency_unavailable"],
    ["unsupported_hopper_build", "unsupported_hopper_build"],
    ["cancelled", "setup_cancelled"],
    ["destination_exists", "destination_exists"],
    ["mount", "mount_failed"],
    ["bundle", "bundle_invalid"],
    ["copy", "copy_failed"],
  ] as const)("maps %s to %s", (reason, code) => {
    const result = setupInstallFailure(reason as HopperInstallFailureReason);
    expect(result).toMatchObject({ status: "failed", code });
    if (result.status === "failed")
      expect(result.remediation.length).toBeGreaterThan(20);
  });
});

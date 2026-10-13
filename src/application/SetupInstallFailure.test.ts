import { describe, expect, it } from "vitest";

import { HOPPER_PUBLISHER } from "./MacHopper.js";
import { setupInstallFailure } from "./SetupInstallFailure.js";

describe("macOS Hopper setup failure projection", () => {
  it("projects a publisher mismatch onto its own code and recovery", () => {
    expect(setupInstallFailure("publisher_verification_failed")).toEqual({
      status: "failed",
      code: "publisher_verification_failed",
      remediation: `The mounted Hopper application is not signed by the publisher REA pins (${HOPPER_PUBLISHER.bundleIdentifier}, Apple team ${HOPPER_PUBLISHER.teamIdentifier}); nothing was copied or launched. Install Hopper yourself and set HOPPER_LAUNCHER_PATH to its launcher, then rerun rea setup.`,
    });
  });

  it("keeps a broken bundle distinct from a publisher mismatch", () => {
    expect(setupInstallFailure("bundle")).toEqual({
      status: "failed",
      code: "bundle_invalid",
      remediation:
        "The mounted package did not contain the expected Hopper application bundle. Retry setup; if it repeats, update REA before installing.",
    });
  });
});

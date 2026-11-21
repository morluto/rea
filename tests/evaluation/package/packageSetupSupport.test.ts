import { describe, expect, it } from "vitest";

import { packageSetupSupport } from "../../../scripts/verify-package-discovery.mjs";
import { parseLinuxDistribution } from "../../../src/application/LinuxHopper.js";

const ubuntuRelease = "ID=ubuntu\nVERSION_ID=24.04";
const ubuntuX64 = parseLinuxDistribution(ubuntuRelease, "x64");

const checks = ({ node = true, host = true } = {}) => [
  { name: "node", ok: node },
  { name: "host", ok: host },
];

describe("packaged setup support derivation", () => {
  it.each([
    [
      "untested Kali on x64",
      "ID=kali\nVERSION_ID=2026.3\nID_LIKE=debian",
      "x64",
    ],
    ["tested Ubuntu on arm64", ubuntuRelease, "arm64"],
  ] as const)(
    "keeps %s out of the automated Hopper path",
    (_label, release, architecture) => {
      expect(
        packageSetupSupport(checks(), {
          platform: "linux",
          linuxDistribution: parseLinuxDistribution(release, architecture),
        }),
      ).toEqual({
        supportedSetupHost: true,
        hopperReadinessRequired: false,
        hopperSetupSupported: false,
      });
    },
  );

  it("follows the distribution's own applicability, not host readiness", () => {
    expect(
      packageSetupSupport(checks({ host: false }), {
        platform: "linux",
        linuxDistribution: ubuntuX64,
      }),
    ).toEqual({
      supportedSetupHost: true,
      hopperReadinessRequired: false,
      hopperSetupSupported: true,
    });
  });

  it("keeps unreadable Linux applicability unknown", () => {
    expect(packageSetupSupport(checks(), { platform: "linux" })).toEqual({
      supportedSetupHost: true,
      hopperReadinessRequired: false,
      hopperSetupSupported: undefined,
    });
  });

  it("uses the owner's macOS predicate and excludes Windows", () => {
    expect(
      packageSetupSupport(checks(), { platform: "darwin" })
        .hopperSetupSupported,
    ).toBe(true);
    expect(
      packageSetupSupport(checks({ host: false }), { platform: "darwin" })
        .hopperSetupSupported,
    ).toBe(false);
    expect(
      packageSetupSupport([], { platform: "darwin" }).hopperSetupSupported,
    ).toBeUndefined();
    expect(
      packageSetupSupport(checks(), { platform: "win32" }).hopperSetupSupported,
    ).toBe(false);
  });

  it("reports agent setup support from the node check alone", () => {
    expect(
      packageSetupSupport(checks({ node: false }), {
        platform: "linux",
        linuxDistribution: ubuntuX64,
      }),
    ).toEqual({
      supportedSetupHost: false,
      hopperReadinessRequired: true,
      hopperSetupSupported: true,
    });
  });
});

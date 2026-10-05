import { describe, expect, it } from "vitest";

import { packageSetupSupport } from "../../../scripts/verify-package-discovery.mjs";

describe("packaged setup support classification", () => {
  it.each([
    ["linux", true, true, true, true],
    ["linux", true, false, true, false],
    ["linux", false, true, false, false],
    ["linux", false, false, false, false],
    ["darwin", true, true, true, true],
    ["darwin", true, false, true, false],
    ["darwin", false, true, false, false],
    ["darwin", false, false, false, false],
    ["win32", true, true, true, false],
    ["win32", true, false, true, false],
    ["win32", false, true, false, false],
    ["win32", false, false, false, false],
  ] as const)(
    "%s with node=%s and host=%s: agent setup=%s, Hopper setup=%s",
    (platform, node, host, supportedSetupHost, hopperSetupSupported) => {
      expect(
        packageSetupSupport(
          [
            { name: "host", ok: host },
            { name: "node", ok: node },
          ],
          platform,
        ),
      ).toEqual({ supportedSetupHost, hopperSetupSupported });
    },
  );

  it.each([
    { checks: undefined },
    { checks: [] },
    { checks: [{ name: "host", ok: true }] },
  ])("requires an affirmative Node check: $checks", ({ checks }) => {
    expect(packageSetupSupport(checks, "linux")).toEqual({
      supportedSetupHost: false,
      hopperSetupSupported: false,
    });
  });

  it("requires an affirmative host check only for Hopper setup", () => {
    expect(
      packageSetupSupport(
        [
          { name: "node", ok: true },
          { name: "hopper", ok: true },
        ],
        "linux",
      ),
    ).toEqual({ supportedSetupHost: true, hopperSetupSupported: false });
  });
});

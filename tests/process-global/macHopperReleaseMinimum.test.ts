import { afterEach, expect, it, vi } from "vitest";

import { createDoctorHostFixture } from "../../src/application/Doctor.fixture.js";
import { HOPPER_RELEASES_URL } from "../../src/application/HopperReleaseFeed.js";
import { macHopperHostVersionDetail } from "../../src/application/MacHopper.js";
import { setupInstallFailure } from "../../src/application/SetupInstallFailure.js";
import { runSetup } from "../../src/application/Setup.js";
import { systemSetupHost } from "../../src/application/SetupHost.js";

afterEach(() => vi.unstubAllGlobals());

const PACKAGE_URL =
  "https://www.hopperapp.com:443/downloader/public/Hopper-6.6.1-demo.dmg";
// The public macOS release row observed on 2026-11-01, without its changelog
// and Sparkle signatures.
const FEED = JSON.stringify({
  "OS X": {
    version: "6.6.1",
    filename: PACKAGE_URL,
    file_length: "34838169",
    file_hash: "b2a74b6c47abc15d0f0ba2cbc36ed98eed8bd5d1",
    public: "1",
    beta: "0",
    deployment_target: "12.4",
  },
});

/** Approved Hopper-only setup on a Mac without Hopper; vendor responses are local. */
const setupHopperOnMacos = async (version: string) => {
  const fetch = vi.fn<typeof globalThis.fetch>((input) =>
    Promise.resolve(
      String(input) === HOPPER_RELEASES_URL
        ? new Response(FEED)
        : new Response(null, { status: 404 }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const host = {
    ...systemSetupHost(
      createDoctorHostFixture({
        platform: "darwin",
        macosVersion: () => Promise.resolve(version),
        executable: () => Promise.resolve(false),
        validTarget: () => Promise.resolve(false),
      }),
      { HOME: "/fixture/home", USERPROFILE: "/fixture/home" },
    ),
    // Keep the runtime gate independent of the Node.js running the suite.
    nodeVersion: "24.22.1",
  };
  try {
    const result = await runSetup(
      {
        approved: true,
        installHopper: true,
        structured: true,
        clientIds: [],
        installSkill: false,
      },
      host,
    );
    return {
      result,
      requests: fetch.mock.calls.map(([input]) => String(input)),
    };
  } finally {
    await host.close?.();
  }
};

it.each(["12.0", "12.3"])(
  "refuses Hopper on macOS %s from the release deployment target before downloading the package",
  async (version) => {
    const { result, requests } = await setupHopperOnMacos(version);

    expect(result).toMatchObject({
      status: "needs_human",
      code: "incompatible_host_version",
      appliedActions: [],
    });
    // Recovery and installer detail are delivered from their owners; the
    // observed facts are checked independently of that wording.
    expect(result.remediation).toContain(
      setupInstallFailure("incompatible_host_version").remediation,
    );
    expect(result.remediation).toContain(
      macHopperHostVersionDetail({
        source: "release_feed",
        packageUrl: PACKAGE_URL,
        minimumVersion: "12.4",
        hostVersion: version,
      }),
    );
    for (const fact of [PACKAGE_URL, "12.4", version, "HOPPER_LAUNCHER_PATH"])
      expect(result.remediation).toContain(fact);
    expect(requests).toEqual([HOPPER_RELEASES_URL]);
  },
);

it("requests the package once macOS meets the release deployment target", async () => {
  const { result, requests } = await setupHopperOnMacos("12.4");

  expect(result).toMatchObject({ code: "download_failed" });
  expect(requests).toEqual([HOPPER_RELEASES_URL, PACKAGE_URL]);
});

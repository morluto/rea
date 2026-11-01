import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createDoctorHostFixture } from "../../src/application/Doctor.fixture.js";
import { downloadHopperPackage } from "../../src/application/HopperDownload.js";
import {
  HOPPER_PUBLIC_KEY_URL,
  HOPPER_RELEASES_URL,
} from "../../src/application/HopperReleaseFeed.js";
import {
  systemLinuxHopperInstallHost,
  type LinuxHopperInstallHost,
} from "../../src/application/LinuxHopper.js";
import { LinuxHopperPublisher } from "../../src/application/LinuxHopperPublisher.js";
import { systemSetupHost } from "../../src/application/SetupHost.js";
import { ok } from "../../src/domain/result.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

vi.mock("../../src/application/LinuxHopper.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/application/LinuxHopper.js")
    >();
  return {
    ...actual,
    systemLinuxHopperInstallHost: vi.fn(actual.systemLinuxHopperInstallHost),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const debUrl =
  "https://www.hopperapp.com:443/downloader/public/Hopper-6.6.1-Linux-demo.deb";
const dmgUrl =
  "https://www.hopperapp.com:443/downloader/public/Hopper-6.6.1-demo.dmg";
const packageBytes = Buffer.from("fixture package");
const sha1 = (bytes: Uint8Array) =>
  createHash("sha1").update(bytes).digest("hex");
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const missing =
  "The vendor reports this file as missing, so an immediate retry is unlikely to help; check for a newer REA release, then retry.";
const temporary =
  "The vendor service reported a temporary failure; wait, then retry.";
const recovery = { 404: missing, 503: temporary } as const;

const linuxRelease = (mainExeHash = "0".repeat(64)) => ({
  version: "6.6.1",
  filename: debUrl,
  file_length: String(packageBytes.byteLength),
  file_hash: sha1(packageBytes),
  main_exe_hash: mainExeHash,
  signature: "AA==",
  public: "1" as const,
  beta: "0" as const,
});
const feed = (mainExeHash?: string) =>
  JSON.stringify({
    "OS X": {
      filename: dmgUrl,
      file_length: String(packageBytes.byteLength),
      file_hash: sha1(packageBytes),
    },
    "Ubuntu / Mint": linuxRelease(mainExeHash),
  });

/** Route controlled vendor responses by the exact caller-selected URL. */
const vendor = (responses: Readonly<Record<string, () => Response>>) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const respond = responses[String(input)];
    if (respond === undefined)
      throw new Error(`Unexpected request ${String(input)}`);
    return respond();
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch };
};
const failed = (status: number, cancel?: () => void) => () =>
  new Response(new ReadableStream({ ...(cancel ? { cancel } : {}) }), {
    status,
  });

const linuxDoctor = () =>
  createDoctorHostFixture({
    platform: "linux",
    linuxDistribution: async () => ({
      id: "ubuntu",
      versionId: "24.04",
      packageFamily: "deb",
      hopperSetupSupported: true,
    }),
  });

const installThroughSetup = async (
  platform: "darwin" | "linux",
  environment: Readonly<NodeJS.ProcessEnv> = {},
) => {
  const host = systemSetupHost(
    platform === "linux"
      ? linuxDoctor()
      : createDoctorHostFixture({ platform: "darwin" }),
    environment,
  );
  try {
    return await host.installHopper(false);
  } finally {
    expect(await host.close?.()).toBeUndefined();
  }
};

it.each([404, 503] as const)(
  "names the macOS release feed URL and HTTP %i in the setup result",
  async (status) => {
    const { fetch } = vendor({ [HOPPER_RELEASES_URL]: failed(status) });
    expect(await installThroughSetup("darwin")).toEqual({
      status: "failed",
      code: "download_failed",
      remediation: `The official Hopper release feed request to ${HOPPER_RELEASES_URL} returned HTTP ${status}. ${recovery[status]}`,
      download: {
        request: "release_feed",
        url: HOPPER_RELEASES_URL,
        kind: "http_status",
        httpStatus: status,
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it.each([404, 503] as const)(
  "names the selected macOS DMG URL and HTTP %i in the setup result",
  async (status) => {
    const cancel = vi.fn();
    vendor({
      [HOPPER_RELEASES_URL]: () => new Response(feed()),
      [dmgUrl]: failed(status, cancel),
    });
    expect(await installThroughSetup("darwin")).toEqual({
      status: "failed",
      code: "download_failed",
      remediation: `The official Hopper package request to ${dmgUrl} returned HTTP ${status}. ${recovery[status]}`,
      download: {
        request: "package",
        url: dmgUrl,
        kind: "http_status",
        httpStatus: status,
      },
    });
    expect(cancel).toHaveBeenCalledOnce();
  },
);

it("keeps a network failure distinct from an HTTP status in setup", async () => {
  vendor({
    [HOPPER_RELEASES_URL]: () => new Response(feed()),
    [dmgUrl]: () => {
      throw new TypeError("fetch failed", {
        cause: new Error("getaddrinfo ENOTFOUND www.hopperapp.com"),
      });
    },
  });
  expect(await installThroughSetup("darwin")).toEqual({
    status: "failed",
    code: "download_failed",
    remediation: `The official Hopper package request to ${dmgUrl} failed with a network error (fetch failed: getaddrinfo ENOTFOUND www.hopperapp.com). Check network, DNS, proxy and TLS access to this URL, then retry.`,
    download: {
      request: "package",
      url: dmgUrl,
      kind: "network",
      detail: "fetch failed: getaddrinfo ENOTFOUND www.hopperapp.com",
    },
  });
});

it.each([404, 503] as const)(
  "names the Linux publisher release feed URL and HTTP %i in the setup result",
  async (status) => {
    const { fetch } = vendor({ [HOPPER_RELEASES_URL]: failed(status) });
    expect(await installThroughSetup("linux")).toEqual({
      status: "failed",
      code: "download_failed",
      remediation: `The official Hopper release feed request to ${HOPPER_RELEASES_URL} returned HTTP ${status}. ${recovery[status]}`,
      download: {
        request: "release_feed",
        url: HOPPER_RELEASES_URL,
        kind: "http_status",
        httpStatus: status,
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it.each([404, 503] as const)(
  "names the Linux publisher public-key URL and HTTP %i before any package manager runs",
  async (status) => {
    const root = await createTestTempDirectory("rea-hopper-key-failure-");
    const { fetch } = vendor({
      [HOPPER_RELEASES_URL]: () => new Response(feed()),
      [debUrl]: () => new Response(packageBytes),
      [HOPPER_PUBLIC_KEY_URL]: failed(status),
    });
    expect(
      await installThroughSetup("linux", {
        HOME: root,
        XDG_CACHE_HOME: join(root, "cache"),
      }),
    ).toEqual({
      status: "failed",
      code: "publisher_verification_failed",
      remediation: `The official Hopper public key request to ${HOPPER_PUBLIC_KEY_URL} returned HTTP ${status}. ${recovery[status]}`,
      download: {
        request: "public_key",
        url: HOPPER_PUBLIC_KEY_URL,
        kind: "http_status",
        httpStatus: status,
      },
    });
    expect(fetch.mock.calls.map(([input]) => input)).toEqual([
      HOPPER_RELEASES_URL,
      debUrl,
      HOPPER_PUBLIC_KEY_URL,
    ]);
  },
);

it.each([404, 503] as const)(
  "names the Linux package URL and HTTP %i in the setup result",
  async (status) => {
    const unexpected = vi.fn((): never => {
      throw new Error("Unexpected installation effect");
    });
    const host: LinuxHopperInstallHost = {
      distribution: async () => ({
        id: "ubuntu",
        versionId: "24.04",
        packageFamily: "deb",
        hopperSetupSupported: true,
      }),
      release: async () => ok(linuxRelease()),
      download: downloadHopperPackage,
      createTemporaryDirectory: unexpected,
      writeArchive: unexpected,
      installPackage: unexpected,
      verifyArchive: unexpected,
      retainVerifiedArchive: unexpected,
      launcherStatus: unexpected,
      cleanup: unexpected,
    };
    vi.mocked(systemLinuxHopperInstallHost).mockReturnValueOnce(host);
    const cancel = vi.fn();
    vendor({ [debUrl]: failed(status, cancel) });
    expect(await installThroughSetup("linux")).toEqual({
      status: "failed",
      code: "download_failed",
      remediation: `The official Hopper package request to ${debUrl} returned HTTP ${status}. ${recovery[status]}`,
      download: {
        request: "package",
        url: debUrl,
        kind: "http_status",
        httpStatus: status,
      },
    });
    expect(cancel).toHaveBeenCalledOnce();
  },
);

it.each([503, 404] as const)(
  "names the package URL and HTTP %i when launch verification downloads the current release",
  async (status) => {
    const root = await createTestTempDirectory("rea-hopper-launch-download-");
    const launcher = join(root, "Hopper");
    await writeFile(launcher, "fixture launcher");
    const launcherHash = sha256(Buffer.from("fixture launcher"));
    vendor({
      [HOPPER_RELEASES_URL]: () => new Response(feed(launcherHash)),
      [debUrl]: failed(status),
    });
    const publisher = new LinuxHopperPublisher(
      { XDG_CACHE_HOME: join(root, "cache") },
      async () => "deb",
    );
    try {
      const inspected = await publisher.inspectLauncher(launcher);
      expect(inspected).toMatchObject({
        ok: false,
        error: {
          reason: "download",
          message: `The official Hopper package request to ${debUrl} returned HTTP ${status}.`,
          download: {
            request: "package",
            url: debUrl,
            kind: "http_status",
            httpStatus: status,
          },
        },
      });
    } finally {
      await publisher.close();
    }
  },
);

it.each([undefined, null, 0, 200, 600, 503.5, "503", Number.NaN])(
  "omits an invalid failed-response status %s instead of reporting it",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
        const response = new Response(null, { status: 503 });
        Object.defineProperty(response, "status", { value: status });
        return response;
      }),
    );
    expect(await downloadHopperPackage(debUrl)).toEqual({
      ok: false,
      error: { url: debUrl, kind: "http_status" },
    });
    expect(await installThroughSetup("darwin")).toEqual({
      status: "failed",
      code: "download_failed",
      remediation: `The official Hopper release feed request to ${HOPPER_RELEASES_URL} received an unsuccessful HTTP response without a valid status. Check proxy, firewall or network policy for this request, then retry.`,
      download: {
        request: "release_feed",
        url: HOPPER_RELEASES_URL,
        kind: "http_status",
      },
    });
  },
);

it("keeps a successful download unchanged", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("package")),
  );
  expect(await downloadHopperPackage(debUrl)).toEqual(
    ok(Buffer.from("package")),
  );
});

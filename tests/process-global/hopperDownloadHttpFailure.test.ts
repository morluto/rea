import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createDoctorHostFixture } from "../../src/application/Doctor.fixture.js";
import {
  describeHopperRequestFailure,
  downloadHopperPackage,
  hopperRequestRecovery,
  type HopperRequestFailure,
} from "../../src/application/HopperDownload.js";
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
import type {
  SetupFailureCode,
  SetupHopperInstallResult,
} from "../../src/application/SetupInstallFailure.js";
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

const nativeFetch = globalThis.fetch;

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
const credentialed =
  "https://fixture-user:fixture-secret@downloads.hopperapp.com/redirected";

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
const vendor = (
  responses: Readonly<Record<string, () => Response | Promise<Response>>>,
) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const respond = responses[String(input)];
    // Native Fetch refuses credentialed URLs offline, echoing them in its error.
    if (respond === undefined && String(input) === credentialed)
      return nativeFetch(input, init);
    if (respond === undefined)
      throw new Error(`Unexpected request ${String(input)}`);
    return respond();
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch };
};
const failed = (status: number, cancel?: () => void) => () =>
  new Response(new ReadableStream(cancel ? { cancel } : {}), {
    status,
  });

/** Delivered guidance comes from the owning formatters; facts are checked independently. */
const expectRequestFailure = (
  result: SetupHopperInstallResult,
  code: SetupFailureCode,
  download: HopperRequestFailure,
) => {
  expect(result).toEqual({
    status: "failed",
    code,
    remediation: `${describeHopperRequestFailure(download)} ${hopperRequestRecovery(download)}`,
    download,
  });
  if (result.status !== "failed") throw new Error("Expected a setup failure");
  expect(result.remediation).toContain(download.url);
  if (download.kind === "http_status" && download.httpStatus !== undefined)
    expect(result.remediation).toContain(`HTTP ${download.httpStatus}`);
};

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
    expectRequestFailure(
      await installThroughSetup("darwin"),
      "download_failed",
      {
        request: "release_feed",
        url: HOPPER_RELEASES_URL,
        kind: "http_status",
        httpStatus: status,
      },
    );
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
    expectRequestFailure(
      await installThroughSetup("darwin"),
      "download_failed",
      {
        request: "package",
        url: dmgUrl,
        kind: "http_status",
        httpStatus: status,
      },
    );
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
  expectRequestFailure(await installThroughSetup("darwin"), "download_failed", {
    request: "package",
    url: dmgUrl,
    kind: "network",
    detail: "fetch failed: getaddrinfo ENOTFOUND www.hopperapp.com",
  });
});

it.each([404, 503] as const)(
  "names the Linux publisher release feed URL and HTTP %i in the setup result",
  async (status) => {
    const { fetch } = vendor({ [HOPPER_RELEASES_URL]: failed(status) });
    expectRequestFailure(
      await installThroughSetup("linux"),
      "download_failed",
      {
        request: "release_feed",
        url: HOPPER_RELEASES_URL,
        kind: "http_status",
        httpStatus: status,
      },
    );
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
    expectRequestFailure(
      await installThroughSetup("linux", {
        HOME: root,
        XDG_CACHE_HOME: join(root, "cache"),
      }),
      "publisher_verification_failed",
      {
        request: "public_key",
        url: HOPPER_PUBLIC_KEY_URL,
        kind: "http_status",
        httpStatus: status,
      },
    );
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
    expectRequestFailure(
      await installThroughSetup("linux"),
      "download_failed",
      {
        request: "package",
        url: debUrl,
        kind: "http_status",
        httpStatus: status,
      },
    );
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
          download: {
            request: "package",
            url: debUrl,
            kind: "http_status",
            httpStatus: status,
          },
        },
      });
      if (inspected.ok || inspected.error.download === undefined)
        throw new Error("Expected the failed package request");
      expect(inspected.error.message).toBe(
        describeHopperRequestFailure(inspected.error.download),
      );
      expect(inspected.error.message).toContain(`HTTP ${status}`);
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
    expectRequestFailure(
      await installThroughSetup("darwin"),
      "download_failed",
      {
        request: "release_feed",
        url: HOPPER_RELEASES_URL,
        kind: "http_status",
      },
    );
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

it("chooses recovery by failure class: missing file, temporary service failure, refusal or unreachable host", () => {
  const status = (httpStatus?: number) =>
    hopperRequestRecovery(
      httpStatus === undefined
        ? { url: debUrl, kind: "http_status" }
        : { url: debUrl, kind: "http_status", httpStatus },
    );
  const unreachable = hopperRequestRecovery({
    url: debUrl,
    kind: "network",
    detail: "fetch failed",
  });
  expect(status(410)).toBe(status(404));
  for (const transient of [408, 429, 500, 502, 504])
    expect(status(transient)).toBe(status(503));
  expect(status(undefined)).toBe(status(403));
  expect(
    hopperRequestRecovery({
      url: debUrl,
      kind: "timeout",
      limit: "stalled",
      timeoutMs: 30_000,
      receivedBytes: 0,
    }),
  ).toBe(unreachable);
  expect(
    new Set([status(404), status(503), status(403), unreachable]).size,
  ).toBe(4);
});

it.each([
  { platform: "darwin", request: "package", url: dmgUrl },
  { platform: "linux", request: "release_feed", url: HOPPER_RELEASES_URL },
] as const)(
  "refuses a credentialed redirect of the $request request without echoing its credentials",
  async ({ platform, request, url }) => {
    const { fetch } = vendor({
      [HOPPER_RELEASES_URL]: () =>
        url === HOPPER_RELEASES_URL
          ? new Response(null, {
              status: 302,
              headers: { location: credentialed },
            })
          : new Response(feed()),
      [dmgUrl]: () =>
        new Response(null, {
          status: 302,
          headers: { location: credentialed },
        }),
    });
    const result = await installThroughSetup(platform);
    expectRequestFailure(result, "download_failed", {
      request,
      url,
      kind: "url_refused",
      refusal: "credentials",
    });
    expect(JSON.stringify(result)).not.toMatch(/fixture-(user|secret)/u);
    expect(fetch.mock.calls.map(([input]) => input)).not.toContain(
      credentialed,
    );
  },
);

it("refuses a credentialed request URL before any request and reports it without userinfo", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetch);
  expect(
    await downloadHopperPackage(
      "https://fixture-user:fixture-secret@www.hopperapp.com/package",
    ),
  ).toEqual({
    ok: false,
    error: {
      url: "https://www.hopperapp.com/package",
      kind: "url_refused",
      refusal: "credentials",
    },
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps an observed HTTP status when its truncated body cannot be cancelled", async () => {
  vendor({
    [HOPPER_RELEASES_URL]: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 503 },
      ),
  });
  expectRequestFailure(await installThroughSetup("darwin"), "download_failed", {
    request: "release_feed",
    url: HOPPER_RELEASES_URL,
    kind: "http_status",
    httpStatus: 503,
  });
});

it("keeps the size-limit outcome when releasing the oversized body fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(4));
            },
            cancel() {
              throw new TypeError("terminated");
            },
          }),
        ),
    ),
  );
  expect(await downloadHopperPackage(debUrl, { maxBytes: 3 })).toEqual({
    ok: false,
    error: { url: debUrl, kind: "response_too_large", maxBytes: 3 },
  });
});

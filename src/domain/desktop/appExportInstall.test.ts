import { describe, expect, it } from "vitest";

import {
  electronLaunchArguments,
  exportInstall,
  fromUbuntuNobleArchive,
  installLimitations,
} from "./appExportInstall.js";
import type { AptRepository, DesktopPackage } from "./desktopCapture.js";

const TYPORA_SOURCE = "https://downloads.typora.io/linux ./ Packages";

const repository = (overrides: Partial<AptRepository> = {}): AptRepository => ({
  source: TYPORA_SOURCE,
  sources_file: "/etc/apt/sources.list.d/typora.list",
  uri: "https://downloads.typora.io/linux",
  suite: "./",
  components: [],
  signing_key: {
    path: "/etc/apt/trusted.gpg.d/typora.gpg",
    sha256: "a".repeat(64),
    format: "binary",
    fingerprint: "4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE",
  },
  ...overrides,
});

const typora = (
  repositories: readonly AptRepository[] | undefined,
): DesktopPackage => ({
  kind: "deb",
  name: "typora:arm64",
  version: "1.14.9-1",
  architecture: "arm64",
  sources: [TYPORA_SOURCE],
  source_origins: ["typora.io"],
  package_lists_present: true,
  ...(repositories === undefined
    ? {}
    : { apt_repositories: [...repositories] }),
  library_packages: ["libgbm1", "libnss3"],
  missing_libraries: [],
  unpackaged_libraries: [],
});

describe("exportInstall", () => {
  it("installs from a vendor repository whose key the capture verified", () => {
    const install = exportInstall(typora([repository()]), "typora");

    expect(install).toEqual({
      ok: true,
      value: {
        aptPackage: "typora",
        libraryPackages: ["libgbm1", "libnss3"],
        sources: [
          {
            uri: "https://downloads.typora.io/linux",
            suite: "./",
            components: [],
            keyFile: "apt-keys/typora.gpg",
            keySha256: "a".repeat(64),
          },
        ],
        skipped: [],
      },
    });
  });

  it("names an armored key .asc and shares one file between repositories with the same key", () => {
    const armored = repository({
      uri: "https://example.com/apt",
      suite: "stable",
      components: ["main"],
      signing_key: {
        path: "/usr/share/keyrings/example.asc",
        sha256: "b".repeat(64),
        format: "armored",
        fingerprint: "F",
      },
    });
    const install = exportInstall(
      typora([
        repository(),
        armored,
        repository({ uri: "https://mirror.example.com/typora" }),
      ]),
      "typora",
    );

    expect(
      install.ok && install.value.sources.map((source) => source.keyFile),
    ).toEqual([
      "apt-keys/typora.gpg",
      "apt-keys/typora-2.asc",
      "apt-keys/typora.gpg",
    ]);
  });

  it("refuses a vendor repository whose key was not verified, naming it and the reason", () => {
    const install = exportInstall(
      typora([
        repository({
          signing_key: null,
          signing_key_reason: "gpgv is not installed",
        }),
      ]),
      "typora",
    );

    expect(install).toEqual({
      ok: false,
      error: expect.stringContaining(
        "https://downloads.typora.io/linux ./: gpgv is not installed",
      ),
    });
  });

  it("leaves out an unverified repository when another one verified", () => {
    const install = exportInstall(
      typora([
        repository({
          uri: "http://ftp.example.com/typora",
          signing_key: null,
          signing_key_reason: "no candidate key verifies it",
        }),
        repository(),
      ]),
      "typora",
    );

    expect(install.ok && install.value.skipped).toEqual([
      "http://ftp.example.com/typora ./: no candidate key verifies it",
    ]);
    expect(install.ok && install.value.sources).toHaveLength(1);
  });

  it("refuses repositories agentenv cannot fetch, captures without repositories, and other package kinds", () => {
    expect(
      exportInstall(typora([repository({ uri: "file:/srv/apt" })]), "typora"),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("http or https"),
    });
    expect(exportInstall(typora(undefined), "typora")).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "not installed from the Ubuntu 24.04 package archive or a vendor apt repository",
      ),
    });
    expect(
      exportInstall(
        { ...typora(undefined), kind: "snap", name: "typora" },
        "typora",
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("not an apt package (snap typora"),
    });
  });

  it("installs an Ubuntu archive package by name, trusting its declared dependencies", () => {
    const install = exportInstall(
      {
        ...typora(undefined),
        name: "mousepad",
        sources: [
          "http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages",
        ],
        source_origins: ["Ubuntu"],
      },
      "mousepad",
    );

    expect(install).toMatchObject({
      ok: true,
      value: {
        aptPackage: "mousepad",
        sources: [],
        libraryPackages: [],
      },
    });
  });
});

describe("electronLaunchArguments", () => {
  it("turns Chromium's sandbox off right after an Electron program, once", () => {
    expect(electronLaunchArguments(["typora", "/home/ada/a.md"], true)).toEqual(
      ["typora", "--no-sandbox", "/home/ada/a.md"],
    );
    expect(electronLaunchArguments(["typora", "--no-sandbox"], true)).toEqual([
      "typora",
      "--no-sandbox",
    ]);
    expect(electronLaunchArguments(["mousepad"], false)).toEqual(["mousepad"]);
  });
});

describe("installLimitations", () => {
  it("says where the package comes from, which libraries are unmapped and that the sandbox is off", () => {
    const installed: DesktopPackage = {
      ...typora([repository()]),
      missing_libraries: ["libfoo.so.1"],
      library_packages_reason: "REA stopped after 512 libraries",
    };
    const install = exportInstall(installed, "typora");
    if (!install.ok) throw new Error(install.error);

    const limitations = installLimitations(install.value, installed, true).join(
      "\n",
    );

    expect(limitations).toContain(
      "installed by name from https://downloads.typora.io/linux",
    );
    expect(limitations).toContain(
      "REA stopped after 512 libraries; not found on the capture host: libfoo.so.1",
    );
    expect(limitations).toContain("Chromium's sandbox is off");
  });
});

describe("fromUbuntuNobleArchive", () => {
  const mirror = "http://mirror.local/ubuntu noble/universe amd64 Packages";
  const ports =
    "http://ports.ubuntu.com/ubuntu-ports noble/universe arm64 Packages";

  it("trusts apt's origin, so mirrors count and other repositories do not", () => {
    expect(fromUbuntuNobleArchive([mirror], ["Ubuntu"])).toBe(true);
    expect(
      fromUbuntuNobleArchive(
        [
          "https://ppa.launchpadcontent.net/a/b/ubuntu noble/main amd64 Packages",
        ],
        ["LP-PPA-a-b"],
      ),
    ).toBe(false);
    expect(
      fromUbuntuNobleArchive(
        ["https://dl.winehq.org/wine-builds/ubuntu noble/main amd64 Packages"],
        [null],
      ),
    ).toBe(false);
    expect(
      fromUbuntuNobleArchive(
        ["http://archive.ubuntu.com/ubuntu jammy/universe amd64 Packages"],
        ["Ubuntu"],
      ),
    ).toBe(false);
  });

  it("accepts only Canonical's hosts when the capture recorded no origins", () => {
    expect(fromUbuntuNobleArchive([ports], undefined)).toBe(true);
    expect(fromUbuntuNobleArchive([mirror], undefined)).toBe(false);
    expect(fromUbuntuNobleArchive([], [])).toBe(false);
  });
});

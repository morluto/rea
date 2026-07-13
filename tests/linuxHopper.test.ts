import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  installLinuxHopper,
  linuxPackageManagerCommands,
  linuxSharedLibrariesAvailable,
  parseLinuxDistribution,
  type LinuxDistribution,
  type LinuxHopperDownload,
  type LinuxHopperInstallHost,
  type LinuxHopperLauncherStatus,
  type LinuxPackageFamily,
} from "../src/application/LinuxHopper.js";

class RecordingLinuxHost implements LinuxHopperInstallHost {
  distributionValue: LinuxDistribution | undefined = {
    id: "ubuntu",
    versionId: "24.04",
    packageFamily: "deb",
    supported: true,
  };
  archive = new Uint8Array([1, 2, 3]);
  archiveOk = true;
  installSucceeds = true;
  launcherStatusValue: LinuxHopperLauncherStatus = "ready";
  downloads: string[] = [];
  installed: Array<{ family: LinuxPackageFamily; archive: string }> = [];
  cleaned: string[] = [];

  distribution = (): Promise<LinuxDistribution | undefined> =>
    Promise.resolve(this.distributionValue);
  download = (url: string): Promise<LinuxHopperDownload> => {
    this.downloads.push(url);
    return Promise.resolve({ ok: this.archiveOk, bytes: this.archive });
  };
  createTemporaryDirectory = (): Promise<string> =>
    Promise.resolve("/tmp/rea test");
  writeArchive = (): Promise<void> => Promise.resolve();
  installPackage = (
    family: LinuxPackageFamily,
    archive: string,
  ): Promise<boolean> => {
    this.installed.push({ family, archive });
    return Promise.resolve(this.installSucceeds);
  };
  launcherStatus = (): Promise<LinuxHopperLauncherStatus> =>
    Promise.resolve(this.launcherStatusValue);
  cleanup = (path: string): Promise<void> => {
    this.cleaned.push(path);
    return Promise.resolve();
  };
}

describe("Linux Hopper host classification", () => {
  it.each([
    ['ID=ubuntu\nVERSION_ID="24.04"\n', "deb"],
    ["ID=fedora\nVERSION_ID=41\n", "rpm"],
    ["ID=arch\n", "arch"],
  ] as const)("accepts an official Hopper distribution", (document, family) => {
    expect(parseLinuxDistribution(document)).toMatchObject({
      packageFamily: family,
      supported: true,
    });
  });

  it("detects unresolved or loader-reported shared libraries", () => {
    expect(
      linuxSharedLibrariesAvailable(
        "libQt6Network.so.6 => not found\nlibc.so.6 => /lib/libc.so.6",
      ),
    ).toBe(false);
    expect(
      linuxSharedLibrariesAvailable(
        "error while loading shared libraries: libQt6Gui.so.6",
      ),
    ).toBe(false);
    expect(
      linuxSharedLibrariesAvailable(
        "libQt6Network.so.6 => /usr/lib/libQt6Network.so.6",
      ),
    ).toBe(true);
  });

  it.each([
    'ID=ubuntu\nVERSION_ID="22.04"\n',
    "ID=fedora\nVERSION_ID=40\n",
    'ID=debian\nVERSION_ID="13"\nID_LIKE=debian\n',
  ])("rejects unsupported vendor/version combinations", (document) => {
    expect(parseLinuxDistribution(document).supported).toBe(false);
  });
});

describe("Linux Hopper installation", () => {
  it.each([
    ["deb", "apt-get"],
    ["rpm", "dnf"],
    ["arch", "pacman"],
  ] as const)("selects the %s native package manager", (family, executable) => {
    expect(
      linuxPackageManagerCommands(family, "/tmp/Hopper package", true),
    ).toContainEqual(
      expect.objectContaining({
        executable,
      }),
    );
    expect(
      linuxPackageManagerCommands(family, "/tmp/Hopper package", false),
    ).toContainEqual(
      expect.objectContaining({
        executable: "pkexec",
        args: expect.arrayContaining([executable, "/tmp/Hopper package"]),
      }),
    );
  });

  it.each([
    ["deb", ["xvfb", "xauth", "python3", "libx11-6", "libxtst6"]],
    [
      "rpm",
      [
        "xorg-x11-server-Xvfb",
        "xorg-x11-xauth",
        "python3",
        "libX11",
        "libXtst",
      ],
    ],
    ["arch", ["xorg-server-xvfb", "xorg-xauth", "python", "libx11", "libxtst"]],
  ] as const)(
    "installs the %s demo-session dependencies",
    (family, packages) => {
      expect(
        linuxPackageManagerCommands(family, "/tmp/Hopper package", true),
      ).toContainEqual(
        expect.objectContaining({
          args: expect.arrayContaining([...packages]),
        }),
      );
    },
  );

  it.each(["deb", "rpm", "arch"] as const)(
    "downloads, verifies, installs, reads back, and cleans a %s package",
    async (family) => {
      const host = new RecordingLinuxHost();
      host.distributionValue = {
        id: family,
        packageFamily: family,
        supported: true,
      };
      const result = await installFixture(host);
      expect(result).toEqual({
        status: "installed",
        launcherPath: "/opt/hopper/bin/Hopper",
      });
      expect(host.installed).toEqual([
        { family, archive: `/tmp/rea test/hopper.${family}` },
      ]);
      expect(host.cleaned).toEqual(["/tmp/rea test"]);
    },
  );

  it.each([
    ["unsupported host", "unsupported_host"],
    ["package request failure", "download"],
    ["checksum mismatch", "integrity"],
    ["package manager failure", "authorization_or_package_manager"],
    ["missing launcher", "launcher_missing"],
    ["missing runtime", "runtime_dependencies"],
    ["unsupported build", "unsupported_hopper_build"],
  ] as const)("classifies %s", async (scenario, reason) => {
    const host = new RecordingLinuxHost();
    if (scenario === "unsupported host")
      host.distributionValue = {
        id: "debian",
        packageFamily: "deb",
        supported: false,
      };
    if (scenario === "package request failure") host.archiveOk = false;
    if (scenario === "checksum mismatch") host.archive = new Uint8Array([9]);
    if (scenario === "package manager failure") host.installSucceeds = false;
    if (scenario === "missing launcher") host.launcherStatusValue = "missing";
    if (scenario === "missing runtime")
      host.launcherStatusValue = "runtime_dependencies";
    if (scenario === "unsupported build")
      host.launcherStatusValue = "unsupported_hopper_build";
    expect(await installFixture(host)).toEqual({
      status: "failed",
      reason,
    });
    if (host.installed.length > 0)
      expect(host.cleaned).toEqual(["/tmp/rea test"]);
  });

  it("cancels before network or mutation", async () => {
    const host = new RecordingLinuxHost();
    const controller = new AbortController();
    controller.abort();
    expect(
      await installLinuxHopper(host, { signal: controller.signal }),
    ).toEqual({
      status: "failed",
      reason: "cancelled",
    });
    expect(host.downloads).toEqual([]);
    expect(host.installed).toEqual([]);
  });
});

function releasesFor(
  bytes: Uint8Array,
): Record<
  LinuxPackageFamily,
  { filename: string; file_length: string; file_hash: string }
> {
  const release = (extension: string) => ({
    filename: `https://www.hopperapp.com:443/downloader/public/Hopper.${extension}`,
    file_length: String(bytes.byteLength),
    file_hash: createHash("sha1").update(bytes).digest("hex"),
  });
  return {
    deb: release("deb"),
    rpm: release("rpm"),
    arch: release("pkg.tar.xz"),
  };
}

const installFixture = (host: RecordingLinuxHost) =>
  installLinuxHopper(host, {
    releases: releasesFor(new Uint8Array([1, 2, 3])),
  });

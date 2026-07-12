import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  installLinuxHopper,
  linuxPackageManagerCommand,
  linuxSharedLibrariesAvailable,
  parseLinuxDistribution,
  type LinuxDistribution,
  type LinuxHopperDownload,
  type LinuxHopperInstallHost,
  type LinuxPackageFamily,
} from "../src/application/LinuxHopper.js";

class RecordingLinuxHost implements LinuxHopperInstallHost {
  distributionValue: LinuxDistribution | undefined = {
    id: "ubuntu",
    versionId: "24.04",
    packageFamily: "deb",
    supported: true,
  };
  metadata: unknown = releasesFor(new Uint8Array([1, 2, 3]));
  archive = new Uint8Array([1, 2, 3]);
  metadataOk = true;
  archiveOk = true;
  installSucceeds = true;
  launcherExists = true;
  downloads: string[] = [];
  installed: Array<{ family: LinuxPackageFamily; archive: string }> = [];
  cleaned: string[] = [];

  distribution = (): Promise<LinuxDistribution | undefined> =>
    Promise.resolve(this.distributionValue);
  download = (url: string): Promise<LinuxHopperDownload> => {
    this.downloads.push(url);
    if (url.includes("files-api.php"))
      return Promise.resolve({
        ok: this.metadataOk,
        bytes: new TextEncoder().encode(JSON.stringify(this.metadata)),
      });
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
  launcherReady = (): Promise<boolean> => Promise.resolve(this.launcherExists);
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
      linuxPackageManagerCommand(family, "/tmp/Hopper package", true),
    ).toMatchObject({
      executable,
    });
    expect(
      linuxPackageManagerCommand(family, "/tmp/Hopper package", false),
    ).toMatchObject({
      executable: "pkexec",
      args: [
        executable,
        expect.any(String),
        expect.any(String),
        expect.any(String),
      ],
    });
  });

  it.each(["deb", "rpm", "arch"] as const)(
    "downloads, verifies, installs, reads back, and cleans a %s package",
    async (family) => {
      const host = new RecordingLinuxHost();
      host.distributionValue = {
        id: family,
        packageFamily: family,
        supported: true,
      };
      const result = await installLinuxHopper(host);
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
    ["malformed metadata", "release_metadata"],
    ["unexpected origin", "release_metadata"],
    ["metadata request failure", "release_metadata"],
    ["package request failure", "download"],
    ["checksum mismatch", "integrity"],
    ["package manager failure", "authorization_or_package_manager"],
    ["missing launcher", "launcher_missing"],
  ] as const)("classifies %s", async (scenario, reason) => {
    const host = new RecordingLinuxHost();
    if (scenario === "unsupported host")
      host.distributionValue = {
        id: "debian",
        packageFamily: "deb",
        supported: false,
      };
    if (scenario === "malformed metadata") host.metadata = { invalid: true };
    if (scenario === "unexpected origin") {
      const metadata = releasesFor(host.archive);
      const ubuntu = metadata["Ubuntu / Mint"];
      if (ubuntu === undefined)
        throw new Error("fixture omitted Ubuntu release");
      ubuntu.filename = "https://example.com/Hopper.deb";
      host.metadata = metadata;
    }
    if (scenario === "metadata request failure") host.metadataOk = false;
    if (scenario === "package request failure") host.archiveOk = false;
    if (scenario === "checksum mismatch") host.archive = new Uint8Array([9]);
    if (scenario === "package manager failure") host.installSucceeds = false;
    if (scenario === "missing launcher") host.launcherExists = false;
    expect(await installLinuxHopper(host)).toEqual({
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
  string,
  { filename: string; file_length: string; file_hash: string }
> {
  const release = (extension: string) => ({
    filename: `https://www.hopperapp.com:443/downloader/public/Hopper.${extension}`,
    file_length: String(bytes.byteLength),
    file_hash: createHash("sha1").update(bytes).digest("hex"),
  });
  return {
    "Ubuntu / Mint": release("deb"),
    Fedora: release("rpm"),
    Arch: release("pkg.tar.xz"),
  };
}

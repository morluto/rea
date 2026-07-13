import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  installMacHopper,
  type MacHopperInstallHost,
} from "../src/application/MacHopper.js";

class FakeMacHopperHost implements MacHopperInstallHost {
  readonly archive = new TextEncoder().encode("hopper-dmg");
  archiveOk = true;
  valid = true;
  existing = false;
  mountSucceeds = true;
  copySucceeds = true;
  launcherSucceeds = true;
  badHash = false;
  unmounts = 0;
  cleanups = 0;
  opens = 0;

  download = (url: string) =>
    Promise.resolve(
      url.includes("files-api")
        ? {
            ok: true,
            bytes: new TextEncoder().encode(
              JSON.stringify({
                "OS X": {
                  filename:
                    "https://www.hopperapp.com:443/downloader/public/Hopper-demo.dmg",
                  file_length: String(this.archive.byteLength),
                  file_hash: this.badHash
                    ? "0".repeat(40)
                    : createHash("sha1").update(this.archive).digest("hex"),
                },
              }),
            ),
          }
        : { ok: this.archiveOk, bytes: this.archive },
    );
  createTemporaryDirectory = () => Promise.resolve("/tmp/rea-hopper-test");
  createMountDirectory = () => Promise.resolve();
  writePackage = () => Promise.resolve();
  mount = () => Promise.resolve(this.mountSucceeds);
  unmount = () => {
    this.unmounts += 1;
    return Promise.resolve();
  };
  appBundle = () => Promise.resolve("/mounted/Hopper Disassembler.app");
  validBundle = () => Promise.resolve(this.valid);
  destinationExists = () => Promise.resolve(this.existing);
  installBundle = () => Promise.resolve(this.copySucceeds);
  launcherReady = () => Promise.resolve(this.launcherSucceeds);
  openApplication = () => {
    this.opens += 1;
    return Promise.resolve();
  };
  cleanup = () => {
    this.cleanups += 1;
    return Promise.resolve();
  };
  destination = () => "/home/user/Applications/Hopper Disassembler.app";
}

describe("macOS Hopper installation", () => {
  it("installs, verifies, opens, and cleans the official package", async () => {
    const host = new FakeMacHopperHost();
    await expect(installMacHopper(host)).resolves.toEqual({
      status: "installed",
      launcherPath:
        "/home/user/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
    });
    expect(host.opens).toBe(1);
    expect(host.unmounts).toBe(1);
    expect(host.cleanups).toBe(1);
  });

  it("rejects an integrity mismatch before mounting", async () => {
    const host = new FakeMacHopperHost();
    host.badHash = true;
    await expect(installMacHopper(host)).resolves.toEqual({
      status: "failed",
      reason: "integrity",
    });
    expect(host.unmounts).toBe(0);
    expect(host.cleanups).toBe(0);
  });

  it("refuses to overwrite an existing application", async () => {
    const host = new FakeMacHopperHost();
    host.existing = true;
    await expect(installMacHopper(host)).resolves.toEqual({
      status: "failed",
      reason: "destination_exists",
    });
  });

  it("cleans and detaches after bundle validation fails", async () => {
    const host = new FakeMacHopperHost();
    host.valid = false;
    await expect(installMacHopper(host)).resolves.toEqual({
      status: "failed",
      reason: "bundle",
    });
    expect(host.unmounts).toBe(1);
    expect(host.cleanups).toBe(1);
  });
});

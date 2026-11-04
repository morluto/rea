import { describe, expect, it } from "vitest";

import {
  isAppImageHeader,
  packageFromPath,
  parseAptPolicySources,
  parseDpkgOwners,
  parseDpkgStatus,
} from "./linuxPackages.js";

describe("dpkg output", () => {
  it("reads every owner of a path and skips diversions", () => {
    expect(
      parseDpkgOwners(
        [
          "diversion by foo from: /usr/bin/editor",
          "editor-common, editor:amd64: /usr/bin/editor",
          "other: /usr/bin/editor-extra",
        ].join("\n"),
        "/usr/bin/editor",
      ),
    ).toEqual(["editor-common", "editor:amd64"]);
  });

  it("reads one status line", () => {
    expect(
      parseDpkgStatus("mousepad\t0.6.1-1build2\tamd64\tinstalled\n"),
    ).toEqual({
      name: "mousepad",
      version: "0.6.1-1build2",
      architecture: "amd64",
      status: "installed",
    });
    expect(parseDpkgStatus("")).toBeUndefined();
  });
});

describe("parseAptPolicySources", () => {
  it("lists the archives offering the installed version", () => {
    expect(
      parseAptPolicySources(
        [
          "mousepad:",
          "  Installed: 0.6.1-1build2",
          "  Candidate: 0.6.2-1",
          "  Version table:",
          "     0.6.2-1 500",
          "        500 http://archive.ubuntu.com/ubuntu oracular/universe amd64 Packages",
          " *** 0.6.1-1build2 500",
          "        500 http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages",
          "        100 /var/lib/dpkg/status",
        ].join("\n"),
      ),
    ).toEqual([
      "http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages",
    ]);
  });

  it("returns nothing for a version known only to dpkg", () => {
    expect(
      parseAptPolicySources(
        [
          "joplin:",
          "  Installed: 3.0.15",
          "  Candidate: 3.0.15",
          "  Version table:",
          " *** 3.0.15 100",
          "        100 /var/lib/dpkg/status",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("packageFromPath", () => {
  it("recognises snaps, flatpaks and AppImages by location", () => {
    expect(
      packageFromPath("/snap/firefox/4793/usr/lib/firefox/firefox"),
    ).toEqual({ kind: "snap", name: "firefox", revision: "4793" });
    expect(packageFromPath("/snap/bin/firefox")).toEqual({
      kind: "snap",
      name: "firefox",
      revision: null,
    });
    expect(
      packageFromPath(
        "/var/lib/flatpak/app/org.gnucash.GnuCash/x86_64/stable/active/files/bin/gnucash",
      ),
    ).toEqual({ kind: "flatpak", name: "org.gnucash.GnuCash" });
    expect(
      packageFromPath("/var/lib/flatpak/exports/bin/org.gnucash.GnuCash"),
    ).toEqual({ kind: "flatpak", name: "org.gnucash.GnuCash" });
    expect(packageFromPath("/home/ada/Apps/Joplin-3.0.15.AppImage")).toEqual({
      kind: "appimage",
    });
    expect(packageFromPath("/usr/bin/mousepad")).toBeUndefined();
  });

  it("recognises the AppImage magic in an ELF header", () => {
    const header = Uint8Array.from([
      0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02,
    ]);
    expect(isAppImageHeader(header)).toBe(true);
    expect(isAppImageHeader(header.with(10, 0x03))).toBe(false);
    expect(isAppImageHeader(header.subarray(0, 8))).toBe(false);
  });
});

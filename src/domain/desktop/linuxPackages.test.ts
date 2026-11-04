import { describe, expect, it } from "vitest";

import {
  isAppImageHeader,
  packageFromPath,
  parseAptPolicyOrigins,
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

describe("parseAptPolicyOrigins", () => {
  const policy = [
    "Package files:",
    " 100 /var/lib/dpkg/status",
    "     release a=now",
    " 500 http://ppa.launchpad.net/mozillateam/ppa/ubuntu noble/main arm64 Packages",
    "     release v=24.04,o=LP-PPA-mozillateam,a=noble,n=noble,l=Firefox ESR and security updates,c=main,b=arm64",
    "     origin ppa.launchpad.net",
    " 500 https://packages.example.com/apt stable/main arm64 Packages",
    "     release a=stable,c=main,b=arm64",
    "     origin packages.example.com",
    " 500 http://mirror.example.edu/ubuntu-ports noble-updates/universe arm64 Packages",
    "     release v=24.04,o=Ubuntu,a=noble-updates,n=noble,l=Ubuntu,c=universe,b=arm64",
    "     origin mirror.example.edu",
    " 500 http://ports.ubuntu.com/ubuntu-ports noble/universe arm64 Packages",
    "     release v=24.04,o=Ubuntu,a=noble,n=noble,l=Ubuntu,c=universe,b=arm64",
    "     origin ports.ubuntu.com",
    "Pinned packages:",
    "     firefox -> 128.5.0esr+build1-0ubuntu0.24.04.1~mt1 with priority 1001",
  ].join("\n");

  it("reads the origin apt reports for each package file", () => {
    expect(Object.fromEntries(parseAptPolicyOrigins(policy))).toEqual({
      "/var/lib/dpkg/status": null,
      "http://ppa.launchpad.net/mozillateam/ppa/ubuntu noble/main arm64 Packages":
        "LP-PPA-mozillateam",
      "https://packages.example.com/apt stable/main arm64 Packages": null,
      "http://mirror.example.edu/ubuntu-ports noble-updates/universe arm64 Packages":
        "Ubuntu",
      "http://ports.ubuntu.com/ubuntu-ports noble/universe arm64 Packages":
        "Ubuntu",
    });
  });

  it("keys origins by the source text the package policy lists", () => {
    const [source] = parseAptPolicySources(
      [
        "mousepad:",
        "  Installed: 0.6.1-1build2",
        "  Candidate: 0.6.1-1build2",
        "  Version table:",
        " *** 0.6.1-1build2 500",
        "        500 http://ports.ubuntu.com/ubuntu-ports noble/universe arm64 Packages",
        "        100 /var/lib/dpkg/status",
      ].join("\n"),
    );
    expect(parseAptPolicyOrigins(policy).get(source ?? "")).toBe("Ubuntu");
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

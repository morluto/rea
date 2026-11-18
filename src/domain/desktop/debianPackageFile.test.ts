import { describe, expect, it } from "vitest";

import { DPKG_DEB_OUTPUT } from "./debianPackageFile.fixture.js";
import {
  dependencyPackages,
  packageFileMismatch,
  parseDpkgDebFields,
} from "./debianPackageFile.js";

describe("parseDpkgDebFields", () => {
  it("reads the fields dpkg-deb prints and splits relationship fields into their entries", () => {
    expect(parseDpkgDebFields(DPKG_DEB_OUTPUT)).toEqual({
      package: "varicad2026-en",
      version: "1:2.03-1",
      architecture: "amd64",
      depends: [
        "libc6 (>= 2.34)",
        "libgl1 | libgl1-mesa-glx",
        "libstdc++6:any (>= 12)",
        "libx11-6",
        "libfontconfig1 (>= 2.12.6)",
      ],
      pre_depends: ["dpkg (>= 1.15.6)"],
    });
  });

  it("leaves out a field the file lacks and joins a folded one", () => {
    expect(
      parseDpkgDebFields(
        "Package: tool\nVersion: 1.0\nArchitecture: all\nDepends: libc6,\n  python3\n   (>= 3.12)\n",
      ),
    ).toMatchObject({
      architecture: "all",
      depends: ["libc6", "python3 (>= 3.12)"],
      pre_depends: [],
    });
  });

  it("gives nothing without Package, Version and Architecture", () => {
    expect(parseDpkgDebFields("Package: tool\nVersion: 1.0\n")).toBeUndefined();
    expect(parseDpkgDebFields("")).toBeUndefined();
  });
});

describe("packageFileMismatch", () => {
  const fields = parseDpkgDebFields(DPKG_DEB_OUTPUT);
  if (fields === undefined) throw new Error("fixture did not parse");
  const installed = {
    name: "varicad2026-en:amd64",
    version: "1:2.03-1",
    architecture: "amd64",
  };

  it("accepts the installed name, with or without its architecture qualifier, version and architecture", () => {
    expect(packageFileMismatch(fields, installed)).toBeUndefined();
    expect(
      packageFileMismatch(fields, { ...installed, name: "varicad2026-en" }),
    ).toBeUndefined();
  });

  it("names what the file holds and what dpkg installed when they differ", () => {
    expect(
      packageFileMismatch(fields, { ...installed, version: "1:2.02-1" }),
    ).toBe(
      "holds varicad2026-en 1:2.03-1 (amd64), not the installed varicad2026-en 1:2.02-1 (amd64)",
    );
    expect(
      packageFileMismatch(fields, { ...installed, architecture: "arm64" }),
    ).toContain("not the installed varicad2026-en 1:2.03-1 (arm64)");
    expect(
      packageFileMismatch(fields, { ...installed, name: "varicad" }),
    ).toContain("not the installed varicad ");
  });
});

describe("dependencyPackages", () => {
  it("takes each entry's first alternative without its qualifier or version, once", () => {
    expect(
      dependencyPackages({
        depends: [
          "libc6 (>= 2.34)",
          "libgl1 | libgl1-mesa-glx",
          "libstdc++6:any (>= 12)",
          "libc6",
        ],
        pre_depends: ["dpkg (>= 1.15.6)", "python3:native"],
      }),
    ).toEqual({
      names: ["libc6", "libgl1", "libstdc++6", "dpkg", "python3"],
      unread: [],
    });
  });

  it("returns an entry whose first alternative names no package apart", () => {
    expect(
      dependencyPackages({
        depends: ["${shlibs:Depends}", "x"],
        pre_depends: [],
      }),
    ).toEqual({ names: [], unread: ["${shlibs:Depends}", "x"] });
  });
});

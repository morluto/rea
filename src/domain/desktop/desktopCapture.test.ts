import { describe, expect, it } from "vitest";

import {
  checkpointNameRefusal,
  desktopApplicationInventorySchema,
} from "./desktopCapture.js";

describe("checkpointNameRefusal", () => {
  it("accepts an omitted name and a new one", () => {
    expect(checkpointNameRefusal(undefined, new Set(["saved"]))).toBe(
      undefined,
    );
    expect(checkpointNameRefusal("checkpoint-2", new Set(["saved"]))).toBe(
      undefined,
    );
  });

  it("refuses empty, reserved and repeated names", () => {
    expect(checkpointNameRefusal("", new Set())).toMatch(/empty/u);
    for (const name of ["baseline", "stop", "time-limit", "exit"])
      expect(checkpointNameRefusal(name, new Set())).toMatch(/reserved/u);
    expect(checkpointNameRefusal("saved", new Set(["saved"]))).toMatch(
      /already recorded/u,
    );
  });
});

describe("desktopApplicationInventorySchema", () => {
  const inventory = (package_: Record<string, unknown>) => ({
    desktop_entry: null,
    argv: ["varicad"],
    working_directory: "/home/ada",
    executable: {
      path: "/usr/bin/varicad",
      resolved_path: "/opt/VariCAD/bin/varicad",
      electron_markers: [],
    },
    package: {
      kind: "deb",
      name: "varicad2026-en",
      version: "2.03",
      architecture: "amd64",
      sources: [],
      package_lists_present: true,
      ...package_,
    },
    state_directories: [],
  });
  const file = {
    name: "varicad2026-en_2.03_amd64.deb",
    sha256: "d".repeat(64),
    size: 312_000_000,
    package: "varicad2026-en",
    version: "2.03",
    architecture: "amd64",
    depends: ["libc6 (>= 2.34)"],
    pre_depends: [],
  };

  it("reads captures written before package files were recorded, and either fact", () => {
    const parse = (package_: Record<string, unknown>) =>
      desktopApplicationInventorySchema.safeParse(inventory(package_)).success;

    expect(parse({})).toBe(true);
    expect(parse({ package_file: file })).toBe(true);
    expect(parse({ package_file_reason: "dpkg-deb is not installed" })).toBe(
      true,
    );
  });

  it("refuses a package file name that is a path or a parent folder", () => {
    for (const name of ["../varicad.deb", "..", "debs/varicad.deb", ""])
      expect(
        desktopApplicationInventorySchema.safeParse(
          inventory({ package_file: { ...file, name } }),
        ).success,
      ).toBe(false);
  });
});
